/**
 * ADR 0949 P2a — Experiments routes (host-extension, no wire). Every route is
 * toggle-gated (`experiments`) and org-scoped (`authorizeOrgScope`): read needs
 * `workspace:read`, every write `workspace:write`. A row in another org is the
 * same 404 as a missing one (ADR 0921 D3).
 *
 *   GET    …/experiments                 list (?kind=&ref=&status=)
 *   POST   …/experiments                 create a Decide draft
 *   GET    …/experiments/:id             one experiment
 *   PATCH  …/experiments/:id             edit a draft (name, hypothesis, arms, plan draft)
 *   DELETE …/experiments/:id             delete a draft that never launched
 *   POST   …/experiments/:id/lock        lock the plan (409 plan_locked after)
 *   POST   …/experiments/:id/launch      launch (idempotent)
 *   POST   …/experiments/:id/stop        stop
 *   POST   …/experiments/:id/abandon     abandon
 *   POST   …/experiments/:id/epoch       the next Optimize epoch
 *   GET    …/experiments/:id/gates       the ADR 0950 promotion gate checklist
 *   POST   …/experiments/:id/promote     start the ADR 0950 governed promotion (sub-toggle `experiments.auto-promote`)
 *   GET    …/experiments/:id/results     the Decide verdict, or the Optimize model estimate
 *   GET    …/power                       sample size per arm for a plan
 */
import type { Request, Response } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, launchSubjectOf, requireFeatureEnabled } from '../featureRoute.js';
import { AUTO_PROMOTE_TOGGLE, startPromotion } from './promotionService.js';
import { featureAccessRefusal, type LaunchSubject } from '../../host/workflowFeatureGate.js';
import { powerCalc } from '../../host/experiments/decide.js';
import { checkPromotionGates } from '../../host/experiments/promotion.js';
import {
  abandon, createDraft, deleteDraft, getExperiment, launch, listExperiments, lockPlan, optimizeEpoch, results, stop, updateDraft,
} from './experimentsService.js';

export const EXPERIMENTS_FEATURE = { toggleId: 'experiments', label: 'Experiments' };
const BASE = '/host/openwop-app/experiments/orgs/:orgId';

const q = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const notFound = (): never => { throw new OpenwopError('not_found', 'Experiment not found.', 404, {}); };

/** The result of a `cms.page` experiment is a projection over analytics events,
 *  so reading it needs `analytics` (toggle + plan), as the CMS results do (ADR 0820 §7). */
async function assertResultsSource(kind: string, tenantId: string, subject: LaunchSubject): Promise<void> {
  if (kind !== 'cms.page') return;
  const refusal = await featureAccessRefusal('analytics', tenantId, subject);
  if (refusal) {
    throw new OpenwopError('forbidden', 'Experiment results for pages come from Analytics, which is not available in this workspace.', 403,
      { feature: 'analytics', reason: refusal === 'plan' ? 'not_entitled' : refusal === 'unresolved' ? 'feature_unavailable' : 'feature_disabled' });
  }
}

export function registerExperimentsRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get(`${BASE}/experiments`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, EXPERIMENTS_FEATURE, 'workspace:read');
      res.json({ experiments: await listExperiments(tenantId, orgId, { kind: q(req.query.kind), ref: q(req.query.ref), status: q(req.query.status) }) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/experiments`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId, user } = await authorizeOrgScope(req, EXPERIMENTS_FEATURE, 'workspace:write');
      res.status(201).json({ experiment: await createDraft(tenantId, orgId, user.userId, req.body) });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/experiments/:experimentId`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, EXPERIMENTS_FEATURE, 'workspace:read');
      res.json({ experiment: (await getExperiment(tenantId, orgId, req.params.experimentId)) ?? notFound() });
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/experiments/:experimentId`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, EXPERIMENTS_FEATURE, 'workspace:write');
      res.json({ experiment: await updateDraft(tenantId, orgId, req.params.experimentId, req.body) });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/experiments/:experimentId`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, EXPERIMENTS_FEATURE, 'workspace:write');
      if (!(await deleteDraft(tenantId, orgId, req.params.experimentId))) notFound();
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/experiments/:experimentId/lock`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, EXPERIMENTS_FEATURE, 'workspace:write');
      res.json({ experiment: await lockPlan(tenantId, orgId, req.params.experimentId, (req.body ?? {}).plan) });
    } catch (err) { next(err); }
  });

  for (const [verb, fn] of [['launch', launch], ['stop', stop], ['abandon', abandon]] as const) {
    app.post(`${BASE}/experiments/:experimentId/${verb}`, async (req: Request, res: Response, next) => {
      try {
        const { orgId, tenantId, user } = await authorizeOrgScope(req, EXPERIMENTS_FEATURE, 'workspace:write');
        res.json({ experiment: await fn(tenantId, orgId, req.params.experimentId, user.userId) });
      } catch (err) { next(err); }
    });
  }

  // ADR 0949 P4 — run the next Optimize epoch now (the scheduled chain does
  // the same through the surface). `too_soon` is an answer, not an error.
  app.post(`${BASE}/experiments/:experimentId/epoch`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, EXPERIMENTS_FEATURE, 'workspace:write');
      const r = await optimizeEpoch(tenantId, orgId, req.params.experimentId, { asOf: new Date().toISOString() });
      res.json({ outcome: r.outcome, epoch: r.epoch, experiment: r.experiment });
    } catch (err) { next(err); }
  });

  // ADR 0950 P0 — the promotion gate checklist for one experiment (read-only).
  app.get(`${BASE}/experiments/:experimentId/gates`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, EXPERIMENTS_FEATURE, 'workspace:read');
      const exp = (await getExperiment(tenantId, orgId, req.params.experimentId)) ?? notFound();
      await assertResultsSource(exp.surface.kind, tenantId, launchSubjectOf(req));
      res.json(await checkPromotionGates(exp, new Date().toISOString()));
    } catch (err) { next(err); }
  });

  // ADR 0950 P2 — start the governed promotion. The sub-toggle AND the parent;
  // workspace:write; a row in another org is the same 404 as a missing one.
  app.post(`${BASE}/experiments/:experimentId/promote`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId, user } = await authorizeOrgScope(req, EXPERIMENTS_FEATURE, 'workspace:write');
      await requireFeatureEnabled(req, AUTO_PROMOTE_TOGGLE, 'Experiments — governed promotion');
      const exp = (await getExperiment(tenantId, orgId, req.params.experimentId)) ?? notFound();
      await assertResultsSource(exp.surface.kind, tenantId, launchSubjectOf(req));
      const body = (req.body ?? {}) as { holdoutPct?: unknown };
      const started = await startPromotion({ storage: deps.storage, hostSuite: deps.hostSuite }, tenantId, orgId, exp.experimentId, user.userId,
        { ...(body.holdoutPct !== undefined ? { holdoutPct: body.holdoutPct } : {}) });
      res.status(202).json(started);
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/experiments/:experimentId/results`, async (req: Request, res: Response, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, EXPERIMENTS_FEATURE, 'workspace:read');
      const exp = (await getExperiment(tenantId, orgId, req.params.experimentId)) ?? notFound();
      await assertResultsSource(exp.surface.kind, tenantId, launchSubjectOf(req));
      res.json(await results(tenantId, orgId, req.params.experimentId));
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/power`, async (req: Request, res: Response, next) => {
    try {
      await authorizeOrgScope(req, EXPERIMENTS_FEATURE, 'workspace:read');
      const n = (k: string): number => Number(req.query[k]);
      res.json({ samplePerArm: powerCalc({ baselineRate: n('baselineRate'), mde: n('mde'), alpha: n('alpha'), power: n('power') }) });
    } catch (err) { next(err); }
  });
}
