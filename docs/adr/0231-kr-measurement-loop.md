# ADR 0231 — KR measurement loop: typed key results, check-ins, cadence, connector-fed metrics

Status: implemented (P1–P5, 2026-07-03; commerce-revenue + bigquery sources honestly skipped v1 per §C3; cadence config is API-first like the insights-suite precedent — no FE page)

> **Correction (2026-07-03, follow-on batch):** STRAT-PK1 added the `commerce-revenue`
> metric source — `metricSync.ts` now sums `paid`+`fulfilled` `Order.total` (major
> units) via `listOrders`, so a KR can be fed live from commerce. **BigQuery stays
> `source_unsupported` by design**: it belongs to an external-connector chain, not an
> in-process source read — the honest documented pattern, not a stub. The source matrix
> is now 3-of-4 (project · manual · commerce-revenue live; bigquery = chain).

Date: 2026-07-03
Relates to: ADR 0079/0080 (Strategy), ADR 0230 (governance wiring — emits/audit/gate), ADR 0152 (chain-pack loader), ADR 0082 (no dashboards/parallel stores), RFC 0013 (workflow chains), RFC 0096 (reviewable proposals — the semantics the proposed→confirmed model borrows), docs/research/strategy-gap-analysis.md (Phase C1–C3)

## Context

The gap analysis's keystone finding (E2, grade C): `StrategyKeyResult.target/current`
are free-text strings — no numeric typing, no history, no weights, no check-in
ritual, no connector-fed metrics, no stale detection. Everything downstream
(cadence C2, metric sync C3, board packs C5) starves without measurement.

**Binding constraint discovered in the Phase C architect review:** the
capability firewall only evaluates chat/agent tool calls
(`conversationToolLoop.ts`); workflow-node `ctx.features.*` calls bypass it
(`host/adsAdapter.ts:204` records the same lesson for ad spend). Any
"agent writes are approval-gated" promise must therefore be enforced **inside
the feature's own service**, by actor class — never by the firewall.

## Decision

### C1 — Typed measurement + check-ins (the data model)

- **Additive `measure` block on `StrategyKeyResult`** (free-text `target`/
  `current` stay valid — no migration):
  `measure?: { kind: 'numeric'|'percent'|'currency'|'boolean'; baseline?: number;
  target?: number; direction?: 'increase'|'decrease'; unit?: string;
  source?: MetricSource }`.
- **Append-only `StrategyCheckIn` rows** (own `DurableCollection`
  `strategy:checkin`, tenant-indexed — the ADR 0230 revision-store pattern):
  strategyId, krId, `value?: number`, `note?`, `confidence?: high|medium|low`,
  actor, createdAt, and **`status: 'confirmed' | 'proposed'`**:
  - **Human writes (routes) ⇒ `confirmed`.**
  - **Agent/run writes (`ctx.features.strategy.checkIn`) ⇒ `proposed`,
    structurally** — decided by actor class in the service (the adsAdapter
    in-owner-gate pattern). The Strategy Analyst can only ever *propose*; its
    mutation-free doctrine (ADR 0080) survives in spirit.
  - **Connector-sync writes (C3) ⇒ `confirmed` only because a human configured
    `measure.source` on that KR** — a standing authorization; the run actor is
    recorded for provenance. A sync write against a KR with NO source is
    refused (fail-closed).
  - A `proposed` row is confirmed (or dismissed) by a human via
    `POST …/check-ins/:id/{confirm,dismiss}` (write-gated; audited + evented
    per ADR 0230).
- **Progress + rollup computed AT READ** (architect Q2): a KR's progress
  derives from the latest **confirmed** check-in vs baseline/target/direction
  (boolean: done/not); objective progress = weighted mean of measured KRs
  (`weight?: number` additive on KR, default 1); strategy progress = weighted
  mean of objectives (`weight?` on objectives too). `strategyHealth.ts` gains
  progress + `staleKrCount` (no confirmed check-in within the cadence window,
  default 14d) as additional signals. No stored derived state.
- **Node-pack verbs** (`feature.strategy.nodes` v1.1 when written; **v1.3.0 on disk** as of ADR 0676 D1, which classified `create-board-memo` as side-effectful): `check-in` (proposes,
  per above), `list-check-ins`, `list-stale-krs`. The `ctx.features.strategy`
  surface gains the same — reads stay org/shared-scoped as today; the ONE
  write verb is the structurally-proposing check-in.

### C2 — Cadence (chain pack, no new scheduler machinery)

- `vendor.openwop-app.workflows.strategy` chain pack
  (`examples/workflow-chain-packs/strategy/`) with `strategy.weekly-checkin`:
  `list-stale-krs` → per-owner addressed notifications (ADR 0050) deep-linking
  the strategy detail. Stale detection also emits
  `host.strategy.kr.stale` (ADR 0230 emit) so webhooks/bindings can react.
- **Scheduling by reconciliation** (the insights-suite pattern): a
  `GET/PUT /v1/host/openwop-app/strategy/cadence` config route reconciles ONE
  scheduler job (cron, default weekly) against the chain-expanded workflow.
  No auto-boot job — clean installs stay quiet until an operator opts in.

### C3 — Connector-fed KRs (existing surfaces only)

- `MetricSource = { kind: 'crm-deal-total'|'analytics-conversions'|
  'commerce-revenue'|'bigquery'; query?: string; orgId: string }` on
  `measure.source` — set by a human (write-gated route), the standing
  authorization for automated confirmed check-ins.
- `strategy.sync-metrics` chain (same pack): for each active strategy's
  sourced KRs, read via the EXISTING surfaces (`ctx.features.crm` /
  `ctx.features.analytics` / `ctx.features.commerce` / `bigquery.query`
  through the Connections broker) → write through the C1 check-in path
  (actor = the run, `confirmed` by standing authorization). Failures surface
  on the run/exception surfaces — that IS the sync-health view (no bespoke
  panel). Scheduled by the same cadence reconciliation (its own job).
- Sourced KRs render "auto-updated from <source>" in the UI — honest
  provenance.

## What this deliberately does NOT do

- No stored progress/derived state; no dashboard; no reminder engine; no new
  scheduler/queue; no firewall reliance for node-path writes (see Context).
- No wire change: routes are host-ext; events are `host.*` (RFC 0086 §E);
  chains ride Accepted RFC 0013. **No new RFC.**

## Phases

| Phase | Deliverable | Verification |
|---|---|---|
| P1 | measure block + check-in store + routes (write/confirm/dismiss/list) + proposed-vs-confirmed actor classing | route tests: human=confirmed, verb=proposed, confirm flow, fail-closed sync-without-source |
| P2 | progress + staleness in strategyHealth + weights | health unit tests incl. weighted rollup |
| P3 | node verbs + surface (v1.1) | surface/verb tests |
| P4 | chain pack (weekly-checkin + sync-metrics) + cadence reconcile route | chain expansion test + reconcile route test |
| P5 | FE: check-in affordance + sparkline-lite (recent confirmed values), proposed-pending badge, source provenance line | build gates |
