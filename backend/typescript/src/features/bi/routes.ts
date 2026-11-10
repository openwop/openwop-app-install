/**
 * ADR 0417 P1 — BI metric-catalog CRUD + run routes (host-extension, non-
 * normative). Reads gate on `workspace:read`; catalog writes gate on
 * `host:members:manage` (admin). Every path is toggle-gated (`bi`) and
 * org-scoped via the shared `authorizeOrgScope` — the SAME predicate the P2
 * agent tools reuse (the ADR 0308 shared-helper rule). ADR 1052 D0: the path org
 * IS the catalog — every read and write names it.
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireOrgScope } from '../featureRoute.js';
import { listMetrics, getMetric, createMetric, updateMetric, deleteMetric, runMetric, projectCatalog, adoptMetric, type MetricInput } from './biService.js';
import type { MetricCatalogEntry, MetricDef, RunMetricParams } from './metricTypes.js';
import { sendError } from '../../middleware/errorEnvelope.js';
import { OpenwopError } from '../../types.js';

const FEATURE = { toggleId: 'bi', label: 'Business metrics' };
const ORG = '/host/openwop-app/bi/orgs/:orgId';
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

/** The definition fields a create/update body may carry (never identity or author). */
function metricInputOf(body: Record<string, unknown>): MetricInput {
  return {
    title: String(body.title ?? ''),
    ...(str(body.description) ? { description: str(body.description) } : {}),
    entityType: String(body.entityType ?? ''),
    aggregate: String(body.aggregate ?? ''),
    ...(str(body.field) ? { field: str(body.field) } : {}),
    ...(body.filters !== undefined ? { filters: body.filters } : {}),
    ...(str(body.groupBy) ? { groupBy: str(body.groupBy) } : {}),
    ...(str(body.timeField) ? { timeField: str(body.timeField) } : {}),
  };
}

/** ADR 1052 D9 — what a route returns for one metric: the shared projection plus the
 *  version the editor round-trips; never `createdBy` or `tenantId` (grade-code L7). */
async function entryOf(tenantId: string, def: MetricDef): Promise<MetricCatalogEntry & { updatedAt?: string }> {
  const [entry] = await projectCatalog(tenantId, [def]);
  return def.system ? entry! : { ...entry!, updatedAt: def.updatedAt };
}

/** ADR 1052 D11 — may this caller manage the org's catalog? The write doors' OWN
 *  predicate, asked and caught: a projection for the page, never authority. */
async function canManage(req: Request): Promise<boolean> {
  try {
    await requireOrgScope(req, 'host:members:manage');
    return true;
  } catch (err) {
    if (err instanceof OpenwopError && err.httpStatus === 403) return false;
    throw err;
  }
}

export function registerBiRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const authz = (req: Request, scope: Scope) => authorizeOrgScope(req, FEATURE, scope);

  app.get(`${ORG}/metrics`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const defs = await listMetrics(tenantId, orgId);
      const entries = await projectCatalog(tenantId, defs);
      // The editor round-trips `updatedAt` as its version (ADR 1052 D8).
      const versions = new Map(defs.map((m) => [m.metricId, m.updatedAt]));
      res.json({
        metrics: entries.map((e) => (e.system ? e : { ...e, updatedAt: versions.get(e.metricId) })),
        viewer: { canManage: await canManage(req) },
      });
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/metrics/:metricId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const metric = await getMetric(tenantId, orgId, req.params.metricId);
      if (!metric) { sendError(res, 404, 'not_found', 'Metric not found.'); return; }
      res.json({ metric: await entryOf(tenantId, metric) });
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/metrics`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'host:members:manage');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const metric = await createMetric(tenantId, orgId, user.userId, String(body.metricId ?? ''), metricInputOf(body));
      res.status(201).json({ metric: await entryOf(tenantId, metric) });
    } catch (err) { next(err); }
  });

  app.patch(`${ORG}/metrics/:metricId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'host:members:manage');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const metric = await updateMetric(tenantId, orgId, req.params.metricId, metricInputOf(body), str(body.expectedUpdatedAt));
      res.json({ metric: await entryOf(tenantId, metric) });
    } catch (err) { next(err); }
  });

  // BI84WF-12 — move a pre-1052 tenant-wide metric into this org's catalog.
  app.post(`${ORG}/metrics/:metricId/adopt`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'host:members:manage');
      res.json({ metric: await entryOf(tenantId, await adoptMetric(tenantId, orgId, req.params.metricId)) });
    } catch (err) { next(err); }
  });

  app.delete(`${ORG}/metrics/:metricId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'host:members:manage');
      await deleteMetric(tenantId, orgId, req.params.metricId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/metrics/:metricId/run`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:read');
      // ADR 0846 D2 — read as the caller: the CRM's own routes pass this same id as
      // the viewer (`crm/orgRoutes.ts` deals list + pipeline report).
      const result = await runMetric(tenantId, req.params.metricId, parseRunParams(orgId, (req.body ?? {}) as Record<string, unknown>), user.userId);
      res.json({ result });
    } catch (err) { next(err); }
  });
}
