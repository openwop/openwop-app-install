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
import { persistSyncedRows, claimSync, syncCooldown, yesterdayIso, planSync, recordAccountRows, isLiveSyncPlatform, type SyncPlan } from './syncService.js';
import { listTenantDispatchRecords, makeAdsAdapter, type AccountMetricsRow } from '../../host/adsAdapter.js';
import { assertOrgScope } from '../../host/accessControlService.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { deliverQueuedConversions, SCHEDULED_CONVERSIONS_TOGGLE } from './conversionDelivery.js';
import { resolveOne } from '../../host/featureToggles/service.js';
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
          // The pre-ADR-0907 node path (sync@1.0.0): its rows carry no
          // conversions/revenue. sync@1.1.0 records through recordAccountRows.
          const base = { spend: num(r.spend), impressions: num(r.impressions), clicks: num(r.clicks), conversions: 0, revenue: 0 };
          return { platform, campaignName: str(r.campaignName), adSet: optStr(r.adSet) || 'dispatched', date, ...base, ...computeDerived(base) };
        });
      if (rows.length === 0) return { imported: 0, deduped: 0 };
      const campaignIdByName = args.campaignIdByName && typeof args.campaignIdByName === 'object'
        ? Object.fromEntries(Object.entries(args.campaignIdByName as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
        : undefined;
      return { ...(await persistSyncedRows(tenantId, orgId, platform, rows, campaignIdByName ? { campaignIdByName } : {})) };
    },
    // ADR 0907 D3 — the node's half of the ONE sync implementation: plan
    // (which accounts, which window, which campaigns) and record (map + persist)
    // live here; the node only loops ctx.ads.getAccountMetrics over the plan.
    planSync: async (args) => {
      const orgId = str(args.orgId);
      const platform = args.platform;
      if (!orgId || !isLiveSyncPlatform(platform)) return { outcome: 'invalid', error: 'orgId and a live-sync platform are required' };
      const scope = args.syncScope === 'account' || args.syncScope === 'dispatched' ? args.syncScope : undefined;
      const out = await planSync(tenantId, orgId, platform, await listTenantDispatchRecords(tenantId), scope ? { scope } : {});
      return { ...out };
    },
    recordAccountRows: async (args) => {
      const orgId = str(args.orgId);
      const plan = args.plan as SyncPlan | undefined;
      if (!orgId || !plan || !isLiveSyncPlatform(plan.platform) || !Array.isArray(plan.ledger)) return { imported: 0, deduped: 0, campaigns: 0, error: 'orgId and the plan from planSync are required' };
      // Pack code hands these over: keep only well-formed rows (ISO day, string
      // ids, finite non-negative numbers) — the recordSyncedMetrics stance.
      const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
      const rows: AccountMetricsRow[] = (Array.isArray(args.rows) ? (args.rows as Array<Record<string, unknown>>) : [])
        .filter((r) => r && typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && typeof r.campaignId === 'string' && r.campaignId.length > 0)
        .map((r) => ({
          date: r.date as string, campaignId: r.campaignId as string,
          campaignName: typeof r.campaignName === 'string' && r.campaignName ? r.campaignName.slice(0, 300) : (r.campaignId as string),
          impressions: n(r.impressions), clicks: n(r.clicks), spend: n(r.spend),
          // `null` is meaningful (unreported, ADR 0907 D3) — never coerce it to 0.
          conversions: r.conversions === null ? null : n(r.conversions), revenue: r.revenue === null ? null : n(r.revenue),
          ...(typeof r.currency === 'string' && /^[A-Z]{3}$/.test(r.currency) ? { currency: r.currency } : {}),
        }));
      return { ...(await recordAccountRows(tenantId, orgId, plan, rows)) };
    },
    // ADR 0907 D7 — the scheduled delivery node's ONE call. Acts as the RUN
    // OWNER (a schedule fires as its creator, ADR 0816 D8): the broker resolves
    // that person's ad connections, and they must hold workspace:write in the
    // org — the manual dispatch route's rule. No owner ⇒ refused, never a
    // system-identity send. Delivery itself is conversionDelivery.ts, shared
    // with the route (consent re-check, per-row targets, resumable).
    deliverConversions: async (args) => {
      const orgId = str(args.orgId);
      const actingUserId = scope.actingUserId;
      if (!orgId) return { outcome: 'invalid', error: 'orgId is required' };
      // Lead amendment — scheduled delivery is OFF until the workspace opts in:
      // nothing is read or sent, and the run says so.
      // Toggle + plan (ADR 0819 resolveOne, never the opt-out), and a sub-toggle
      // is AND-ed with its parent feature (ADR 0404 §P4).
      const [parent, toggle] = await Promise.all([resolveOne('campaign-connectors', { tenantId }), resolveOne(SCHEDULED_CONVERSIONS_TOGGLE, { tenantId })]);
      if (!parent?.enabled || !toggle?.enabled) return { outcome: 'disabled' };
      if (!actingUserId) return { outcome: 'no_acting_user' };
      await assertOrgScope(tenantId, actingUserId, orgId, 'workspace:write', { ...(scope.personalTenant ? { personalTenant: scope.personalTenant } : {}) });
      const adapter = makeAdsAdapter({ storage: hostExtStorage(), tenantId, runId: scope.runId ?? `hostext:capi-run:${orgId}`, actingUserId, orgId });
      return { outcome: 'delivered', ...(await deliverQueuedConversions(adapter, tenantId, orgId)) };
    },
    importCsv: async (args) => {
      const orgId = str(args.orgId);
      const csv = str(args.csv);
      const platform = asPlatform(args.defaultPlatform);
      return { ...(await importCsv(tenantId, orgId, csv, { ...(platform ? { defaultPlatform: platform } : {}), ...(optStr(args.campaignId) ? { campaignId: str(args.campaignId) } : {}) })) };
    },
  };
}
