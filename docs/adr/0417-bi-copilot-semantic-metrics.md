# ADR 0417 — BI copilot v1: the semantic metric catalog + NL→query→chart lane

Status: implemented (P1–P4, 2026-07-18)

## Implementation record

| Phase | What landed |
|---|---|
| P1 | `features/bi`: `bi:metric` store (tenant-keyed, teardown-registered), closed-world write-time validation vs the entities registry, in-code system metrics (never stored — no seed/fold hazard), `runMetric` over service-layer entity reads (kernel allowlist per the correction note) with org scoping + stored filters + range/bucket, admin CRUD/run routes; seed-coverage ACK; 12 tests. |
| P2 | `ctx.features.bi` (listMetrics/getCatalog/runMetric — ADR 0358 projection) + `openwop:bi.{list-metrics,run-metric}` chat tools (toggle-gated, fail-empty, bounded params, typed-error repair signal), allowlisted on the assistant pack; parity tripwire; LLM-EXCHANGE-AUDIT row. |
| P3 | `feature.bi.nodes` 1.0.0 (+pin, both corpus tripwires green); run-metric emits the `interactive.chart` envelope (bar grouped / line bucketed); the `bi-metric` dashboard tile (lazy, toggle-gated) + biClient; i18n ×4. |
| P4 | `/metrics` admin page (list + system chips + inline run + create/edit/delete via the backend's closed world), nav entry, `bi` i18n namespace ×4, page tests. |

OQ-1 resolved: bucketing shipped in v1 (day/week/month). OQ-2 resolved: tenant-wide metrics, org as a run param. OQ-3 open: tile-read caching — measure first (trigger: tile poll cost).

Decision source: **docs/steward/GAP-SWEEP-2026-07.md §3 row 3** (analytics/BI copilot over a
semantic layer is the sweep's biggest zero-coverage hole for a "business OS" —
table stakes per Fabric Copilot / Cortex Analyst / ThoughtSpot / Tableau MCP)
re-scoped **L→M** by the 2026-07-18 `/architect` audit: query, FTS, rollups, and
chart rendering all exist; **the semantic metric catalog is the only net-new
system**. The recent content-kernel programs (ADRs 0386/0406–0410) made this
tractable — CRM deals and commerce products now live on queryable typed
entities.

## Context

A user cannot ask the app "how did Q2 deals trend by region?" and get a chart.
Everything below the question exists:

- **Governed query**: `features/entities/surface.ts:103` `query` — tenant/
  project-scoped, filtered, paginated, typed (`queryEntities`); `host.db.search`
  (RFC 0018) for full-text.
- **Rollups**: `features/analytics` (summary/events), `features/usage-analytics`
  (AI spend); `insights-suite` runs computes as workflows and **deleted its
  parallel read model** (ADR 0082) — a lesson this ADR must not repeat.
- **Rendering**: the `interactive.chart` artifact + `ChartRenderer.tsx`
  (ADR 0128 Phase 4, XSS-safe SVG) + dashboard chart tiles (ADR 0377).
- **Chat-tool seam**: `registerFeatureAgentTool` (ADR 0308) with the shared
  route/tool access-predicate rule; `getCatalog` ops feed models live catalogs
  (ADR 0358).

What's missing is the **semantic layer**: a governed definition of what
"pipeline value", "win rate", or "MRR" MEANS over those entities — the thing
that makes NL→query trustworthy instead of a model guessing at fields (the
Cortex-Analyst lesson: accuracy comes from semantic models, not bigger prompts).

## Decision

Build ONE new package, `features/bi` (toggle `bi`, default OFF, tenant bucket):

> **Correction (2026-07-18, P1 architect review):** two facts the design must
> honor. (a) The generic `entities.query` SURFACE serves user types only (the
> `isUserType` gate) — the evaluator reads KERNEL system types via the service
> layer (`listSystemEntities`/`queryEntities`) behind BI's OWN org-scoped gate,
> never by widening the entities surface. (b) "orders" and "contacts" are NOT
> kernel entity types (plain DurableCollections) — the queryable kernel set is
> `crm.deal`, `commerce.product`, `crm.company`, `cms.page`; seeded system
> metrics target those. System metrics ship as a static in-code const merged
> into reads (deterministic, no store writes, no fold/seed machinery), not
> seeded rows.

1. **The metric catalog (the net-new core).** A `bi:metric` DurableCollection of
   closed-world metric definitions: `{ metricId, title, entityType, aggregate
   (count|sum|avg|min|max), field?, filters?, groupBy?, timeField? }` — validated
   against the entities type registry at write time (unknown type/field = typed
   422, never a stored-then-failing metric). Seeded system metrics for the
   kernel types (deals, orders, contacts); tenant admins add their own via CRUD
   routes. The catalog is exposed to models via a `bi.getCatalog` surface op
   (ADR 0358 pattern) — schema text generated from the SSoT, parity-tested.
2. **The evaluator = a projection over `entities.query`.** `runMetric(metricId,
   {range, groupBy})` compiles a metric to `queryEntities` calls + in-service
   aggregation. It NEVER takes raw filter ASTs from the model — the model picks
   a metricId + bounded parameters (closed-world; the ADR 0397 firewall
   philosophy applied to analytics). No SQL generation in v1.
3. **The chat lane.** `openwop:bi.run-metric` + `openwop:bi.list-metrics` agent
   tools via `registerFeatureAgentTool`, sharing the routes' access predicate;
   results return compact tables AND emit an `interactive.chart` artifact so the
   answer renders in the existing chat canvas. A `feature.bi.nodes` pack wraps
   `runMetric`/`listMetrics` for workflows (a scheduled agent chat + these tools
   = a weekly metrics digest with zero new plumbing — the ADR 0125 composition).
4. **Dashboard reach.** A `bi-metric` dashboard tile type rendering a saved
   metric through the existing tile/sparkline machinery — no new dashboard
   system.

Non-goals (v1): NL→arbitrary-SQL (the governed-metric lane IS the guardrail);
warehouse sync (GAP-SWEEP §3 row 7, its own future ADR); a BI page builder
(dashboard tiles suffice); cross-tenant/benchmark analytics (isolation).

## Alternatives weighed

- **NL→SQL over the Postgres schema** (the Cortex/Fabric surface shape) —
  rejected for v1: the app's data spans KV collections + entities, not one SQL
  schema; and free SQL breaks the closed-world validation invariant that every
  model-facing write/read here obeys. The metric catalog gives the accuracy
  benefit (semantic definitions) without the injection/isolation surface.
- **Extend `features/analytics` instead of a new package** — rejected:
  analytics owns EVENT rollups (page views, funnels); business-entity metrics
  over the kernel is a different read model with different governance; forcing
  them together couples two lifecycles. The seam between them is recorded: BI
  reads entities; analytics stays event-truth.
- **A chart-building UI first** — rejected: the chat + tiles are the delivery
  surfaces users already have; a builder is post-v1 polish.

## Phased implementation plan

- **P1 — catalog + evaluator**: the `bi:metric` store, closed-world validation
  against the entities registry, `runMetric` over `queryEntities`, seeded kernel
  metrics, CRUD routes (admin-gated), unit + route tests.
- **P2 — chat lane**: `bi.getCatalog` surface op + the two agent tools (shared
  predicate, pack-allowlisted per ADR 0315) + `interactive.chart` emission;
  prompt-catalog parity test.
- **P3 — workflow + dashboard reach**: `feature.bi.nodes` pack (+ pins), the
  `bi-metric` tile, the weekly-digest example composition (docs, not new code).
- **P4 — UX pass**: metrics admin page (list/create/edit with type-aware field
  pickers), i18n ×4, dark-mode, a11y; /ux-review.

## Open questions

- OQ-1: time-series bucketing (day/week/month) in v1 or P3? (Leaning v1 — a
  trend chart without buckets is a bar chart.)
- OQ-2: metric-level access control beyond tenant/admin (per-org metrics)? v1:
  tenant-wide, org filter as a metric parameter.
- OQ-3: should `runMetric` results be cacheable with a TTL for dashboard tiles?
  Measure first; the tile poll cadence may make it moot.
