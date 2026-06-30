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
import { requireFeatureEnabled, requireString } from '../featureRoute.js';
import { importCsv, listRecords, kpiSummary } from './performanceService.js';
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
      const result = await importCsv(tenantOf(req), orgId, csv, {
        ...(mapping ? { mapping } : {}),
        ...(defaultPlatform ? { defaultPlatform } : {}),
        ...(campaignId ? { campaignId } : {}),
      });
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
}
