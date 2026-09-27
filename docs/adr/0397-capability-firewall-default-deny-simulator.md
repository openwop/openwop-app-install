# ADR 0397 — Capability-firewall depth: default-deny mode + policy simulator + decision observability

**Status:** implemented — all 5 phases landed (see §Implementation log)
**Date:** 2026-07-17
**Lane:** host governance depth — extends ADR 0135 (`features/capability-firewall/`). No new feature-package, no OpenWOP wire change.
**RFC verdict:** **host-extension — NO new RFC** (see §RFC verdict; the firewall is not advertised on `/.well-known/openwop` and this ADR adds no wire vocabulary).

> **Origin.** `docs/steward/MYNDHYVE-GAP-ANALYSIS.md` governance rows: line 54 (`Policies: default-deny mode + simulator on capability-firewall | M | governance`), line 351 (`Policies engine … PARTIAL | capability-firewall has effects (types.ts:69) but default-allow/no-op (ADR 0135:17), org-scoped, no simulator | Add default-deny mode + simulator — M`), and the decision-§5 summary at line 392. MyndHyve advertises a "policies engine (allow/deny/require-approval, default-deny, simulator)"; openwop-app has the *stronger enforcement primitive* (composition-aware, replay-safe, fail-closed rule store) but ships **default-allow** and has **no simulator or decisions view**. This ADR closes those three gaps without forking the one authorization path.

---

## Context — boundaries audit first (MANDATORY, with file:line)

Everything this ADR needs already exists; the work is three bounded additions over the ADR 0135 machinery. The load-bearing facts, verified against the code:

| Fact (claimed in the gap analysis) | Verified at | Note |
|---|---|---|
| The firewall's effects are `allow`/`deny`/`require-approval` | `features/capability-firewall/types.ts:68-72` (`CapabilityVerdict.decision`) | The gap-analysis "types.ts:69" points here. |
| It is **default-allow / no-op** today | `docs/adr/0135-capability-firewall.md:17` (graduation note: "ships **rule-less** by default … a no-op until an admin adds rules"); `firewallHook.ts:28-30` (`defaultCapabilityRules()` returns `[]`); `compositionEvaluator.ts:85` (no rule matches ⇒ `{ decision: 'allow' }`); `conversationToolLoop.ts:441-452` (the loop skips building the hook when a tenant has no rules) | Confirmed at four sites. The default posture is allow: an unmatched action always proceeds. |
| The evaluator is a **pure** function | `compositionEvaluator.ts:53` (`evaluateComposition`, no I/O, no clock) | The simulator can call it directly with zero side effects. |
| Per-tenant rule store + fail-closed validation | `ruleStore.ts:25` (`DurableCollection('capability-firewall:rules')`), `:61` (`validateRules`), `:102` (`getCapabilityRules` default-when-unset), `:111` (`getUnknownToolPolicy` default `treat-as-risky` = fail-closed) | The mode flag rides this same `StoredRuleSet`. |
| RBAC on rule management | `routes.ts:34` (`workspace:read`), `:42` (`workspace:write`), `:51-58` (audit via `hostExtStorage().appendAudit`, action `capability-firewall.rules.set`) | Org-admin scope; the simulate + mode routes reuse it. |
| The loop AND-term + verdict application | `agentDispatch.ts:1015-1042` (firewall evaluated after §A14 → ADR 0132 scope → ADR 0102 perms; `deny` → forbidden message, `require-approval` → deferred) | The default-deny fallback plugs into this same site. |
| `require-approval` rides the **existing** HITL ledger | `agentDispatch.ts:1027-1032` + `conversationToolLoop.ts:492-496` (`recordToolApprovalRequested`) + the ADR 0132 Phase-3 `interrupt.approval` card | No second approval surface — the middle tier is already wired for rule-driven approvals. |
| Replay/fork stamp | `firewallHook.ts:133` (`computeFirewallStamp` → `run.metadata.capabilityFirewall`); ADR 0135 §CRITICAL (seen-set rebuilt from recorded `agent.toolCalled` events) | The mode joins this stamp so a fork reproduces the same posture (ADR 0031). |
| A unified decision-log seam **already exists** and `firewall` is already a kind | `host/governanceDecisionLog.ts:10` (`GovernanceDecisionKind = … \| 'firewall' \| …`), `:25` (`recordGovernanceDecision`), `:56` (`listGovernanceDecisions`); the CDP feature already exposes a view at `features/cdp/routes.ts:176` (`GET /v1/host/openwop-app/cdp/governance-decisions`) | **But the firewall does NOT compose it today** — `agentDispatch.ts:1021/1027` only `log.info('capability_firewall_blocked', …)`. Decision observability = wire the existing seam in, not build a new one. |
| The rules editor FE exists | `frontend/react/src/features/capability-firewall/FirewallRulesPage.tsx` + `firewallClient.ts` | The mode selector, simulator panel, and decisions view extend this page. |

### The bypass-lane reality (capability-enumeration completeness — REQUIRED analysis)

The firewall governs **one lane**: the chat/agent tool loop (`runChatToolLoop`, `agentDispatch.ts`). It does **not** see workflow-DAG node execution or direct host adapters — verified:

- `host/adsAdapter.ts:270` — "node `ctx.ads` calls **BYPASS the capability-firewall**, which only sees chat/agent" calls.
- `features/commerce/commerceService.ts:103` — same note for commerce node calls.
- `host/governanceService.ts:59,72` — governance thresholds exist "because direct node calls bypass the capability-firewall."
- `FEATURES.md:171` (Strategy) — "the firewall can't see node calls, so the gate lives in the owner."

That non-chat lane is governed **separately and already**: per-tenant `GovernancePolicy` thresholds (`host/governanceService.ts`), `core.approvalGate` HITL nodes, and — for network egress specifically — the **ADR 0187 application-layer egress firewall** (`host/egressPolicy.ts`, `host/brokeredEgress.ts`, `host/smtpEgress.ts`), plus the `adapterOnly` provider marking that forces a vendor write through its governed adapter instead of generic `http.fetch` (see memory [[governed-vendor-write-adapteronly]]).

Two consequences this ADR must state honestly:

1. **Default-deny is scoped to the chat/tool-loop lane.** Turning on default-deny does **not** deny node-path egress; that lane keeps its own governance. Claiming otherwise would be a dishonest security posture. The long-term "single policy-enforcement-point across both lanes" is out of scope (§Open questions OQ-4).
2. **Within the chat lane, default-deny is *strictly more complete* than default-allow.** Today's default-allow requires an admin to enumerate *every* risky class as a deny rule — and the classification table (`toolCapabilityResolver.ts:19-35`) is prefix-based and admittedly partial, so an un-enumerated egress class (e.g. an agent POSTing via `core.openwop.http` classed `egress:'safe-fetch'`, not `host-mediated`) slips a `host-mediated`-keyed exfil rule. Default-deny **inverts the burden**: anything not explicitly allow-listed is denied, so the un-enumerated case fails closed. The completeness obligation flips from "enumerate all bad" (unbounded, leaky) to "allow-list all good" (bounded, reviewable) — and the existing `unknownToolPolicy: 'treat-as-risky'` default (`ruleStore.ts:111`) already makes an *unclassified* tool participate as write+egress, so it too is denied under default-deny. The residual risk becomes **availability, not exfiltration**: a benign tool the classification table misses gets mis-denied. That is exactly what shadow mode (below) exists to surface before enforcement.

---

## Decision

Add three composing capabilities to `features/capability-firewall/`, all riding the existing `StoredRuleSet` + pure evaluator + loop hook:

**(a) An opt-in DEFAULT-DENY mode, staged.** A per-org `mode` on the rule set with three states, and a `defaultDenyVerdict` middle-tier control:

```ts
// added to StoredRuleSet (ruleStore.ts) — additive, default preserves today's behavior
mode: 'default-allow' | 'shadow' | 'enforce';   // default 'default-allow' (today)
defaultDenyVerdict: 'deny' | 'require-approval'; // the posture for an UNMATCHED action under deny modes
```

- `default-allow` — **today's behavior, unchanged.** Ordered rules, first match wins, no match ⇒ allow. Rule-less tenants stay a true no-op (the loop still skips the hook).
- `shadow` — evaluate as if default-deny, **compute** the would-be verdict for every unmatched action, **record it to the decision log** with a `shadow: true` / `wouldBlock` flag, but **apply `allow`** (the call proceeds). This is the **headline migration path**: run deny-by-default in log-only mode, review the would-deny stream in the simulator/decisions UI, build the allow-list of legitimate exceptions, then flip to enforce.
- `enforce` — apply default-deny: an unmatched action resolves to `defaultDenyVerdict` (`deny`, or `require-approval` for the human-gated middle tier).

To carve exceptions under deny modes, the rule `verdict` union gains **`'allow'`** (an explicit allow-list rule; meaningful only in `shadow`/`enforce`, a harmless no-op in `default-allow`). An `allow` rule short-circuits first-match to allow; deny/require-approval rules match as today; **no match ⇒ `defaultDenyVerdict`** (in `enforce`) or logged-would-block-then-allow (in `shadow`).

**(b) A policy SIMULATOR** — evaluate a hypothetical action against the current policy set with **no side effects**, returning the decision, the matched rule, and a per-rule trace. Both an admin UI panel and a service API so agents/CI can pre-flight before acting.

**(c) Decision observability** — compose the *existing* `recordGovernanceDecision({ kind: 'firewall', … })` at the verdict site (it is not wired today), and add a tenant-scoped `listGovernanceDecisions` view filtered to `kind: 'firewall'` — a recent-decisions log with matched-rule attribution, mirroring the CDP view at `features/cdp/routes.ts:176`.

### Rule-match explanation model

The hot-path `evaluateComposition` stays allocation-light (returns the verdict only). The simulator and decision-log attribution use a sibling **`explainComposition(seen, next, rules, mode) → { decision, matchedRuleId?, matchedClause?, fellThroughToDefault: boolean, trace: RuleTrace[] }`**, where each `RuleTrace` row is `{ ruleId, predicateKind: 'presence'|'countAtLeast'|'expression', matched: boolean, why: string }`. `why` names the concrete reason ("`seen` contains `safetyTier:read` and `next` is `egress:host-mediated`"; or "fell through — no rule matched, default-deny ⇒ `require-approval`"). `explainComposition` calls the same predicate helpers as `evaluateComposition` (one truth for matching); it is pure, so it is identical whether invoked live (for the decision-log `detail`) or from the simulator.

### Simulator API contract (pure, side-effect-free, admin-gated)

```
POST /v1/host/openwop-app/capability-firewall/orgs/:orgId/simulate     (workspace:read)
  body:  {
    seen?:  (CapabilityClass | { toolName: string })[],   // prior calls this turn (classes or resolvable tool names)
    next:    CapabilityClass | { toolName: string },       // the action under test
    context?: { permissionMode?: 'safe'|'bypass', unknownToolPolicy?: 'skip'|'treat-as-risky' },
    modeOverride?: 'default-allow'|'shadow'|'enforce'       // "what WOULD enforce do?" without switching the org
  }
  200:   {
    decision: 'allow'|'deny'|'require-approval',
    mode: 'default-allow'|'shadow'|'enforce',               // effective mode used
    matchedRuleId?: string, matchedClause?: string,
    fellThroughToDefault: boolean,
    trace: RuleTrace[],
    platformBaseline?: RuleTrace[]                           // superadmin rules that also applied (read-only, §RBAC)
  }
```

Invariants: it **reads no run and writes nothing** (no decision-log entry, no store mutation) — it re-runs `explainComposition` against the tenant's *current* stored rules + mode (or `modeOverride`). `workspace:read` (not write) — it is a pre-flight/read op. The same computation is exported as a pure service function `simulateFirewall(tenantId, action, opts)` so CI and in-process callers pre-flight without HTTP. `modeOverride` is what makes it a *planning* tool: an admin in `default-allow` can ask "what would `enforce` decide for this action?" before committing.

### `require-approval` middle tier — HITL wiring, timeout/fallback semantics

A `require-approval` verdict (whether from a rule or from `defaultDenyVerdict` under deny modes) rides the **existing** ADR 0132 Phase-3 path unchanged: `agentDispatch.ts:1027-1032` records the pending approval, the agent is told it is awaiting review and instructed not to retry, and `conversationToolLoop.ts:492-496` writes the `interrupt.approval` card. **Fallback semantics (fail-closed):** an approval that is never resolved stays **pending indefinitely** — there is no auto-timeout that flips it to allow (that would be fail-open and is explicitly rejected). On replay/fork the recorded pending/resolved decision is read verbatim (never re-evaluated). Under `bypass` permission mode, a `require-approval` is downgraded to allow exactly as today (`firewallHook.ts:123`), but a hard `deny` — including a `defaultDenyVerdict: 'deny'` fall-through — is **never** downgraded (`firewallHook.ts:112` invariant preserved).

### Fail-closed ON THE FIREWALL ITSELF

Today the evaluator is pure and effectively cannot throw; the resolve/classification path can (a malformed persisted expression, a resolver error). The rule: **in `enforce` mode a firewall evaluation error MUST deny** (`{ decision: 'deny', reason: 'firewall evaluation error' }`), logged as a `firewall`/`deny` decision. In `default-allow` and `shadow`, an evaluation error preserves today's non-blocking behavior (allow, logged) so an internal fault never turns a non-enforcing tenant's chat into a wall of denials. The loop hook wraps `evaluate` in a try/catch keyed on the effective mode.

---

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (0001) | **Extends** `features/capability-firewall/` — mode flag on the existing `ruleStore`, `explainComposition` beside `evaluateComposition`, `simulate` + `governance-decisions` routes, FE panels on the existing `FirewallRulesPage`. No new package; `features → core` only; the tool loop stays the one gate owner. |
| 2 | Toggle / admin UI | **No new toggle — a per-org MODE FLAG, not a compiled toggle.** Justified: the firewall is already always-on (toggle retired, ADR 0135:17); a feature toggle is a compiled on/off, whereas `mode` is *stored governance state* with three values that must be per-tenant, replay-stamped, and default-preserving (`default-allow`). It rides `StoredRuleSet`, edited in the existing rules admin. Adding a toggle would wrongly imply the firewall can be switched off. |
| 3 | Workflow / `ctx` surface | **No `ctx`/node tool day-1.** A `firewall.simulate` agent read tool (pre-flight before acting) is plausible but deliberately deferred: it would need pack-allowlisting into the ADR 0315 baseline and is not required — CI/agents pre-flight via the HTTP `simulate` route + the exported `simulateFirewall` service function. Revisit if an agent genuinely needs in-turn self-pre-flight (§OQ-3). |
| 4 | Node pack | **None.** Governance posture is a tenant admin concern, not a named workflow capability (matches ADR 0135 row 4). |
| 5 | AI-chat envelopes | **None.** Transparent to the model: a default-deny block surfaces as the *existing* forbidden message / approval card (ADR 0135 row 5). No new envelope kind — a new kind would require an OpenWOP RFC, and none is warranted. |
| 6 | Agent pack | **None** (composition/deny policy is tenant governance, not a named-agent trait — [[agent-capability-core-not-named]]). |
| 7 | Public surface | **None.** Admin + service only. |
| 8 | RBAC + isolation (0006) | **Org-admin** (`workspace:write`) manages rules + `mode` + `defaultDenyVerdict`; **`workspace:read`** runs the simulator + reads the decisions view; tenant-scoped, uniform-404 IDOR (unchanged from `routes.ts`). **Superadmin platform-baseline rules** (new): a platform-level rule set that ANDs *under* tenant rules (most-restrictive-wins — a tenant cannot weaken a platform deny), surfaced read-only in the tenant simulator trace for honesty (`OPENWOP_SUPERADMIN_TENANTS` env-gated, per [[prod-superadmin-mechanism]]). **Fail-closed on the firewall itself:** an eval error denies in `enforce` (see above). A mode change audits like a rule change (`capability-firewall.rules.set` precedent, `routes.ts:51`). |
| 9 | Replay / fork safety (0031) | The **mode** joins the resolved stamp: `run.metadata.capabilityFirewall = { rules, mode, defaultDenyVerdict, platformRules?, resolvedAt }`. Per-call verdicts stay recorded (`agent.toolReturned{forbidden}` / approval interrupt); the seen-set + counts rebuild from recorded `agent.toolCalled` events (ADR 0135 §CRITICAL) so `explainComposition` reproduces the same attribution deterministically. **Shadow decisions** are recorded to the (non-replayed) governance decision log, not to run events — they never influence run outcome, so they add no replay surface. **⟶ Correction (implementation, 2026-07-17):** the drafted claim that "a run stamped `enforce` reproduces enforce on fork even if the admin later reverts" is **not** how the chat loop works. The stamp is written but **never read** to drive evaluation — `conversationToolLoop` re-resolves rules + mode **live** from the store each turn, exactly like the `capabilityScope` precedent (`computeCapabilityScopeStamp` is also record-only). So the firewall stamp is **provenance/audit**, not the fork evaluation input; a fork re-resolves the *current* posture. The P3 stamp change therefore exists to keep run metadata **honest** (a deny-mode or platform-governed run is recorded as governed even with an empty allow-list), not to pin fork behavior. Pinning fork behavior to the stamp would be a behavior change to the established re-resolve pattern and is out of scope (would apply equally to `capabilityScope`). |
| 10 | Frontend | **Rules editor already exists** (`FirewallRulesPage.tsx`, verified). Add: a **mode selector** (default-allow / shadow / enforce + `defaultDenyVerdict`) with a clear "shadow = log-only, nothing is blocked" affordance; a **simulator panel** (pick seen classes/tools + a next action → decision + rule trace, with a `modeOverride` "what would enforce do?" control); a **decisions log view** (recent `kind:firewall` decisions, matched-rule attribution, shadow/enforced badge) composing `listGovernanceDecisions`. `ui/` tokens, a11y, light+dark, 4-locale i18n parity ([[frontend-feature-ui-gotchas]]). |

---

## Phased plan

1. **Decision observability (ship first, lowest risk).** Compose `recordGovernanceDecision({ kind:'firewall', outcome, reason, detail:{ ruleId, decision } })` at the `agentDispatch.ts:1021/1027` verdict sites (best-effort, never breaks the turn). Add `listGovernanceDecisions(tenantId, { kind:'firewall' })` + `GET …/capability-firewall/orgs/:orgId/decisions` (`workspace:read`) + the FE decisions view. Delivers value on today's default-allow tenants immediately and is the prerequisite for reviewing shadow output. Tests: a deny/approve records one decision; the view is tenant-filtered.
2. **`explainComposition` + simulator API + UI.** The pure trace function (exhaustively unit-tested against every predicate kind) + `POST …/simulate` (`workspace:read`, no side effects) + the `simulateFirewall` service export + the FE simulator panel. Tests: simulate matches live `evaluateComposition` verdicts for the same input; `modeOverride: 'enforce'` reports fall-through; no store/decision-log mutation occurs.
3. **Mode flag + shadow mode.** Add `mode` + `defaultDenyVerdict` to `StoredRuleSet` + validation (default `default-allow`); the `'allow'` rule verdict; the evaluator no-match fallback + the shadow post-process (compute + log `wouldBlock`, apply allow); stamp `mode` in `run.metadata`; the FE mode selector. Shadow is safe to GA — it never blocks. Tests: shadow logs would-deny but the call proceeds; the stamp carries the mode; a fork reproduces the stamped mode.
4. **`require-approval` middle tier under deny modes.** Wire `defaultDenyVerdict: 'require-approval'` fall-through into the existing HITL ledger; confirm the fail-closed timeout semantics (never auto-grants) and the `bypass` downgrade rules. Tests: an unmatched action under `enforce` + `require-approval` defers to the approval card; an unresolved approval stays pending on replay; `bypass` downgrades approval but not a hard deny.
5. **Enforce mode GA + platform baseline.** Allow flipping to `enforce`; the fail-closed eval-error→deny wrap keyed on mode; superadmin platform-baseline rules (AND under tenant rules, shown read-only in the simulator trace); docs + the FEATURES/ROADMAP sync. Tests: enforce denies an unmatched action; an eval error denies in enforce but allows in default-allow/shadow; a platform deny cannot be weakened by a tenant allow rule.

---

## Implementation log

| Phase | Status | Where | Notes |
|---|---|---|---|
| 1 — Decision observability | ✅ landed | `host/governanceDecisionLog.ts` (`kind` filter), `host/agentDispatch.ts` (`onFirewallDecision` injected callback), `host/conversationToolLoop.ts` (tenant-capturing closure → `recordGovernanceDecision`), `features/capability-firewall/routes.ts` (`GET …/decisions`), FE `FirewallRulesPage.tsx` + `firewallClient.ts` + i18n×4 | **Seam refinement (architect):** the recorder is NOT called inside the pure sync `evaluate`, nor is a raw `tenantId` plumbed into the hot loop. Instead `agentDispatch` calls an **injected `onFirewallDecision` callback** (symmetric with `firewall.evaluate`/`onEvent`), and the host closure in `conversationToolLoop` captures `run.tenantId` and fire-and-forgets the record — so the dispatch loop stays feature-free AND record-free. A `require-approval` verdict maps to `outcome:'deny'` (the call did NOT proceed this turn); `detail.decision` carries the true tri-state. Tests: `host/__tests__/governanceDecisionLogKind.test.ts` (kind filter + tenant isolation), FE decisions-view render + empty-state. |
| 2 — Simulator | ✅ landed | `compositionEvaluator.ts` (`explainComposition` + shared `matchRule`), `simulator.ts` (`simulateFirewall`), `routes.ts` (`POST …/simulate`, `workspace:read`), FE `SimulatorPanel` on `FirewallRulesPage.tsx` + client + i18n×4 | **One matching truth:** refactored `evaluateComposition` to route through a shared `matchRule`, and `explainComposition` reuses it — so a simulated verdict provably equals the live verdict (fuzzed across every predicate kind). `explainComposition` accepts `mode` + `defaultDenyVerdict` (forward-compatible with P3) so the simulator can preview `enforce` fall-through today. Simulator resolves tool NAMES through the same classification + `unknownToolPolicy` fallback the loop uses, and writes NOTHING (no decision-log entry — test-pinned). Tests: `explainComposition.test.ts` (parity + trace + first-match-supersede), `simulator.test.ts` (name resolution, risky fallback, modeOverride, no side effects). |
| 3 — Mode flag + shadow | ✅ landed | `types.ts` (`FirewallMode`, `'allow'` verdict), `ruleStore.ts` (mode/defaultDenyVerdict + validators + getters), `firewallHook.ts` (deny-mode fallback + per-turn shadow dedup + stamp fix), `conversationToolLoop.ts` (resolve posture, build hook under a deny mode even rule-less/bypass, shadow → governance log), `routes.ts` (GET/PUT posture), FE mode selector + `'allow'` verdict + i18n×4 | **Hazard resolved + honesty correction (see §9 note):** the stamp is now written whenever `mode !== 'default-allow'` (or a platform floor exists) even with an EMPTY allow-list, so an enforce run isn't misrepresented as ungoverned. IMPORTANT: the stamp records **provenance** and does NOT itself drive fork evaluation — evaluation re-resolves the posture live from the store, exactly like the `capabilityScope` precedent. `verdict:'allow'` (with a ruleId) carves an exception; a fall-through (allow, no ruleId) resolves to the mode default. Shadow logs a would-block (deduped per turn, OQ-1) via the governance log and applies allow. Tests: `firewallModes.test.ts`. |
| 4 — require-approval tier | ✅ landed | (delivered by P3's `defaultDenyVerdict` + the existing HITL path in `agentDispatch.ts`) | A `defaultDenyVerdict:'require-approval'` fall-through IS a `require-approval` verdict and rides the **unchanged** ADR 0132 HITL branch (pending approval + `interrupt.approval` card); no agentDispatch change needed. Fail-closed: an unresolved approval stays pending (no auto-grant); `bypass` downgrades a fall-through require-approval but NEVER a hard deny. Tests: `firewallModes.test.ts` (bypass rules) + `host/__tests__/firewallLoopIntegration.test.ts` (loop: require-approval → pendingApproval + observability record; allow → executes, no record). |
| 5 — Enforce GA + platform baseline | ✅ landed | `firewallHook.ts` (most-restrictive `platformRules` combine + fail-closed eval-error wrap keyed on mode), `ruleStore.ts` (`get/setPlatformRules` singleton), `simulator.ts` (`platformBaseline` trace + floor in effective decision), `routes.ts` (superadmin `GET/PUT …/platform/rules`), FE simulator platform-baseline panel + i18n; FEATURES/ROADMAP synced | Enforce enforcement landed in P3; P5 adds the fail-closed wrap (enforce eval-error ⇒ deny; else preserve non-blocking) and the superadmin **platform baseline** — a global floor that ANDs *under* tenant rules (most-restrictive-wins; a tenant `allow` can't weaken a platform `deny`), surfaced read-only in the simulator trace and joined to the provenance stamp. Tests: `firewallModes.test.ts` (floor + fail-closed) + `simulator.test.ts` (platform trace). |

### Grade-pass hardening (2026-07-17, post-implementation `/grade-code` + `/grade-data`)

The platform-floor evaluation was reworked to close correctness/security gaps the grade pass found:

- **Floor is mode-independent + not droppable by a tenant's `skip` policy.** The platform floor is now evaluated FIRST, in its OWN fail-closed try/catch (a floor eval-error denies regardless of the tenant's mode), and resolves an unclassified `next` with the risky fallback — so a `skip`-policy tenant can't slip an unclassified tool past the operator's floor. A platform `deny` short-circuits (never bypassed, never shadowed).
- **Shadow honesty under a floor.** A shadow would-block is recorded ONLY when the call ultimately proceeds (final `allow`), so the decisions log never shows a call as "ran (shadow)" that the platform floor actually blocked.
- **Simulator mirrors the live shape.** `simulateFirewall` now reproduces the live unclassified-`skip` short-circuit (rules skipped, mode fall-through still applies) and the mode-independent risky-fallback floor — closing a sim≠live divergence where an `anyOf`-only rule fired in the simulator but not live. The "provably equals" claim was softened accordingly.
- **Partial-PUT posture preservation.** A `PUT …/rules` that OMITS `mode`/`defaultDenyVerdict` now PRESERVES the stored posture (never silently de-escalates an active `enforce`/`shadow` to `default-allow`) — the fail-safe default, matching the fail-closed `unknownToolPolicy` omit-default.
- **Provenance leak tightened.** The run-metadata stamp records `platformRuleCount` (a count) instead of the verbatim superadmin rule bodies — `run.metadata` is tenant-readable and the global policy content stays operator-only.

New tests pin each: platform floor on an unclassified-`skip` next, platform eval-error deny for a `default-allow` tenant, shadow-record suppression under a platform deny, and sim==live for the unclassified-`skip` short-circuit.

**OQ-6 (deferred, pre-existing) — decisions-view window starvation.** `listGovernanceDecisions` over-reads `limit×4` from the GLOBAL audit stream then tenant-filters in memory (never leaks cross-tenant, but a sparse tenant can under-return its own recent rows as global volume grows — OQ-1's volume concern). This is the existing shared helper the CDP view also uses; a tenant/kind-partitioned or indexed audit query is the fix, out of scope for this ADR.

---

## Alternatives weighed

1. **Embed OPA/Rego (or another general policy engine).** Rejected. Honest trade: OPA gives a richer expression language and an ecosystem — real value for a large, evolving policy fact-set. But the firewall's fact-set is *tiny and fixed* (seen classes, counts, the next tool's classes), ADR 0135 P6 already ships a bounded, side-effect-free native expression predicate with fail-closed save-time validation, and the whole security argument of that design is a *closed grammar over fixed facts* (`compositionEvaluator.ts` + `expressionEvaluator.ts`). Embedding Rego means a new WASM/eval runtime, a second policy language operators must learn, and a materially larger security surface — the opposite of the auditability default-deny is meant to buy. Default-deny is a *mode over the existing evaluator*, not a new engine.
2. **Per-feature ad-hoc guards (status quo for the node lane).** Not rejected wholesale — *correctly scoped*. The node/workflow lane's `GovernancePolicy` thresholds + `core.approvalGate` + ADR 0187 egress policy are the right model *for that lane* precisely because the firewall can't see node calls. This ADR does **not** absorb them; it deepens the chat-lane firewall and explicitly leaves the node lane to its own (already default-deny-capable) governance. The two lanes are complementary, not redundant.
3. **A second default-deny store / parallel decision engine.** Rejected — it forks the one authorization path (ADR 0135's own rejected alternative #1). Mode + `explainComposition` are additions *to* the existing evaluator and store, not beside them.

---

## Open questions

1. **OQ-1 — Shadow-mode log volume.** Under default-deny, *every* unmatched chat tool call in a shadow tenant emits a would-block decision — potentially every call. Recommend deduping by `(tenantId, ruleId|‹fallthrough›, classKey)` within a run (or sampling) so the decisions log stays reviewable; decide the dedup grain in Phase 1 when the log view lands.
2. **OQ-2 — Batch / corpus pre-flight.** The simulator evaluates a single hypothetical action. Reviewing a proposed `enforce` config against *recent real runs* (replay each run's recorded seen-set through the new mode and diff) is higher-value for a go/no-go decision but needs per-run seen-set reconstruction. Recommend single-action simulator in v1; batch replay-review deferred until an operator asks.
3. **OQ-3 — In-turn agent self-pre-flight.** Should an agent get a `firewall.simulate` read tool to check itself before attempting a risky combination (turning a hard block into a graceful self-route)? Deferred (matrix row 3). If pursued, it is pack-allowlisted, never added to the ADR 0315 default-on baseline, and must fail EMPTY without an acting user (the registerFeatureAgentTool access-predicate rule).
4. **OQ-4 — Unified cross-lane policy-enforcement-point.** True deny-by-default across *both* the chat lane and the node/adapter lane would require routing node execution and direct adapters through one PEP that also consults the firewall rules. That is a large refactor (every `ctx.*` adapter + the DAG executor) and would merge two governance models that today are deliberately separate. Flagged as the real long-term shape; explicitly out of scope here. This ADR's default-deny is chat-lane-scoped and says so.
5. **OQ-5 — Classification-table completeness under deny.** Default-deny converts a missing `toolCapabilityResolver.ts` entry from a *security hole* (default-allow) into an *availability* risk (a benign tool mis-denied). Shadow mode is the mitigation (surface mis-denies before enforcing), but consider a "classification coverage" report in the simulator UI listing agent tools that resolve to `null` for a tenant about to enforce.

---

## RFC verdict (Step 5)

**Host-extension — NO new RFC.** Confirmed against the wire surface:

- The capability firewall is **not advertised** on `/.well-known/openwop` (`routes/discovery.ts:97` `buildAdvertisement` carries no firewall/governance capability). Default-deny is a host-internal decision *posture* over already-advertised RFC 0078 tool metadata + the RFC 0064 hook seam; it only ever **narrows** (deny / require-approval / allow-list), never widens the advertised tool surface. So there is no capability-handshake interaction to declare — a consumer's view of the host's advertised capabilities is unchanged.
- No new run-event field, event type, capability flag, endpoint *contract*, or normative MUST. The resolved posture rides non-normative `run.metadata.capabilityFirewall` (adding one `mode` field to an existing non-wire object). The `simulate` and `decisions` routes are host-extension routes under `/v1/host/openwop-app/*` — non-normative by construction, never touching the wire (CLAUDE.md host-extension rule).
- The `require-approval` middle tier rides the ADR 0132 approval seam, itself already host-internal.

If a future phase ever wanted to *advertise* "this host enforces deny-by-default" as a discoverable capability (e.g. for a client to reason about), *that* would be a wire change needing an OpenWOP RFC — but nothing here does, and the simulator/decisions/mode work is entirely host governance.
