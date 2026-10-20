/**
 * Campaign Connectors routes (ADR 0159) — host-extension under
 * /v1/host/openwop-app/campaign-connectors/*. CSV import + performance reads + KPI.
 * Toggle + accessControl gated, fail-closed.
 *
 * @see docs/adr/0159-campaign-studio-connectors-performance.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { requireFeatureEnabled, requireString, authorizeOrgScope } from '../featureRoute.js';
import { resolveToggle } from '../../host/featureToggles/service.js';
import { ownerPublicRuntimeLapsed } from '../../host/publicLapse.js';
import { getOrg } from '../../host/accessControlService.js';
import { upsertPixel, listPixels, removePixel, publicPixelsForOrg, relayConversion, listConversions, marketingAllowedOrUnreadable } from './pixelService.js';
import { deliverQueuedConversions, enabledConversionPlatforms, conversionHealth } from './conversionDelivery.js';
import { clientIp } from '../../host/clientIp.js';
import { importCsv, listRecords, kpiSummary } from './performanceService.js';
import { runMetricsSync, runMetricsBackfill, getSyncStatus, getConnectorSettings, saveConnectorSettings, isLiveSyncPlatform, enabledSyncPlatforms, LIVE_SYNC_PLATFORMS } from './syncService.js';
import { buildAudienceUpload } from './audienceService.js';
import { makeAdsAdapter } from '../../host/adsAdapter.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { randomUUID } from 'node:crypto';
import { AD_PLATFORMS, type AdPlatform } from './types.js';
import type { ColumnMapping } from './csvImport.js';

// The consent gate for both public lanes lives in pixelService (ADR 0907 D7
// hoisted it there so the send-time re-check calls the same function).

const TOGGLE_ID = 'campaign-connectors';
const LABEL = 'Campaign Connectors';

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

async function requireOrgScopeFor(req: Request, orgId: string, scope: Scope): Promise<void> {
  const access = await resolveEffectiveAccess(tenantOf(req), { subject: actingUserOf(req), orgId });
  if (!access.scopes.includes(scope)) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope, orgId });
  }
}

export function registerCampaignConnectorsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/host/openwop-app/campaign-connectors';

  // C2 → ADR 0907 D3 — live "Sync Now": pull the 7-day look-back per the org's
  // connector settings (dispatched campaigns, or the whole ad account) through
  // the acting user's connection (the broker resolves it; fail-closed
  // no_connection per ad account). 15-min cooldown.
  app.post(`${BASE}/sync`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const orgId = requireString(body.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      const platform = typeof body.platform === 'string' && (AD_PLATFORMS as readonly string[]).includes(body.platform)
        ? (body.platform as AdPlatform) : undefined;
      if (!platform || !isLiveSyncPlatform(platform)) {
        throw new OpenwopError('validation_error', `platform must be one of: ${LIVE_SYNC_PLATFORMS.join(', ')} (the platforms with a live metrics reader).`, 400, { platform: body.platform });
      }
      const storage = hostExtStorage();
      const adapter = makeAdsAdapter({
        storage, tenantId: tenantOf(req), runId: `hostext:sync:${randomUUID()}`,
        ...(actingUserOf(req) ? { actingUserId: actingUserOf(req) as string } : {}), orgId,
      });
      const result = await runMetricsSync(adapter, tenantOf(req), orgId, platform);
      if (result.outcome === 'synced') {
        void storage.appendAudit({
          timestamp: new Date().toISOString(), principalId: actingUserOf(req) ?? 'unknown',
          action: 'campaign.sync.completed', resource: `campaign-connectors:${orgId}`, outcome: 'success',
          payload: { tenantId: tenantOf(req), orgId, actor: actingUserOf(req) ?? 'unknown', platform, scope: result.scope, since: result.since, until: result.until, date: result.date, campaigns: result.campaigns, imported: result.imported, failures: result.failures.length, truncated: result.truncated },
        }).catch(() => undefined);
      }
      res.status(result.outcome === 'cooldown' ? 429 : 200).json(result);
    } catch (err) { next(err); }
  });

  // ADR 0907 D3 — per-(org, platform) connector settings: which campaigns the
  // sync reads (dispatched vs whole account), the ad accounts, and Meta's
  // conversion action types. No secrets here: the token stays in the broker.
  app.get(`${BASE}/orgs/:orgId/connector-settings/:platform`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: LABEL }, 'workspace:read');
      const platform = req.params.platform;
      if (!isLiveSyncPlatform(platform)) throw new OpenwopError('validation_error', `platform must be one of: ${LIVE_SYNC_PLATFORMS.join(', ')}.`, 400, { platform });
      const { key: _key, tenantId: _t, ...settings } = await getConnectorSettings(tenantId, orgId, platform);
      res.json({ settings });
    } catch (err) { next(err); }
  });
  app.put(`${BASE}/orgs/:orgId/connector-settings/:platform`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: LABEL }, 'workspace:write');
      const platform = req.params.platform;
      if (!isLiveSyncPlatform(platform)) throw new OpenwopError('validation_error', `platform must be one of: ${LIVE_SYNC_PLATFORMS.join(', ')}.`, 400, { platform });
      const b = (req.body ?? {}) as Record<string, unknown>;
      const { key: _key, tenantId: _t, ...settings } = await saveConnectorSettings(tenantId, orgId, platform, { syncScope: b.syncScope, adAccountIds: b.adAccountIds, conversionActionTypes: b.conversionActionTypes }, user.userId);
      res.json({ settings });
    } catch (err) { next(err); }
  });

  // ADR 0907 D3 — bounded, resumable backfill (≤ 90 days). Each call reads a
  // few 7-day windows and reports progress; call again to continue.
  app.post(`${BASE}/orgs/:orgId/sync/backfill`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: LABEL }, 'workspace:write');
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!isLiveSyncPlatform(b.platform)) throw new OpenwopError('validation_error', `platform must be one of: ${LIVE_SYNC_PLATFORMS.join(', ')}.`, 400, { platform: b.platform });
      const days = typeof b.days === 'number' ? b.days : Number(b.days);
      const adapter = makeAdsAdapter({ storage: hostExtStorage(), tenantId, runId: `hostext:backfill:${randomUUID()}`, actingUserId: user.userId, orgId });
      const result = await runMetricsBackfill(adapter, tenantId, orgId, b.platform, { days });
      if (result.outcome === 'progress' || result.outcome === 'done' || result.outcome === 'rate_limited') {
        void deps.storage.appendAudit({
          timestamp: new Date().toISOString(), principalId: user.userId,
          action: 'campaign.backfill.step', resource: `campaign-connectors:${orgId}`, outcome: 'success',
          payload: { tenantId, orgId, actor: user.userId, platform: b.platform, outcome: result.outcome, remainingDays: result.remainingDays, windowsDone: result.windowsDone, imported: result.imported },
        }).catch(() => undefined);
      }
      res.status(result.outcome === 'busy' || result.outcome === 'rate_limited' ? 429 : 200).json(result);
    } catch (err) { next(err); }
  });

  // C3 (ADR 0217) — segment → platform custom audience. Consent + suppression
  // filtering happens in the build; the adapter's approval gate (default
  // require-approval) guards the actual upload. 202 on approval-pending.
  app.post(`${BASE}/audience-sync`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const orgId = requireString(body.orgId, 'orgId');
      const segmentId = requireString(body.segmentId, 'segmentId');
      const adAccountId = requireString(body.adAccountId, 'adAccountId');
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      const platform = body.platform === 'meta' || body.platform === 'google' ? body.platform : undefined;
      if (!platform) throw new OpenwopError('validation_error', "platform must be 'meta' or 'google'.", 400, { platform: body.platform });
      const upload = await buildAudienceUpload(tenantOf(req), segmentId);
      if (upload.size === 0) {
        res.status(200).json({ outcome: 'empty_audience', excluded: upload.excluded });
        return;
      }
      const adapter = makeAdsAdapter({
        storage: hostExtStorage(), tenantId: tenantOf(req), runId: `hostext:audience:${randomUUID()}`,
        ...(actingUserOf(req) ? { actingUserId: actingUserOf(req) as string } : {}), orgId,
      });
      const result = await adapter.syncAudience({
        platform, adAccountId,
        audienceName: typeof body.audienceName === 'string' && body.audienceName.trim() ? body.audienceName.trim().slice(0, 120) : `Segment ${segmentId}`,
        memberHashes: upload.memberHashes, membersKey: upload.membersKey,
      });
      res.status(result.outcome === 'requires_approval' ? 202 : 200).json({ ...result, ...(result.outcome === 'synced' ? { excluded: upload.excluded } : {}) });
    } catch (err) { next(err); }
  });

  // ── ADR 0297 D1 — pixel configs (authed) + the consented public reads ──────

  app.get(`${BASE}/orgs/:orgId/pixels`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: LABEL }, 'workspace:read');
      res.json({ pixels: await listPixels(tenantId, orgId) });
    } catch (err) { next(err); }
  });
  app.put(`${BASE}/orgs/:orgId/pixels`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: LABEL }, 'workspace:write');
      const b = (req.body ?? {}) as { platform?: unknown; pixelId?: unknown; active?: unknown; googleCustomerId?: unknown; conversionActions?: unknown };
      res.json({ pixel: await upsertPixel(tenantId, orgId, {
        platform: b.platform, pixelId: b.pixelId, ...(b.active !== undefined ? { active: b.active } : {}),
        ...(b.googleCustomerId !== undefined ? { googleCustomerId: b.googleCustomerId } : {}),
        ...(b.conversionActions !== undefined ? { conversionActions: b.conversionActions } : {}),
      }) });
    } catch (err) { next(err); }
  });
  app.delete(`${BASE}/orgs/:orgId/pixels/:platform`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: LABEL }, 'workspace:write');
      const ok = await removePixel(tenantId, orgId, req.params.platform);
      if (!ok) throw new OpenwopError('not_found', 'Pixel not found.', 404, {});
      res.json({ ok: true });
    } catch (err) { next(err); }
  });
  // ADR 0297 D1 follow-on → ADR 0907 D5 — deliver queued conversions through the
  // acting user's ad connections, via the ONE delivery path the scheduled chain
  // also uses (conversionDelivery.ts). The schedule (P4) is the cadence; this is
  // the manual "send now".
  app.post(`${BASE}/orgs/:orgId/conversions/dispatch`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: LABEL }, 'workspace:write');
      const adapter = makeAdsAdapter({
        storage: hostExtStorage(), tenantId, runId: `hostext:capi:${randomUUID()}`,
        actingUserId: user.userId, orgId,
      });
      res.json(await deliverQueuedConversions(adapter, tenantId, orgId));
    } catch (err) { next(err); }
  });

  // ADR 0907 D7 — the health card: queued / delivered / failing, per platform.
  app.get(`${BASE}/orgs/:orgId/conversions/health`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: LABEL }, 'workspace:read');
      res.json(await conversionHealth(tenantId, orgId));
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/orgs/:orgId/conversions`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: LABEL }, 'workspace:read');
      // ADR 0907 D6 — the IP and user agent exist only for delivery; a workspace
      // reader sees the queue, not the visitors' network addresses.
      res.json({ conversions: (await listConversions(tenantId, orgId)).map(({ ip: _ip, userAgent: _ua, ...row }) => row) });
    } catch (err) { next(err); }
  });

  // PUBLIC: which pixels a consented visitor loads. Marketing consent — an
  // unconsented visitor gets an EMPTY list (the page renders, no pixels), and
  // the response never distinguishes "none configured" from "not consented".
  app.get('/host/openwop-app/public/:orgId/pixels', async (req, res, next) => {
    try {
      const org = await getOrg(req.params.orgId);
      if (!org) throw new OpenwopError('not_found', 'Site not found.', 404, {});
      // ADR 0819 §1 opt-out — a PUBLIC lane (tenant from the resource): ADR 0419 never paywalls a shopper/visitor on the operator's plan.
      const assignment = await resolveToggle(TOGGLE_ID, { tenantId: org.tenantId });
      const vk = typeof req.query.vk === 'string' && req.query.vk.length <= 128 ? req.query.vk : '';
      // ADR 0820 §7 — the owner-lapse policy (off unless the grace knob is set) answers like the toggle: no pixels.
      if (!assignment?.enabled || (await ownerPublicRuntimeLapsed(TOGGLE_ID, org.tenantId)) || !vk || (await marketingAllowedOrUnreadable(org.tenantId, vk, 'pixels')) !== true) {
        res.json({ pixels: [] });
        return;
      }
      res.json({ pixels: await publicPixelsForOrg(org.tenantId, req.params.orgId) });
    } catch (err) { next(err); }
  });

  // PUBLIC: the conversions relay intake. Consent-gated like the analytics
  // beacon (202 recorded:false — never an error a probe can mine); the email
  // identifier is hashed server-side before anything persists.
  app.post('/host/openwop-app/public/:orgId/conversions', async (req, res, next) => {
    try {
      const org = await getOrg(req.params.orgId);
      if (!org) throw new OpenwopError('not_found', 'Site not found.', 404, {});
      // ADR 0819 §1 opt-out — a PUBLIC lane (tenant from the resource): ADR 0419 never paywalls a shopper/visitor on the operator's plan.
      const assignment = await resolveToggle(TOGGLE_ID, { tenantId: org.tenantId });
      // ADR 0820 §7 — a lapsed owner past the grace window answers like the toggle being off.
      if (!assignment?.enabled || (await ownerPublicRuntimeLapsed(TOGGLE_ID, org.tenantId))) { res.status(202).json({ recorded: false, reason: 'not_enabled' }); return; }
      const b = (req.body ?? {}) as Record<string, unknown>;
      const vk = typeof b.vk === 'string' && b.vk.length <= 128 ? b.vk : '';
      if (!vk) { res.status(202).json({ recorded: false, reason: 'consent' }); return; }
      const allowed = await marketingAllowedOrUnreadable(org.tenantId, vk, 'conversions');
      if (allowed !== true) {
        res.status(202).json({ recorded: false, reason: allowed === 'unreadable' ? 'consent_unreadable' : 'consent' });
        return;
      }
      // ADR 0907 D6 — match-quality signals: click ids and hashed phone from the
      // site's beacon; the client IP (trusted-proxy walk, ADR 0851) and user
      // agent from the REQUEST, never from the body a page could forge.
      const { event, deduped } = await relayConversion(org.tenantId, req.params.orgId, {
        eventId: b.eventId, eventName: b.eventName, email: b.email, value: b.value, currency: b.currency, visitor: vk,
        phone: b.phone, fbc: b.fbc, fbclid: b.fbclid, fbclidAt: b.fbclidAt, fbp: b.fbp,
        ttclid: b.ttclid, gclid: b.gclid, gbraid: b.gbraid, wbraid: b.wbraid, pageUrl: b.pageUrl,
        ip: clientIp(req), userAgent: req.header('user-agent') ?? undefined,
      });
      res.status(202).json({ recorded: true, eventId: event.eventId, deduped });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/platforms`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      // ADR 0907 D2 — `liveSync` / `liveConversions`: the readers and the
      // conversion senders that may run right now (the rest await a sandbox run).
      res.json({ platforms: AD_PLATFORMS, liveSync: enabledSyncPlatforms(), liveConversions: enabledConversionPlatforms() });
    } catch (err) { next(err); }
  });

  // Import a CSV blob into the performance store (workspace:write in the org).
  app.post(`${BASE}/import`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const orgId = requireString(body.orgId, 'orgId');
      const csv = requireString(body.csv, 'csv');
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      const defaultPlatform = typeof body.defaultPlatform === 'string' && (AD_PLATFORMS as readonly string[]).includes(body.defaultPlatform)
        ? (body.defaultPlatform as AdPlatform) : undefined;
      const mapping = body.mapping && typeof body.mapping === 'object' ? (body.mapping as ColumnMapping) : undefined;
      const campaignId = typeof body.campaignId === 'string' && body.campaignId.length > 0 ? body.campaignId : undefined;
      const preset = typeof body.preset === 'string' && body.preset ? body.preset : undefined; // ADR 0357 P5
      const result = await importCsv(tenantOf(req), orgId, csv, {
        ...(mapping ? { mapping } : {}),
        ...(preset ? { preset } : {}),
        ...(defaultPlatform ? { defaultPlatform } : {}),
        ...(campaignId ? { campaignId } : {}),
      });
      // Audit the import (campaign gap plan §5B B1 — payload.tenantId REQUIRED;
      // the governance route pattern: best-effort, inline after the mutation).
      void deps.storage
        .appendAudit({
          timestamp: new Date().toISOString(),
          principalId: actingUserOf(req) ?? 'unknown',
          action: 'campaign.import.completed',
          resource: `campaign-connectors:${orgId}`,
          outcome: 'success',
          payload: { tenantId: tenantOf(req), orgId, actor: actingUserOf(req) ?? 'unknown', imported: result.imported, deduped: result.deduped, invalid: result.invalid, ...(campaignId ? { campaignId } : {}) },
        })
        .catch(() => undefined);
      res.status(201).json(result);
    } catch (err) { next(err); }
  });

  // List records (read in the org).
  app.get(`${BASE}/records`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = requireString(req.query.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:read');
      const campaignId = typeof req.query.campaignId === 'string' && req.query.campaignId.length > 0 ? req.query.campaignId : undefined;
      res.json({ records: await listRecords(tenantOf(req), orgId, campaignId) });
    } catch (err) { next(err); }
  });

  // KPI summary (read in the org).
  app.get(`${BASE}/kpi`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = requireString(req.query.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:read');
      const campaignId = typeof req.query.campaignId === 'string' && req.query.campaignId.length > 0 ? req.query.campaignId : undefined;
      res.json(await kpiSummary(tenantOf(req), orgId, campaignId));
    } catch (err) { next(err); }
  });

  // R2 CC-SP-13 — data freshness: when each platform's live sync last landed.
  app.get(`${BASE}/orgs/:orgId/sync-status`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: LABEL }, 'workspace:read');
      res.json({ platforms: await getSyncStatus(tenantId, orgId) });
    } catch (err) { next(err); }
  });
}
