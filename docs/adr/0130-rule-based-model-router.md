# ADR 0130 — Rule-based per-turn model router

**Status:** in-progress — **Phase 1 implemented** (2026-06-24): the PURE selector. `features/model-router/routeTurn.ts` — `routeTurn(features, config, probe, now, state?)` choosing a `{provider, model}` from a rule set with the capability FILTER (an attachment turn NEVER routes to a non-vision target — the invariant), cooldown STICKINESS (sticky target re-used while eligible), and a fallback. Pure + deterministic (no dispatch/I/O/clock). **Phase 2 (config) implemented** (2026-06-24): `features/model-router/configService.ts` — `ModelRouterConfig` (DurableCollection per tenant/org) + `validateRouterConfig` (rule kind / target / fallback validation) + setRouterConfig/getRouterConfig/setRouterEnabled; routes `/model-router/orgs/:orgId/config` (GET/PUT/enable, authorizeOrgScope), toggle `model-router` OFF/tenant. **Phase 3a (resolver) implemented** (2026-06-24): `resolveModelRoute(tenantId, orgId, features, now, state?)` reads the tenant config (Phase 2), gates on `enabled`, and runs `routeTurn` (Phase 1) with the REAL RFC 0031 probe — returns the target or null (off → explicit model kept). **Phase 3b (dispatch override, READ side) implemented** (2026-06-24): `effectiveModelTarget(provider, model, metadata)` (pure) reads a stamped `run.metadata.modelRoute` and overrides the run's provider/model — wired into `conversationExchange.dispatchReply`. Read verbatim ⇒ `:fork` re-runs with the SAME target (the router never re-evaluates on replay, ADR 0001 stamp pattern); no stamp ⇒ unchanged. The WRITE side (stamping the resolved route at run creation, Phase 3c) + LLM-classify (Phase 4) + FE (Phase 5) pending. **Date:** 2026-06-23
**Toggle:** `model-router` · default **OFF** · `bucketUnit: tenant` (a cost/quality-optimization surface a tenant opts into). When OFF, dispatch is unchanged — the run's explicit provider/model (or the ADR 0110 headless default) is used as today.
**Surface:** host-extension `/v1/host/openwop-app/model-router/*` (non-normative) — a per-tenant rule set + a **routing stage** in the dispatch path. No new wire contract; the chosen provider/model travels in `run.metadata` exactly like any provider choice.
**Depends on / composes:** ADR 0067 (conversation-run dispatch — the router is a stage in front of `dispatchReply`), ADR 0110 (headless default binding — composes as the **fallback default**; DISTINCT — 0110 is one binding, this is per-turn routing), `host/modelCapabilityProbe.ts` (the router's capability filter), the BYOK secret store + `byok/secretResolver.ts` (each routed target resolves its key), ADR 0031 (the `run.metadata` decision-stamp + replay-on-fork invariant — the CRITICAL design point below), ADR 0121 (a routed target MAY be a `compat` endpoint, if that lands).
**RFC verdict:** **host-extension — NO new RFC.** Routing is a host-internal stage choosing among **already-advertised** providers (`aiProviders.supported[]`); it adds no run-event field, capability flag, event type, endpoint contract, or normative MUST. The choice is stamped in non-normative `run.metadata`. (The set of providers it can route to is already wire-honest; the router doesn't widen it. If it ever routes to an *unadvertised* class — e.g. a `compat` endpoint — that honesty is **ADR 0121's** RFC gate, not this ADR's.)

> **Origin.** `docs/research/2026-06-23-ai-chat-competitive-analysis.md` §6 (AnythingLLM **Model Router (rule-based)**, Partial) + §9/§11 — "OpenWOP has none." Competitor impl path: AnythingLLM `server/utils/AiProviders/modelRouter/` + `server/models/modelRouter*.js` — routes **per turn** by token / message-count / attachment-presence rules + **cached LLM-classification**, with **sticky cooldown** + **fallback**. The value: cost/quality optimization (cheap model for trivial turns, a capable model for hard/long/attachment-bearing turns) — a differentiator none of the other four ship.

---

## Context — boundaries audit first (MANDATORY)

The naïve build is "a router that calls providers directly." That would fork the dispatch path and bypass the BYOK/policy/capability seams. The router is a **decision stage**, not a dispatcher — it chooses `{provider, model, credentialRef}` and hands off to the **existing** `dispatchChat`/`dispatchReply`.

| Concern | Existing owner (file:line) | How the router reuses it |
|---|---|---|
| Provider dispatch | `providers/dispatch.ts:138` `dispatchChat` over `DispatchRequest`; `host/conversationExchange.ts` `dispatchReply` reads `run.inputs.{provider,model,credentialRef}` | The router runs **before** `dispatchReply`, replacing the run-input default with a rule-chosen `{provider,model,credentialRef}`. It never dispatches itself — it's a selector feeding the one dispatch owner. |
| Capability filter | `host/modelCapabilityProbe.ts` (per-provider cap map) + `assertModalitiesAdvertised` (ADR 0089 §2) | A rule can only route to a target that **supports the turn's modalities** (an image-bearing turn must route to a vision-capable target). The router filters candidates through the probe — never routes to a target that would 422 on the gate. |
| Key resolution | `byok/secretResolver.ts` `resolveSecret({tenantId})` | Each candidate target carries a `credentialRef`; the chosen one resolves the same way the conversation already resolves BYOK (SR-1, host-side only). |
| The fallback default | ADR 0110 `resolveHeadlessAi` / the run's explicit provider | When no rule matches (or the chosen target's key is unresolvable), the router falls back to the run's explicit provider, else the ADR 0110 headless default. **0110 is composed, not duplicated** — it's the floor. |
| Optional LLM-classification | `dispatchManagedChat` / a cheap model | A rule MAY classify the turn ("is this a coding question?") with a **cheap** model call — but its **output is nondeterministic**, which forces the replay design below. |
| The decision stamp | `run.metadata` at creation (`runStarter.ts:46`, ADR 0031 variant-stamp precedent) | **The crux** — the chosen `{provider,model,credentialRef}` + which rule fired is stamped at creation and read verbatim on `:fork`. |

**Net new (small):** a per-tenant `ModelRouterConfig` (ordered rules + targets + cooldown), a pure `routeTurn(features, config) → decision` selector, a thin call-site in `dispatchReply` (router-then-dispatch), and the `run.metadata.modelRoute` stamp. No new dispatcher, no new key store, no new capability vocabulary.

---

## CRITICAL design point — replay/fork determinism (ADR 0031 invariant)

**The routing DECISION is a variable that influences the run, so it MUST be stamped in `run.metadata` at creation and read verbatim on `:fork` — never recomputed.** This is non-negotiable and is the reason this ADR exists as a careful decision rather than a one-liner:

- **Rule evaluation over turn features** (token count, message count, attachment presence) is *mostly* deterministic, **but** LLM-classification routing is **nondeterministic** (a cheap classifier model's output varies run-to-run), and **sticky cooldown** is **time/state-dependent** (which target is "cooling down" depends on recent history). Recomputing the route on `:fork` could pick a **different model than the original run used**, silently changing the forked run's behavior — the exact ADR 0031 failure mode (a variable that influences the run must be stamped, not recomputed — the variant-stamp lesson from ADR 0001's `run.metadata` correction).
- **Therefore:** at run creation the router writes `run.metadata.modelRoute = { provider, model, credentialRef, ruleId, reason, classifierUsed }`. The dispatch reads the stamp; **`:fork` reads the stamp verbatim and re-dispatches against the same `{provider,model}`** — it does **not** re-run the rules or re-classify. The classifier's nondeterminism is captured once and frozen.
- The model's **reply** is live (recorded as the conversation turn, ADR 0067); replay reads the recorded turn and never re-dispatches (ADR 0089 §Q4). The stamp guarantees that a forked-and-continued run (which *does* dispatch new turns) uses the **same routing decision** the parent established for already-decided turns, and routes *new* turns by the rules (a new decision, freshly stamped) — consistent with how every per-turn provider choice already works.

This mirrors ADR 0103's discipline (a live-derived value is either never stamped, or snapshotted at generation): here the route MUST be snapshotted because a fork that recomputed it would diverge.

---

## Decision

Add an optional, per-tenant **`model-router`**: an **ordered rule set** evaluated against per-turn features (token/message/attachment thresholds + optional cheap-LLM classification) that selects a `{provider, model, credentialRef}` **target**, with **sticky cooldown** (avoid flapping between targets) and **fallback** to the run's explicit provider / the ADR 0110 default. The router is a **stage in the dispatch path (ADR 0067)** that feeds the **existing** `dispatchChat` — it never dispatches itself, never bypasses BYOK/capability gates. **The chosen route is stamped in `run.metadata` at creation and read verbatim on `:fork`** (the CRITICAL point above).

### Data model — an ordered rule set + targets

```ts
ModelRouterConfig                     // per-tenant, opt-in
  { tenantId, enabled,
    targets: RouterTarget[],          // the named models this tenant routes among
    rules: RouterRule[],              // ordered; first match wins
    cooldown: { windowMs, key: 'target' },  // sticky — don't flap mid-conversation
    fallbackTargetId?,                // else the run's explicit provider / ADR 0110 default
    updatedBy, updatedAt }

RouterTarget { id, provider, model, credentialRef }   // a real dispatch target (BYOK or managed ref)

RouterRule
  { id, when: {                        // ALL present conditions must hold (AND); rules are OR'd by order
      minTokens?, maxTokens?,          // estimated input tokens this turn
      minMessages?, maxMessages?,      // conversation length
      hasAttachment?: boolean,         // image/file part present (forces a vision-capable target)
      classify?: { prompt, model, equals }  // OPTIONAL cheap-LLM classification (nondeterministic — stamped)
    },
    targetId }                         // the target to route to when matched
```

### The routing stage (pure selector + a thin call-site)

`routeTurn(features, config, capabilityProbe, now) → RouterDecision` (pure, fully unit-testable):
1. Apply cooldown: if a target is sticky for this conversation within `windowMs`, prefer it (skip re-evaluation flap).
2. Evaluate `rules` in order; first whose `when` holds (incl. an optional classifier call) wins.
3. **Capability-filter** the chosen target through `modelCapabilityProbe` — if the turn has an attachment and the target isn't vision-capable, skip to the next matching rule / fallback (never route to a target that 422s the gate).
4. If none match → `fallbackTargetId` → the run's explicit provider → the ADR 0110 headless default.
5. Return `{ provider, model, credentialRef, ruleId, reason, classifierUsed }`.

The call-site in `dispatchReply` (ADR 0067) runs `routeTurn` **only when the feature is ON**, stamps the decision into `run.metadata.modelRoute`, and dispatches with the chosen target via the existing path. OFF ⇒ unchanged.

### RBAC & isolation

Editing the router config = `workspace:write` on the tenant's AI-config scope; each `RouterTarget.credentialRef` is validated against the tenant's own BYOK store (can't point at another tenant's secret — the ADR 0110 validation). Tenant-scoped; uniform-404 IDOR. The classifier call (if used) bills the tenant's own provider/managed budget.

---

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (0001) | `features/model-router/` — config entity + the pure `routeTurn` selector + the `dispatchReply` call-site + UI. features→core only; the dispatch path stays the one owner. |
| 2 | Toggle + admin UI | `model-router` toggle, OFF default, `bucketUnit:'tenant'`; standard `requireEnabled` gate; rule editor in the BYOK/AI-config admin. |
| 3 | Workflow surface (0014) | None new — the router is transparent to nodes; it only changes which `{provider,model}` a turn dispatches with. |
| 4 | Node pack | None. |
| 5 | AI-chat envelopes | Composes ADR 0067 dispatch; the in-chat experience is unchanged except a cheaper/better model is chosen per turn. The chosen model MAY be surfaced in the turn's metadata for transparency. |
| 6 | Agent pack | None — orthogonal to agent identity; capability stays core ([[agent-capability-core-not-named]]). |
| 7 | Public surface | None. Authed config; the route stamp is internal `run.metadata`. |
| 8 | RBAC + isolation (0006) | `workspace:write` to configure; `credentialRef` validated in-tenant; tenant scoping; uniform-404 IDOR. |
| 9 | Replay / fork safety | **The crux** — `run.metadata.modelRoute` stamped at creation, read verbatim on `:fork`; rules/classifier **never recomputed** on fork (nondeterminism frozen — ADR 0031). Live reply recorded as the turn, never re-dispatched on replay (ADR 0089 §Q4). |
| 10 | Frontend | An ordered rule editor (thresholds + attachment toggle + optional classifier) + target list (provider/model/key) + cooldown; a per-turn "routed to <model> (<rule>)" transparency chip; `ui/` tokens, a11y, light+dark. |

---

## Phased plan

1. **The pure selector.** `routeTurn(features, config, probe, now)` + rule/target/cooldown types + the capability filter. Fully unit-tested (threshold boundaries, attachment→vision filter, cooldown stickiness, fallback chain, classifier-equals). No dispatch yet.
2. **Config entity + routes.** `ModelRouterConfig` (`DurableCollection`), `/v1/host/openwop-app/model-router/*` CRUD, `credentialRef`-in-tenant validation, toggle OFF/tenant, RBAC + IDOR-404.
3. **The dispatch call-site + the stamp.** Wire `routeTurn` in front of `dispatchReply` (ADR 0067) **only when ON**; stamp `run.metadata.modelRoute` at creation; dispatch with the chosen target. Test: a fork reads the stamp verbatim (does NOT re-classify); an attachment turn never routes to a non-vision target.
4. **Optional LLM-classification.** The `classify` rule path (a cheap model call, result stamped). Test: classifier nondeterminism is captured once; fork reuses the stamped result.
5. **Frontend + transparency.** The rule editor + the per-turn routed-to chip; `/ux-review`.

## Alternatives weighed

1. **Recompute the route on replay/fork (don't stamp).** **Rejected — the central hazard.** LLM-classification + cooldown are nondeterministic/stateful; recomputing would silently pick a different model on a fork, diverging the run (ADR 0031 violation). The decision MUST be stamped.
2. **A single tenant default only (ADR 0110).** That's the *floor*, not the feature — 0110 binds **one** model for headless ops; this routes **per turn** by content. We **compose** 0110 as the fallback, not replace it (DISTINCT surfaces).
3. **Router dispatches providers directly (AnythingLLM-style).** Rejected — would fork the dispatch path and bypass BYOK/capability/policy seams. The router is a **selector** that feeds the one `dispatchChat` owner.
4. **Server-side "auto" model (provider-native routing, e.g. OpenAI's).** A different axis (the provider routes within its own family); this routes **across** providers/models by tenant rules. Not mutually exclusive; out of scope.

## Open questions

1. **OQ-1 — Token estimation.** "Input tokens this turn" needs an estimate before dispatch. Lean: a cheap heuristic (char/4 + attachment flag), not a real tokenizer call, since rules are coarse thresholds.
2. **OQ-2 — Cooldown scope.** Sticky per-conversation (proposed) vs per-tenant. Per-conversation avoids mid-thread model flapping (the AnythingLLM intent); confirm.
3. **OQ-3 — Classifier cost/caching.** AnythingLLM caches classification. A cheap classifier call per turn adds latency+cost; cache by a turn-content hash within a conversation. Lean: cache, and the result is what's stamped.
4. **OQ-4 — Transparency.** Surface the chosen model to the user per turn? Lean: yes, a subtle chip — routing silently to a cheaper model without disclosure is a trust hazard.
5. **OQ-5 — Interaction with `compat` targets (ADR 0121).** A `RouterTarget` MAY be a `compat` endpoint once 0121 lands — but routing to an *unadvertised* provider class inherits **0121's** RFC gate, not this one's. v1: route only among already-advertised providers.

## RFC verdict (Step 5)

**Host-extension — NO new RFC.** The router is a host-internal decision stage choosing among **already-advertised** providers (`aiProviders.supported[]`, `routes/discovery.ts:457`); it adds no run-event field, capability flag, event type, endpoint contract, or normative MUST. The routing decision is stamped in non-normative `run.metadata.modelRoute` (the ADR 0031 variant-stamp precedent) and dispatched through the existing `dispatchChat`/BYOK seams. The router never widens the wire-honest provider set; routing to an unadvertised class (e.g. an ADR 0121 `compat` endpoint) inherits **that** ADR's RFC gate.

> **Phase 3c (lazy creation stamp — WRITE side) implemented** (2026-06-24):** the model-router is now FUNCTIONAL end-to-end. `conversationExchange.maybeStampModelRoute` runs on the first exchange where `run.metadata.modelRoute` is absent: it calls `resolveModelRoute` (3a) with the turn's features (tokenEstimate) and, if a target is routed, persists it via `storage.updateRun` (workspace-root org = `scopeId ?? tenantId`). Written ONCE, then read verbatim by `dispatchReply` (3b) every turn + on `:fork` — never re-resolved on replay (the guard: `computeRouteStamp` returns null when already stamped). BEST-EFFORT: any failure leaves the run's explicit model. /architect GO (replay-safe lazy stamp confirmed as the correct seam vs the client-metadata-driven POST /v1/runs), /code-review clean. Only the FE config UI (Phase 5) remains.

> **Phase 5 (frontend rule editor + transparency chip) — the remaining user-facing gap (flagged 2026-06-24).** A third-party competitive analysis (`compare.md`, June 2026, "Policy Router") listed model routing as a differentiator OpenWOP "lacks." The fact-check confirmed the engine ships end-to-end (Phases 1–3c) but is **invisible without the config UI** — the router cannot be configured in-app, only via the `/model-router/orgs/:orgId/config` REST surface. Phase 5 is therefore the **lowest-effort, highest-visibility** completion: an ordered rule editor (token/message/attachment thresholds + optional classifier) + target list (provider/model/credentialRef) + cooldown, plus the per-turn "routed to &lt;model&gt; (&lt;rule&gt;)" transparency chip (OQ-4). Pure FE work on an already-accepted design; no backend or wire change. Run `/ux-review` on landing.


## § Follow-on — Trust Budget Router (innovation strategy, 2026-06-24)

`openwop_ai_chat_innovation_strategy.md` proposes routing not only by token/message/
attachment/classifier but by **data sensitivity, action risk, reversibility, cost
ceiling, latency target, and execution zone**. This is an **additive routing-axis
extension of THIS ADR**, not a new feature: add sensitivity/risk classifiers as new
`RouterRule.when` conditions + an `executionZone` dimension on `RouterTarget` (a
"trusted zone" ties to ADR 0121 local/private provider). Same `run.metadata` stamp +
dispatch-stage design, same `model-router` toggle; compose ADR 0135 (Capability
Firewall) for the action-risk signal. Host-extension, no new RFC.

---

## Follow-up action — surfacing audit (2026-06-24)

**Audit verdict:** 🟡 backend-complete + wired into dispatch (`host/conversationExchange.ts`
`maybeStampModelRoute`/`resolveModelRoute`), but **zero UI** — no rule editor, no enable
switch, no per-turn transparency chip. A config exists only if someone hand-calls
`PUT /v1/host/openwop-app/model-router/orgs/:orgId/config`; no user can enable routing,
author rules, or see that a turn was routed. This is the open Phase 5 named in this ADR.

**Seam-correct action (Phase 5 — pure FE, backend already done):**
1. Add `frontend/react/src/features/model-router/` — an **admin-tier** rule-editor page
   (a `modelRouterClient.ts` over the existing `/model-router/orgs/:orgId/config` GET/PUT
   + `/enable`), registered in `FRONTEND_FEATURES` (`features/registry.ts`) + `FEATURES`
   (`chrome/features.tsx`) in the **"Access & data" / Platform** nav group, alongside the
   Capability-Firewall page (ADR 0135) it composes.
2. Add the **"routed to `<model>`" transparency chip** in the chat message header, reading
   the existing `run.metadata` route stamp (no new capture path).

**Boundary check:** config is org-scoped (`requireOrgScope('workspace:write')`); no new
wire, no second router — reuse the existing route + `model-router` toggle. Single owner
stays `features/model-router/`.
