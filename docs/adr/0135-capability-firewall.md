# ADR 0135 — Capability Firewall (composition-aware tool/data/action risk)

**Status:** implemented — all 4 phases (2026-06-24)
**Date:** 2026-06-24

## Implementation record

| Phase | What | Commit |
|---|---|---|
| 1 | Pure composition evaluator (`compositionEvaluator` + types; `anyOf` over seen∪next so cross- AND within-call exfil both fire) | `6d027625` |
| 2 | Loop hook in `runChatToolLoop` (injected `firewall` callback, within-turn `seen`) + `toolCapabilityResolver` (classify builtins; unknown→skip+log) + `run.metadata.capabilityFirewall` stamp | `0bc0b591` |
| 3 | Per-tenant rule store (`getCapabilityRules` default-when-unset) + REST (`/capability-firewall/orgs/:orgId/rules`, `authorizeOrgScope`, fail-closed validation) | `a0a9b727` |
| 4 | FE rule manager (`FirewallRulesPage`, lazy/admin, fixed-enum class chips) + i18n | `cba6e566` |

Built under `/goal` with `/architect` before each phase + `/code-review` (+`/ux-review` on P4) after; each phase GO'd. The loop firewall ANDs after the §A14 / ADR 0132 / ADR 0102 gates (narrows only). A tenant `unknownToolPolicy` (`skip` default fail-open / `treat-as-risky` fail-closed) closes the unclassified-tool coverage gap; the toggle copy discloses that default coverage is classified tools only. Deferred: cross-turn `seen` seeding; the per-run risk panel.

**Graduation (2026-06-24):** the toggle was **removed — always-on**, shipped **rule-less** by default (maintainer decision): the firewall is present for every tenant but a no-op until an admin adds rules (the loop skips building the hook when a tenant has no rules), so graduation imposes zero approval friction. The id is in `RETIRED_TOGGLE_IDS`. The original toggle rationale below is retained for the reasoning trail.

**Toggle (historical):** `capability-firewall` · default **OFF** · `bucketUnit: tenant` (a governance
surface a workspace opts into). When OFF, the live tool loop is unchanged — only the
existing per-tool gates apply.
**Surface:** host-extension — a per-tenant `CapabilityRuleSet` (DurableCollection) + a
**composition evaluator** that runs **inside** the one tool-loop owner
(`host/agentDispatch.ts` `runChatToolLoop`) as an additional AND-term, plus REST under
`/v1/host/openwop-app/capability-firewall/*` to manage rules. No OpenWOP wire field; a
denied/approval verdict rides the EXISTING `agent.toolReturned` + the conversation
approval-request seam (ADR 0132 Phase 3).
**Depends on / composes:** RFC 0078 ToolDescriptor (`safetyTier` pure/read/write/exec +
`egress` none/safe-fetch/host-mediated/host-owned + `auth.scopes` — the **class
taxonomy the rules are written over**), ADR 0132 (per-conversation capability scope —
the firewall is a *fourth-and-a-half* AND-term right after it), ADR 0102 (per-tool
`permissions.read/write`), ADR 0036 (`permissions.never`), ADR 0075 (HITL approval —
the suspend path), ADR 0031 (the `run.metadata` resolve-stamp + replay-on-fork
invariant), `host/agentDispatch.ts:835+` (the existing per-call gate chain).
**RFC verdict:** **host-extension — NO new RFC.** The firewall is a host-internal
decision stage over **already-advertised** tool metadata (RFC 0078, Accepted) and the
RFC 0064 hook seam (Accepted); it only ever *narrows* (deny / require-approval), never
grants. No run-event field, capability flag, event type, endpoint contract, or
normative MUST. The resolved rule set is stamped in non-normative `run.metadata`.

> **Origin.** `openwop_ai_chat_innovation_strategy.md` §3/§4 "Capability Firewall" — the
> doc's strongest genuinely-novel idea (the codebase fact-check confirmed nothing does
> composition-aware risk; ADR 0132/0102 gate *individual* tools only). The insight: risk
> emerges from **combinations** — *read a drive* + *send an email* is exfiltration even
> though each tool alone is permitted.

---

## Context — boundaries audit first (MANDATORY)

The naïve build is "a new risk engine that wraps tool calls." That would fork the
authorization path. There are already **four** AND-terms per tool call in the one loop
owner (`runChatToolLoop`): §A14 allowlist (`agentDispatch.ts:877`), ADR 0132
conversation scope (`:892`), ADR 0102 per-tool permissions (`:920`), arg validation.
The firewall is a **fifth term** — the only one that is *stateful across the run* (it
reasons over the *set* of tools/data classes seen so far), not per-call-in-isolation.

| Concern | Existing owner (file:line) | How the firewall reuses it |
|---|---|---|
| Per-call gate chain | `host/agentDispatch.ts` `runChatToolLoop` (§A14 → ADR 0132 scope → ADR 0102 perms) | The firewall evaluates **after** those, over the run's accumulated capability set. Never replaces them; ANDs in. |
| Tool class taxonomy | RFC 0078 `ToolDescriptor.safetyTier` + `.egress` + `.auth.scopes` (`routes/toolCatalog.ts`) | Rules are written over **classes** (`read` + `egress:host-mediated`), not brittle tool-id pairs, so a rule covers every tool in the class. |
| Suspend-for-approval | the conversation approval-request seam (ADR 0132 Phase 3 `approvalLedger` + the `interrupt.approval` card) | A `require-approval` firewall verdict reuses that exact deferral path — no second approval surface. |
| Hard deny + recording | `agent.toolReturned{status:'forbidden'}` (RFC 0064) | A blocked combination records the existing forbidden verdict (replay reuses it verbatim). |
| Decision stamp | `run.metadata` (the `computeRouteStamp`/`computeCapabilityScopeStamp` precedent, `conversationExchange.ts:86`) | The resolved rule set is stamped at run creation, read verbatim on `:fork`. |

**Net new (bounded):** a per-tenant `CapabilityRuleSet` store, a **pure** composition
evaluator (`evaluateComposition(seenClasses, nextTool, rules) → verdict`), a small
"capability set so far" accumulator threaded through `runChatToolLoop`, the
`run.metadata.capabilityFirewall` stamp, REST to manage rules, and an FE rule manager +
risk panel. **No new tool taxonomy, no second approval store, no forked tool loop.**

---

## CRITICAL design point — composition state + replay (ADR 0031)

The firewall verdict depends on a **variable that influences the run**: which capability
*classes* the run has already exercised. Two invariants:

1. **The rule set is resolved + stamped once** at run creation (`run.metadata.capabilityFirewall`),
   read verbatim on `:fork` — an admin editing rules mid-run (or after) never changes a
   forked run's behavior (the ADR 0031 freeze; matches ADR 0130/0132).
2. **The "capability set so far" is reconstructed from the recorded event log, not a
   live in-memory tally** — on replay/`:fork` the accumulator is rebuilt from the
   recorded `agent.toolCalled` events, so the same combination triggers the same verdict
   deterministically. Per-call verdicts are themselves recorded (`forbidden` /
   approval interrupt), so pure replay reads them and never re-evaluates.

---

## Decision

Add an optional, per-tenant **Capability Firewall**: an ordered `CapabilityRuleSet`
evaluated — **inside `runChatToolLoop`, after the ADR 0132/0102 gates** — against the
*combination* of capability classes the run has exercised plus the tool about to run. A
matching rule yields **allow / require-approval / deny** (v1; `sandbox` defers to the
code-exec adapter, `redact` to a later data-egress capability). It only ever narrows.

### Data model — rules over capability classes

```ts
CapabilityRuleSet                         // per-tenant, opt-in
  { tenantId, enabled, rules: CapabilityRule[], updatedBy, updatedAt }

CapabilityRule
  { id, description,
    when: {                               // a combination is risky when ALL hold
      anyOf?: CapabilityClass[],          // a class already exercised this run …
      with?: CapabilityClass[],           // … AND the tool about to run is in this class
      sameDataTaint?: boolean,            // (P2) the egress tool would carry data a
                                          //      prior `read` tool sourced (data-flow)
    },
    verdict: 'deny' | 'require-approval',
    reason }                              // human-readable, surfaced in the card/log

CapabilityClass =                         // projected from the RFC 0078 ToolDescriptor
  | { safetyTier: 'read'|'write'|'exec' }
  | { egress: 'safe-fetch'|'host-mediated'|'host-owned' }
  | { scope: string }                     // e.g. 'workspace:write'

// stamped at run creation; read verbatim on :fork
run.metadata.capabilityFirewall = { rules: CapabilityRule[], resolvedAt }
```

Seed rule (the origin example): *`read` (or `egress` inbound) seen, then a tool with
`egress:host-mediated`/`host-owned` → require-approval* ("data left a read context and
is about to leave the host").

### The evaluation stage (pure selector + a thin loop hook)

`evaluateComposition(seenClasses, nextToolClasses, rules) → CapabilityVerdict` (pure,
fully unit-testable). In `runChatToolLoop`, only when the feature is ON: maintain
`seenClasses` (folded from each executed tool's descriptor); before executing a call,
run the evaluator; `deny` → `agent.toolReturned{forbidden, reason}`; `require-approval`
→ the ADR 0132 Phase-3 deferral. OFF ⇒ the loop is byte-identical.

### RBAC & isolation

Managing the rule set = `workspace:write` (admin AI-config scope), tenant-scoped,
uniform-404 IDOR. Rules name capability **classes**, never sensitive resource names, so
the UI can't leak resources (the doc's own risk note).

---

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (0001) | `features/capability-firewall/` — rule store + pure evaluator + the `runChatToolLoop` hook + REST + FE. features→core only; the tool loop stays the one gate owner. |
| 2 | Toggle + admin UI | `capability-firewall`, OFF, `bucketUnit:'tenant'`; rule manager in the AI-config admin. |
| 3 | Workflow surface (0014) | None new in v1 (it governs the interactive loop; heartbeat governance stays ADR 0105). A read-only `ctx` is deferred. |
| 4 | Node pack | None. |
| 5 | AI-chat envelopes | None — transparent to the model; a blocked/approval combination surfaces as the existing forbidden/approval card. |
| 6 | Agent pack | None — composition policy is a tenant governance concern, not a named-agent one ([[agent-capability-core-not-named]]). |
| 7 | Public surface | None. |
| 8 | RBAC + isolation (0006) | `workspace:write` to manage; rules over classes (no resource leak); tenant IDOR-404; fail-closed (deny on evaluator error). |
| 9 | Replay / fork safety | Rule set stamped at creation, read verbatim on `:fork`; the capability-set accumulator rebuilt from recorded `agent.toolCalled` events; per-call verdicts recorded (ADR 0031 + ADR 0089 §Q4). |
| 10 | Frontend | A `FirewallRuleManager` (class-combination rules) + a per-run `CapabilityRiskPanel` showing which combination triggered a block/approval; `ui/` tokens, a11y, light+dark. |

---

## Phased plan

1. **The pure evaluator.** `evaluateComposition` + the `CapabilityRule`/`CapabilityClass`
   types + class projection from a `ToolDescriptor`. Unit-tested (the read+egress seed,
   class-prefix matching, deny vs require-approval, empty rules → allow). No loop change.
2. **The loop hook + stamp.** Thread `seenClasses` through `runChatToolLoop`; evaluate
   before execute (ON only); stamp `run.metadata.capabilityFirewall`. Test: a forked run
   reads the stamp; the read+egress combination defers to approval; replay reuses the
   recorded verdict.
3. **Rule store + REST + RBAC.** `CapabilityRuleSet` (`DurableCollection`),
   `/v1/host/openwop-app/capability-firewall/*` CRUD, `workspace:write`, IDOR-404.
4. **Frontend.** Rule manager + per-run risk panel; `/ux-review`.
5. **(Deferred) data-flow taint (`sameDataTaint`) + `sandbox`/`redact` verdicts** — taint
   tracks which `read` sourced the data an `egress` tool carries; `sandbox` composes the
   code-exec adapter; `redact` composes a future data-egress capability.

## Alternatives weighed

1. **A standalone risk engine wrapping the loop.** Rejected — forks the one authorization
   path; the firewall is a *term* in `runChatToolLoop`, stateful across the run.
2. **Rules over tool-id pairs.** Rejected — brittle and unmaintainable; rules over RFC
   0078 *classes* (safetyTier/egress) cover whole categories and survive new tools.
3. **Live in-memory capability tally.** Rejected for the replay path — the accumulator is
   rebuilt from recorded `agent.toolCalled` events so `:fork` is deterministic.
4. **Fold into ADR 0132 (capability scope).** Rejected — 0132 is per-*tool* narrowing set
   by the conversation owner; the firewall is per-*combination* risk set by a tenant
   admin. Distinct authors, distinct grain; they AND together.

## Open questions

1. **OQ-1 — Plan-time vs live-only.** Evaluate only live (per the recorded-turn model,
   proposed) or also pre-screen a declared plan when one exists? Lean: live-only v1;
   plan-time when the agent emits a structured plan.
2. **OQ-2 — Data-flow taint cost.** `sameDataTaint` needs per-read provenance; defer to
   P5 (the high-value but heavier half).
3. **OQ-3 — Relationship to the Intent Ledger (ADR 0136).** The ledger is *per-mission
   authored* bounds; the firewall is *tenant-global risk* rules. Both AND into the loop;
   confirm the evaluation order (ledger forbidden → 0132 scope → 0102 perms → firewall).

## RFC verdict (Step 5)

**Host-extension — NO new RFC.** A host-internal composition-risk stage over
already-advertised RFC 0078 tool metadata + the RFC 0064 hook seam; narrows only (never
widens the advertised tool surface), stamps its decision in non-normative
`run.metadata`. No wire field/event/capability/endpoint/MUST added.
