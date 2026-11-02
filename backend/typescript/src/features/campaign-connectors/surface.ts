/**
 * Campaign Connectors workflow surface (ADR 0159 / ADR 0014) —
 * `ctx.features['campaign-connectors']`. The KPI read and the sync/import
 * writes the nodes call. ADR 1022 D4: every write asks `workspace:write` of the
 * run's person through the ADR 0832 floor (`CAMPAIGN_CONNECTORS_SURFACE_POLICY`).
 *
 * @see docs/adr/0159-campaign-studio-connectors-performance.md
 */

import { OpenwopError } from '../../types.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { importCsv, kpiSummary } from './performanceService.js';
import { attemptOf, claimSync, noteSyncAttempt, planSync, recordAccountRows, isLiveSyncPlatform } from './syncService.js';
import { listTenantDispatchRecords, makeAdsAdapter, type AccountMetricsRow } from '../../host/adsAdapter.js';
import { assertOrgScope } from '../../host/accessControlService.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { deliverQueuedConversions, SCHEDULED_CONVERSIONS_TOGGLE } from './conversionDelivery.js';
import { pushCatalog } from './catalogFeed.js';
import { configuredPublicBaseUrl } from '../featureRoute.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { buildAudienceUpload } from './audienceService.js';
import { AD_PLATFORMS, type AdPlatform } from './types.js';

const asPlatform = (v: unknown): AdPlatform | undefined =>
  typeof v === 'string' && (AD_PLATFORMS as readonly string[]).includes(v) ? (v as AdPlatform) : undefined;

/** ADR 1022 D4 — the floor asks what the HTTP doors ask: write for every write;
 *  the audience build reads the TENANT-wide contact list, so it asks the tenant
 *  scope the CRM doors ask (contacts are not org-scoped). */
export const CAMPAIGN_CONNECTORS_SURFACE_POLICY = {
  methodScopes: {
    claimSync: 'workspace:write', planSync: 'workspace:write', recordAccountRows: 'workspace:write',
    deliverConversions: 'workspace:write', pushCatalog: 'workspace:write', importCsv: 'workspace:write',
  },
  tenantMethodScopes: { buildAudienceUpload: 'workspace:write' },
} as const;

export function buildCampaignConnectorsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    // ADR 1022 D3 — an org is required (the service refuses ''); no org-less
    // read of the whole tenant's performance.
    kpiSummary: async (args) => ({ ...(await kpiSummary(tenantId, str(args.orgId), optStr(args.campaignId))) }),
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
      const platform = args.platform;
      // Typed failures, never a `{error}` a node could read as "synced 0" (CP71CD-3).
      if (!orgId || !isLiveSyncPlatform(platform) || !Array.isArray(args.batches)) throw new OpenwopError('validation_error', 'orgId, a live-sync platform and batches are required.', 400);
      // ADR 1022 D1 (B1) — the node's plan is NOT trusted: the server plans
      // again from this org's ledger and settings, and a batch from an account
      // that plan does not name is dropped. A pack-built plan could otherwise
      // name another org's dispatches or accounts.
      const scope = args.syncScope === 'account' || args.syncScope === 'dispatched' ? args.syncScope : undefined;
      const window = { ...(optStr(args.since) ? { since: str(args.since) } : {}), ...(optStr(args.until) ? { until: str(args.until) } : {}) };
      const planned = await planSync(tenantId, orgId, platform, await listTenantDispatchRecords(tenantId), { ...(scope ? { scope } : {}), ...window });
      if (planned.outcome !== 'plan') {
        // CP71CD-13 — the cooldown is already claimed; leave the trace the
        // status page reads before refusing.
        await noteSyncAttempt(tenantId, orgId, platform, { at: new Date().toISOString(), outcome: 'failed', reason: 'plan_changed' });
        throw new OpenwopError('conflict', `The sync plan changed while the accounts were read (${planned.outcome}); nothing was recorded.`, 409, { outcome: planned.outcome });
      }
      const allowed = new Set(planned.plan.adAccountIds);
      // Pack code hands these over: keep only well-formed rows (ISO day, string
      // ids, finite non-negative numbers).
      const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
      const rows: AccountMetricsRow[] = [];
      let droppedBatches = 0;
      for (const b of args.batches as Array<Record<string, unknown>>) {
        if (!b || typeof b.adAccountId !== 'string' || !allowed.has(b.adAccountId) || !Array.isArray(b.rows)) { droppedBatches += 1; continue; }
        for (const r of b.rows as Array<Record<string, unknown>>) {
          if (!r || typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || typeof r.campaignId !== 'string' || r.campaignId.length === 0) continue;
          rows.push({
            date: r.date, campaignId: r.campaignId,
            campaignName: typeof r.campaignName === 'string' && r.campaignName ? r.campaignName.slice(0, 300) : r.campaignId,
            impressions: n(r.impressions), clicks: n(r.clicks), spend: n(r.spend),
            // `null` is meaningful (unreported, ADR 0907 D3) — never coerce it to 0.
            conversions: r.conversions === null ? null : n(r.conversions), revenue: r.revenue === null ? null : n(r.revenue),
            ...(typeof r.currency === 'string' && /^[A-Z]{3}$/.test(r.currency) ? { currency: r.currency } : {}),
          });
        }
      }
      const okAccounts = (args.batches as Array<Record<string, unknown>>).length - droppedBatches;
      const failures = (Array.isArray(args.failures) ? (args.failures as Array<Record<string, unknown>>) : [])
        .filter((f) => f && typeof f.adAccountId === 'string' && allowed.has(f.adAccountId))
        .map((f) => ({ reason: typeof f.reason === 'string' ? f.reason.slice(0, 120) : 'unknown' }));
      const recorded = rows.length > 0 ? await recordAccountRows(tenantId, orgId, planned.plan, rows) : { imported: 0, deduped: 0, campaigns: 0 };
      await noteSyncAttempt(tenantId, orgId, platform, attemptOf(okAccounts, failures));
      return { ...recorded, ...(droppedBatches > 0 ? { droppedBatches } : {}) };
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
    // ADR 0952 D6 (P7) — the scheduled catalog push's ONE call. Same identity rule
    // as deliverConversions: the RUN OWNER's connections, workspace:write in the
    // org, never a system identity. Only changed items go; removed items leave.
    pushCatalog: async (args) => {
      const orgId = str(args.orgId);
      const platform = args.platform === 'google' ? 'google' : args.platform === 'meta' ? 'meta' : null;
      if (!orgId || !platform) return { outcome: 'invalid', error: 'orgId and platform (meta | google) are required' };
      if (!(await resolveOne('campaign-connectors', { tenantId }))?.enabled) return { outcome: 'disabled' };
      const actingUserId = scope.actingUserId;
      if (!actingUserId) return { outcome: 'no_acting_user' };
      await assertOrgScope(tenantId, actingUserId, orgId, 'workspace:write', { ...(scope.personalTenant ? { personalTenant: scope.personalTenant } : {}) });
      const deps = { storage: hostExtStorage(), tenantId, runId: scope.runId ?? `hostext:catalog-push:${orgId}`, actingUserId, orgId };
      return { ...(await pushCatalog(deps, tenantId, orgId, platform, configuredPublicBaseUrl())) };
    },
    importCsv: async (args) => {
      const orgId = str(args.orgId);
      const csv = str(args.csv);
      const platform = asPlatform(args.defaultPlatform);
      return { ...(await importCsv(tenantId, orgId, csv, { ...(platform ? { defaultPlatform: platform } : {}), ...(optStr(args.campaignId) ? { campaignId: str(args.campaignId) } : {}) })) };
    },
  };
}
