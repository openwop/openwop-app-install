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
import { buildAttribution } from './attribution.js';
import { buildPacing } from './pacing.js';

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
  const BASE = '/v1/host/openwop-app/campaign-intel';

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
      const result = await adapter.updateBudget({
        platform,
        adAccountId: requireString(body.adAccountId, 'adAccountId'),
        campaignId: requireString(body.campaignId, 'campaignId'),
        dailyBudgetMinor: Math.floor(budget),
        ...(body.dryRun === true ? { dryRun: true } : {}),
      });
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
}
