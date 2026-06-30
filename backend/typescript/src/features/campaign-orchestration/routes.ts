/**
 * Campaign Studio routes (ADR 0158) — host-extension under
 * /v1/host/openwop-app/campaign-orchestration/*. The MarketingCampaign container + a
 * REST finalize (reads a confirmed brief, upserts the campaign).
 *
 * Gating, fail-closed (ADR 0006): toggle `campaign-studio` ON → RBAC in the
 * entity's org (read = workspace:read, miss → uniform 404; write = workspace:write).
 *
 * @see docs/adr/0158-campaign-studio-orchestration.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { requireFeatureEnabled, requireString } from '../featureRoute.js';
import { getBrief } from '../campaign-brief/briefService.js';
import {
  listCampaigns, getCampaign, finalizeFromBrief, updateCampaignStatus, renameCampaign, deleteCampaign,
} from './campaignService.js';
import type { CampaignStatus, MarketingCampaign } from './types.js';

const TOGGLE_ID = 'campaign-orchestration';
const LABEL = 'Campaign Studio';
const STATUSES: ReadonlyArray<CampaignStatus> = ['draft', 'active', 'paused', 'completed', 'archived'];

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

async function hasOrgScope(req: Request, orgId: string, scope: Scope): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantOf(req), { subject: actingUserOf(req), orgId });
  return access.scopes.includes(scope);
}
async function requireOrgScopeFor(req: Request, orgId: string, scope: Scope): Promise<void> {
  if (!(await hasOrgScope(req, orgId, scope))) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope, orgId });
  }
}
async function loadCampaignScoped(req: Request, scope: Scope): Promise<MarketingCampaign> {
  const campaign = await getCampaign(tenantOf(req), req.params.campaignId);
  if (!campaign || !(await hasOrgScope(req, campaign.orgId, 'workspace:read'))) {
    throw new OpenwopError('not_found', 'Campaign not found.', 404, { campaignId: req.params.campaignId });
  }
  if (scope !== 'workspace:read') await requireOrgScopeFor(req, campaign.orgId, scope);
  return campaign;
}

export function registerCampaignStudioRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/campaign-orchestration';

  app.get(`${BASE}/campaigns`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = typeof req.query.orgId === 'string' && req.query.orgId.length > 0 ? req.query.orgId : undefined;
      const all = await listCampaigns(tenantOf(req), orgId);
      const out: MarketingCampaign[] = [];
      const readable = new Map<string, boolean>();
      for (const c of all) {
        let ok = readable.get(c.orgId);
        if (ok === undefined) { ok = await hasOrgScope(req, c.orgId, 'workspace:read'); readable.set(c.orgId, ok); }
        if (ok) out.push(c);
      }
      res.json({ campaigns: out });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/campaigns/:campaignId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      res.json({ campaign: await loadCampaignScoped(req, 'workspace:read') });
    } catch (err) { next(err); }
  });

  // Finalize: read a brief, upsert its campaign (one per brief).
  app.post(`${BASE}/finalize`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const briefId = requireString((req.body ?? {})?.briefId, 'briefId');
      const brief = await getBrief(tenantOf(req), briefId);
      if (!brief || !(await hasOrgScope(req, brief.orgId, 'workspace:read'))) {
        throw new OpenwopError('not_found', 'Brief not found.', 404, { briefId });
      }
      await requireOrgScopeFor(req, brief.orgId, 'workspace:write');
      const campaign = await finalizeFromBrief(tenantOf(req), brief, actingUserOf(req) ?? 'unknown');
      res.status(201).json({ campaign });
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/campaigns/:campaignId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const campaign = await loadCampaignScoped(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      let updated: MarketingCampaign | null = campaign;
      if (typeof body.name === 'string') updated = await renameCampaign(tenantOf(req), campaign.id, body.name);
      if (typeof body.status === 'string' && STATUSES.includes(body.status as CampaignStatus)) {
        updated = await updateCampaignStatus(tenantOf(req), campaign.id, body.status as CampaignStatus);
      }
      if (!updated) throw new OpenwopError('not_found', 'Campaign not found.', 404, { campaignId: campaign.id });
      res.json({ campaign: updated });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/campaigns/:campaignId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const campaign = await loadCampaignScoped(req, 'workspace:write');
      await deleteCampaign(tenantOf(req), campaign.id);
      res.json({ deleted: true, campaignId: campaign.id });
    } catch (err) { next(err); }
  });
}
