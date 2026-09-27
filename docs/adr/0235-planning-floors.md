# ADR 0235 — Planning floors: scenarios, investment/capacity, hierarchy lens, import

Status: implemented (2026-07-03; D1 scenario FE is API + node + chat-drivable v1 — the PM-page scenario UI rides a follow-on; portfolio parent-grouping visual likewise, rows already carry parentStrategyId)

> **Correction (2026-07-03, follow-on batch):** the two deferred FE tails now shipped.
> The PM-page scenario UI is `ScenarioPanel.tsx` (add/select/compare, above/below-line
> chips, one human plan-of-record, agent-PROPOSED scenarios badged+inert; the
> strategy-coverage overlay is FE-composition over `strategyRefs`, honoring the ADR 0079
> import direction — PM never imports strategy). Portfolio parent-grouping is the
> "part of {parent}" chip on strategy cards/rows. Scenario add/select now route through
> the STRAT-PM2 CAS writer (`mutateSessionRow`) so concurrent edits can't clobber the
> scenarios array.

Date: 2026-07-03
Relates to: ADR 0058 (planning sessions), ADR 0232 (idea intake — `estimatedValue` feeds scenario budgets), ADR 0234 (session rationale), ADR 0079 (strategy; the PM↛strategy import rule), ADR 0231 (health signals), docs/research/strategy-gap-analysis.md (Phase D; §6 non-goals fence off Planview-class scope)

## D1 — Scenario floor (PM planning sessions)

- `PlanningSession.scenarios?: SessionScenario[]` (ON the session row — the
  aggregate root; cap 8; concurrent adds are read-modify-write like existing
  session updates, accepted): `{ scenarioId, name, constraints: { maxItems?,
  maxBudget? }, selection: {mode: 'top-n', n} | {mode: 'manual', cardIds},
  proposedBy?: 'agent', planOfRecord?: true, createdBy, createdAt }`.
- **Resolution AT READ**: a scenario resolves against the CURRENT ranking +
  intake `estimatedValue` (ADR 0232) — `aboveLine`/`belowLine` card lists with
  the binding constraint named. Nothing resolved is stored.
- Routes: `POST /lists/:listId/sessions/:sessionId/scenarios` ·
  `GET …/scenarios` (resolved) · `GET …/scenarios/compare?a&b` (idea
  movements between two scenarios) · `POST …/scenarios/:scenarioId/select`
  (marks `planOfRecord` on ONE scenario, emits + audits). **Architect ruling
  Q1:** select is plain emit+audit — the activation gate exists for
  authority-granting transitions; a plan-of-record mark executes nothing. The
  approval seam composes later in `selectScenario` if that changes.
- **Architect correction (import direction):** strategy-coverage annotation
  ("this scenario drops ideas linked to strategy X") is **FE-composition**
  over the `strategyRefs` map the PM page already fetches — the compare
  endpoint returns idea movements ONLY (PM never imports strategy).
- AI arm: a `propose-scenario` node verb writes a scenario stamped
  `proposedBy:'agent'` — inert until a human selects (inherently
  proposal-safe; no firewall reliance — the ADR 0231 lesson).

## D2 — Investment/capacity floor

- Additive `plan` on `StrategyInitiative`: `{ budgetAmount?, budgetCurrency?,
  capacityPoints?, actualAmount?, actualPoints? }` (numbers validated finite
  ≥0; currency a short code label, no FX).
- `StrategyHealthSignals` gains read-time sums: `budgetPlanned`,
  `budgetActual`, `capacityPlanned`, `capacityActual` (initiatives with a plan
  block only; mixed currencies sum numerically with the FIRST currency
  labeled — a floor, honestly documented).
- Scenario `maxBudget` (D1) reads idea intake `estimatedValue` at the PM
  level. Explicitly NOT here (non-goals): cost plans, rate cards, fiscal
  calendars, ERP reconciliation.

## D3 — Hierarchy lens + import

- `Strategy.parentStrategyId?` — ONE level. **Write-time (architect Q2):**
  parent must exist, share the child's `orgId`, not itself have a parent, not
  be self. **Read-time:** rows carry the ref verbatim; grouping renders a
  child UNGROUPED when the parent is archived/unreadable (the STRAT-2 silent
  drop posture). Archiving a parent never mutates children. Health/portfolio
  rows carry `parentStrategyId` for FE grouping.
- `POST /strategy/:id/import-objectives`: CSV text
  (`objective,keyResult,target,unit` — header optional), server-side split
  parser (the `campaign-connectors/csvImport.ts` posture, no new deps),
  appends within the existing objective/KR caps, write-gated, revisioned +
  audited like any content PATCH. Draft-from-document AI stays chat-drivable
  via the Analyst (recorded deferral).

Host-ext only; no new toggles; **no new RFC**.
