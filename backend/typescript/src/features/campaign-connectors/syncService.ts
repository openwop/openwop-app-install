/**
 * Live ad-metrics sync (campaign gap plan §5C C2 — turns ADR 0159's honest-off
 * `ads.sync` honest-ON for the platforms with a metrics reader).
 *
 * ONE implementation, two callers: the `POST /campaign-connectors/sync` route
 * (builds the broker-backed ads adapter for the acting user) and the
 * `feature.campaign-connectors.nodes.sync` node (composes `ctx.ads` + the
 * feature surface's `recordSyncedMetrics`, which lands HERE). Both funnel every
 * row through `persistSyncedRows` — the single owner of the 15-minute cooldown
 * (ADR 0159's design) and the dedup'd performance store write.
 *
 * Honesty: rows are DATE-SCOPED (`window:'yesterday'`) so a daily sync writes
 * one row per (platform,campaign,date) — never lifetime cumulative totals that
 * would double-count in the KPI sums. Conversions/revenue are NOT pulled (the
 * platforms model them differently) — they stay 0 on synced rows; CSV import
 * remains the revenue-bearing path until C5's attribution join.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import type { AdsAdapter, DispatchLedgerRow, AdPlatform as DispatchPlatform } from '../../host/adsAdapter.js';
import { computeDerived, type ParsedRow } from './csvImport.js';
import { persistRecords } from './performanceService.js';
import type { AdPlatform } from './types.js';
// Cross-feature READ (the documented campaign-orchestration → campaign-brief
// precedent): link synced rows to the MarketingCampaign finalized from the
// dispatch's brief, so campaign-scoped KPI + C5 attribution see them.
import { getCampaignByBrief } from '../campaign-orchestration/campaignService.js';

const log = createLogger('campaign-connectors.sync');

/** Cooldown between live pulls per (tenant, org, platform) — ADR 0159. */
export const SYNC_COOLDOWN_MS = 15 * 60 * 1000;

interface SyncStateRow {
  key: string;
  tenantId: string;
  orgId: string;
  platform: string;
  lastSyncAt: string;
}
const syncState = new DurableCollection<SyncStateRow>(
  'campaign-connectors:sync-state',
  (r) => r.key,
);
const stateKey = (tenantId: string, orgId: string, platform: string): string => `${tenantId}::${orgId}::${platform}`;

/** R2 CC-SP-13 — `lastSyncAt` was persisted for the cooldown and never exposed:
 *  no surface answered "when did this data last refresh?". */
export async function getSyncStatus(tenantId: string, orgId: string): Promise<Array<{ platform: string; lastSyncAt: string }>> {
  const rows = await syncState.listByPrefix(`${tenantId}::${orgId}::`);
  return rows.filter((r) => r.tenantId === tenantId && r.orgId === orgId)
    .map(({ platform, lastSyncAt }) => ({ platform, lastSyncAt }))
    .sort((a, b) => a.platform.localeCompare(b.platform));
}

export type SyncOutcome =
  | { outcome: 'cooldown'; retryAtIso: string }
  | { outcome: 'no_dispatches' }
  | {
      outcome: 'synced';
      platform: AdPlatform;
      date: string;
      campaigns: number;
      imported: number;
      deduped: number;
      /** Per-campaign pull failures (no_connection/unsupported/errors) — the sync
       *  is best-effort per campaign, never all-or-nothing. */
      failures: Array<{ platformCampaignId: string; reason: string }>;
    };

/** Yesterday (UTC) — the date synced rows carry. */
export function yesterdayIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The single persist + cooldown chokepoint. `rows` must already be date-scoped. */
export async function persistSyncedRows(
  tenantId: string,
  orgId: string,
  platform: AdPlatform,
  rows: ParsedRow[],
  opts: { campaignIdByName?: Record<string, string> } = {},
): Promise<{ imported: number; deduped: number }> {
  // Group rows by their linked campaign so persistRecords can stamp the link.
  const byCampaign = new Map<string | undefined, ParsedRow[]>();
  for (const row of rows) {
    const link = opts.campaignIdByName?.[row.campaignName];
    const list = byCampaign.get(link) ?? [];
    list.push(row);
    byCampaign.set(link, list);
  }
  let imported = 0;
  let deduped = 0;
  for (const [campaignId, list] of byCampaign) {
    const r = await persistRecords(tenantId, orgId, list, 'api', campaignId);
    imported += r.imported;
    deduped += r.deduped;
  }
  await syncState.put({ key: stateKey(tenantId, orgId, platform), tenantId, orgId, platform, lastSyncAt: new Date().toISOString() });
  return { imported, deduped };
}

/** Atomically CLAIM the cooldown at sync START (grade-code AUDIT-7). Stamping
 *  `lastSyncAt` only at the END (in persistSyncedRows) left a wide check-then-act
 *  window — two concurrent syncs both passed `syncCooldown` and both hit the
 *  platform — AND meant a total-failure/no-rows sync never backed off (it
 *  re-hammered the platform every call). This CAS-stamps the state row up front:
 *  the loser sees the claim and reports cooldown; a failed pull now cools down. */
export async function claimSync(tenantId: string, orgId: string, platform: string): Promise<{ claimed: boolean; retryAtIso?: string }> {
  const key = stateKey(tenantId, orgId, platform);
  const prev = await syncState.get(key).catch(() => undefined);
  const now = Date.now();
  if (prev && prev.tenantId === tenantId) {
    const retryAt = new Date(prev.lastSyncAt).getTime() + SYNC_COOLDOWN_MS;
    if (now < retryAt) return { claimed: false, retryAtIso: new Date(retryAt).toISOString() };
  }
  const next: SyncStateRow = { key, tenantId, orgId, platform, lastSyncAt: new Date(now).toISOString() };
  const won = await syncState.compareAndSwap(prev && prev.tenantId === tenantId ? prev : null, next);
  if (!won) {
    // A concurrent sync claimed first — surface its cooldown honestly.
    const fresh = await syncState.get(key).catch(() => undefined);
    const retryAt = fresh ? new Date(fresh.lastSyncAt).getTime() + SYNC_COOLDOWN_MS : now + SYNC_COOLDOWN_MS;
    return { claimed: false, retryAtIso: new Date(retryAt).toISOString() };
  }
  return { claimed: true };
}

/** Cooldown check — callers surface `retryAtIso` honestly instead of silently
 *  re-pulling. */
export async function syncCooldown(tenantId: string, orgId: string, platform: string): Promise<{ blocked: boolean; retryAtIso?: string }> {
  const row = await syncState.get(stateKey(tenantId, orgId, platform)).catch(() => undefined);
  if (!row || row.tenantId !== tenantId) return { blocked: false };
  const retryAt = new Date(row.lastSyncAt).getTime() + SYNC_COOLDOWN_MS;
  if (Date.now() >= retryAt) return { blocked: false };
  return { blocked: true, retryAtIso: new Date(retryAt).toISOString() };
}

/**
 * Pull yesterday's metrics for every dispatched campaign of `platform` and land
 * them in the performance store. Best-effort per campaign; respects the
 * cooldown; links rows to the MarketingCampaign finalized from each dispatch's
 * brief when one exists.
 */
export async function runMetricsSync(
  adapter: AdsAdapter,
  tenantId: string,
  orgId: string,
  /** Constrained to the platforms the adapter can actually read (meta/google today). */
  platform: DispatchPlatform,
): Promise<SyncOutcome> {
  // R2 CC-SP-14 — the dispatch check runs BEFORE the cooldown claim: it is a
  // local ledger read (no platform call), and claiming first meant a
  // no_dispatches probe consumed the 15-minute window, locking out the first
  // REAL sync after a dispatch lands.
  const dispatches = (await adapter.listDispatches()).filter(
    (d): d is DispatchLedgerRow & { adAccountId: string } => d.platform === platform && typeof d.adAccountId === 'string' && d.adAccountId.length > 0,
  );
  if (dispatches.length === 0) return { outcome: 'no_dispatches' };

  // Claim the cooldown up front (grade-code AUDIT-7) — atomic, so concurrent
  // syncs don't both hit the platform and a failed pull still backs off.
  const claim = await claimSync(tenantId, orgId, platform);
  if (!claim.claimed) return { outcome: 'cooldown', retryAtIso: claim.retryAtIso ?? new Date().toISOString() };

  const date = yesterdayIso();
  const rows: ParsedRow[] = [];
  const failures: Array<{ platformCampaignId: string; reason: string }> = [];
  const campaignIdByName: Record<string, string> = {};

  for (const d of dispatches) {
    const r = await adapter.getMetrics({ platform, adAccountId: d.adAccountId, campaignId: d.platformCampaignId, window: 'yesterday' });
    if (r.outcome !== 'ok') {
      failures.push({ platformCampaignId: d.platformCampaignId, reason: r.outcome === 'failed' ? r.error : r.outcome });
      continue;
    }
    const campaignName = d.campaignName ?? d.platformCampaignId;
    const base = {
      spend: r.metrics.spend,
      impressions: r.metrics.impressions,
      clicks: r.metrics.clicks,
      conversions: 0, // not pulled — see module header
      revenue: 0,
    };
    // CONN-1: date the row by the platform's reported day when it carries one,
    // else fall back to the UTC label. A platform-reported date is the account's
    // timezone day, so it survives a near-midnight offset that the UTC label
    // would misdate (and then wrongly dedup in the performance natural key).
    const rowDate = r.date ?? date;
    rows.push({ platform, campaignName, adSet: 'dispatched', date: rowDate, ...base, ...computeDerived(base) });
    if (d.briefId && !campaignIdByName[campaignName]) {
      const campaign = await getCampaignByBrief(tenantId, d.briefId).catch(() => null);
      if (campaign && campaign.orgId === orgId) campaignIdByName[campaignName] = campaign.id;
    }
  }

  if (rows.length === 0) {
    log.info('campaign_sync_no_rows', { tenantId, orgId, platform, failures: failures.length });
    return { outcome: 'synced', platform, date, campaigns: 0, imported: 0, deduped: 0, failures };
  }
  const { imported, deduped } = await persistSyncedRows(tenantId, orgId, platform, rows, { campaignIdByName });
  log.info('campaign_sync_completed', { tenantId, orgId, platform, date, campaigns: rows.length, imported, deduped, failures: failures.length });
  return { outcome: 'synced', platform, date, campaigns: rows.length, imported, deduped, failures };
}
