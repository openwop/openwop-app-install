# D9 Field Sales — chat-first port review

**Scope (single-unit mode):** the four Sales-vertical feature packages —
`dealers` (ADR 0281), `territories` (ADR 0272), `sales-maps` (ADR 0282),
`sales-commissions` (ADR 0280). Backend `backend/typescript/src/features/{dealers,
territories,sales-maps,sales-commissions}`; frontend `frontend/react/src/features/*`;
packs `packs/feature.{dealers,territories,sales-commissions}.{nodes,agents}`.

**One-line verdict:** these four features are *architecturally correct on paper and
un-ignited in practice*. Every write is designed to ride a governed node behind an
approval-gated chain, and every advisory agent is correctly read-only — but **no
workflow, scheduler entry, or chat tool ever creates a run of any of it**, so the
governed writes are THEATER and the actual writes happen through bespoke page buttons
that PARALLEL the shared HITL/reviews machinery. The advisory *read* chat genuinely
rides the engine; the *decide* and *do* halves do not.

---

## Contract scouting (pinned evidence)

**What is declared vs what creates runs of it**

- Each feature ships a node pack with **governed WRITE nodes** explicitly documented
  to "ride a chain behind an approval gate (ADR 0208 §2)":
  - `packs/feature.dealers.nodes/pack.json` — `approve-registration` (`side-effectful`).
  - `packs/feature.territories.nodes/pack.json` — `activate-model`, `set-quota`.
  - `packs/feature.sales-commissions.nodes/pack.json` — `compute-statement`,
    `approve-statement`.
- **Nothing ignites them.** No `builtinWorkflows` on any of the four features
  (`backend/typescript/src/features/dealers/feature.ts:18`, `territories/feature.ts:25`,
  `sales-commissions/feature.ts:20`, `sales-maps/feature.ts:19` — grep for
  `builtinWorkflows` across all four = NONE). No `startWorkflowRun` caller in any
  feature. No workflow JSON/template anywhere references these node type-ids
  (`grep -rln feature.*.nodes --include=*.json` finds only the packs themselves).
  So the "approval-gated chain" the write nodes claim to ride **does not exist**.
- Node implementations are real and honest — `packs/feature.dealers.nodes/index.mjs`
  calls `ctx.features.dealers.*` and exports the named `nodes` map
  (`index.mjs:60-66`); same shape for territories/commissions. They would work *if
  something ran them*. Nothing does.

**Agent tool allowlists vs what the tools can do**

- All three agents are **advisory, read-only** — correct stance:
  - `feature.dealers.agents` Channel Manager — allowlist = `list-dealers`,
    `list-outlets`, `list-registrations` only (`pack.json`); prompt present
    (`prompts/channel-manager.md`).
  - `feature.territories.agents` Territory Planner — 7 read nodes; prompt present.
  - `feature.sales-commissions.agents` Commissions Analyst — `list-plans`,
    `list-statements`; prompt present.
- The agents' "tools" ARE the read nodes (the ADR 0058 chat-drivability pattern);
  there are **no `registerFeatureAgentTool` chat-time tools** in any of the four
  features (confirmed NONE). So the agents can *read and propose* in chat but the
  proposal has nowhere to land — see BLOCKER 2.

**Which owners each instantiates vs shadows**

- Workflow surfaces correctly instantiate the `ctx.features.*` owner and enforce the
  route's predicate against the run owner (fail-closed for system runs):
  `dealers/surface.ts:28-46`, `territories/surface.ts:39-79`,
  `sales-commissions/surface.ts:34-72`. This is a clean RIDES on the
  authority-parity axis.
- **HITL owner is SHADOWED.** Every human decision is a bespoke `<button>`:
  `DealersPage.tsx:260-264` (approve/reject registration),
  `CommissionsPage.tsx:339-341` (approve / mark-paid statement),
  `TerritoriesPage.tsx` activate/archive (client calls `activateModel` ×2,
  `archiveModel` ×2). None touch the shared approval/interrupt/reviews machinery —
  grep for `reviews|interrupt|approvalService|createGate` across the four backends =
  NONE. These duplicate the ADR 0198 approval machinery (delegation/OOO/anti-double-
  vote/durable decision record) with naked REST mutations.
- **Money owner:** `markStatementPaid` (`sales-commissions/entities/statement.ts:198-200`)
  flips status only — payout is "external/demo" (ADR 0280 §8). It correctly moves **no
  money in-host**, but records the payout as a bare row-status change **outside the
  obligation ledger (ADR 0447)** that kicktodo shares / affiliate commissions ride.

**Chassis constraints that bound the port**

- Packs auto-install via `requiredPacks` when the feature is composed
  (`features/index.distribution.ts:158,182`) — the agents ARE reachable in the one
  chat once toggled on (via the agents page / scoped deep-link). No new install
  plumbing needed.
- Gates live in the **parent** run; a commission "compute for all reps in a
  territory" is an array/subworkflow shape, so its HITL gate must sit in the parent,
  not the child (the ADR 0458-B1 opaque-child-interrupt lesson).
- No feature UI deep-links into the chat (`grep navigate('/?agent=' | EmbeddedChatPanel`
  across all four frontends = NONE) — the advisory agents exist but have no entry
  point from their own surface.

---

## Verdict table

| # | Capability | Today (file:line) | Verdict | Port target |
|---|---|---|---|---|
| 1 | Ask the network/coverage/comp advisor questions (3 agents) | read nodes over `ctx.features.*`, driven through the ONE chat (`*.agents/pack.json`) | **RIDES** | leave; add a deep-link from each page into the scoped agent |
| 2 | Dealer directory / outlets / registrations views | `DealersPage.tsx:126-272` | **PAGE-LEGIT** | keep |
| 3 | Territory model / hierarchy / rules / quotas / attainment views | `TerritoriesPage.tsx` (`listModels`, `listTerritories`, `listRules`, `getAttainment`) | **PAGE-LEGIT** | keep |
| 4 | Commission plans / statements views (subject-scoped) | `CommissionsPage.tsx:160-176, 312-349` | **PAGE-LEGIT** | keep |
| 5 | Sales-map choropleth + outlet pins | `SalesMapsPage.tsx:94-112`, `MapView.tsx` | **PAGE-LEGIT** | keep (read-only geo projection) |
| 6 | Partner portal (token mint + public deal-registration intake) | `dealers/routes.ts:120-174` | **PAGE-LEGIT** | keep (capability-token external surface) |
| 7 | Geocode address → point (BYOK, cached) | `sales-maps/routes.ts:26-33` | **ADAPTER** | leave; watch for drift |
| 8 | Structured admin authoring (create/edit dealer, outlet, plan, model, territory, rule, quota) | forms in all four pages | **PAGE-LEGIT** | keep as forms; but wire the *dispose* seam (BLOCKER 2) |
| 9 | Dealers governed-write nodes "ride an approval-gated chain" | `feature.dealers.nodes` (`approve-registration`) — no igniter | **THEATER** | ignite via a built-in workflow + chat tool, or stop claiming it |
| 10 | Territories governed-write nodes "ride a chain" | `feature.territories.nodes` (`activate-model`, `set-quota`) — no igniter | **THEATER** | ignite or stop claiming |
| 11 | Commissions governed-write nodes "ride a chain" | `feature.sales-commissions.nodes` (`compute-statement`, `approve-statement`) — no igniter | **THEATER** | ignite or stop claiming |
| 12 | Approve/reject deal registration (human decision) | `DealersPage.tsx:260-264` → `POST …/registrations/:id/approve` (`dealers/routes.ts:136-145`) | **PARALLEL** | reviews-inbox approval kind + inline interrupt card |
| 13 | Activate/archive territory model (org-wide blast radius) | `TerritoriesPage.tsx` activate/archive → `territories/routes.ts:112-142` | **PARALLEL** | reviews-inbox approval kind |
| 14 | Approve statement / mark paid (payout-affecting) | `CommissionsPage.tsx:339-341` → `sales-commissions/routes.ts:148-168` | **PARALLEL** | reviews-inbox approval kind + obligation-ledger entry (BLOCKER 4) |

**Counts:** RIDES 1 · ADAPTER 1 · PARALLEL 3 · THEATER 3 · PAGE-LEGIT 6.

---

## Blockers (from scouting) — each with the honest alternative

**BLOCKER 1 — No igniter exists for any governed write node.** The write nodes are
documented to "ride a chain behind an approval gate (ADR 0208 §2)", but there is no
`builtinWorkflows`, no `startWorkflowRun`, no `registerFeatureAgentTool`, and no
workflow template referencing the node type-ids. The chain is imaginary; the nodes are
catalog entries a user could theoretically drag into the builder and nothing more.
*Honest alternative:* ship one **built-in workflow per governed write**, assembled
from EXISTING nodes — the feature's own read node → structured-AI proposal (optional)
→ **shared HITL gate in the parent run** → the feature's own governed-write node — and
one **chat-time igniter tool** (allowlisted to the advisory agent) that calls
`startWorkflowRun` and emits the authoritative `workflow_run` turn. Until then, correct
the pack descriptions to stop advertising a chain that no run assembles.

**BLOCKER 2 — The advisory agents can propose but nothing can dispose.** The read-only
stance is correct (high-blast writes stay human-gated), and the design explicitly says
"proposes … a human disposes." But the only disposal path is the bespoke page buttons,
which live in a completely separate surface from the chat proposal. The propose→dispose
loop is broken. *Honest alternative:* the disposal is the HITL gate from BLOCKER 1 —
render it as an inline interrupt card in the same conversation + a reviews-inbox entry,
so the agent's proposal and the human's decision are one durable thread (the ADR 0459
plan-revision precedent: typed registered renderer for display + interrupt card for
capture).

**BLOCKER 3 — Human decisions are bespoke buttons, not the shared HITL/reviews
primitive.** approve/reject registration (`DealersPage.tsx:260-264`), activate/archive
model, approve/mark-paid statement (`CommissionsPage.tsx:339-341`) are naked
`<button onClick={REST}>`. No shared gate, no reviews-inbox record, none of the ADR 0198
delegation/OOO/anti-double-vote/durable-decision guarantees. *Honest alternative:*
model each as an approval kind that renders in the reviews inbox + inline; the existing
REST route (`…/approve`, `…/activate`) becomes the gate-resolution handler rather than
a standalone mutation, so both surfaces resolve through one durable decision.

**BLOCKER 4 (money) — mark-paid is a status flip outside the obligation ledger.**
`markStatementPaid` (`statement.ts:198-200`) flips draft→approved→paid; it moves no
money in-host (satisfies the money invariant) but records a payout as a plain row state,
not through the obligation ledger (ADR 0447). *Honest alternative:* on statement
*approve*, record the owed amount as an obligation-ledger entry (host never moves money;
the ledger is the durable owed-money SSoT); mark-paid settles that entry. Defer honestly
if out of scope — but do not grow a second money-state machine in the statement row.

**Constraint (chassis, not a defect):** the commission "compute for all reps" shape is an
array/subworkflow; its HITL gate MUST live in the parent run (child interrupts are
opaque — ADR 0458-B1).

---

## Demolition list (with regression pins)

- **`DealersPage.tsx:260-264`** approve/reject registration buttons → replaced by a
  reviews-inbox approval kind. *Pin:* a test asserting registration disposal creates a
  durable review/decision record and no bespoke decision `<button>` remains.
- **`CommissionsPage.tsx:339-341`** approve / mark-paid buttons → reviews inbox. *Pin:*
  statement approval leaves a reviews decision record + an obligation-ledger entry;
  mark-paid settles it.
- **`TerritoriesPage.tsx`** activate/archive model buttons → reviews-inbox approval
  (org-wide blast radius warrants a gate, not a click). *Pin:* activation resolves
  through a gate with a durable record.
- **Keep (do NOT demolish):** all read views (rows 2-5), the partner portal (row 6),
  the geocode seam (row 7), the CRUD authoring forms (row 8, page-legit), and the
  advisory agents (row 1, rides). Demolish decision buttons ONLY after the
  reviews-inbox replacement works.

---

## New-code inventory (small)

- **3 built-in workflows** (`dealers-registration-decision`, `territory-activation`,
  `commission-run`) assembled entirely from EXISTING nodes — each feature's own read +
  governed-write nodes + a shared HITL gate node. No new engine, no substantive pack
  logic.
- **1 chat-time igniter tool** (generic or per-feature) → `startWorkflowRun` + the
  authoritative `workflow_run` turn, allowlisted to the advisory agents. This is the
  missing "dispose" seam.
- **HITL reconcile:** wire each decision to the shared approval/reviews primitive
  (approval kinds + interrupt cards) — additive; no bespoke A2UI renderer (these are
  app-known, i18n-critical, trusted-producer cards → typed registered renderer +
  interrupt card, per the card-mechanism test).
- **Obligation-ledger entry** on statement approve/settle.
- **Deep-link** from each page header into its scoped agent (`navigate('/?agent=…')`).
- **Regression pins** per demolition target above.

---

## Phased plan (real gates; compliance-seam-first)

- **P0 — Honesty.** Correct the three node-pack descriptions to stop claiming an
  un-ignited "approval-gated chain"; mark it deferred-visibly. Nothing demolished.
  Gate: `npm run ci`.
- **P1 — HITL reconcile (BLOCKER 3).** Move the three decision surfaces onto the shared
  reviews/interrupt machinery; the REST routes become gate-resolution handlers; pages
  render the reviews inbox. Add regression pins. Close with `/code-review` + `/ux-review`,
  apply fixes.
- **P2 — Ignition (BLOCKERS 1+2).** Ship the three built-in workflows + the chat igniter
  tool so the advisory agent can propose → gate → governed-write end-to-end in the one
  chat. This retires the THEATER (rows 9-11). `/code-review` + `/ux-review`.
- **P3 — Money (BLOCKER 4).** Obligation-ledger entries for approved statements; mark-paid
  settles. `npm run ci` + `/grade-data`.
- **P4 — Demolish.** Remove the bespoke decision buttons once P1/P2 are proven; the
  regression pins keep them from resurrecting.

---

## Deferred honestly

- **Sales-maps geocoding pins beyond the P2 seam** and the territory→region mapping for
  ambiguous country names (ADR 0282 §8) — genuinely deferred upstream; keep visible, do
  not paint green.
- **Whether structured admin authoring (commission plans, territory models) should move
  into a chat-canvas** is a real open design choice, not a defect — a rate-rule /
  accelerator / hierarchy editor is legitimately form-shaped (philosophy #7). Defer with
  rationale; revisit only if the propose→dispose loop (P2) makes in-chat authoring the
  natural home.
- **Partner-portal deal-registration** stays an external capability-token surface — not a
  chat-first target (it is a public, unauthenticated partner intake, not an operator
  describing intent).
