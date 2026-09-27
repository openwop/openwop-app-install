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

---

## Phase 5 (Proposed, 2026-07-01) — Fan-out / spawn-rate guardrail

**Origin:** a 2026-07-01 competitive feature-gap analysis — comparable agent-orchestrators ship an explicit per-turn sub-agent dispatch cap (e.g. `spawn_bounds.max_dispatches_per_turn: 5`) plus a purpose guard restricting what a sub-agent dispatch may be *for* (`implement`/`review`/`explore`/`search`). openwop-app's equivalent mechanism, `backend/typescript/src/subruns/subRunDispatcher.ts` (`dispatchSubRun`, invoked from the chat tool loop when an LLM tool call targets a saved workflow), has **no cap of either kind today** — an unbounded chat turn can invoke it an arbitrary number of times, each spinning up a full nested `/v1/runs` execution. This is a genuine, previously-unflagged resource/cost-exhaustion gap: a real risk of the same shape ADR 0135 exists to close (composition/volume risk that individual per-call gates don't see), so it extends this ADR rather than starting a parallel mechanism.

> **Correction note (2026-07-01, at implementation).** The "chat-loop `dispatchSubRun` fan-out" premise above did **not** match the code when Phase 5 was built. `dispatchSubRun` is a **`core.subWorkflow` DAG-node mechanism**, not a chat-tool-loop path: it is invoked from workflow-graph execution and is already bounded by the RFC 0118 `maxConcurrency` cap. The chat tool loop (`runChatToolLoop`) is separately bounded by the RFC 0058 `maxToolRounds` limit and exposes **no workflow-as-tool / fan-out-classed agent tool** — so there was no unbounded chat-loop fan-out call site to cap, and no tool the resolver could classify as `fan-out` today. The mechanism was therefore **retargeted** to what is genuinely missing: (1) a general composition-**VOLUME** predicate, `when.countAtLeast` (the evaluator previously tested class *presence* only, never *count*), usable over **any** class; (2) a **reserved** `{ kind: 'fan-out' }` capability class (defined + validated + round-tripping, so it is ready the day a fan-out-classed tool exists) — **not** wired to any live tool and **not** seeded as an always-on default rule; and (3) a **recommended** (one-click, not default-on) count rule — 3+ off-host sends in one turn ⇒ require-approval — instead of the originally-proposed seeded `max_dispatches_per_turn` default. The original Phase 5 text below is retained unchanged for the reasoning trail; the "seed a **default** rule" step (§Decision / phased-plan step 3) is superseded by this recommended-not-default approach, keeping the firewall rule-less/no-op by default per the Graduation note.

### Boundaries audit

| Concern | Existing owner (file:line) | How this reuses it |
|---|---|---|
| Per-call gate chain | `host/agentDispatch.ts` `runChatToolLoop` — §A14 allowlist → ADR 0132 scope → ADR 0102 perms → **this ADR's composition evaluator** | The spawn-rate check is a **sixth AND-term**, evaluated in the same loop, after the existing composition evaluator — it is stateful across the run exactly like the Phase 1–4 evaluator, just counting instead of set-membership testing. |
| Sub-run dispatch call site | `subruns/subRunDispatcher.ts:97` (`dispatchSubRun`) — the only place a workflow-as-tool invocation happens | No change to the dispatcher itself; the count is tracked at the **call site in `runChatToolLoop`**, the same place `seenClasses` is already threaded (Phase 2). |
| Capability class taxonomy | RFC 0078 `ToolDescriptor` classes (`safetyTier`/`egress`/`auth.scopes`) — the existing `CapabilityClass` union | Add **one** new class shape, `{ kind: 'fan-out' }`, assigned to any tool whose invocation resolves to `dispatchSubRun` (i.e. a `core.subWorkflow`/workflow-as-tool call) — reuses the existing class-projection mechanism (`toolCapabilityResolver`), not a new taxonomy. |
| Decision stamp + replay | `run.metadata.capabilityFirewall` (Phase 2) + the recorded-event-log reconstruction invariant | The running dispatch **count** is reconstructed from recorded `agent.toolCalled` events on replay/`:fork`, identically to how `seenClasses` is already rebuilt — no new replay mechanism. |
| Deny + recording | `agent.toolReturned{status:'forbidden'}` (RFC 0064, reused by Phase 2) | A spawn-rate violation records the **existing** forbidden verdict; no new event type. |

**Net new (small):** one new `CapabilityClass` variant (`fan-out`), one new rule predicate shape (`when.countAtLeast`, below — the existing evaluator only tests class *presence*, not *count*, so this is a genuine small addition to the rule DSL, not a parallel system), a per-turn counter threaded alongside the existing `seenClasses` accumulator, and one seeded default rule. No new feature-package, no new toggle (the firewall is already always-on per the Graduation note above), no new store beyond the existing `CapabilityRuleSet`.

### Decision

Extend `CapabilityRule.when` with an optional **count-based** predicate, distinct from the existing presence-based `anyOf`/`with`:

```ts
CapabilityRule.when.countAtLeast?: {
  class: CapabilityClass;        // e.g. { kind: 'fan-out' }
  threshold: number;             // e.g. 5
  window: 'turn' | 'run';        // 'turn' matches the per-turn cap semantics; 'run' is the wider option
}
```

Seed a **default** rule (present out of the box, unlike the existing seed which is documentation-only): `{ when: { countAtLeast: { class: { kind: 'fan-out' }, threshold: 5, window: 'turn' } }, verdict: 'deny', reason: 'sub-run fan-out limit exceeded for this turn' }` — mirroring the common `max_dispatches_per_turn: 5` default, but tenant-editable via the existing rule manager (an admin can raise/lower/disable it, since the firewall ships rule-less/no-op by default per the Graduation note — this phase makes the *fan-out* rule the one exception with a shipped default, given it is a cost/DoS backstop rather than a discretionary governance choice).

**Purpose-allowlisting (a per-dispatch purpose guard) is explicitly deferred**, not built in this phase: it requires workflows to declare a "purpose" tag (`implement`/`review`/`explore`/`search`-equivalent) that does not exist in the current workflow data model, which is a materially larger addition (workflow-authoring surface + tag taxonomy) than a count-based guardrail on an existing call site. See Open questions below.

### RFC verdict (reaffirmed, unchanged from ADR 0135 baseline)

**Host-extension — NO new RFC.** This phase adds a counting predicate to an already host-internal, narrows-only decision stage (the baseline ADR's own verdict); it introduces no run-event field, capability flag, event type, endpoint contract, or normative MUST. The `fan-out` class is derived host-side from the existing RFC 0078 `ToolDescriptor` classification of the `dispatchSubRun` call site — no new wire vocabulary.

### Phased plan (this addendum only)

1. **`fan-out` class + counter.** Classify the sub-run/workflow-as-tool call site as `{kind:'fan-out'}` in `toolCapabilityResolver`; thread a per-turn count alongside `seenClasses` in `runChatToolLoop`. Tests: count increments only on sub-run dispatch, resets per turn (not per run) when `window:'turn'`.
2. **`countAtLeast` predicate in the evaluator.** Extend `evaluateComposition` (pure, unit-tested) to check count-based rules alongside the existing presence-based ones. Tests: threshold exactly-at vs over, `window:'turn'` vs `'run'` semantics, empty/disabled rule → allow (unchanged default posture for every OTHER rule class).
3. **Seed the default fan-out rule.** Ship the rule described above as a tenant's default-when-unset row (extending the existing `getCapabilityRules` default-when-unset behavior from Phase 3) — the one deliberate exception to "rule-less by default," justified as a cost/DoS backstop rather than a discretionary policy choice.
4. **Replay reconstruction.** Confirm the per-turn count reconstructs from recorded `agent.toolCalled` events identically to `seenClasses` (Phase 2's existing invariant) — no new test infrastructure, just extending the existing replay-determinism test to cover the counter.
5. **Frontend.** Surface the fan-out rule in the existing `FirewallRulesPage` rule manager (a `countAtLeast` row alongside `anyOf`/`with` rows) — no new page.

### Open questions (this addendum)

1. **OQ-5a — Purpose-allowlisting scope.** Deferred per §Decision above. If pursued later: does "purpose" become a required field on workflow authoring (a breaking-ish UX change to the builder) or an optional tag defaulting to "unclassified" (fail-open, weaker guarantee)? Recommend optional-tag-with-fail-open as the v1 shape if this phase is picked up, consistent with the firewall's own "unknown→skip" default posture for unclassified tools (Phase 3 note).
2. **OQ-5b — `window:'run'` cost.** A `run`-scoped count requires reconstructing the counter across the *entire* recorded event log, not just the current turn — confirm this is bounded (event logs aren't unbounded in practice, but a very long-running agent loop could make this non-trivial). Recommend shipping `window:'turn'` only in phase 1 of this addendum; defer `'run'` until a concrete need appears.
3. **OQ-5c — Interaction with sub-run's own nested firewall.** A dispatched sub-run is itself a full run through `runChatToolLoop` (if it drives its own chat/tool loop) — does the child run's fan-out count reset independently (correct, since it's a different run/tenant-scoped turn) or should a *global* per-parent-run cap also exist to bound total fan-out depth across a whole delegation tree? Recommend: independent per-run counts for this phase (matches the per-turn, not global, semantics); a cross-run depth cap is a distinct, larger concern (recursion-limit territory, cf. `openwop` `RFCS/` cross-cut CC-1 `recursionLimit` invariant) and should not be conflated with this addendum.

---

## Phase 6 (Proposed, 2026-07-01) — Bounded expression predicate (declarative-DSL gap, narrowed)

**Origin:** a competitive feature-gap analysis originally framed as "openwop-app needs a CEL-like declarative policy DSL, since comparable tools expose CEL for operator-authored guardrails." **That framing was too broad and is partially corrected here** (per the Scope Rule: don't manufacture work that isn't there):

- **The Capability Firewall (this ADR) already IS a declarative, tenant-editable rule store** — `CapabilityRuleSet` managed via REST + the `FirewallRulesPage` admin UI, no code change needed to add/edit a rule. The **actual** remaining gap is narrower: the rule predicate shape is a **fixed enum** (`anyOf`, `with`, `sameDataTaint`, `countAtLeast` as of Phase 5) rather than a general boolean-expression language, so an operator whose desired rule doesn't fit one of those shapes has no escape hatch short of a code change.
- **RBAC (ADR 0006) has NO declarative rule surface at all** — roles map to a fixed RFC 0049 scope vocabulary (owner/admin/editor/viewer per ADR 0015), with no per-tenant custom-rule authoring. Read in full for this evaluation. **Recommendation: do NOT build one.** A fixed, small role set is the appropriate, auditable model for a B2B workspace app; there is no evidenced operator pain point driving a request for custom RBAC rules, and a declarative authorization DSL is a well-known way to make an access-control system *harder* to audit and reason about (the opposite of RBAC's value proposition), not easier. Building this would be inventing work the Scope Rule says not to invent. **No ADR-0006 change is proposed.**

So this phase proposes exactly **one** bounded addition to the Capability Firewall's existing rule store: a general-purpose but deliberately **non-Turing-complete, side-effect-free** boolean-expression predicate, as an *additional* option alongside the four fixed shapes — not a replacement for them, and not a new policy engine.

### Boundaries audit

| Concern | Existing owner (file:line) | How this reuses it |
|---|---|---|
| Rule store + REST + FE | `CapabilityRuleSet` (Phase 3) + `/v1/host/openwop-app/capability-firewall/rules` + `FirewallRulesPage` (Phase 4) | The new predicate is **one more field** on the existing `CapabilityRule.when` union — same store, same REST, same admin UI (a new row type in the rule editor), not a parallel policy surface. |
| Pure evaluator | `evaluateComposition` (Phase 1, extended Phase 5) | The expression predicate is evaluated by the **same** pure, unit-tested evaluator function — one more `when.*` case in its match, not a second evaluation path. |
| Input facts | `CapabilityClass` projection (`toolCapabilityResolver`) + the `seenClasses`/count accumulators (Phases 2/5) | The expression evaluates over the **same** pre-computed fact set already available to the evaluator (which classes have been seen, current counts, the next tool's classes) — it does NOT gain access to anything the fixed predicates couldn't already see; it only lets an operator combine those same facts with arbitrary AND/OR/NOT instead of the fixed `anyOf`/`with` shapes. |
| Replay/fork determinism | The existing recorded-event-log reconstruction invariant (Phases 2/5) | Unaffected — the expression is pure over the same reconstructed fact set, so it replays deterministically for the same reason the fixed predicates do. |

**Net new (small):** one new `CapabilityRule.when.expression?: string` field, a tiny hand-rolled boolean-expression parser/evaluator (AND/OR/NOT/comparison over named boolean/numeric facts — deliberately **not** a general-purpose scripting language: no loops, no function calls, no external data access, mirroring CEL's own side-effect-free design goal but scoped even smaller since the fact set is fixed and small), and a validation step (reject unknown fact names / unparseable expressions at rule-save time, fail-closed).

### Decision

Add `CapabilityRule.when.expression?: string`, evaluated only when present (mutually exclusive with `anyOf`/`with`/`countAtLeast` on the same rule — a rule uses either the fixed shapes or the expression, not both, to avoid ambiguous precedence). The expression grammar is intentionally minimal:

```
expr    := term (('&&' | '||') term)*
term    := ['!'] fact [comparison literal]
fact    := 'seen.' <capabilityClassName> | 'count.' <capabilityClassName> | 'next.' <capabilityClassName>
```

e.g. `seen.read && next.egress:host-mediated` (equivalent to today's seed rule expressed as `anyOf`/`with`) or `count.fan-out >= 3 && seen.egress:host-owned` (a combination the fixed shapes cannot express today — count AND presence together). Parsing is a small hand-written recursive-descent evaluator over this closed grammar — **not** an embedded general scripting/expression library — to keep the security surface the same size as the existing evaluator (pure function, no I/O, no reflection, bounded grammar with no recursion beyond the fixed two-level structure above).

### RFC verdict (reaffirmed, unchanged from ADR 0135 baseline)

**Host-extension — NO new RFC.** Same reasoning as Phase 5: an additional predicate shape on an already host-internal, narrows-only decision stage. No wire vocabulary.

### Phased plan (this addendum only)

1. **Grammar + pure evaluator.** The parser/evaluator as a standalone, exhaustively unit-tested pure function (valid/invalid grammar, unknown-fact rejection, precedence, the two example expressions above). No loop/rule-store change yet.
2. **Rule-store integration.** Add the `expression` field to `CapabilityRule.when` (validated at save time — fail-closed on an unparseable expression or unknown fact name, matching the existing rule-store's fail-closed validation posture from Phase 3); wire into `evaluateComposition` as one more case.
3. **Frontend.** One new row type in `FirewallRulesPage`'s rule editor (a text input + inline validation error, alongside the existing fixed-shape row builders) — no new page.
4. **Documentation.** The fixed grammar (facts available, operators supported) documented in the rule manager's inline help — this is explicitly a small closed grammar, not "write any JavaScript," and the UI should say so to set correct operator expectations.

### Open questions (this addendum)

1. **OQ-6a — Grammar growth pressure.** Once operators can write `count.X >= N && seen.Y`, will real usage want arithmetic on counts, string matching on scope names, or time-of-day facts? Recommend: ship the minimal grammar above; only grow it in response to an actual operator request, not speculatively — the closed-grammar-over-fixed-facts design is a deliberate security boundary, and growing it casually erodes that boundary.
2. **OQ-6b — Relationship to `sameDataTaint`.** `sameDataTaint` (Phase 1, deferred to a later phase per the original ADR) is itself a fact that could become an expression-grammar boolean (`taint.matches`) once implemented — sequence this addendum's grammar design to anticipate that fact name without over-building for it now.
