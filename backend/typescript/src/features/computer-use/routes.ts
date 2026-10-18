/**
 * ADR 0418 P3 — session read routes (host-extension, non-normative). The
 * trajectory is an EXECUTION record: reads gate on `workspace:read` via the
 * shared org-scope predicate + the feature toggle. Every write that DRIVES the
 * browser rides the recorded node lane (task/decide) so each action stays on the
 * run's trajectory. The one route write is STOP (ADR 0894 D8), which only ends.
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope } from '../featureRoute.js';
import { listSessions, getSession, type CuSession } from './sessionStore.js';
import { sendError } from '../../middleware/errorEnvelope.js';
import { bindApprovalRecordReader } from './approvalBinding.js';
import { endSession, isLive } from './computerUseService.js';

const FEATURE = { toggleId: 'computer-use', label: 'Computer-use browser agents' };
const ORG = '/host/openwop-app/computer-use/orgs/:orgId';

const maskTask = (task: string): string => (task.startsWith('mock:') ? '(mock script)' : task);

/** ADR 0894 D9 — the CLOSED read projection. Never the row: `providerSessionId`
 *  is a hosted-browser handle some providers accept as a connect token, and
 *  `consumedApprovals` is bookkeeping. */
export function projectSession(s: CuSession): Record<string, unknown> {
  return {
    sessionId: s.sessionId,
    orgId: s.orgId,
    status: s.status,
    task: maskTask(s.task),
    startUrl: s.startUrl,
    allowedOrigins: s.allowedOrigins,
    steps: s.steps.map((st) => ({
      kind: st.action.kind, tier: st.tier, decidedBy: st.decidedBy, at: st.at,
      ...(st.action.url ? { url: st.action.url } : {}),
      description: st.action.description,
    })),
    ...(s.pendingAction ? { pendingAction: { kind: s.pendingAction.kind, description: s.pendingAction.description, ...(s.pendingAction.url ? { url: s.pendingAction.url } : {}) } } : {}),
    ...(s.resultSummary ? { resultSummary: s.resultSummary } : {}),
    ...(s.error ? { error: s.error } : {}),
    ...(s.runId ? { runId: s.runId } : {}),
    createdBy: s.createdBy,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export function registerComputerUseRoutes(deps: RouteDeps): void {
  const { app } = deps;
  // ADR 0894 D3 — the decide surface proves an approval from this run record.
  bindApprovalRecordReader(deps.storage, deps.hostSuite.workflowCatalog);
  const authz = (req: Request) => authorizeOrgScope(req, FEATURE, 'workspace:read');

  app.get(`${ORG}/sessions`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req);
      const rows = (await listSessions(tenantId)).filter((s) => s.orgId === orgId);
      res.json({
        sessions: rows.map((s) => ({
          sessionId: s.sessionId, status: s.status, task: maskTask(s.task),
          startUrl: s.startUrl, steps: s.steps.length, createdAt: s.createdAt, updatedAt: s.updatedAt,
          ...(s.runId ? { runId: s.runId } : {}),
          ...(s.error ? { error: s.error } : {}),
        })),
      });
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/sessions/:sessionId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req);
      const s = await getSession(tenantId, req.params.sessionId);
      if (!s || s.orgId !== orgId) { sendError(res, 404, 'not_found', 'Session not found.'); return; }
      res.json({ session: projectSession(s) });
    } catch (err) { next(err); }
  });

  // ADR 0894 D8 — stop a session. `runs:cancel` is the scope that stops a run;
  // stopping is the safe direction, so any holder in the org may stop any
  // session there (as with runs). Another org's id is the same 404.
  app.post(`${ORG}/sessions/:sessionId/abort`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'runs:cancel');
      const s = await getSession(tenantId, req.params.sessionId);
      if (!s || s.orgId !== orgId) { sendError(res, 404, 'not_found', 'Session not found.'); return; }
      if (!isLive(s)) { res.json({ session: projectSession(s) }); return; } // already ended — idempotent
      let adapter = null;
      try { const { resolveAdapter } = await import('./feature.js'); adapter = resolveAdapter(); } catch { /* A5 — the row still ends */ }
      const ended = await endSession(adapter, s, 'aborted_by_user');
      res.json({ session: projectSession(ended) });
    } catch (err) { next(err); }
  });
}
