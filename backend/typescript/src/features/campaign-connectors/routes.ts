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
import { resolveOne } from '../../host/featureToggles/service.js';
import { getOrg } from '../../host/accessControlService.js';
import { isAllowed } from '../consent/consentService.js';
import { upsertPixel, listPixels, removePixel, publicPixelsForOrg, relayConversion, listConversions, dispatchQueuedConversions, type ConversionEvent } from './pixelService.js';
import { importCsv, listRecords, kpiSummary } from './performanceService.js';
import { runMetricsSync, getSyncStatus } from './syncService.js';
import { buildAudienceUpload } from './audienceService.js';
import { makeAdsAdapter } from '../../host/adsAdapter.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { randomUUID } from 'node:crypto';
import { AD_PLATFORMS, type AdPlatform } from './types.js';
import type { ColumnMapping } from './csvImport.js';

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
  const BASE = '/v1/host/openwop-app/campaign-connectors';

  // C2 — live "Sync Now": pull yesterday's metrics for every dispatched
  // campaign of the platform through the acting user's connection (the broker
  // resolves it; fail-closed no_connection per campaign). 15-min cooldown.
  app.post(`${BASE}/sync`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const orgId = requireString(body.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      const platform = typeof body.platform === 'string' && (AD_PLATFORMS as readonly string[]).includes(body.platform)
        ? (body.platform as AdPlatform) : undefined;
      if (!platform || (platform !== 'meta' && platform !== 'google')) {
        throw new OpenwopError('validation_error', "platform must be 'meta' or 'google' (the platforms with a live metrics reader).", 400, { platform: body.platform });
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
          payload: { tenantId: tenantOf(req), orgId, actor: actingUserOf(req) ?? 'unknown', platform, date: result.date, campaigns: result.campaigns, imported: result.imported, failures: result.failures.length },
        }).catch(() => undefined);
      }
      res.status(result.outcome === 'cooldown' ? 429 : 200).json(result);
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
      const b = (req.body ?? {}) as { platform?: unknown; pixelId?: unknown; active?: unknown };
      res.json({ pixel: await upsertPixel(tenantId, orgId, { platform: b.platform, pixelId: b.pixelId, ...(b.active !== undefined ? { active: b.active } : {}) }) });
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
  // ADR 0297 D1 follow-on — deliver queued conversions to the wired platform
  // conversions APIs (Meta CAPI / TikTok Events) through the acting user's ad
  // connections. User-triggered (the /sync precedent): the broker needs an
  // acting human's connection; schedule it via a workflow if you want cadence.
  app.post(`${BASE}/orgs/:orgId/conversions/dispatch`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: LABEL }, 'workspace:write');
      const pixels = await listPixels(tenantId, orgId);
      const pixelByPlatform = new Map(pixels.filter((p) => p.active).map((p) => [p.platform, p.pixelId]));
      const adapter = makeAdsAdapter({
        storage: hostExtStorage(), tenantId, runId: `hostext:capi:${randomUUID()}`,
        actingUserId: user.userId, orgId,
      });
      const transport = async (platform: string, event: ConversionEvent): Promise<void> => {
        const pixelId = pixelByPlatform.get(platform as (typeof pixels)[number]['platform']);
        if (!pixelId) throw new Error('no_pixel');
        const out = await adapter.sendConversion({
          platform, pixelId,
          eventId: event.eventId, eventName: event.eventName, eventTimeIso: event.at,
          ...(event.emailHash ? { emailHash: event.emailHash } : {}),
          ...(event.value !== undefined ? { value: event.value } : {}),
          ...(event.currency ? { currency: event.currency } : {}),
        });
        if (out.outcome !== 'sent') throw new Error(out.outcome === 'failed' ? out.error : out.outcome);
      };
      const sent = await dispatchQueuedConversions(tenantId, orgId, transport, { platforms: ['meta', 'tiktok'] });
      res.json({ sent });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/orgs/:orgId/conversions`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: LABEL }, 'workspace:read');
      res.json({ conversions: await listConversions(tenantId, orgId) });
    } catch (err) { next(err); }
  });

  // PUBLIC: which pixels a consented visitor loads. Marketing consent — an
  // unconsented visitor gets an EMPTY list (the page renders, no pixels), and
  // the response never distinguishes "none configured" from "not consented".
  app.get('/v1/host/openwop-app/public/:orgId/pixels', async (req, res, next) => {
    try {
      const org = await getOrg(req.params.orgId);
      if (!org) throw new OpenwopError('not_found', 'Site not found.', 404, {});
      const assignment = await resolveOne(TOGGLE_ID, { tenantId: org.tenantId });
      const vk = typeof req.query.vk === 'string' && req.query.vk.length <= 128 ? req.query.vk : '';
      if (!assignment?.enabled || !vk || !(await isAllowed(org.tenantId, vk, 'marketing'))) {
        res.json({ pixels: [] });
        return;
      }
      res.json({ pixels: await publicPixelsForOrg(org.tenantId, req.params.orgId) });
    } catch (err) { next(err); }
  });

  // PUBLIC: the conversions relay intake. Consent-gated like the analytics
  // beacon (202 recorded:false — never an error a probe can mine); the email
  // identifier is hashed server-side before anything persists.
  app.post('/v1/host/openwop-app/public/:orgId/conversions', async (req, res, next) => {
    try {
      const org = await getOrg(req.params.orgId);
      if (!org) throw new OpenwopError('not_found', 'Site not found.', 404, {});
      const assignment = await resolveOne(TOGGLE_ID, { tenantId: org.tenantId });
      if (!assignment?.enabled) { res.status(202).json({ recorded: false, reason: 'not_enabled' }); return; }
      const b = (req.body ?? {}) as { vk?: unknown; eventId?: unknown; eventName?: unknown; email?: unknown; value?: unknown; currency?: unknown };
      const vk = typeof b.vk === 'string' && b.vk.length <= 128 ? b.vk : '';
      if (!vk || !(await isAllowed(org.tenantId, vk, 'marketing'))) {
        res.status(202).json({ recorded: false, reason: 'consent' });
        return;
      }
      const { event, deduped } = await relayConversion(org.tenantId, req.params.orgId, { eventId: b.eventId, eventName: b.eventName, email: b.email, value: b.value, currency: b.currency, visitor: vk });
      res.status(202).json({ recorded: true, eventId: event.eventId, deduped });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/platforms`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      res.json({ platforms: AD_PLATFORMS });
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
