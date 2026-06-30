# ADR 0159 — Campaign Studio: Live Connectors & Performance

| Field | Value |
|---|---|
| **Status** | implemented (Phases 1–3, 2026-06-27) |
| **Date** | 2026-06-27 |
| **Feature id / toggle** | `campaign-connectors` (OFF, bucket `tenant`, category `Marketing`) |
| **Packs** | RFC 0095 connection packs (`core.openwop.connections.{google,meta,linkedin}-ads`) + `feature.campaign-connectors.nodes` |
| **Depends on** | ADR 0024/0033/0037 (Connections broker + RFC 0095 + connector reach), 0018 (analytics), 0158 (campaign) |
| **PRD** | [`docs/campaign-studio-prd.md`](../campaign-studio-prd.md) — fifth of the cluster (CS-007/009) |
| **RFC gate** | None — rides **Accepted RFC 0095** (connection packs) + the broker (ADR 0024/0037). **No new RFC.** |

## Context

Bryce's CS-007/009: bring real ad-performance data in — by **CSV import** (9 platform templates) and by **live connector sync** (Google/Meta/LinkedIn Ads, daily). openwop-app already has the Connections broker (ADR 0024) + RFC 0095 connection packs + the connector framework (ADR 0037, day-1 honesty matrix). This ADR adds the three ad-platform **connection packs** (restored from the ADR 0149 revert + LinkedIn), a campaign **performance store** with unified metrics, a **CSV import** path, a **KPI projection**, and a **sync node** (honest-off until the broker reach is wired, the ADR 0037 pattern). It forks neither Connections nor Analytics.

## Decision

1. **Three RFC 0095 connection packs** — `core.openwop.connections.{google,meta,linkedin}-ads` (OAuth2, `category:marketing`, carry no secret). Restored/added under `examples/connection-packs/`.
2. **Performance store** — `CampaignPerformanceRecord` (platform, campaignName, adSet, date, spend/impressions/clicks/conversions/revenue + computed ctr/cpc/cvr/cpa/roas), tenant+org keyed, `DurableCollection`. Dedup key `platform|campaignName|adSet|date`.
3. **CSV import service** — parse + column-map (9 platform templates) + validate (clicks≤impressions, conversions≤clicks, no negatives/future dates) + compute the derived fields + dedup + a tracked `ImportBatch`. Pure parse/validate (unit-testable).
4. **KPI projection** — aggregate totals + per-platform breakdown over the store.
5. **A sync node** (`feature.campaign-connectors.nodes.sync`) — pulls a platform's performance through the Connections broker; **honest-off** (`connector_not_configured`) until the broker reach is wired (ADR 0037 day-1 matrix). Plus a `ctx.features['campaign-connectors']` surface (KPI read).
6. **A Performance FE page** — CSV import wizard + KPI cards + per-platform table.

### Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Connection packs | RFC 0095 manifests, no secret | The accepted seam (ADR 0024/0033); operator supplies the OAuth client host-side. |
| Performance persistence | `DurableCollection`, dedup by natural key | No migration; re-import is idempotent (overlapping date ranges don't double-count). |
| Computed metrics | Derived on import, stored | Bryce's CSVs often omit ctr/cpc/roas; compute once. |
| Sync = honest-off | `connector_not_configured` until brokered | ADR 0037 day-1 honesty — advertise/behave honestly; CSV is the working path now. |
| Compose Analytics | KPI projection is campaign-performance-specific (ad spend), distinct from `analytics` (page/event) | Ad metrics aren't page analytics — a distinct store, surfaced honestly (not a fork of 0018). |

### Non-goals

- Budget recommendations / forecasting / NL queries (→ ADR 0160).
- Live broker reach implementation (deploy-gated, ADR 0037).

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| **1 — Performance store + CSV import + KPI** | `CampaignPerformanceRecord` types + `performanceService` (store, dedup, computed, KPI) + `csvImport.ts` (parse/map/validate, pure) + routes (`/import`, `/records`, `/kpi`) + toggle + tests | backend tsc + tests |
| **2 — Connection packs + sync node** | `{google,meta,linkedin}-ads` connection packs + `feature.campaign-connectors.nodes` (`sync` honest-off, `import-csv`) + `ctx.features['campaign-connectors']` surface + tests | backend tsc + tests; boot loads packs |
| **3 — Frontend** | `src/features/campaign-connectors/` — CSV import + KPI cards + per-platform table · client · `Marketing` nav · en/es/fr/pt-BR | `npm run build` green |

Each phase: **`/architect` before** · **`/code-review` after**; `/ux-review` on Phase 3. HITL avoided.

## Alternatives considered

1. **Reuse `analytics` for ad metrics.** Rejected — analytics is page/event measurement; ad spend/ROAS is a distinct domain. Composing the KPI read is fine; forking the store is not.
2. **Block on live broker reach.** Rejected — CSV import is the working, testable path Bryce needs now; live sync is honest-off (ADR 0037), no block.

## Open questions

1. **Platform templates.** 9 platforms (Google/Meta/LinkedIn/TikTok/X/Pinterest/Snapchat/Reddit/YouTube). Decided: ship the 3 with live packs + a generic mapping; the rest are column-map presets.
2. **Campaign linkage.** Records optionally carry `campaignId` (link to ADR 0158). Decided: optional; KPI works workspace-wide or per-campaign.

## Consequences

- Unblocks ADR 0160 (budget/forecast over the performance store).
- Adds one toggle, one feature, 3 connection packs + 1 node pack, one FE page.

## Implementation log

| Phase | Status | Evidence |
|---|---|---|
| 1 | ✅ Done | `CampaignPerformanceRecord` + `performanceService` (DurableCollection, dedup by natural key, KPI projection) + pure `csvImport.ts` (parse/map/validate/compute) + routes (`/import`,`/records`,`/kpi`). |
| 2 | ✅ Done | RFC 0095 connection packs `core.openwop.connections.{google,meta,linkedin}-ads` (restored/added, boot-loaded) + `feature.campaign-connectors.nodes` (`import-csv`, `sync` honest-off `connector_not_configured`) + `ctx.features[campaign-connectors]` surface. |
| 3 | ✅ Done | `/campaign-performance` FE — CSV paste-import + KPI cards + per-platform table on shared `ui/`; central i18n `format` helpers; en/es/fr/pt-BR. **`npm run build` green**. |

**Verification:** 6/6 `campaign-connectors.test.ts` (+ connection-packs 8/8); tsc clean; 3 ad connection packs load at boot; FE build green. `/architect` + `/code-review` (0) + `/ux-review` passed. Rides Accepted RFC 0095 — no new RFC.
