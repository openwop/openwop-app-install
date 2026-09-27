# Agent governance (A13) — chat-first port review

Unit scope: `backend/typescript/src/features/{intent-ledger, ambient-work-graph,
capability-firewall, computer-use}` + their frontend surfaces. Context: ADR 0136
(intent ledger), 0137 (ambient work graph), 0135/0397 (capability firewall,
MyndHyve port), 0418 (computer-use browser agents).

**Headline:** This is a *governance meta-layer* over the engine, and it already
rides the primitives almost everywhere — the firewall ANDs inside the one live
tool loop, the intent ledger projects onto the ADR 0132 capability scope with a
single enforcement path, computer-use ships a chat-driven Browser Operator agent
whose commit-tier halts ride `core.approvalGate`, and the work graph hands
accepted patterns to the *existing* chat workflow-author. The review finds **one**
genuine chat-first port (mission-contract drafting hides a managed-LLM call behind
a bespoke modal button) and a handful of honesty/adapter watch-items. No THEATER.

---

## Verdict table

| # | Capability | Today | Verdict | Port target |
|---|---|---|---|---|
| 1 | Enforce approved mission contract (scope projection + stamp + relative-TTL expiry) | `ledgerToScope` folded into loop scope, replay-safe stamp | **RIDES** | none — projects onto ADR 0132, one enforcement path (`conversationToolLoop.ts:413-427`) |
| 2 | `openwop:intent-ledger.get` agent read tool | `registerFeatureAgentTool`, mirrors route authz, fails structured | **RIDES** | none — reference-grade read tool (`agentTools.ts:24-73`) |
| 3 | Draft mission from a user-supplied goal (form) | bespoke modal → `POST …/draft` → validate | **ADAPTER** | leave; watch — thin over `validateLedgerInput` (`routes.ts:97-99`) |
| 4 | Draft mission **from the conversation** ("Draft from conversation" button) | modal button → REST → `llmExtractLedger` → `dispatchManagedChat` | **PARALLEL** | governance agent tool `intent-ledger.propose` driven through the one chat; keep modal for review only |
| 5 | Approve / Reject / Revoke the contract | bespoke button pair in modal + `POST …/approve\|reject` | **PAGE-LEGIT** | keep (pre-flight config approval, owner-gated); watch — could reconcile to the shared decision record |
| 6 | Authored-vs-completed reckoning | read-only projection over stamped runs + tool events | **PAGE-LEGIT** | keep; honesty already correct (criteria marked `needs-review`) |
| 7 | Work-pattern suggestions list | read-only projection over the run store | **PAGE-LEGIT** | keep |
| 8 | Refresh / scan (bounded sweep) | `POST …/refresh` → `sweepTenant` | **PAGE-LEGIT** | keep (recompute-on-read, kept off GET) |
| 9 | Accept suggestion → workflow | returns `draftSeed`, FE navigates to the existing chat workflow-author | **RIDES** | none — "no second author" (`ambient-work-graph/routes.ts:58-72`) |
| 10 | Dismiss suggestion | status persist, never resurrected by re-sweep | **PAGE-LEGIT** | keep (`suggestionStore.ts:29-36`) |
| 11 | Background mining daemon | own `setInterval.unref` + per-(tenant,hour) idempotency claim, env-gated | **ADAPTER** | leave; watch — clones the knowledge-sync cadence rather than instantiating the schedules owner |
| 12 | Dashboard "Suggested automations" tile | projection over work-graph suggestions | **PAGE-LEGIT** | keep |
| 13 | Firewall live enforcement (composition-aware) | injected `evaluate` ANDs under ADR 0132/0102 inside the loop | **RIDES** | none — agentDispatch stays feature-free (`conversationToolLoop.ts:464-483`) |
| 14 | Rule manager (list/PUT rules, mode, unknown-tool policy) | admin page + `requireTenantScope` write, fail-closed validation | **PAGE-LEGIT** | keep (governance config; correctly tenant-authority, vuln-scan H3) |
| 15 | Firewall decisions view | read-only over the unified governance decision log | **PAGE-LEGIT** | keep; shadow would-blocks flagged honestly (`routes.ts:159-166`) |
| 16 | Policy simulator (pre-flight, side-effect-free) | `POST …/simulate` mirrors live evaluation truth | **PAGE-LEGIT** | keep (planning tool; mirrors `matchRule`) |
| 17 | Superadmin platform baseline (global floor) | superadmin-only, most-restrictive-wins, tighten-only | **PAGE-LEGIT** | keep (`ruleStore.ts:181-190`) |
| 18 | Firewall `require-approval` → human decision | downgraded/deferred through the existing `interrupt.approval` card + approvals ledger | **RIDES** | none — shared HITL machinery (`conversationToolLoop.ts:465,533`) |
| 19 | Browser Operator agent (chat-driven computer-use) | pure agent pack over the existing chat + node pack | **RIDES** | none — "no new chat surface" (`feature.computer-use.agents/pack.json`) |
| 20 | `task` / `decide` / `status` nodes | existing node catalog, `role:action`, over `ctx.features['computer-use']` | **RIDES** | none |
| 21 | Commit-tier HITL (submit/download/new-origin/credential) | compose `core.approvalGate` → `decide`; session halts `awaiting_approval` | **RIDES** | none — shared gate primitive (`computerUseService.ts:214-253`) |
| 22 | Session trajectory read routes | `GET …/sessions[/:id]`, `workspace:read` | **PAGE-LEGIT** | keep; **no FE consumer today** (see Deferred) |
| 23 | Provider adapter | mock-only; real provider ⇒ typed `capability_not_provided` | **ADAPTER** | leave — honest-off by construction (`feature.ts:32-44`) |
| 24 | Budget / step-ceiling / fail-closed origin allowlist | server-side CAS budget + `MAX_STEPS` + https allowlist | **RIDES** | none |

**Counts: RIDES = 9, ADAPTER = 3, PARALLEL = 1, THEATER = 0, PAGE-LEGIT = 11.**

---

## Blockers (from scouting) — each with the honest alternative

- **B1 — There is no governance/mission agent, only a read tool.** The only
  agent-facing surface is `openwop:intent-ledger.get` (read). Drafting/proposing a
  contract has **no** action tool, so "let the agent propose a mission" is not
  chat-drivable today. *Alternative:* add one thin action tool
  (`intent-ledger.propose`) that shares `requireOwner` and returns a **draft only**
  (never auto-approve — the store already refuses that, `ledgerStore.ts:56-59`);
  the human still approves in the modal. This is the cheapest way to satisfy law #1
  without a second chat.

- **B2 — The mission extractor is a real second model-call path.**
  `llmExtractLedger` (`ledgerExtractor.ts:73-88`) calls `dispatchManagedChat`
  directly from a REST handler behind the "Draft from conversation" button
  (`routes.ts:108`, `IntentLedgerModal.tsx:88`). It is bounded and defensive (like
  `memoryExtractor`), but it is exactly "a form that hides a model call behind a
  button" (law #1). *Alternative:* keep the pure parser (`parseLedgerDraft`) and
  the ceiling-intersection; move the *invocation* to the chat agent so the draft is
  authored in-conversation and the modal renders the result for approval. The pure
  parts are reusable verbatim.

- **B3 — computer-use trajectory has backend reads but no surface.** ADR 0418 P3
  claims a "trajectory surface"; the read routes exist (`computer-use/routes.ts`)
  but no frontend consumes them (`grep` across `frontend/react/src` = none). Not a
  lie — the toggle is OFF and the agent narrates the trajectory in chat — but the
  P3 "surface" is unrealized. *Alternative:* defer visibly (below); when the
  feature graduates, the trajectory is a PAGE-LEGIT read, not a new chat surface.

- **B4 — The mining daemon is a parallel cadence mechanism.**
  `startWorkGraphDaemon` (`workGraphSweep.ts:72-85`) is its own `setInterval`, not
  a registration with the schedules/heartbeat owner. It is an *accepted* clone of
  the knowledge-sync daemon and is stateless recompute, so it is defensible — but
  it is a second cadence path. *Alternative:* if the heartbeat/schedules owner ever
  grows a "recurring maintenance sweep" seam, fold this into it; until then, leave
  and note the drift.

---

## Demolition list (with the regression pins to add)

The unit is mostly correctly-shaped, so demolition is small and **gated on the
replacement working**:

- After B1/B2 land: **the "Draft from conversation" button** in
  `IntentLedgerModal.tsx:88` and the `draftLedgerFromConversation` client path
  (`intentLedgerClient.ts:62`) become redundant with the agent tool.
  - *Regression pin:* a test asserting the modal exposes **no** conversation-scraping
    draft action once the agent tool ships (a resurrected button fails the suite);
    and a test that `llmExtractLedger` is invoked only from the agent tool path, not
    a REST handler.
- **Do NOT demolish** the approve/reject/revoke buttons (row 5), the reckoning view
  (row 6), the rule manager (row 14), the simulator (row 16), or any read page —
  these are PAGE-LEGIT config/provenance surfaces.

---

## New-code inventory (small)

1. `intent-ledger/agentTools.ts` — add `intent-ledger.propose` (action tool):
   shares `requireOwner`'s predicate, calls the existing `parseLedgerDraft` +
   `intersectCeiling`, writes a `status:'draft'` row via `saveLedger`. Typed
   failure on validation; never approves.
2. (Optional) a **Governance agent pack** persona ("Mission Steward") whose
   allowlist is `{ intent-ledger.get, intent-ledger.propose }` — activated via
   `agentProfile`, per the "capability at core, not a named agent" law.
3. Two regression pins (above).
4. Nothing else — no new store, node, envelope, or chat surface.

Everything else in the unit is already the small, correct shape a port would aim
for.

---

## Phased plan (gated on real gates)

- **Phase 1 — add the action tool (compliance seam first).** Ship
  `intent-ledger.propose` sharing the route predicate; the modal still works
  unchanged. Gate: backend vitest + `promptCatalogParity`/`agent-prompt-tool-ids`
  drift tests green. Close with `/code-review`.
- **Phase 2 — route drafting through chat.** Point the "author a mission" affordance
  at the chat (deep-link the one chat scoped to the governance agent, per the
  `EmbeddedChatPanel`/`?agent=` precedent); keep the modal for review/approve/
  reckoning. Gate: `npm run ci` + `/ux-review` on the modal's reduced surface.
- **Phase 3 — demolish + pin.** Remove the conversation-scrape button + client path
  once Phase 2 is verified live; add the regression pins. Gate: full `npm run ci`.
- **Phase 4 (deferred, feature-gated) — computer-use trajectory page** when ADR 0418
  graduates from OFF: a read-only trajectory page over the existing session routes
  (PAGE-LEGIT), no new chat surface.

Each phase closes with `/code-review` + `/ux-review` and fixes applied; nothing is
demolished before its replacement is proven.

---

## Deferred honestly

- **computer-use provider** is mock-only; a real hosted-browser provider needs
  operator BYOK + brokered egress and lands typed as `capability_not_provided`
  until then (`feature.ts:38-44`). Correct honest-off — not theater.
- **computer-use trajectory FE** unbuilt (toggle OFF); reads exist server-side
  (B3). Deferred-visibly, not painted green.
- **Reckoning success-criteria** are prose marked `needs-review` — an LLM/human
  judge is an explicit follow-on (`ledgerReckoning.ts:6-8`). The `withinMandate`
  flag is documented as a gate-blocked-attempt **proxy**, not a verdict
  (`ledgerReckoning.ts:22-29`). Both honest.
- **Mining daemon cadence** (B4) left as an accepted clone; folding into a shared
  scheduler seam is deferred until that seam exists.
