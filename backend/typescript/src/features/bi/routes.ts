/**
 * ADR 0417 P1 — BI metric-catalog CRUD + run routes (host-extension, non-
 * normative). Reads gate on `workspace:read`; catalog writes gate on
 * `host:members:manage` (admin). Every path is toggle-gated (`bi`) and
 * org-scoped via the shared `authorizeOrgScope` — the SAME predicate the P2
 * agent tools reuse (the ADR 0308 shared-helper rule).
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope } from '../featureRoute.js';
import { listMetrics, getMetric, createMetric, updateMetric, deleteMetric, runMetric } from './biService.js';
import type { RunMetricParams } from './metricTypes.js';
import { sendError } from '../../middleware/errorEnvelope.js';

const FEATURE = { toggleId: 'bi', label: 'Business metrics' };
const ORG = '/v1/host/openwop-app/bi/orgs/:orgId';
type Scope = 'workspace:read' | 'host:members:manage';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The bounded run params — the ONLY run-time inputs (never a filter AST). */
export function parseRunParams(orgId: string, body: Record<string, unknown>): RunMetricParams {
  return {
    orgId,
    ...(str(body.groupBy) ? { groupBy: str(body.groupBy) } : {}),
    ...(str(body.since) ? { since: str(body.since) } : {}),
    ...(str(body.until) ? { until: str(body.until) } : {}),
    ...(str(body.bucket) ? { bucket: str(body.bucket) as RunMetricParams['bucket'] } : {}),
  };
}

export function registerBiRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const authz = (req: Request, scope: Scope) => authorizeOrgScope(req, FEATURE, scope);

  app.get(`${ORG}/metrics`, async (req, res, next) => {
    try {
      const { tenantId } = await authz(req, 'workspace:read');
      res.json({ metrics: await listMetrics(tenantId) });
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/metrics/:metricId`, async (req, res, next) => {
    try {
      const { tenantId } = await authz(req, 'workspace:read');
      const metric = await getMetric(tenantId, req.params.metricId);
      if (!metric) { sendError(res, 404, 'not_found', 'Metric not found.'); return; }
      res.json({ metric });
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/metrics`, async (req, res, next) => {
    try {
      const { user, tenantId } = await authz(req, 'host:members:manage');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const metric = await createMetric(tenantId, user.userId, String(body.metricId ?? ''), {
        title: String(body.title ?? ''),
        ...(str(body.description) ? { description: str(body.description) } : {}),
        entityType: String(body.entityType ?? ''),
        aggregate: String(body.aggregate ?? ''),
        ...(str(body.field) ? { field: str(body.field) } : {}),
        ...(body.filters !== undefined ? { filters: body.filters } : {}),
        ...(str(body.groupBy) ? { groupBy: str(body.groupBy) } : {}),
        ...(str(body.timeField) ? { timeField: str(body.timeField) } : {}),
      });
      res.status(201).json({ metric });
    } catch (err) { next(err); }
  });

  app.patch(`${ORG}/metrics/:metricId`, async (req, res, next) => {
    try {
      const { tenantId } = await authz(req, 'host:members:manage');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const metric = await updateMetric(tenantId, req.params.metricId, {
        title: String(body.title ?? ''),
        ...(str(body.description) ? { description: str(body.description) } : {}),
        entityType: String(body.entityType ?? ''),
        aggregate: String(body.aggregate ?? ''),
        ...(str(body.field) ? { field: str(body.field) } : {}),
        ...(body.filters !== undefined ? { filters: body.filters } : {}),
        ...(str(body.groupBy) ? { groupBy: str(body.groupBy) } : {}),
        ...(str(body.timeField) ? { timeField: str(body.timeField) } : {}),
      });
      res.json({ metric });
    } catch (err) { next(err); }
  });

  app.delete(`${ORG}/metrics/:metricId`, async (req, res, next) => {
    try {
      const { tenantId } = await authz(req, 'host:members:manage');
      await deleteMetric(tenantId, req.params.metricId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/metrics/:metricId/run`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const result = await runMetric(tenantId, req.params.metricId, parseRunParams(orgId, (req.body ?? {}) as Record<string, unknown>));
      res.json({ result });
    } catch (err) { next(err); }
  });
}
