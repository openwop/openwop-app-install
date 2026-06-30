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
import { optimizeBudget, forecastCampaigns } from './intelligence.js';

const TOGGLE_ID = 'campaign-intel';
const LABEL = 'Campaign Intelligence';

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

async function requireOrgScopeFor(req: Request, orgId: string, scope: Scope): Promise<void> {
  const access = await resolveEffectiveAccess(tenantOf(req), { subject: actingUserOf(req), orgId });
  if (!access.scopes.includes(scope)) {
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
