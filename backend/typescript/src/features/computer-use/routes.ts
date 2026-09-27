/**
 * ADR 0418 P3 — session read routes (host-extension, non-normative). The
 * trajectory is an EXECUTION record: reads gate on `workspace:read` via the
 * shared org-scope predicate + the feature toggle. No mutation routes — all
 * writes ride the recorded node lane (task/decide) so every action stays on
 * the run's trajectory.
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope } from '../featureRoute.js';
import { listSessions, getSession } from './sessionStore.js';
import { sendError } from '../../middleware/errorEnvelope.js';

const FEATURE = { toggleId: 'computer-use', label: 'Computer-use browser agents' };
const ORG = '/v1/host/openwop-app/computer-use/orgs/:orgId';

export function registerComputerUseRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const authz = (req: Request) => authorizeOrgScope(req, FEATURE, 'workspace:read');

  app.get(`${ORG}/sessions`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req);
      const rows = (await listSessions(tenantId)).filter((s) => s.orgId === orgId);
      res.json({
        sessions: rows.map((s) => ({
          sessionId: s.sessionId, status: s.status, task: s.task.startsWith('mock:') ? '(mock script)' : s.task,
          startUrl: s.startUrl, steps: s.steps.length, createdAt: s.createdAt, updatedAt: s.updatedAt,
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
      res.json({ session: s });
    } catch (err) { next(err); }
  });
}
