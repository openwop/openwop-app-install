/**
 * Campaign Intelligence routes (ADR 0160) — host-extension under
 * /v1/host/openwop-app/campaign-intel/*. Budget recommendations + forecast over
 * the performance store (ADR 0159). Toggle + accessControl gated, fail-closed.
 *
 * @see docs/adr/0160-campaign-studio-intelligence.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { requireFeatureEnabled, requireString } from '../featureRoute.js';
import { listRecords } from '../campaign-connectors/performanceService.js';
import type { AdPlatform } from '../../host/adsAdapter.js';
import { planBudget, scenarioShift, detectAnomalies, funnelByPlatform, topBottomPerformers } from './budgetPlanner.js';
import { optimizeBudget, forecastCampaigns } from './intelligence.js';
import { buildAttribution, buildModelReport } from './attribution.js';
import { getAttributionSettings, parseAttributionSettings, setAttributionSettings, resolveReadModel, MULTI_TOUCH_TOGGLE } from './attributionSettings.js';
import { isAttributionModel, ATTRIBUTION_MODELS, type AttributionModel } from './attributionModels.js';
import { buildReconciliation } from './reconciliation.js';
import { buildAdMap } from './adMap.js';
import { buildPacing } from './pacing.js';
import { listCaps, getCap, createCap, setCapLimit, deleteCap, getCapState, pauseMarketingCampaign } from './spendCaps.js';
import { deleteAlias, getUtmPolicy, lintUrls, listAliases, parseUtmPolicy, setAlias, setUtmPolicy } from './utmGovernance.js';
import { listPlans, applyReallocation, recordRouteApply, proposeReallocation } from './reallocation.js';

const TOGGLE_ID = 'campaign-intel';
const LABEL = 'Campaign Intelligence';

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

/** The adapter's dispatchable platforms — exhaustive by construction (the
 *  `Record<AdPlatform, true>` fails to compile if the adapter union drifts),
 *  so `/recommendations/apply` validates against the REAL canonical set
 *  instead of casting an arbitrary string into the union. */
const APPLY_PLATFORM_SET: Record<AdPlatform, true> = { meta: true, google: true, tiktok: true, linkedin: true };
const APPLY_PLATFORMS = Object.keys(APPLY_PLATFORM_SET) as AdPlatform[];

/** The org-scope authority predicate SHARED by these routes and the Campaign
 *  Intelligence Analyst's chat tools (`agentTools.ts`) — ONE check, so the
 *  route and the tool can never drift on who may read/write an org's campaigns
 *  (the CLAUDE.md "one helper, route + tool both call it" rule). */
export async function orgScopeGranted(tenantId: string, subject: string | undefined, orgId: string, scope: Scope): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
  return access.scopes.includes(scope);
}

async function requireOrgScopeFor(req: Request, orgId: string, scope: Scope): Promise<void> {
  if (!(await orgScopeGranted(tenantOf(req), actingUserOf(req), orgId, scope))) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope, orgId });
  }
}

export function registerCampaignIntelRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/host/openwop-app/campaign-intel';

  app.get(`${BASE}/budget`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = requireString(req.query.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:read');
      const campaignId = typeof req.query.campaignId === 'string' && req.query.campaignId.length > 0 ? req.query.campaignId : undefined;
      const records = await listRecords(tenantOf(req), orgId, campaignId);
      res.json(optimizeBudget(records));
    } catch (err) { next(err); }
  });

  // ADR 0357 P1 — the goal-based budget engine ("$X → N conversions"):
  // deterministic feasibility + efficiency-weighted allocation + pacing +
  // confidence, plus optional scenario shifts. Money math is never LLM-made.
  app.post(`${BASE}/plan-budget`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const body = (req.body ?? {}) as { orgId?: unknown; totalBudgetMinor?: unknown; targetConversions?: unknown; horizonDays?: unknown; platforms?: unknown; scenario?: unknown };
      const orgId = requireString(body.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:read');
      const n = (v: unknown, field: string): number => {
        const x = Number(v);
        if (!Number.isFinite(x) || x <= 0) throw new OpenwopError('validation_error', `\`${field}\` MUST be a positive number.`, 400, { field });
        return Math.floor(x);
      };
      const records = await listRecords(tenantOf(req), orgId);
      const plan = planBudget(records, {
        totalBudgetMinor: n(body.totalBudgetMinor, 'totalBudgetMinor'),
        targetConversions: n(body.targetConversions, 'targetConversions'),
        horizonDays: n(body.horizonDays, 'horizonDays'),
        ...(Array.isArray(body.platforms) ? { platforms: body.platforms.filter((x): x is string => typeof x === 'string') } : {}),
      });
      const sc = body.scenario as { from?: unknown; to?: unknown; pct?: unknown } | undefined;
      const scenario = sc && typeof sc.from === 'string' && typeof sc.to === 'string' && typeof sc.pct === 'number'
        ? scenarioShift(plan, sc.from, sc.to, sc.pct) : undefined;
      res.json({ plan, ...(scenario ? { scenario } : {}) });
    } catch (err) { next(err); }
  });

  // ADR 0357 P2 — rolling-stats anomalies (|z|≥3, min 7 points per series).
  app.get(`${BASE}/anomalies`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = requireString(req.query.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:read');
      res.json({ anomalies: detectAnomalies(await listRecords(tenantOf(req), orgId)) });
    } catch (err) { next(err); }
  });

  // ADR 0357 P4 — funnel + top/bottom performer read models.
  app.get(`${BASE}/overview`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = requireString(req.query.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:read');
      const records = await listRecords(tenantOf(req), orgId);
      res.json({ funnel: funnelByPlatform(records), performers: topBottomPerformers(records) });
    } catch (err) { next(err); }
  });

  // ADR 0357 P3 — apply a budget recommendation through the EXISTING governed
  // write path: ctx-equivalent adsAdapter.updateBudget behind the spend gate
  // (threshold → requires_approval; policy-disabled → refused). One-click UX,
  // ZERO new write paths — the outcome (incl. approvalId) returns verbatim.
  app.post(`${BASE}/recommendations/apply`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const body = (req.body ?? {}) as { orgId?: unknown; platform?: unknown; adAccountId?: unknown; campaignId?: unknown; dailyBudgetMinor?: unknown; dryRun?: unknown };
      const orgId = requireString(body.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      const platformRaw = requireString(body.platform, 'platform');
      if (!(APPLY_PLATFORMS as readonly string[]).includes(platformRaw)) {
        throw new OpenwopError('validation_error', `\`platform\` must be one of: ${APPLY_PLATFORMS.join(', ')}.`, 400, { field: 'platform' });
      }
      const platform = platformRaw as AdPlatform;
      const budget = Number(body.dailyBudgetMinor);
      if (!Number.isFinite(budget) || budget <= 0) throw new OpenwopError('validation_error', '`dailyBudgetMinor` MUST be a positive number.', 400, { field: 'dailyBudgetMinor' });
      const { makeAdsAdapter } = await import('../../host/adsAdapter.js');
      const { hostExtStorage } = await import('../../host/hostExtPersistence.js');
      const { randomUUID } = await import('node:crypto');
      const adapter = makeAdsAdapter({
        storage: hostExtStorage(), tenantId: tenantOf(req), runId: `hostext:intel-apply:${randomUUID()}`,
        ...(actingUserOf(req) ? { actingUserId: actingUserOf(req) as string } : {}), orgId,
      });
      const op = { platform, adAccountId: requireString(body.adAccountId, 'adAccountId'), campaignId: requireString(body.campaignId, 'campaignId'), dailyBudgetMinor: Math.floor(budget) };
      const result = await adapter.updateBudget({ ...op, ...(body.dryRun === true ? { dryRun: true } : {}) });
      // ADR 0952 D3 / finding P3 — the outcome stamps back into the plan store.
      await recordRouteApply(tenantOf(req), orgId, actingUserOf(req), op, result);
      res.json(result);
    } catch (err) { next(err); }
  });

  // C5 (ADR 0219) — the last-click attribution join, computed at read time.
  app.get(`${BASE}/attribution`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = requireString(req.query.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:read');
      res.json(await buildAttribution(tenantOf(req), orgId));
    } catch (err) { next(err); }
  });

  // C7 (ADR 0220) — pacing report (pure read; alerts ride the scheduled chain).
  app.get(`${BASE}/pacing`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = requireString(req.query.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:read');
      res.json(await buildPacing(tenantOf(req), orgId));
    } catch (err) { next(err); }
  });

  // ADR 0952 D2 — hard spend caps. Reading needs workspace:read; creating or
  // LOWERING a cap needs workspace:write (it only ever stops spend). RAISING or
  // deleting one lets more money out, so until ADR 0952 P4 routes it through the
  // ADR 0942 gate it needs the org admin scope (host:org:manage).
  app.get(`${BASE}/caps`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = requireString(req.query.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:read');
      const caps = await listCaps(tenantOf(req), orgId);
      res.json({ caps: await Promise.all(caps.map(async (cap) => ({ ...cap, state: await getCapState(cap) }))) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/caps`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const orgId = requireString(body.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      const actor = actingUserOf(req);
      if (!actor) throw new OpenwopError('unauthenticated', 'A signed-in caller is required.', 401);
      res.status(201).json(await createCap(tenantOf(req), orgId, body, actor));
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/caps/:capId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const body = (req.body ?? {}) as { orgId?: unknown; limitMinor?: unknown; version?: unknown };
      const orgId = requireString(body.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:read');
      const cap = await getCap(tenantOf(req), orgId, String(req.params.capId));
      if (!cap) throw new OpenwopError('not_found', 'Spend cap not found.', 404);
      const limit = Number(body.limitMinor);
      await requireOrgScopeFor(req, orgId, Number.isFinite(limit) && limit > cap.limitMinor ? 'host:org:manage' : 'workspace:write');
      res.json(await setCapLimit(cap, body.limitMinor, body.version));
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/caps/:capId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = requireString(req.query.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:read');
      const cap = await getCap(tenantOf(req), orgId, String(req.params.capId));
      if (!cap) throw new OpenwopError('not_found', 'Spend cap not found.', 404);
      await requireOrgScopeFor(req, orgId, 'host:org:manage');
      await deleteCap(cap);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ADR 0952 D3 — reallocation plans (the reallocate chain's proposals and the
  // one-click route's stamp-backs). Applying an APPROVED plan uses the caller's
  // ad connections and needs workspace:write; the approval is the spend gate.
  app.get(`${BASE}/reallocations`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = requireString(req.query.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:read');
      res.json({ plans: await listPlans(tenantOf(req), orgId) });
    } catch (err) { next(err); }
  });

  // ADR 0952 D4 — the two staged alert actions a person confirms on the page.
  // Propose: ONE plan + ONE approval, no budget changes (workspace:write: it reads
  // live budgets through the caller's ad connections and opens an approval).
  app.post(`${BASE}/reallocations/propose`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = requireString((req.body ?? {}).orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      const actor = actingUserOf(req);
      if (!actor) throw new OpenwopError('unauthenticated', 'A signed-in caller is required.', 401);
      const { makeAdsAdapter } = await import('../../host/adsAdapter.js');
      const { hostExtStorage } = await import('../../host/hostExtPersistence.js');
      const { randomUUID } = await import('node:crypto');
      const runId = `hostext:realloc-propose:${randomUUID()}`;
      const adapter = makeAdsAdapter({ storage: hostExtStorage(), tenantId: tenantOf(req), runId, actingUserId: actor, orgId });
      const out = await proposeReallocation(adapter, tenantOf(req), orgId, { runId, actor });
      res.json(out.outcome === 'no_change' ? out : { outcome: 'proposed', plan: out.plan });
    } catch (err) { next(err); }
  });

  // Pause: every platform campaign of one MarketingCampaign. Ungated (the safe
  // direction), workspace:write, the caller's ad connections.
  app.post(`${BASE}/pause`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const body = (req.body ?? {}) as { orgId?: unknown; campaignId?: unknown };
      const orgId = requireString(body.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      const actor = actingUserOf(req);
      if (!actor) throw new OpenwopError('unauthenticated', 'A signed-in caller is required.', 401);
      const campaignId = requireString(body.campaignId, 'campaignId');
      const { makeAdsAdapter } = await import('../../host/adsAdapter.js');
      const { hostExtStorage } = await import('../../host/hostExtPersistence.js');
      const adapter = makeAdsAdapter({ storage: hostExtStorage(), tenantId: tenantOf(req), runId: `hostext:intel-pause:${campaignId}`, actingUserId: actor, orgId });
      const out = await pauseMarketingCampaign(adapter, tenantOf(req), orgId, campaignId);
      if (!out) throw new OpenwopError('not_found', 'Campaign not found in this org.', 404);
      res.json({ results: out });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/reallocations/:planId/apply`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = requireString((req.body ?? {}).orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      const actor = actingUserOf(req);
      if (!actor) throw new OpenwopError('unauthenticated', 'A signed-in caller is required.', 401);
      const { makeAdsAdapter } = await import('../../host/adsAdapter.js');
      const { hostExtStorage } = await import('../../host/hostExtPersistence.js');
      const adapter = makeAdsAdapter({ storage: hostExtStorage(), tenantId: tenantOf(req), runId: `hostext:realloc-apply:${String(req.params.planId)}`, actingUserId: actor, orgId });
      const out = await applyReallocation(adapter, tenantOf(req), orgId, String(req.params.planId));
      if (out.outcome === 'not_found') throw new OpenwopError('not_found', 'Reallocation plan not found.', 404);
      res.json({ outcome: out.outcome, plan: out.plan, ...(out.outcome === 'requires_approval' ? { approvalId: out.approvalId } : {}) });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/forecast`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = requireString(req.query.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:read');
      const campaignId = typeof req.query.campaignId === 'string' && req.query.campaignId.length > 0 ? req.query.campaignId : undefined;
      const records = await listRecords(tenantOf(req), orgId, campaignId);
      res.json({ forecasts: forecastCampaigns(records) });
    } catch (err) { next(err); }
  });

  // ── ADR 0956 D5 — UTM governance (per client org) ──
  const ORG = `${BASE}/orgs/:orgId`;
  const userOrUnknown = (req: Request): string => actingUserOf(req) ?? 'unknown';

  app.get(`${ORG}/utm-policy`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireOrgScopeFor(req, req.params.orgId, 'workspace:read');
      res.json(await getUtmPolicy(tenantOf(req), req.params.orgId));
    } catch (err) { next(err); }
  });

  app.put(`${ORG}/utm-policy`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireOrgScopeFor(req, req.params.orgId, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const expected = typeof body.expectedVersion === 'number' && Number.isInteger(body.expectedVersion) ? body.expectedVersion : NaN;
      if (Number.isNaN(expected)) throw new OpenwopError('validation_error', 'expectedVersion is required (0 when no policy is saved yet).', 400, { field: 'expectedVersion' });
      const row = await setUtmPolicy(tenantOf(req), req.params.orgId, parseUtmPolicy(body), expected, userOrUnknown(req));
      res.json({ policy: row.policy, version: row.version, isDefault: false });
    } catch (err) { next(err); }
  });

  // The linter as a read: which of these links break the org's policy.
  app.post(`${ORG}/utm-lint`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireOrgScopeFor(req, req.params.orgId, 'workspace:read');
      const urls = (req.body ?? {}).urls;
      if (!Array.isArray(urls) || urls.length === 0 || urls.length > 100 || !urls.every((u) => typeof u === 'string' && u.length <= 4096)) {
        throw new OpenwopError('validation_error', 'urls must be a list of 1–100 links.', 400, { field: 'urls' });
      }
      res.json(await lintUrls(tenantOf(req), req.params.orgId, urls as string[]));
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/utm-aliases`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireOrgScopeFor(req, req.params.orgId, 'workspace:read');
      res.json({ aliases: await listAliases(tenantOf(req), req.params.orgId) });
    } catch (err) { next(err); }
  });

  // A person confirms a mapping; an agent never writes one (no tool).
  app.put(`${ORG}/utm-aliases`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireOrgScopeFor(req, req.params.orgId, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json({ alias: await setAlias(tenantOf(req), req.params.orgId, body.utmCampaign, body.campaignId, userOrUnknown(req)) });
    } catch (err) { next(err); }
  });

  // ── ADR 0956 D1/D2 — attribution settings + the multi-touch model report ──
  app.get(`${ORG}/attribution-settings`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireOrgScopeFor(req, req.params.orgId, 'workspace:read');
      res.json(await getAttributionSettings(tenantOf(req), req.params.orgId));
    } catch (err) { next(err); }
  });

  app.put(`${ORG}/attribution-settings`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireOrgScopeFor(req, req.params.orgId, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const expected = typeof body.expectedVersion === 'number' && Number.isInteger(body.expectedVersion) ? body.expectedVersion : NaN;
      if (Number.isNaN(expected)) throw new OpenwopError('validation_error', 'expectedVersion is required (0 when no settings are saved yet).', 400, { field: 'expectedVersion' });
      const saved = await setAttributionSettings(tenantOf(req), req.params.orgId, parseAttributionSettings(body), expected, userOrUnknown(req));
      res.json({ ...saved, isDefault: false });
    } catch (err) { next(err); }
  });

  // One model at a time, every model beside it; modelled web credit only.
  app.get(`${ORG}/attribution/models`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireFeatureEnabled(req, MULTI_TOUCH_TOGGLE, 'Multi-touch attribution');
      await requireOrgScopeFor(req, req.params.orgId, 'workspace:read');
      const raw = req.query.model;
      if (raw !== undefined && !isAttributionModel(raw)) {
        throw new OpenwopError('validation_error', `model must be one of: ${ATTRIBUTION_MODELS.join(', ')}.`, 400, { field: 'model' });
      }
      res.json(await buildModelReport(tenantOf(req), req.params.orgId, isAttributionModel(raw) ? raw : undefined));
    } catch (err) { next(err); }
  });

  // ── ADR 0956 D6 — reconciliation + AdMap. Last click unless the multi-touch
  // sub-toggle is on; the report names the model it used either way. ──
  const modelFor = (req: Request): Promise<AttributionModel | undefined> => resolveReadModel(tenantOf(req), actingUserOf(req), req.query.model);

  app.get(`${ORG}/reconciliation`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireOrgScopeFor(req, req.params.orgId, 'workspace:read');
      res.json(await buildReconciliation(tenantOf(req), req.params.orgId, await modelFor(req)));
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/admap`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireOrgScopeFor(req, req.params.orgId, 'workspace:read');
      res.json(await buildAdMap(tenantOf(req), req.params.orgId, await modelFor(req)));
    } catch (err) { next(err); }
  });

  app.delete(`${ORG}/utm-aliases/:utmCampaign`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireOrgScopeFor(req, req.params.orgId, 'workspace:write');
      const deleted = await deleteAlias(tenantOf(req), req.params.orgId, req.params.utmCampaign, userOrUnknown(req));
      if (!deleted) throw new OpenwopError('not_found', 'Alias not found.', 404, {});
      res.json({ deleted: true });
    } catch (err) { next(err); }
  });
}
