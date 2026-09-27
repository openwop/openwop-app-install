# ADR 0377 — Dashboard widget-catalog expansion (waves 1–4)

Status: implemented (Waves 1-4 landed 2026-07-16, PRs #1897/#1899/#1900/+W4; catalog 10 -> 46 tiles)

## Context

ADR 0375 (implemented, PRs #1889/#1891/#1892/#1893) shipped the editable dashboard:
the cycle-free tile registry (`allTiles.ts`), fail-closed resolution, per-tile
isolation, and a 10-tile catalog in **two shapes** (list rows + `TileStats` metric).

The follow-on question — *what widgets should the dashboard offer?* — was answered
by a three-source analysis (**`docs/research/dashboard-widget-catalog-analysis.md`**):
MyndHyve's 21-widget registry, a sweep of every openwop-app feature client, and
industry research (Monday.com's 30+ widget library, Jira's gadget set, SaaS
dashboard patterns). Conclusion: the gap is **widget types and instances, not
data** — nearly every feature already exposes a one-call client read that can back
a tile with zero backend work (ADR 0082 composition-only holds throughout).

## Decision

Expand the catalog to ~52 tiles across four waves, adding three visualization
primitives and three interaction types. Everything rides the ADR 0375 machinery
unchanged: `allTiles.ts` registration, `resolveTiles` fail-closed
(owning-toggle ∩ tier ∩ enabled), per-tile `ErrorBoundary`+`Suspense`+`LazyMount`,
`useDashboardOrg`/`useOrgResource` for org-scoped reads, 4-locale i18n.

**Standing rules (apply to every wave):**
- **Composition-only (ADR 0082):** a tile is a projection over an EXISTING client
  call. No new store, no precompute, no backend read added just to feed a tile
  (the honest rejections: comments-feed, cdp, sales-maps).
- **Tile tier = the tier of the page it deep-links to** (the ADR 0375 Pin-4 lesson
  generalized — no dead-end affordances). Verified against nav routes, not assumed.
- **All new tiles ship `defaultEnabled:false`** (opt-in via the picker). The
  default-ON set stays small (industry 5–9-element guardrail); changing defaults is
  a separate, later decision.
- **No SSE inside a tile** — poll-on-mount only (Cloud Run slot budget; a dashboard
  of tiles must never each open a stream).
- **No N+1 inside a tile** — a tile makes 1 (rarely 2 fixed) calls; per-row fetch
  loops are banned. Where a summary needs N calls (workforce metrics), the tile
  shows the list projection and defers depth to the feature page.
- **Charts are token-only CSS/SVG** — no chart library (matches the app posture +
  the `check-tsx-color-literals` gate).

## Waves

**Wave 1 — 21 tiles on the existing two shapes (no new primitives).**
Caller/tenant-scoped: approvals-inbox (`listApprovals` — tenant queue, backend
visibility-filters per ADR 0066), notifications (`listNotifications({status,limit})`,
poll-on-mount), my-projects, agent-fleet (roster + fleet activity, 2 fixed calls),
task-deck (bucket counts), strategy-health, csm-health, advisory-boards,
recent-notebooks, workforce-ops (**list projection only** — per-workforce metrics
would be N+1). Org-scoped (share the org memo): site-traffic, ai-spend,
ad-spend-roas, commissions, model-leaderboard, live-promotions,
suggested-automations, campaigns-in-flight, recent-media, kb-overview,
deal-registrations.

Toggle ids verified against `backend/src/features/*/feature.ts`: `analytics`,
`usage-analytics`, `campaign-connectors`, `sales-commissions`, `evals`,
`promotions`, `ambient-work-graph`, `campaign-orchestration` (campaign studio),
`media`, `kb`, `dealers`, `csm`, `strategy`, `advisory-board`, `notebooks`.
**Workforces has no toggle** (core admin surface) — tier-gated only.

Tiers (= linked page's tier): workspace — approvals-inbox, notifications,
my-projects, agent-fleet, task-deck, strategy-health, csm-health, advisory-boards,
recent-notebooks, site-traffic, commissions, ad-spend-roas, campaigns-in-flight,
live-promotions, deal-registrations; admin — workforce-ops, ai-spend,
model-leaderboard, kb-overview, recent-media, suggested-automations.

**Wave 2 — chart primitives + 11 chart tiles + 4 upgrades.**
Primitives: `<TileBars>` (horizontal distribution bars, generalizing the
`.crm-meter` track+fill), `<Sparkline>` (one inline-SVG polyline), `TileStats`
delta variant (hero number + signed ▲▼). Battery = a stacked `TileBars` row; donut
deliberately skipped (bars beat donuts for a11y, and no chart lib).
Net-new: spend-pacing, pipeline-trend, funnel-daily, share-views-trend,
platform-performance, cost-by-model, content-status, production-status,
quota-attainment, health-distribution, goals-progress. Upgrades (data already
fetched): crm-pipeline +stage bars, funnel-conversion +stepped bars,
commerce-summary +status bars/delta, campaign-kpis +deltas.

**Wave 3 — interaction types.** quick-create (config-driven shortcut buttons),
continue-working (recent canvases/projects resume), upcoming-agenda (merged dated
items, linear list first), mentions-inbox (channels unread mentions). Two flagged
items resolve at their own gate: personal-note (needs a storage decision — a
`note` field on the layout row vs profile-memory) and team-workload (needs an
N+1-free data source; deferred unless one exists).

**Wave 4 — admin-ops health.** connection-health, run-health, retention-health,
plugin-health. Open decision (resolve at the Wave-4 architect gate): dashboard tile
family vs a separate non-customizable `/ops` strip (MyndHyve keeps them separate).

## Alternatives weighed

- **A chart library (Recharts et al.):** rejected — MyndHyve's registry uses a real
  chart in exactly 1 of 21 widgets; bars + one sparkline cover everything in the
  candidate map, and the app's no-chart-dep posture + token gates stay intact.
- **Bigger default-ON set:** rejected for now — research converges on 5–9 elements;
  defaults are a product decision to revisit once the catalog exists.
- **Per-feature tile modules co-located in each feature package:** rejected — the
  ADR 0375 correction stands (dashboard-owned registry; a feature→dashboard import
  edge would cycle via the nav manifest).

## RFC gate

Host-extension UI only — no wire, no capability adverts, no new routes. **No RFC.**

## Phase → artifact (fill as it ships)

| Wave | Artifact |
|---|---|
| 1 — 21 tiles on existing shapes | PR #1897 (31 tiles total) |
| 2 — chart primitives + tiles | `TileBars`/`Sparkline`/`TileStats` delta + 9 chart tiles (pipeline-trend w/ the delta's first consumer, funnel-daily, spend-pacing as per-campaign bars — no daily series exists, architect ruling; platform-performance, cost-by-model, content-status, production-status, quota-attainment, health-distribution w/ NUMERIC bands) + 3 full-size progressive upgrades (crm-pipeline/funnel-conversion/commerce-summary). Skips logged: workforce-trend + share-views-trend (N+1), strategy-distribution (dup), campaign-kpis deltas (no comparative). |
| 3 — interaction types | quick-create (config-driven Links, zero data), continue-working (`listCanvasSources`), upcoming-agenda (2 fixed caller-relevant sources via `Promise.allSettled`; kanban rows UNLINKED — /boards is admin, tile is workspace), team-workload (ONE `listBoardsWithCards` — the same anti-N+1 read the agents dashboard uses). **Deferred, logged:** mentions-inbox (no read-only mentions rollup exists — `unreadCount` only via the POST catchup that STARTS A RUN; notifications covers the signal) + personal-note (needs a backend layout-schema extension — its own gate). |
| 4 — admin-ops | connection-health (`listConnections` status bars) + plugin-health (`listPlugins` trust-tier counts — ADR 0367 honesty label; MyndHyve PluginHealthWidget parity). **Placement decision resolved:** admin-tier tiles in the ONE catalog, NOT a separate /ops surface — tier-gated resolution already achieves MyndHyve's separate-tier intent, and a second surface would duplicate the grid machinery. **Deferred, logged:** run-health + retention-health (no read-only FE data source exists; a tenant-wide run rollup / retention gauge read is its own future gate). |
