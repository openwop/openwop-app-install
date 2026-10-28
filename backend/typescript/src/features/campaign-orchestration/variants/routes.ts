/**
 * ADR 0946 P0 — VariantSet routes, host-extension under
 * /v1/host/openwop-app/campaign-orchestration/campaigns/:campaignId/variant-sets.
 *
 * Gating, fail-closed: `campaign-orchestration`, its sub-toggle
 * `campaign-orchestration.variant-factory` and `creative-briefs` must all be ON
 * (ADR 0946 matrix #2). Access rides the campaign's own scoped read
 * (`loadCampaignScoped`): a campaign the caller cannot read, in any org or
 * tenant, is a uniform 404, and a set is only ever looked up under the
 * campaign it was created in.
 *
 * @see docs/adr/0946-creative-variant-factory.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../../types.js';
import type { RouteDeps } from '../../../routes/registerAllRoutes.js';
import { requireFeatureEnabled } from '../../featureRoute.js';
import { loadCampaignScoped } from '../routes.js';
import {
  createVariantSet, getVariantSet, listVariantSets, listVariantSetVersions, parseVariantSetContent, reviseVariantSet,
} from './variantSetService.js';

export const VARIANT_FACTORY_TOGGLE = 'campaign-orchestration.variant-factory';

async function requireVariantFactory(req: Request): Promise<void> {
  await requireFeatureEnabled(req, 'campaign-orchestration', 'Campaign Studio');
  await requireFeatureEnabled(req, VARIANT_FACTORY_TOGGLE, 'Creative variant factory');
  await requireFeatureEnabled(req, 'creative-briefs', 'Creative briefs');
}

const actorOf = (req: Request): string => req.userId ?? req.principal?.principalId ?? 'unknown';

function setNotFound(setId: string): OpenwopError {
  return new OpenwopError('not_found', 'Variant set not found.', 404, { setId });
}

function parseVersion(raw: unknown, field: string): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new OpenwopError('validation_error', `${field} must be a positive integer.`, 400, { field });
  return n;
}

export function registerVariantSetRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/host/openwop-app/campaign-orchestration/campaigns/:campaignId/variant-sets';

  app.get(BASE, async (req, res, next) => {
    try {
      await requireVariantFactory(req);
      const campaign = await loadCampaignScoped(req, 'workspace:read');
      res.json({ variantSets: await listVariantSets(campaign.tenantId, campaign.id) });
    } catch (err) { next(err); }
  });

  app.post(BASE, async (req, res, next) => {
    try {
      await requireVariantFactory(req);
      const campaign = await loadCampaignScoped(req, 'workspace:write');
      const content = await parseVariantSetContent(campaign.tenantId, campaign.orgId, req.body);
      res.status(201).json({ variantSet: await createVariantSet(campaign, content, actorOf(req)) });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/:setId`, async (req, res, next) => {
    try {
      await requireVariantFactory(req);
      const campaign = await loadCampaignScoped(req, 'workspace:read');
      const set = await getVariantSet(campaign.tenantId, campaign.id, req.params.setId);
      if (!set) throw setNotFound(req.params.setId);
      res.json({ variantSet: set });
    } catch (err) { next(err); }
  });

  // Revise: `{ baseVersion, concepts, members }`. A new version, or the head
  // unchanged when the content hash did not move.
  app.put(`${BASE}/:setId`, async (req, res, next) => {
    try {
      await requireVariantFactory(req);
      const campaign = await loadCampaignScoped(req, 'workspace:write');
      if (!(await getVariantSet(campaign.tenantId, campaign.id, req.params.setId))) throw setNotFound(req.params.setId);
      const baseVersion = parseVersion((req.body ?? {}).baseVersion, 'baseVersion');
      const content = await parseVariantSetContent(campaign.tenantId, campaign.orgId, req.body);
      const out = await reviseVariantSet(campaign, req.params.setId, baseVersion, content, actorOf(req));
      if (!out) throw setNotFound(req.params.setId);
      res.status(out.changed ? 201 : 200).json({ variantSet: out.set, changed: out.changed });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/:setId/versions`, async (req, res, next) => {
    try {
      await requireVariantFactory(req);
      const campaign = await loadCampaignScoped(req, 'workspace:read');
      const versions = await listVariantSetVersions(campaign.tenantId, campaign.id, req.params.setId);
      if (versions.length === 0) throw setNotFound(req.params.setId);
      res.json({ versions });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/:setId/versions/:version`, async (req, res, next) => {
    try {
      await requireVariantFactory(req);
      const campaign = await loadCampaignScoped(req, 'workspace:read');
      const set = await getVariantSet(campaign.tenantId, campaign.id, req.params.setId, parseVersion(req.params.version, 'version'));
      if (!set) throw setNotFound(req.params.setId);
      res.json({ variantSet: set });
    } catch (err) { next(err); }
  });
}
