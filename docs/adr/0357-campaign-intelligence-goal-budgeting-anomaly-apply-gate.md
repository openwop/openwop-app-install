# ADR 0357 — Campaign intelligence: goal-based budgeting, anomaly detection, apply-through-gate, dashboard + connector resilience

| Field | Value |
|---|---|
| **Status** | implemented (Phases 1–6; CON-1 readers stay honest-off pending operator sandbox verification — see corrections) — 2026-07-12 |
| **Date** | 2026-07-12 |
| **Feature** | extends **`campaign-intel`** (ADR 0160/0219/0220) + **`campaign-connectors`** (ADR 0159/0215) + `connections` (ADR 0024) — toggle ids stable |
| **Closes** | `CSG-INT-1..5`, `CSG-CON-1..2` ([gap register](../CAMPAIGN-STUDIO-GAP-FINDINGS.md)) |
| **Composes** | performance store (ADR 0159), `ctx.ads.updateBudget` + spend gate (`host/adsAdapter.ts:1067-1091,279-322`), approvalService, pacing/notification pattern (ADR 0220), the Campaign Intelligence Analyst agent (ONE chat), A/B pairs (ADR 0355) |
| **RFC verdict** | **Host-ext, no new RFC.** |

## Context (boundaries audit)

Real today: CSV import w/ auto-mapping + derived metrics + dedup (`csvImport.ts:26-140`), ROAS
reallocation (`intelligence.ts:37-86`), pacing alerts (`pacing.ts:94-134`), linear forecasting +
creative-fatigue (`intelligence.ts:100-137`), last-click attribution, NL queries via the Analyst
agent. Missing: **goal-based feasibility/scenario** (grep clean), anomaly detection (grep clean),
one-click apply (the governed write path exists in adsAdapter but intel is read-only), dashboard
funnel/top-bottom/comparison/insights widgets (`CampaignIntelPage.tsx:40-141`), per-platform CSV
presets (`csvImport.ts:27-36` is one generic alias table). Connectors: live readers Meta/Google only
(`adsAdapter.ts:1092-1096`); no circuit breaker (grep clean in `connections/`). Single owners
confirmed: analysis → `campaign-intel`; store/import/sync → `campaign-connectors`; platform I/O →
`adsAdapter`; broker → `connections`.

## Decision

1. **Goal-based budget engine (CSG-INT-1).** `planBudget(goal)` in `campaign-intel`:
   `{ totalBudgetMinor, targetConversions, horizonDays, platforms? }` → a **deterministic**
   feasibility computation from historical per-platform CPA/CVR (the store): feasible/stretch/
   infeasible verdict + per-platform allocation + pacing curve + confidence (data-sufficiency
   banded). **Scenario modeling** = pure recompute with shifted allocations ("move 20%
   Google→LinkedIn"). Exposed three ways (AI-first): a route for the FE form, a
   `feature.campaign-intel.nodes.plan-budget` node, and an **Analyst agent tool** so
   *"I have $50K for Q2 and need 500 demos"* works in the ONE chat. An optional envelope narrates
   the deterministic result (numbers never hallucinated — the calc is the source of truth).
2. **Anomaly detection (CSG-INT-2).** Deterministic rolling-window stats over the performance store
   (per platform+campaign: mean/std of spend, CTR, CPA; z-score spikes/drops, min-N guard) →
   `anomalies[]` read model + notifications through the **pacing alert pattern** (dedup memo,
   CAS-claimed, deep-linked). No ML dependency; thresholds as named constants.
3. **Apply-through-gate (CSG-INT-3).** Recommendation rows (reallocation, scale up/down, pause)
   gain `apply` → a thin action that calls **`ctx.ads.updateBudget` through the EXISTING spend
   gate** (`adsAdapter.ts` — `requires_approval` at/above threshold, policy-refused when disabled).
   One-click UX, zero new write path; the approval card names the recommendation it enacts.
   Applied/skipped outcomes stamp back onto the recommendation (audit).
4. **Dashboard completion (CSG-INT-4).** Read models + FE sections: conversion funnel
   (impressions→clicks→conversions per platform), top/bottom performers (by ROAS/CPA, min-spend
   guard), platform comparison, and an insights feed (anomalies + fatigue + pacing + recommendations
   in one stream). Composes ADR 0355's A/B pairs: pair-level performance splits when both variants
   carry UTM-attributed data.
5. **CSV platform presets (CSG-INT-5).** Nine per-platform column presets as data (Google, Meta,
   LinkedIn, TikTok, X, Pinterest, Snapchat, Reddit, YouTube) layered over the generic alias
   autodetect — preset chosen by the user or filename hint; autodetect remains the fallback.
6. **Connector resilience (CSG-CON-1/2).**
   - **TikTok/LinkedIn metric readers** in adsAdapter (same shape as Meta/Google; honest
     `unsupported` until each is verified against a sandbox — the ADR 0223 discipline).
   - **Circuit breaker in the connections broker**: per-connection failure counter, open after N
     consecutive failures (default 5), half-open probe via the existing `probeConnection`, auto
     reset on success; while open, calls return the existing graceful `connector_unavailable`
     shape and the FE shows "Reconnect / retrying at T". Composes `refreshDaemon`; no new daemon.

## Phases

| Phase | Ships | Gaps |
|---|---|---|
| 1 | `planBudget` calc + route + node + agent tool (+ narration envelope) | INT-1 |
| 2 | Anomaly stats + notifications + insights feed | INT-2, INT-4 (feed) |
| 3 | Apply-through-gate on recommendations | INT-3 |
| 4 | Funnel/top-bottom/comparison dashboard sections + A/B splits | INT-4 |
| 5 | CSV presets ×9 | INT-5 |
| 6 | Circuit breaker (broker) + TikTok/LinkedIn readers (honest-off → verified) | CON-1, CON-2 |

## Matrix highlights

Toggles stable (`campaign-intel`, `campaign-connectors`). Packs: `feature.campaign-intel.nodes`
(+plan-budget, +anomaly-scan) and agent pack tool additions — version bumps, signed. Replay: all
computations deterministic (node outputs); applies ride approvalService fork-stable keys. RBAC:
plan/read = `workspace:read`; apply = `workspace:write` **plus** the adsAdapter spend gate (defense
in depth). Honesty: readers advertise per-platform support truthfully; breaker state is graceful,
never a silent success.

## Alternatives weighed

- *LLM-computed budget plans*: rejected — money math must be deterministic/replayable; the LLM only
  narrates.
- *A new optimization daemon*: rejected — anomaly scan rides the existing scheduler+chain-pack
  pattern (ADR 0215 precedent).
- *Breaker in adsAdapter instead of the broker*: rejected — the broker owns connection health;
  adsAdapter stays the policy/gate chokepoint.

## As-built corrections (2026-07-12)

- **CON-1 (TikTok/LinkedIn metric readers) deliberately NOT wired**: shipping reader code
  that has never touched a sandbox would be dead, unverifiable surface — the ADR 0223
  discipline stands (implement + verify against a live sandbox as ONE operator step). The
  dispatch legs remain live; readers stay `unsupported` until verified.
- The breaker lives in the CONNECTIONS broker (health owner) keyed `(tenant, ads:<platform>)`
  and is consulted by adsAdapter's publish path; IN-PROCESS state (restart ⇒ closed — the
  safe direction), threshold 5, cooldown 120s, half-open single probe.
- Anomalies: |z| ≥ 3, min 7 points per (platform, campaign, metric) — open Q1 as suggested.
- Scheduled apply (open Q2) deferred — `apply` supports `dryRun` for previews.
- The apply route composes `makeAdsAdapter` runlessly (the sync-route precedent) — the spend
  gate + approval flow return verbatim; zero new write paths.

## Phase → implementation record

| Phase | Ships | Evidence |
|---|---|---|
| 1 | `planBudget` (deterministic feasibility/allocation/pacing/confidence) + `scenarioShift` · route + surface op + `plan-budget` node w/ narration-only AI · Analyst agent tool · FE goal form | `campaign-intel/budgetPlanner.ts`; `test/campaign-intel-goal-anomaly.test.ts` |
| 2 | `detectAnomalies` (rolling stats, min-N) + route + surface op | same |
| 3 | `POST /recommendations/apply` → `adsAdapter.updateBudget` through the EXISTING spend gate | `campaign-intel/routes.ts` |
| 4 | `funnelByPlatform` + `topBottomPerformers` (+ `/overview` route) | same |
| 5 | 9 `PLATFORM_CSV_PRESETS` layered over autodetect (`mappingWithPreset`, `preset` on import) | `campaign-connectors/csvImport.ts` |
| 6 | Circuit breaker (broker-owned, adsAdapter-consulted) | `connections/connectionsService.ts`, `host/adsAdapter.ts` |
