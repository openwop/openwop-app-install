# ADR 0215 — Campaign Studio: live ad-metrics sync (ads.sync honest-ON)

| Field | Value |
|---|---|
| **Status** | implemented (2026-07-03) |
| **Date** | 2026-07-03 |
| **Feature(s)** | `campaign-connectors` (`syncService`, surface, route, page), `host/adsAdapter.ts` (metric windows + ledger read), `feature.campaign-connectors.nodes` v1.1.0, `feature.campaign-connectors.workflows` chain pack |
| **Plan** | `docs/research/campaign-gap-analysis.md` §5C **C2** (E4: "`ads.sync` honest-off; no scheduled sync") |
| **Depends on** | ADR 0159 (performance store + the honest-off sync node + the 15-min-cooldown design), ADR 0167/0186 (`ctx.ads` metrics readers), ADR 0152 (chain-pack loader) |
| **RFC gate** | **None** — rides the Accepted RFC 0013 (chain pack) + the implemented ctx.ads seam. |
| **ADR numbering note** | 0209–0213 reserved by the in-flight CRM branch (duplicate-number policy). |

## Context

ADR 0159 shipped the performance store with an **honest-off** `ads.sync` node (`connector_not_configured`) because no live broker reach existed. ADR 0167/0186 later landed real `ctx.ads.getMetrics` readers for Meta/Google — the reach now exists; the sync just was never wired to it.

## Decision

**ONE sync implementation, two callers, one persist chokepoint:**

- **`campaign-connectors/syncService.ts`** owns everything stateful: the 15-minute cooldown per `(tenant, org, platform)` (ADR 0159's design, now durable in `campaign-connectors:sync-state`), row building, campaign linking, and `persistSyncedRows` → the store's dedup'd `persistRecords`.
- **Callers:** `POST /campaign-connectors/sync` (builds the broker-backed adapter for the acting user — `workspace:write`, audited `campaign.sync.completed`, 429 on cooldown) and the **`sync` node** (composes `ctx.ads.listDispatches` + `ctx.ads.getMetrics` with the surface's `checkSyncCooldown`/`recordSyncedMetrics`, which land in the same service). The page gains "Sync Meta / Sync Google" actions.
- **Date-scoped honesty (the load-bearing choice):** rows carry `window:'yesterday'` metrics — Meta `date_preset=yesterday`, Google `segments.date DURING YESTERDAY` (`GetMetricsArgs.window`, default `lifetime` for back-compat). Lifetime-cumulative rows would double-count in every KPI sum. **Conversions/revenue are NOT pulled** (platforms model them differently) — synced rows carry 0 and CSV import stays the revenue-bearing path until C5's attribution join; per-campaign failures are collected, never all-or-nothing.
- **What gets synced:** every row of the adapter's fork-stable dispatch ledger for the platform (the ledger gains `adAccountId`; `listDispatches` joins `ctx.ads`). Rows link to the `MarketingCampaign` finalized from the dispatch's brief (the documented cross-feature READ precedent).
- **Scheduling = the ONE scheduler:** `feature.campaign-connectors.workflows` ships `campaign-sync.daily-metrics` as an RFC 0013 chain pack (`examples/workflow-chain-packs/campaign-sync/`) — sync → notification; pair with a daily schedule. No new daemon (the ADR 0149 lesson).
- **Honesty matrix:** meta/google `supported:true`; tiktok + the CSV-only platforms keep the structured `connector_not_configured` (CSV import is their path).

## Alternatives rejected

- A sync daemon — the scheduler + chain pack IS the recurrence primitive.
- Lifetime metrics into dated rows — double-counting; rejected outright.
- Surface-only implementation — the broker needs the acting user (`BrokeredEgressDeps.actingUserId`); surfaces are tenant-scoped, so the node path composes `ctx.ads` (run-scoped) and the route builds its own adapter.

## Verification

`campaign-sync.test.ts` (cooldown, date-scoped rows, per-campaign best-effort, campaign linking, route RBAC + 429) + `ads-metrics-budget` window assertions; FE gates green.
