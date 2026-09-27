/**
 * CMS page-experiment routes (ADR 0236 — campaign gap D1). Org-scoped under the
 * CMS base like its siblings; tenant+org IDOR-guarded in the service:
 *   list/get/results            → workspace:read
 *   create/edit/delete (draft)  → workspace:write   (translator grants: 403 —
 *                                 an experiment controls served base content)
 *   start/stop/promote          → host:members:manage (they change what the
 *                                 PUBLIC surface serves — the publish tier)
 * Promote respects the `cms-approval-gate`: a gated org gets restore + submit
 * (the inbox stays the only publish path) and an honest `pendingApproval: true`.
 *
 * @see docs/adr/0236-cms-page-experiments.md
 */

import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireString } from '../featureRoute.js';
import { requireCmsScope } from './cmsScope.js';
import { getLocaleGrant } from './cmsService.js';
import {
  createExperiment,
  deleteExperiment,
  experimentResults,
  getExperiment,
  listExperiments,
  promoteExperiment,
  startExperiment,
  stopExperiment,
  updateExperiment,
} from './pageExperimentsService.js';

export function registerPageExperimentRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/cms/orgs/:orgId/pages/:pageId/experiments';

  // ADR 0205 D1 — a translator grant is overlay-only; experiment writes steer
  // base content on the public surface, so grant-holders are 403 (mirrors the
  // cms routes' denyIfTranslator).
  const denyIfTranslator = async (tenantId: string, orgId: string, subject: string): Promise<void> => {
    if (await getLocaleGrant(tenantId, orgId, subject)) {
      throw new OpenwopError('forbidden_scope', 'Your translator grant covers locale overlays only.', 403, {});
    }
  };

  function notFound(experimentId: string): never {
    throw new OpenwopError('not_found', 'Experiment not found.', 404, { experimentId });
  }

  app.get(BASE, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireCmsScope(req, 'workspace:read');
      res.json({ experiments: await listExperiments(tenantId, orgId, req.params.pageId) });
    } catch (err) { next(err); }
  });

  app.post(BASE, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireCmsScope(req, 'workspace:write');
      await denyIfTranslator(tenantId, orgId, user.userId);
      const body = (req.body ?? {}) as { name?: unknown; variants?: unknown };
      const exp = await createExperiment({
        tenantId,
        orgId,
        pageId: req.params.pageId,
        name: requireString(body.name, 'name'),
        variants: body.variants,
        createdBy: user.userId,
      });
      res.status(201).json(exp);
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/:experimentId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireCmsScope(req, 'workspace:read');
      const exp = await getExperiment(tenantId, orgId, req.params.pageId, req.params.experimentId);
      if (!exp) notFound(req.params.experimentId);
      res.json(exp);
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/:experimentId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireCmsScope(req, 'workspace:write');
      await denyIfTranslator(tenantId, orgId, user.userId);
      const body = (req.body ?? {}) as { name?: unknown; variants?: unknown };
      const patch: { name?: string; variants?: unknown } = {};
      if (typeof body.name === 'string') patch.name = body.name;
      if (body.variants !== undefined) patch.variants = body.variants;
      const exp = await updateExperiment(tenantId, orgId, req.params.pageId, req.params.experimentId, patch, user.userId);
      if (!exp) notFound(req.params.experimentId);
      res.json(exp);
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/:experimentId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireCmsScope(req, 'workspace:write');
      await denyIfTranslator(tenantId, orgId, user.userId);
      const ok = await deleteExperiment(tenantId, orgId, req.params.pageId, req.params.experimentId, user.userId);
      if (!ok) notFound(req.params.experimentId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/:experimentId/start`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireCmsScope(req, 'host:members:manage');
      const exp = await startExperiment(tenantId, orgId, req.params.pageId, req.params.experimentId, user.userId);
      if (!exp) notFound(req.params.experimentId);
      res.json(exp);
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/:experimentId/stop`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireCmsScope(req, 'host:members:manage');
      const exp = await stopExperiment(tenantId, orgId, req.params.pageId, req.params.experimentId, user.userId);
      if (!exp) notFound(req.params.experimentId);
      res.json(exp);
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/:experimentId/promote`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await requireCmsScope(req, 'host:members:manage');
      const body = (req.body ?? {}) as { variantKey?: unknown };
      const result = await promoteExperiment(
        tenantId,
        orgId,
        req.params.pageId,
        req.params.experimentId,
        requireString(body.variantKey, 'variantKey'),
        user.userId,
      );
      if (!result) notFound(req.params.experimentId);
      res.json(result);
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/:experimentId/results`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await requireCmsScope(req, 'workspace:read');
      const results = await experimentResults(tenantId, orgId, req.params.pageId, req.params.experimentId);
      if (!results) notFound(req.params.experimentId);
      res.json(results);
    } catch (err) { next(err); }
  });
}
