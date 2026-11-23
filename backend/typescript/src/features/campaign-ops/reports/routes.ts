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
import type { ClientAccount } from '../types.js';
import { OpenwopError } from '../../../types.js';
import type { RouteDeps } from '../../../routes/registerAllRoutes.js';
import { launchSubjectOf, publicBaseUrl, requireFeatureEnabled } from '../../featureRoute.js';
import { authorizeClient } from '../routes.js';
import { syncReportSchedule } from './schedule.js';
import { startClientReportRun } from '../runLauncher.js';
import { personalTenantOf } from '../../../host/requestSubject.js';
import { planExemptStampOf } from '../../../host/operatorPlanExemption.js';
import {
  createDefinition, createReport, getDefinition, getReport, listDefinitions, listReports, parseDefinition, resolvePeriod, updateDefinition, withdrawReport,
} from './reportService.js';
import { dropReportLinks, sendReportLinks } from './portalLinks.js';

export const CLIENT_REPORTS_TOGGLE = 'campaign-ops.client-reports';
const BASE = '/host/openwop-app/campaign-ops/clients/:orgId';

async function gate(req: Request, scope: 'workspace:read' | 'workspace:write' | 'host:members:manage'): Promise<{ tenantId: string; orgId: string; userId: string; client: ClientAccount }> {
  const { client, tenantId, userId } = await authorizeClient(req, scope);
  await requireFeatureEnabled(req, CLIENT_REPORTS_TOGGLE, 'Client reports');
  return { tenantId, orgId: client.orgId, userId, client };
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
      const input = await parseDefinition(tenantId, orgId, req.body, launchSubjectOf(req));
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
      const input = await parseDefinition(tenantId, orgId, body, launchSubjectOf(req));
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
      res.status(201).json({ report: await createReport(def, period, userId, { subject: launchSubjectOf(req) }) });
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
        // CC-AUTH-3 / ADR 1108 — the listed operator's run keeps the exemption
        // (re-checked downstream against the allowlist), as `POST /runs` does.
        ...(planExemptStampOf(req) ? { planExempt: true as const } : {}),
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

  // ADR 0957 D5/D7 (P2) — send a PUBLISHED report to the client's contacts: one
  // grant-backed link each, emailed with the link only. Behind the client-portal
  // sub-toggle (off by default). The URLs come back once, with `emailed`, so the
  // operator can copy a link that was not emailed.
  app.post(`${BASE}/reports/:reportId/links`, async (req, res, next) => {
    try {
      const { tenantId, userId, client } = await gate(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const links = await sendReportLinks({
        tenantId, client, reportId: req.params.reportId, sentBy: userId, baseUrl: publicBaseUrl(req),
        ...(body.collaboratorIds !== undefined ? { collaboratorIds: body.collaboratorIds } : {}),
      });
      res.status(201).json({ links });
    } catch (err) { next(err); }
  });

  // ADR 0957 D5 / matrix row 8 — withdraw a published report. Its client links
  // go dark on the next request; the row and snapshot are kept.
  app.post(`${BASE}/reports/:reportId/withdraw`, async (req, res, next) => {
    try {
      const { tenantId, orgId, userId } = await gate(req, 'host:members:manage');
      const report = await withdrawReport(tenantId, orgId, req.params.reportId, userId);
      await dropReportLinks(tenantId, orgId, report.reportId, userId);
      res.json({ report });
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
