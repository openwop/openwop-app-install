/**
 * ADR 0957 P0 — report definitions and draft client reports, host extension
 * under /v1/host/openwop-app/campaign-ops/clients/:orgId/…
 *
 * Gating, fail-closed: `campaign-ops` (inside `authorizeClient`) AND its
 * sub-toggle `campaign-ops.client-reports`. Access is the client org's own
 * (`authorizeClient`): a client the caller cannot read is a uniform 404, and
 * every row is looked up under that org, so another client's id is a 404 too.
 * Reads need `workspace:read`; defining and computing need `workspace:write`.
 *
 * @see docs/adr/0957-client-reporting-and-portal.md
 */
import type { Request } from 'express';
import { OpenwopError } from '../../../types.js';
import type { RouteDeps } from '../../../routes/registerAllRoutes.js';
import { requireFeatureEnabled } from '../../featureRoute.js';
import { authorizeClient } from '../routes.js';
import { syncReportSchedule } from './schedule.js';
import { startClientReportRun } from '../runLauncher.js';
import { personalTenantOf } from '../../../host/requestSubject.js';
import {
  createDefinition, createReport, getDefinition, getReport, listDefinitions, listReports, parseDefinition, resolvePeriod, updateDefinition,
} from './reportService.js';

export const CLIENT_REPORTS_TOGGLE = 'campaign-ops.client-reports';
const BASE = '/host/openwop-app/campaign-ops/clients/:orgId';

async function gate(req: Request, scope: 'workspace:read' | 'workspace:write'): Promise<{ tenantId: string; orgId: string; userId: string }> {
  const { client, tenantId, userId } = await authorizeClient(req, scope);
  await requireFeatureEnabled(req, CLIENT_REPORTS_TOGGLE, 'Client reports');
  return { tenantId, orgId: client.orgId, userId };
}

const notFound = (what: string, id: string): OpenwopError => new OpenwopError('not_found', `${what} not found.`, 404, { id });

export function registerClientReportRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get(`${BASE}/report-definitions`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await gate(req, 'workspace:read');
      res.json({ definitions: await listDefinitions(tenantId, orgId) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/report-definitions`, async (req, res, next) => {
    try {
      const { tenantId, orgId, userId } = await gate(req, 'workspace:write');
      const input = await parseDefinition(tenantId, orgId, req.body);
      const def = await createDefinition(tenantId, orgId, input, userId);
      await syncReportSchedule(def, userId); // D2 — one scheduler job per definition
      res.status(201).json({ definition: def });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/report-definitions/:definitionId`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await gate(req, 'workspace:read');
      const def = await getDefinition(tenantId, orgId, req.params.definitionId);
      if (!def) throw notFound('Report definition', req.params.definitionId);
      res.json({ definition: def });
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/report-definitions/:definitionId`, async (req, res, next) => {
    try {
      const { tenantId, orgId, userId } = await gate(req, 'workspace:write');
      const def = await getDefinition(tenantId, orgId, req.params.definitionId);
      if (!def) throw notFound('Report definition', req.params.definitionId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const expected = typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined;
      const input = await parseDefinition(tenantId, orgId, body);
      const next = await updateDefinition(def, input, expected, userId);
      await syncReportSchedule(next, userId); // re-arm: the job pins the new version
      res.json({ definition: next });
    } catch (err) { next(err); }
  });

  // Compute a draft report: the sections' numbers, frozen and hashed.
  app.post(`${BASE}/report-definitions/:definitionId/reports`, async (req, res, next) => {
    try {
      const { tenantId, orgId, userId } = await gate(req, 'workspace:write');
      const def = await getDefinition(tenantId, orgId, req.params.definitionId);
      if (!def) throw notFound('Report definition', req.params.definitionId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const period = resolvePeriod(def.period.kind, { start: body.periodStart, end: body.periodEnd });
      res.status(201).json({ report: await createReport(def, period, userId) });
    } catch (err) { next(err); }
  });

  // ADR 0957 D2 — run the client-report chain now: compute, then the client's
  // report.publish review gate, then publish. The same chain the schedule starts.
  app.post(`${BASE}/report-definitions/:definitionId/runs`, async (req, res, next) => {
    try {
      const { tenantId, orgId, userId } = await gate(req, 'workspace:write');
      const def = await getDefinition(tenantId, orgId, req.params.definitionId);
      if (!def) throw notFound('Report definition', req.params.definitionId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Validate the period here so a bad one is a 400, not a failed run.
      resolvePeriod(def.period.kind, { start: body.periodStart, end: body.periodEnd });
      const personal = personalTenantOf(req);
      const runId = await startClientReportRun({ storage: deps.storage, hostSuite: deps.hostSuite }, {
        tenantId, orgId, definitionId: def.definitionId, definitionVersion: def.version, causedBy: userId,
        ...(typeof body.periodStart === 'string' ? { periodStart: body.periodStart } : {}),
        ...(typeof body.periodEnd === 'string' ? { periodEnd: body.periodEnd } : {}),
        ...(personal ? { personalTenant: personal } : {}),
      });
      res.status(202).json({ runId });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/reports`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await gate(req, 'workspace:read');
      const definitionId = typeof req.query.definitionId === 'string' ? req.query.definitionId : undefined;
      res.json({ reports: await listReports(tenantId, orgId, definitionId) });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/reports/:reportId`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await gate(req, 'workspace:read');
      const report = await getReport(tenantId, orgId, req.params.reportId);
      if (!report) throw notFound('Report', req.params.reportId);
      res.json({ report });
    } catch (err) { next(err); }
  });
}
