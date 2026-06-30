# ADR 0160 — Campaign Studio: Campaign Intelligence

| Field | Value |
|---|---|
| **Status** | implemented (Phases 1–2, 2026-06-27) |
| **Date** | 2026-06-27 |
| **Feature id / toggle** | `campaign-intel` (OFF, bucket `tenant`, category `Marketing`) |
| **Packs** | `feature.campaign-intel.{nodes,agents}` |
| **Depends on** | ADR 0159 (performance store), 0158 (campaign), 0018 (analytics), 0010 (notifications) |
| **PRD** | [`docs/campaign-studio-prd.md`](../campaign-studio-prd.md) — sixth/last of the cluster (CS-007/010) |
| **RFC gate** | None — host work over the performance store. **No new RFC.** |

## Context

The last layer turns campaign performance data (ADR 0159) into decisions: **budget recommendations** (shift spend toward higher marginal ROAS), **forecasting** (creative-fatigue detection + outcome projection), and **natural-language queries** ("how should I allocate $5k across platforms?"). In MyndHyve this was `BudgetOptimizerService` (heuristic + AI scenarios) + the predictive engine. The KPI dashboard already shipped in ADR 0159; this ADR adds the analysis layer, driven through the one chat by a **Campaign Intelligence Analyst** agent (ADR 0058) — NOT a parallel analytics dashboard (the "build ON orchestration" rule).

## Decision

1. **A heuristic budget optimizer** (pure `budgetOptimizer.ts`) — scores each platform/campaign by marginal ROAS and recommends reallocations (shift from low to high), respecting a min-spend floor + a max-shift cap. Deterministic, unit-testable; the LLM-scenario layer is the node's optional enrichment.
2. **A forecaster** (pure `forecast.ts`) — creative-fatigue detection (declining CTR over a campaign's run) + outcome projection (linear extrapolation of spend/conversions to period end).
3. **`feature.campaign-intel.nodes`** — `budget-optimize` (heuristic over the performance store + optional `ctx.callAI` scenario narrative) and `forecast` (fatigue + projection). Over a `ctx.features['campaign-intel']` surface.
4. **The Campaign Intelligence Analyst agent** — tool-allowlisted to the intel + performance-KPI nodes; answers NL budget/forecast questions through the one chat (ADR 0058). The "natural-language campaign queries" path.
5. **A light FE panel** — budget recommendations + forecast cards on the performance page + an "Ask the Analyst" deep-link. No new dashboard.

### Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Heuristic-first | Pure deterministic optimizer/forecast; LLM is optional enrichment | Unit-testable, replay-trivial, explainable; the MyndHyve heuristic+AI split (ADR 0155 seam). |
| NL queries = agent | The Analyst agent over the nodes (ADR 0058) | "Build ON orchestration" — no bespoke analytics chatbox; the one chat answers. |
| Compose performance store | Read ADR 0159's `performanceService` | No parallel metrics store; intelligence is a projection. |
| Alerts/digests | Surface through Notifications (ADR 0010) — deferred to a follow-on | Honest sequencing: ship the analysis nodes + agent now; the scheduled digest rides the scheduler later. |

### Non-goals

- A scheduled alert/digest daemon (a follow-on over the scheduler + Notifications).
- A separate analytics dashboard (the KPI view is ADR 0159; recommendations are a panel + the agent).

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| **1 — Engine + nodes + agent** | pure `budgetOptimizer.ts` + `forecast.ts` + routes (`/budget`, `/forecast`) + `feature.campaign-intel.nodes` (`budget-optimize`, `forecast`) + `ctx.features['campaign-intel']` surface + Campaign Intelligence Analyst agent + toggle + tests | backend tsc + tests; boot |
| **2 — Frontend** | budget-recommendations + forecast cards on the performance page (or a panel) + Analyst deep-link · client · en/es/fr/pt-BR | `npm run build` green |

Each phase: **`/architect` before** · **`/code-review` after**; `/ux-review` on Phase 2. HITL avoided.

## Alternatives considered

1. **A bespoke intelligence dashboard.** Rejected — the "build ON orchestration, not parallel surfaces" rule; recommendations surface as a panel + the Analyst agent, not a second analytics app.
2. **LLM-only budget optimization.** Rejected — a deterministic marginal-ROAS heuristic is explainable + replay-safe; the LLM adds a scenario narrative on top, not the core math.

## Open questions

1. **Marginal-ROAS proxy.** With only aggregate data, use platform ROAS as the marginal proxy + a diminishing-returns dampener. Decided: ROAS-ranked reallocation with a max-shift cap (advisory).
2. **Forecast horizon.** Decided: project to the end of the data's trailing 30-day window; fatigue flagged when CTR's second-half mean drops >15% vs first-half.

## Consequences

- Completes the Campaign Studio cluster (ADR 0155–0160).
- Adds one toggle, one feature, two packs, one FE panel.

## Implementation log

| Phase | Status | Evidence |
|---|---|---|
| 1 | ✅ Done | pure `intelligence.ts` (`optimizeBudget` marginal-ROAS reallocation + `forecastCampaigns` fatigue+projection) + routes (`/budget`,`/forecast`) + `feature.campaign-intel.nodes` (`budget-optimize` w/ optional `ctx.callAI` narrative, `forecast`) + surface + Campaign Intelligence Analyst agent. `campaign-intel.test.ts` 7/7. |
| 2 | ✅ Done | `/campaign-intelligence` FE — budget reallocation table + forecast/fatigue cards + Analyst chat deep-link (ADR 0058) on shared `ui/`; central i18n `format`; en/es/fr/pt-BR. **`npm run build` green**. |

**Verification:** 7/7 tests; tsc clean; agent loads at boot; FE build green. `/architect` + `/code-review` (0) + `/ux-review` passed. Completes the Campaign Studio cluster (ADR 0155–0160). No new RFC.
