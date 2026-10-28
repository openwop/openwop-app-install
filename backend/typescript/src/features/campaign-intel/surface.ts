/**
 * Campaign Intelligence workflow surface (ADR 0160 / ADR 0014) —
 * `ctx.features['campaign-intel']`. Tenant-trusted budget + forecast reads the
 * intel nodes call. Composes the performance store (ADR 0159).
 *
 * @see docs/adr/0160-campaign-studio-intelligence.md
 */

import { OpenwopError } from '../../types.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listRecords } from '../campaign-connectors/performanceService.js';
import { optimizeBudget, forecastCampaigns } from './intelligence.js';
import { buildAttribution, buildModelReport } from './attribution.js';
import { MULTI_TOUCH_TOGGLE, resolveReadModel } from './attributionSettings.js';
import { ATTRIBUTION_MODELS, isAttributionModel, type AttributionModel } from './attributionModels.js';
import { buildReconciliation } from './reconciliation.js';
import { buildAdMap } from './adMap.js';
import { buildPacing, runPacingCheck } from './pacing.js';
import { enforceCaps, listCaps, CAPS_TOGGLE_ID } from './spendCaps.js';
import { proposeReallocation, applyReallocation } from './reallocation.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { makeAdsAdapter } from '../../host/adsAdapter.js';
import { assertOrgScope, assertRunScopeOrg } from '../../host/accessControlService.js';

export function buildCampaignIntelSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  const surfaceModel = (raw: unknown): Promise<AttributionModel | undefined> => resolveReadModel(tenantId, scope.actingUserId, raw);
  /** Toggle on + a run owner with workspace:write in the org ⇒ an adapter on their connections. */
  const ownerGate = async (orgId: string): Promise<{ outcome: string; error?: string } | { adapter: ReturnType<typeof makeAdsAdapter>; orgId: string; actingUserId: string }> => {
    if (!orgId) return { outcome: 'invalid', error: 'orgId is required' };
    if (!(await resolveOne(CAPS_TOGGLE_ID, { tenantId }))?.enabled) return { outcome: 'disabled' };
    const actingUserId = scope.actingUserId;
    if (!actingUserId) return { outcome: 'no_acting_user' };
    await assertOrgScope(tenantId, actingUserId, orgId, 'workspace:write', { ...(scope.personalTenant ? { personalTenant: scope.personalTenant } : {}) });
    return { adapter: makeAdsAdapter({ storage: hostExtStorage(), tenantId, runId: scope.runId ?? `hostext:campaign-intel:${orgId}`, actingUserId, orgId }), orgId, actingUserId };
  };
  return {
    // ADR 0357 P1/P2 — deterministic goal planning + anomalies for nodes/agents.
    planBudget: async (args) => {
      const { listRecords } = await import('../campaign-connectors/performanceService.js');
      const { planBudget } = await import('./budgetPlanner.js');
      // Mirror the route's positive-finite guard: NaN/zero/negative goals must
      // not reach the money math (node args are as untrusted as HTTP bodies).
      const n = (v: unknown, field: string): number => {
        const x = Number(v);
        if (!Number.isFinite(x) || x <= 0) {
          throw new OpenwopError('validation_error', `\`${field}\` MUST be a positive number.`, 400, { field });
        }
        return Math.floor(x);
      };
      const records = await listRecords(tenantId, String(args.orgId ?? ''));
      const plan = planBudget(records, {
        totalBudgetMinor: n(args.totalBudgetMinor, 'totalBudgetMinor'),
        targetConversions: n(args.targetConversions, 'targetConversions'),
        horizonDays: n(args.horizonDays ?? 90, 'horizonDays'),
        ...(Array.isArray(args.platforms) ? { platforms: (args.platforms as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
      });
      return { plan };
    },
    anomalies: async (args) => {
      const { listRecords } = await import('../campaign-connectors/performanceService.js');
      const { detectAnomalies } = await import('./budgetPlanner.js');
      return { anomalies: detectAnomalies(await listRecords(tenantId, String(args.orgId ?? ''))) };
    },
    optimizeBudget: async (args) => {
      const records = await listRecords(tenantId, str(args.orgId), optStr(args.campaignId));
      return { ...optimizeBudget(records) };
    },
    forecast: async (args) => {
      const records = await listRecords(tenantId, str(args.orgId), optStr(args.campaignId));
      return { forecasts: forecastCampaigns(records) };
    },
    // C5 (ADR 0219) — attribution join; C7 (ADR 0220) — pacing (read + alerting check).
    attribution: async (args) => ({ ...(await buildAttribution(tenantId, str(args.orgId))) }),
    pacing: async (args) => ({ ...(await buildPacing(tenantId, str(args.orgId))) }),
    pacingCheck: async (args) => ({ ...(await runPacingCheck(tenantId, str(args.orgId))) }),
    // ADR 0952 D2 — the spend-cap watchdog's ONE call (the scheduled
    // `enforce-caps` node). Acts as the RUN OWNER (a schedule fires as its
    // creator, ADR 0816 D8): the broker resolves that person's ad connections,
    // and pausing needs workspace:write in the org. No owner ⇒ refused, never a
    // system-identity pause. Toggle + plan (ADR 0819 resolveOne).
    // ADR 0952 D3 — the reallocate chain's two calls. Both act as the RUN OWNER
    // (their ad connections read the live budgets) with workspace:write in the org.
    proposeReallocation: async (args) => {
      const gate = await ownerGate(str(args.orgId));
      if ('outcome' in gate) return gate;
      const out = await proposeReallocation(gate.adapter, tenantId, gate.orgId, {
        ...(args.recommendation !== undefined ? { recommendation: args.recommendation } : {}),
        ...(args.ops !== undefined ? { ops: args.ops } : {}),
        ...(optStr(args.campaignId) ? { campaignId: str(args.campaignId) } : {}),
        runId: scope.runId ?? 'surface', actor: gate.actingUserId,
      });
      // Which recommendation the plan was built from: the upstream node's (the
      // chain edge) or recomputed here. A run record should say, not imply.
      const recommendationSource = args.ops !== undefined ? 'ops' : args.recommendation !== undefined ? 'upstream' : 'recomputed';
      return out.outcome === 'no_change'
        ? { ...out, recommendationSource }
        : { outcome: 'proposed', planId: out.plan.planId, approvalId: out.plan.approvalId, ops: out.plan.ops, dropped: out.plan.dropped, recommendationSource };
    },
    applyReallocation: async (args) => {
      const planId = str(args.planId);
      if (!planId) return { outcome: 'no_plan' };
      const gate = await ownerGate(str(args.orgId));
      if ('outcome' in gate) return gate;
      const out = await applyReallocation(gate.adapter, tenantId, gate.orgId, planId);
      if (out.outcome === 'not_found') return { outcome: 'not_found' };
      return { outcome: out.outcome, planId, status: out.plan.status, results: out.plan.results, ...(out.outcome === 'requires_approval' ? { approvalId: out.approvalId } : {}) };
    },
    enforceCaps: async (args) => {
      const orgId = str(args.orgId);
      if (!orgId) return { outcome: 'invalid', error: 'orgId is required' };
      if (!(await resolveOne(CAPS_TOGGLE_ID, { tenantId }))?.enabled) return { outcome: 'disabled' };
      // An org with no caps has nothing to enforce: no identity is needed, so the
      // pacing chain this node rides keeps running green for it.
      if ((await listCaps(tenantId, orgId)).length === 0) return { outcome: 'enforced', caps: [] };
      const actingUserId = scope.actingUserId;
      if (!actingUserId) return { outcome: 'no_acting_user' };
      await assertOrgScope(tenantId, actingUserId, orgId, 'workspace:write', { ...(scope.personalTenant ? { personalTenant: scope.personalTenant } : {}) });
      const adapter = makeAdsAdapter({ storage: hostExtStorage(), tenantId, runId: scope.runId ?? `hostext:spend-caps:${orgId}`, actingUserId, orgId });
      return { outcome: 'enforced', caps: await enforceCaps(adapter, tenantId, orgId) };
    },
    /** ADR 0956 D2 `attribution-models` — conversions credited under one model
     *  (default: the org's), every model beside it. Refuses while the
     *  `campaign-intel.multi-touch` sub-toggle is off; floors the run's person
     *  on the org (`assertRunScopeOrg`). */
    attributionModels: async (args) => {
      const orgId = str(args.orgId);
      await assertRunScopeOrg(scope, orgId, 'workspace:read');
      const { resolveOne } = await import('../../host/featureToggles/service.js');
      // The seam's own toggle-off shape (featureSurfaces.ts), for the sub-toggle.
      if (!(await resolveOne(MULTI_TOUCH_TOGGLE, { tenantId, ...(scope.actingUserId ? { userId: scope.actingUserId } : {}) }))?.enabled) {
        throw Object.assign(new Error(`'${MULTI_TOUCH_TOGGLE}' is not enabled for this tenant`), { code: 'host_capability_disabled', capability: `host.sample.${MULTI_TOUCH_TOGGLE}` });
      }
      // A misspelt model is a typed failure, never a silent fall-back to the
      // default (the route's 400, grade-workflows).
      if (args.model !== undefined && !isAttributionModel(args.model)) {
        throw new OpenwopError('validation_error', `model must be one of: ${ATTRIBUTION_MODELS.join(', ')}.`, 400, { field: 'model' });
      }
      return { ...(await buildModelReport(tenantId, orgId, isAttributionModel(args.model) ? args.model : undefined)) };
    },
    /** ADR 0956 D6 `reconciliation` / `ad-map` — platform claims beside measured
     *  credit, and each ad's landing page. Last click unless the multi-touch
     *  sub-toggle is on (a named non-last-click model is then a typed failure).
     *  Floors the run's person on the org (`assertRunScopeOrg`). */
    reconciliation: async (args) => {
      const orgId = str(args.orgId);
      await assertRunScopeOrg(scope, orgId, 'workspace:read');
      return { ...(await buildReconciliation(tenantId, orgId, await surfaceModel(args.model))) };
    },
    adMap: async (args) => {
      const orgId = str(args.orgId);
      await assertRunScopeOrg(scope, orgId, 'workspace:read');
      return { ...(await buildAdMap(tenantId, orgId, await surfaceModel(args.model))) };
    },
    /** ADR 0956 D5 `utm-lint` — which links break the client org's UTM policy.
     *  Floors the run's person on that org (the `assertRunScopeOrg` contract). */
    utmLint: async (args) => {
      const orgId = str(args.orgId);
      await assertRunScopeOrg(scope, orgId, 'workspace:read');
      const urls = (Array.isArray(args.urls) ? args.urls : []).filter((u): u is string => typeof u === 'string' && u.length <= 4096).slice(0, 100); // the lint route's bounds
      const { lintUrls } = await import('./utmGovernance.js');
      return { ...(await lintUrls(tenantId, orgId, urls)) };
    },
  };
}
