# ADR 0132 — Per-conversation capability scope + per-tool-call approval

**Status:** implemented — all 5 phases (2026-06-24). P1 pure resolver + `run.metadata` stamp (`features/conversation-tools/{scopeResolver,capabilityScopeStamp}.ts`); P2 the loop hook / fourth AND-term in `runChatToolLoop` (`host/agentDispatch.ts` + `host/conversationToolLoop.ts`, live-per-turn enforcement — §replay correction); P3 per-tool approval request→record→fold-on-reattempt (`approvalLedger.ts` + `applyApprovalDecisions`, §Phase-3 correction); P4 REST + owner-gated RBAC under `/v1/host/openwop-app/conversation-tools/sessions/:id/*` (§Phase-4 note); P5 the FE chipset + approvals (`frontend/react/src/conversationTools/`). Each phase: `/architect` GO + `/code-review` CLEAR (+ `/ux-review` PASS for P5); 32 backend tests + the FE gate green.
> **CORRECTED 2026-10-06 (ADR 0834, feature loop round 2 row 20).** Three claims in this
> ADR were false at HEAD, measured on `a767ee948`:
> 1. **"Stamped at creation, read verbatim on `:fork`."** `readCapabilityScopeStamp` has no
>    caller. Every turn — a fork's included — resolves the scope LIVE (now through
>    `host/conversationToolScope.ts`, shared with voice). That is the behaviour the §replay
>    correction below asks for ("tighter wins"); the stamp is provenance only.
> 2. **"The per-call approval rides the EXISTING interrupt/resume seam" / "the conversation
>    surfaces an `interrupt.approval` card".** Nothing reads the loop's `pendingApprovals`
>    after a turn; there is no card. ADR 0834 D6 surfaces a held call on the composer's
>    conversation-tools control, with the call's arguments and what an approval covers.
> 3. **The approval grain.** An approval covers every later call of that tool in the
>    conversation, with any arguments, and could be issued with no pending ask. ADR 0834
>    D2 makes an approval answer a pending ask (409 otherwise), records the ask's origin,
>    and checks the version the approver saw; allow-once is ADR 0834 FW2-D1.
> Also: voice never applied this scope (ADR 0834 D5), and the toggle described below was
> retired in the 2026-06-24 graduation (always on).

**Date:** 2026-06-24
**Toggle:** `conversation-tools` · default **OFF** · `bucketUnit: tenant` (a shared
operator-console surface a workspace opts into). When OFF, the live tool loop is
unchanged — an agent may use exactly the tools its `agentProfile` already permits
(ADR 0102), with no per-conversation narrowing and no per-call approval prompts.
**Surface:** host-extension — an additive `capabilityScope` on `ConversationMeta`
(`host/conversationStore.ts`) read by the existing live tool loop
(`host/agentDispatch.ts` `runChatToolLoop`). No OpenWOP wire field, capability flag,
or run-event change; the per-call approval rides the EXISTING interrupt/resume seam
(RFC 0064) and the verdict is recorded in the EXISTING
`agent.toolReturned{status:'forbidden'}`.
**Depends on / composes:** ADR 0031 (`agentProfile.permissions{read,write,never}` —
the agent's *ceiling*), ADR 0102 (per-tool `permissions.read/write` enforcement at
`runChatToolLoop` — the scope ANDs into this), ADR 0104 (superadmin `toolAllowlist`
override — a second AND term), ADR 0089 (chat-driven agent tool loop + the nested
agentic run / interrupt seam — Phase 4), ADR 0075 (HITL approver routing — the
*run-proposal* approval, **DISTINCT** from this per-tool-call approval; see § below),
RFC 0078 `/v1/tools` tool catalog (`routes/toolCatalog.ts` — the chipset's data
source), ADR 0031 (the `run.metadata` decision-stamp + replay-on-fork invariant — the
critical design point), the HITL card registry (`chat/registry/defaultCards.tsx`
`interrupt.approval`).
**RFC verdict:** **host-extension — NO new RFC.** The scope is a host-internal
**narrowing** filter ANDed into the already-honored per-tool permission model (ADR
0102 / RFC 0064, Accepted); it never *widens* an agent's advertised tool surface. The
per-call approval is an interrupt on the already-specified RFC 0064 hook seam; its
verdict travels in the existing `agent.toolReturned`. The effective scope is stamped
in non-normative `run.metadata`. No run-event field, capability flag, event type,
endpoint contract, or normative MUST is added.

> **Origin.** Third-party competitive analysis (`compare.md`, June 2026) §"Skill and
> Tool Approval Hub" — its **#1 recommendation** and the single gap it identified
> correctly. Competitor patterns: Open WebUI per-chat skill/function toggles,
> LibreChat manifest-driven tool layer, AnythingLLM skill whitelisting + request
> approval. The value: an OpenWOP chat becomes an **operator console** ("what may
> this agent do in *this* conversation, and what must I approve first") rather than a
> message stream with capabilities frozen at agent-definition time.

---

## Context — boundaries audit first (MANDATORY)

The naïve build is "a per-conversation tool list the chat checks before calling a
tool." That would **fork** the authorization path — the place tool authorization
*already* happens is the live tool loop, and there are already **three** AND-terms
gating a call. The conversation scope is a **fourth narrowing term**, not a new gate.

| Concern | Existing owner (file:line) | How the scope reuses it |
|---|---|---|
| Per-tool authorization | `host/agentDispatch.ts` `runChatToolLoop` + ADR 0102 `permissions.read/write` enforcement (verdict → `agent.toolReturned{status:'forbidden'}`, RFC 0064) | The conversation `capabilityScope` is evaluated **inside** the same loop, ANDed with the agent's permissions. A tool fires only if `agentAllows ∧ allowlistAllows ∧ scopeAllows`. **Never widens** — a scope can only *remove* a tool the agent could otherwise use. |
| The agent's tool ceiling | `agentProfile.permissions` (ADR 0031), superadmin `toolAllowlist` (ADR 0104) | The scope is intersected with these; it is impossible to enable a tool outside the agent's ceiling (fail-closed). |
| Tool catalog / metadata | RFC 0078 `routes/toolCatalog.ts` `GET /v1/tools` — `ToolDescriptor{toolId, source, safetyTier, auth.scopes, approval, egress}` | The chipset reads the catalog, filtered to the scoped agent's allowlist; `safetyTier` (`pure/read/write/exec`) + `approval` (`never/conditional/always`) drive the **default** scope (write/exec default to approval-required) so the UX is honest without per-tool hand-config. |
| Mid-run approval | the interrupt/resume seam (ADR 0089 Phase 4 nested agentic run; `routes/interrupts.ts`) + the `interrupt.approval` HITL card (`chat/registry/defaultCards.tsx`) | A tool marked `require-approval` for this conversation **suspends the loop with an interrupt** and surfaces the existing approval card. Approve ⇒ the call proceeds; deny ⇒ `agent.toolReturned{status:'forbidden'}`. **Reuses the card + interrupt + recorded-decision machinery** — no new approval surface. |
| Conversation metadata | `host/conversationStore.ts:53` `ConversationMeta` | Additive optional `capabilityScope?` field. No new store, no parallel "chat settings" table. |
| The decision stamp | `run.metadata` at run creation (ADR 0031 variant-stamp precedent, the ADR 0130 `modelRoute` precedent) | The **effective** scope (resolved against the agent ceiling at creation) is stamped and read verbatim on `:fork`. |

**Why this is NOT ADR 0075.** ADR 0075's approval is a **pre-run, per-run-proposal**
gate (a roster agent in `autonomyLevel:'review'` queues a `PendingApproval` *before*
the run starts; resolved via the approval *inbox*). This ADR's approval is a
**mid-run, per-tool-call** interrupt inside the live loop (the agent is already
running and is about to call a specific tool). They are different seams for different
moments; this ADR reuses the **interrupt** machinery (ADR 0089), not the approval
inbox. The two compose cleanly — a run can be proposal-approved (0075) and *still*
hit per-tool approval (0132) mid-execution.

**Net new (small):** an additive `ConversationMeta.capabilityScope`, a pure
`resolveCapabilityScope(agentCeiling, scope) → effective` intersection helper, a thin
read inside `runChatToolLoop` (the fourth AND-term + the require-approval interrupt),
the `run.metadata.capabilityScope` stamp, REST to read/set the scope, and the FE
chipset. **No new tool catalog, no new approval store, no new authorization path.**

---

## CRITICAL design point — replay/fork determinism (ADR 0031 invariant)

**The capability scope is a variable that influences the run** (it decides which tool
calls fire and which suspend), **so the effective scope MUST be stamped in
`run.metadata` at creation and read verbatim on `:fork` — never re-resolved.**

- The scope is *resolved against the agent ceiling at run creation*
  (`effective = scope ∩ agentPermissions ∩ allowlist`). The ceiling can change later
  (an admin edits the agent's `permissions`), so re-resolving on `:fork` could let a
  tool fire that the *original* run blocked, silently diverging the forked run — the
  ADR 0031 failure mode. Therefore the **resolved effective scope** is frozen at
  creation: `run.metadata.capabilityScope = { enabled[], requireApproval[], resolvedAt }`.
- The per-call **approval decisions** are already captured as interrupt/resume values
  on the durable log (ADR 0089 / ADR 0067 recorded-turn model). Replay reads the
  recorded decision and **never re-prompts**; a fork-and-continue applies the stamped
  scope to *new* turns and re-interrupts only for genuinely new tool calls.

> **§ Correction (2026-06-24, Phase 2 implementation) — the stamp is PROVENANCE, not
> the enforcement source; enforcement is LIVE per turn.** The original framing above
> ("the effective scope MUST be stamped and read verbatim — never re-resolved") over-
> applied the ADR 0031 freeze. ADR 0031's freeze is required for *nondeterministic*
> variables (the model-router's classifier, a clock, randomness). The capability scope
> is **deterministic data** (the conversation's config ∩ the agent ceiling), and — the
> load-bearing point — **per-turn tool decisions are already recorded as events**
> (`agent.toolReturned{forbidden}` for a scoped-out call; the approval interrupt/resume
> for an approved/denied one — ADR 0089 §Q4). So:
> - **Pure replay** reads those recorded outcomes and never re-runs the loop → deterministic regardless of scope.
> - **`:fork`-continue** runs only genuinely-*new* turns live; resolving them against the *current* config is correct (a new branch has no original to diverge from) and is the **safe direction** for a security *narrowing* control — the latest (possibly tighter) restriction wins, never a stale looser one.
>
> Therefore the loop **enforces from the LIVE `ConversationMeta.capabilityScope`**
> resolved against each turn's ceiling (`host/conversationToolLoop.ts`), which also makes
> the interactive operator control honest (a mid-conversation re-scope applies to the
> next turn). The `run.metadata.capabilityScope` stamp is retained as **best-effort
> provenance/audit** (the inspector can show "this run was scope-restricted") and a
> defensive fallback — written once via `computeCapabilityScopeStamp` (the already-
> stamped guard still holds) but **never** the enforcement source. This resolves OQ
> around interactive mutability vs determinism in favor of *both*.

> **§ Correction (2026-06-24, Phase 3 implementation) — approval grain is
> per-tool-for-the-conversation, enforced on RE-ATTEMPT (the no-mid-loop-suspend
> constraint).** The original design implied a per-single-*call* suspend ("the call
> proceeds on approve"). The in-process tool loop (`runChatToolLoop`) is a plain
> async for-loop that **cannot suspend mid-iteration**; the codebase only supports
> *turn-boundary* suspension, and blocking the loop to poll for a human decision
> would hold the run open indefinitely (the `subRunDispatcher` budget exists to avoid
> exactly that). So Phase 3 ships the architecturally-honest fit:
> - A `requireApproval` tool call is **not executed** — the loop collects it as a
>   `pendingApproval`, tells the model the action was *requested, not performed*, and
>   the turn completes (`host/agentDispatch.ts`). The deferral is recorded in a
>   durable ledger (`features/conversation-tools/approvalLedger.ts`, keyed by
>   tenant×conversation×tool) and surfaced as an `interrupt.approval` card.
> - On **approve**, the decision is folded into the effective scope on the agent's
>   next attempt (`applyApprovalDecisions` drops the tool from `requireApproval` so
>   the loop executes it); on **deny**, the tool is dropped from `enabled` (forbidden).
>   The fold is deterministic over the durable ledger ⇒ replay-safe (no stamp).
> - **Grain:** per-tool-for-this-conversation ("Allow this tool for the chat / Deny"),
>   not per-single-invocation. Per-single-call auto-execute-on-approve (re-entering the
>   exact loop iteration) is a documented **follow-on** — it needs a loop-state
>   serialization / re-entry seam the runtime does not yet have. The resolve route
>   lands in Phase 4 with the scope REST. Approval **never widens** beyond the agent
>   ceiling: it only ungates a tool already inside the effective set.

> **§ Note (2026-06-24, Phase 4) — route namespace + RBAC.** The routes ship under
> the **feature** namespace `/v1/host/openwop-app/conversation-tools/sessions/:sessionId/*`
> (GET/PUT `…/capability-scope`, POST `…/approvals/:toolName`), NOT the ADR's proposed
> `/chat/sessions/:id/capability-scope` — the latter would inject feature routes into
> the core-owned `/chat/sessions` namespace (features register *after* core, so a
> future core parameterized route could shadow it). RBAC follows the **chat-session
> resource model** (NOT org-scope `workspace:write`, which needs an orgId the URL does
> not carry): the `conversation-tools` toggle gate + `isVisibleToAsync`
> (participant/owner visibility). **READ** = any visible participant; **WRITE** (set
> scope / resolve an approval) = visible AND, when the conversation has a recorded
> `ownerUserId`, owner-only (`requireOwnerWrite`) — so a participant cannot silently
> re-scope another's tools or self-approve a gated action. The meta MUST exist + be
> visible (a missing meta ⇒ IDOR-safe 404, not a permissive default). Never-widen needs
> no set-time tool validation: the resolver intersects with the agent ceiling at
> runtime, so a free-text tool id outside the ceiling is inert.

This mirrors ADR 0130's `modelRoute` stamp exactly: a host-internal decision that
gates run behavior is snapshotted once, then read-only on replay/fork.

---

## Decision

Add an optional, per-conversation **`capabilityScope`** — a **narrowing** filter over
the agent's already-permitted tool set, with an optional **per-tool require-approval**
flag that suspends the live tool loop with the existing HITL interrupt card. The scope
is enforced **inside** `runChatToolLoop` as a fourth AND-term (never a widening), is
**stamped in `run.metadata` at creation** and read verbatim on `:fork`, and is driven
by the RFC 0078 tool catalog so write/exec tools default to approval-required.

### Data model — an additive narrowing scope

```ts
// additive on ConversationMeta (host/conversationStore.ts)
ConversationMeta {
  // … existing fields …
  capabilityScope?: ConversationCapabilityScope
}

ConversationCapabilityScope
  { mode: 'agent-default' | 'restricted',   // 'agent-default' = no narrowing (== OFF semantics)
    enabled?: string[],                       // toolIds explicitly enabled (subset of the agent ceiling)
    disabled?: string[],                      // toolIds explicitly disabled (removed from the ceiling)
    requireApproval?: string[],               // toolIds that suspend for per-call approval this conversation
    setBy, setAt }

// stamped at run creation, read verbatim on :fork
run.metadata.capabilityScope =
  { enabled: string[], requireApproval: string[], resolvedAt }  // the RESOLVED effective set
```

`enabled`/`disabled` are interpreted as a narrowing of the agent ceiling (default =
the full ceiling; `disabled` removes; `enabled`, when present, restricts to that
subset). The resolver is pure: `effective = (enabled ?? ceiling) \ disabled`, then
`∩ ceiling` (so an `enabled` entry outside the ceiling is silently dropped — never a
widening).

### The enforcement point (a thin read in the existing loop)

`runChatToolLoop`, **only when the feature is ON**, before each tool call:
1. If `toolId ∉ effective.enabled` → **skip** the tool (it never reaches the model as
   callable; or, if the model calls it anyway, return `agent.toolReturned{status:'forbidden', reason:'conversation-scope'}`).
2. If `toolId ∈ effective.requireApproval` → **suspend** with an `interrupt.approval`
   (the existing card) carrying `{toolId, args-preview, safetyTier}`; on resume,
   approve ⇒ call proceeds, deny ⇒ `forbidden`.
3. Otherwise → the existing ADR 0102 path, unchanged.

OFF ⇒ the loop is byte-identical to today (the read short-circuits on
`mode:'agent-default'`).

### RBAC & isolation

Setting `capabilityScope` requires being a **participant/owner** of the conversation
(the ADR 0043 conversation-access predicate) **and** `workspace:write`. A scope can
only **narrow**; a user can never enable a tool outside the agent ceiling, nor approve
a tool whose `auth.scopes` (RFC 0078) exceed the user's own effective scopes
(fail-closed). Tenant + conversation IDOR-guarded; uniform-404.

---

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (0001) | `features/conversation-tools/` — the pure scope resolver + REST (`routes.ts`) + the `runChatToolLoop` call-site hook + FE. features→core only; the live tool loop stays the one authorization owner. |
| 2 | Toggle + admin UI | `conversation-tools` toggle, OFF default, `bucketUnit:'tenant'`; standard `requireEnabled` gate; managed in `FeatureTogglePanel`. |
| 3 | Workflow surface (0014) | None new — the scope governs the **interactive** chat tool loop. Heartbeat/scheduled tool calls keep their own governance (ADR 0105); the scope is a chat-conversation concept and does not silently re-govern the heartbeat path (called out as OQ-2). |
| 4 | Node pack | None. |
| 5 | AI-chat envelopes | Composes ADR 0089 dispatch; adds no envelope type. The chat experience gains a scope chipset + per-call approval cards (existing card type). |
| 6 | Agent pack | None — capability gating is a core-agent concern, not a named-agent one ([[agent-capability-core-not-named]]). |
| 7 | Public surface | None. Authed conversation-scoped config. |
| 8 | RBAC + isolation (0006) | Participant/owner + `workspace:write` to set; narrow-only; per-tool `auth.scopes` checked against the user's scopes; tenant + conversation IDOR-404; fail-closed. |
| 9 | Replay / fork safety | **The crux** — `run.metadata.capabilityScope` (resolved effective set) stamped at creation, read verbatim on `:fork`; the ceiling is **never** re-resolved on fork. Per-call approvals recorded as interrupt/resume values, never re-prompted on replay (ADR 0089). |
| 10 | Frontend | An **Enabled-capabilities chipset** in the conversation header/composer: lists the agent's tools (from `GET /v1/tools` filtered to the agent allowlist) with enable/disable + require-approval toggles; `safetyTier` colour-coded; a per-call approval card (existing `interrupt.approval`) when a gated tool is attempted; `ui/` tokens, a11y, light+dark. |

---

> **Correction 2026-10-03 (found implementing ADR 0773 plan B.2).** The enforcement point read the scope from `getConversationMeta(run.tenantId, params.conversationId)`, and `params.conversationId` is the run-derived gate id (`runId:nodeId:0`, `host/conversation.ts`). ConversationMeta is keyed by the chat SESSION id (`exchange/authorizeResolve.ts`, and the comment at `conversationExchange.ts` "KEY (unchanged)"), and that is the key this feature's own routes and the chat UI's scope control write under. So on every chat-started run (all of which carry `run.metadata.chatSessionId`), a scope set from the UI never narrowed anything. The same mismatch applied to the approval ledger (recorded under the gate id, resolved by the route under the session id) and the ADR 0136 intent ledger. `host/conversationToolLoop.ts` now reads and writes all three under `chatSessionId ?? params.conversationId`, the rule `authorizeResolve` already uses. Witness: `test/conversation-tool-loop-session-key.test.ts` drives the real turn entry with the managed round stubbed and asserts what the model is offered; reading by the gate id again reddens the session-id case. Unit tests of the resolver and the loop core passed throughout, because neither takes the key: the defect lived in the wiring, between two correct parts.

## Phased plan

1. **The pure resolver + the stamp.** `resolveCapabilityScope(ceiling, scope) → effective`
   (intersection, never-widen) + the `run.metadata.capabilityScope` stamp at run
   creation. Fully unit-tested (narrowing, never-widen, disabled-wins, empty-enabled).
   No loop change yet.
2. **The loop hook.** Wire the fourth AND-term into `runChatToolLoop` **only when ON**:
   skip / forbid a tool outside `enabled`. Test: a scoped-out tool returns
   `forbidden{reason:'conversation-scope'}`; a fork reads the stamp verbatim (does NOT
   re-resolve against a since-edited ceiling).
3. **Per-call approval interrupt.** A `require-approval` tool suspends with
   `interrupt.approval`; resume approve/deny → proceed/forbidden. Test: replay reads
   the recorded decision and never re-prompts (ADR 0089 §Q4).
4. **REST + RBAC.** `GET/PUT /v1/host/openwop-app/chat/sessions/:id/capability-scope`,
   participant + `workspace:write`, narrow-only validation, per-tool `auth.scopes`
   check, IDOR-404.
5. **Frontend.** The capabilities chipset (read `GET /v1/tools`) + the approval card
   wiring; `/ux-review`.

## Alternatives weighed

1. **A new per-conversation authorization gate separate from `runChatToolLoop`.**
   Rejected — forks the authorization path; ADR 0102 already owns per-tool
   enforcement. The scope is a *term* in that gate, not a new gate.
2. **Reuse the ADR 0075 approval inbox for per-tool approval.** Rejected — 0075 is a
   *pre-run, per-proposal* concept resolved out-of-band in an inbox; a mid-run
   per-tool prompt is an **interrupt** (ADR 0089), and forcing it through the inbox
   would break the in-chat flow and the recorded-turn replay model.
3. **Let the scope WIDEN (grant tools beyond the agent ceiling for one chat).**
   Rejected — a wire-honesty + security hazard (a conversation could escalate beyond
   the agent's advertised permissions). Narrow-only, intersected with the ceiling, is
   the invariant.
4. **Re-resolve the scope on `:fork`.** Rejected — the ADR 0031 divergence hazard
   (a since-edited ceiling would change forked behavior). Stamp the resolved effective
   set; read verbatim.
5. **No stamp; scope is purely live FE state.** Rejected — the scope influences run
   behavior; an unstamped scope is not replayable and a forked run would silently
   differ.

## Open questions

1. **OQ-1 — Default approval policy source.** Lean: derive the per-tool default
   `requireApproval` from the RFC 0078 `ToolDescriptor.approval` (`always`/`conditional`)
   + `safetyTier` (`write`/`exec`), so a fresh conversation is safe-by-default without
   hand-config; the user can then relax/tighten. Confirm the default mapping.
2. **OQ-2 — Heartbeat-path interaction.** This scope governs the **interactive** chat
   loop. Heartbeat/scheduled tool calls are governed by ADR 0105 (workflow portfolio +
   autonomy), not this scope. Confirm we do NOT silently extend the conversation scope
   to the heartbeat path (it would be a surprising re-governance).
3. **OQ-3 — Project/agent inheritance.** Should a project (ADR 0054) or an agent
   profile carry a *default* capability scope that new conversations inherit? Lean:
   defer — v1 is per-conversation; inheritance is an additive follow-on.
4. **OQ-4 — Approval audit.** A per-call approval is recorded as an interrupt/resume
   value (durable). Do we *also* surface it in the unified review projection (ADR 0068)
   for an audit trail? Lean: yes, read-only, in a follow-on.

## RFC verdict (Step 5)

**Host-extension — NO new RFC.** The scope is a host-internal **narrowing** filter
ANDed into the already-honored per-tool permission model (ADR 0102, implementing the
Accepted RFC 0064); it never widens an agent's advertised tool surface, so the wire's
capability honesty is preserved. The per-call approval is an interrupt on the
already-specified RFC 0064 hook seam, and its verdict travels in the existing
`agent.toolReturned{status:'forbidden'}`. The effective scope is stamped in
non-normative `run.metadata.capabilityScope`. No run-event field, capability flag,
event type, endpoint contract, or normative MUST is added. (If a *portable,
cross-host* "conversation capability scope" were ever desired, that portability would
be an RFC — but v1 is host-local and needs none.)
