/**
 * Campaign Connectors workflow surface (ADR 0159 / ADR 0014) —
 * `ctx.features['campaign-connectors']`. Tenant-trusted KPI + import reads the
 * sync/import nodes call.
 *
 * @see docs/adr/0159-campaign-studio-connectors-performance.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { importCsv, kpiSummary } from './performanceService.js';
import { computeDerived, type ParsedRow } from './csvImport.js';
import { persistSyncedRows, claimSync, syncCooldown, yesterdayIso } from './syncService.js';
import { buildAudienceUpload } from './audienceService.js';
import { AD_PLATFORMS, type AdPlatform } from './types.js';

const asPlatform = (v: unknown): AdPlatform | undefined =>
  typeof v === 'string' && (AD_PLATFORMS as readonly string[]).includes(v) ? (v as AdPlatform) : undefined;

export function buildCampaignConnectorsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    kpiSummary: async (args) => ({ ...(await kpiSummary(tenantId, optStr(args.orgId), optStr(args.campaignId))) }),
    // C3 (ADR 0217) — suppression-safe, consent-checked, hashed audience build.
    buildAudienceUpload: async (args) => ({ ...(await buildAudienceUpload(tenantId, str(args.segmentId))) }),
    // C2 — the sync node's persist path (cooldown + dedup owned by syncService).
    // SYNC-1: claimSync ATOMICALLY reserves the cooldown window (compare-and-swap),
    // so two concurrent chain runs can't both pass the gate and double-hit the
    // platform. The same CAS backs the route path (runMetricsSync → claimSync), so
    // a node claim and a route claim contend on one key and exactly one wins — no
    // double-claim. Shape mirrors syncCooldown ({ blocked, retryAtIso }) so the
    // node contract is unchanged.
    claimSync: async (args) => {
      const c = await claimSync(tenantId, str(args.orgId), str(args.platform));
      return c.claimed ? { blocked: false } : { blocked: true, ...(c.retryAtIso ? { retryAtIso: c.retryAtIso } : {}) };
    },
    // Retained (read-only, non-claiming) for any surface that only needs to peek
    // the cooldown without reserving it.
    checkSyncCooldown: async (args) => ({ ...(await syncCooldown(tenantId, str(args.orgId), str(args.platform))) }),
    recordSyncedMetrics: async (args) => {
      const orgId = str(args.orgId);
      const platform = asPlatform(args.platform);
      if (!orgId || !platform) return { imported: 0, deduped: 0, error: 'orgId and a known platform are required' };
      const date = optStr(args.date) || yesterdayIso();
      const raw = Array.isArray(args.rows) ? (args.rows as Array<Record<string, unknown>>) : [];
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
      const rows: ParsedRow[] = raw
        .filter((r) => typeof r.campaignName === 'string' && (r.campaignName as string).length > 0)
        .map((r) => {
          // Synced rows never carry conversions/revenue (not pulled — C2 honesty).
          const base = { spend: num(r.spend), impressions: num(r.impressions), clicks: num(r.clicks), conversions: 0, revenue: 0 };
          return { platform, campaignName: str(r.campaignName), adSet: optStr(r.adSet) || 'dispatched', date, ...base, ...computeDerived(base) };
        });
      if (rows.length === 0) return { imported: 0, deduped: 0 };
      const campaignIdByName = args.campaignIdByName && typeof args.campaignIdByName === 'object'
        ? Object.fromEntries(Object.entries(args.campaignIdByName as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
        : undefined;
      return { ...(await persistSyncedRows(tenantId, orgId, platform, rows, campaignIdByName ? { campaignIdByName } : {})) };
    },
    importCsv: async (args) => {
      const orgId = str(args.orgId);
      const csv = str(args.csv);
      const platform = asPlatform(args.defaultPlatform);
      return { ...(await importCsv(tenantId, orgId, csv, { ...(platform ? { defaultPlatform: platform } : {}), ...(optStr(args.campaignId) ? { campaignId: str(args.campaignId) } : {}) })) };
    },
  };
}
