# ADR 0234 — Timeline projection + scoring integrity

Status: implemented (2026-07-03; score-history FE surfacing rides the IdeaIntakePanel follow-on; session constraints deferred to D1 per §C7)

> **Correction (2026-07-03, follow-on batch):** the score-history FE surfacing now
> shipped — `IdeaIntakePanel.tsx` renders a `ScoreHistorySection` ("why-ranked"
> component breakdown, fail-soft: renders nothing on fetch error) via the new
> `getIdeaScoreHistory` client verb. Session constraints (maxItems/maxBudget) are now
> consumed by the D1 scenario builder (see ADR 0235 correction).

Date: 2026-07-03
Relates to: ADR 0079 (strategy), ADR 0058/0059 (PM scoring), ADR 0230 §B4 (score history rows), ADR 0103 (idea schedules), ADR 0054 (project milestones), docs/research/strategy-gap-analysis.md (Phase C6/C7)

## Context

E5 (D−): no roadmap/timeline rendering, no dependencies, no slip detection —
despite milestones, idea schedules, and horizons already being stored. E4's
residue (C7): score changes now have a trail (ADR 0230 B4) but nothing surfaces
it, and "why did this rank here" stays locked in `scoring.ts` math.

## Decision

### C6 — Timeline read-projection (NOT a Gantt engine)

- **Additive fields on `StrategyInitiative`**: `startDate?`, `endDate?`
  (strict `YYYY-MM-DD`), `dependsOn?: string[]` (same-strategy initiative ids;
  unknown ids are validation errors at write).
- **`GET /strategy/:id/timeline`** (read-gated like `GET /:id`) and
  **`GET /strategy/timeline`** (the caller's readable portfolio) — ONE
  projection computed at read over what already exists:
  - the strategy's initiatives (dates + status),
  - linked projects' charter milestones (title/dueDate/done),
  - linked priority ideas' schedules (targetDate/state, ADR 0103).
  Each item carries **slip flags computed at read**: `overdue` (due before
  today, not done/completed), `dependencyLate` (a `dependsOn` initiative whose
  `endDate` falls after this one's `startDate`). No scheduling solver, no
  auto-replanning, no baseline store.
- **FE**: a "Timeline" tab on the strategy detail — items grouped by month,
  slip chips, one fetch. Publish-safe exports land with the board pack (ADR
  0229).

### C7 — Scoring integrity surfacing

- **`GET …/lists/:listId/ideas/:cardId/score-history`** — the ADR 0230 B4
  `IdeaScoreChange` trail (prior/new priority, per-criterion scores, actor,
  voter), read-gated `workspace:read`.
- **"Why ranked here"**: the same response carries a `breakdown` computed from
  the CURRENT criteria set + the idea's current scores — per-criterion
  `{criterionId, name, weight, score, weighted}` so the FE (IdeaIntakePanel)
  explains the rank without new math (it reuses `scoring.ts` components).
- **Session rationale**: `PlanningSession.rationale?` (free text, set at
  create/update) — the "why we picked these" note C8's decision records cite.
- **Deferral recorded**: session budget/capacity CONSTRAINTS belong to the
  scenario floor (Phase D1) where selections are compared under constraint
  sets — not duplicated here.

Host-ext only; no new toggles; **no new RFC**.
