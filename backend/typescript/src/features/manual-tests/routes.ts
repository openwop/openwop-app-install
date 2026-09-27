/**
 * Manual-test run routes (ADR 0183) — durable per-user run progress for the `/test` runner.
 * Authed (the global middleware); the row is keyed by the caller's subject + tenant, so
 * authorization is STRUCTURAL — a caller only ever touches their own runs. Host-extension
 * (`/v1/host/openwop-app/manual-tests/*`), no wire.
 *
 * AUTHZ POSTURE (deliberate — the ADR 0071 `uiStateStore` precedent): there is NO admin/scope
 * gate here, even though the `/test` PAGE is admin-tier on the frontend. The admin-tier is a
 * NAV-PLACEMENT/UX choice, not a security boundary — manual-test runs are per-user, bounded,
 * non-sensitive QA scratch (checklist state + notes). Any authenticated caller (incl. the anon
 * demo tier) may keep their OWN runs; the subject+tenant key IS the authorization boundary
 * (a caller can never read/write another subject's rows). Adding an admin gate would be
 * over-scoping — a tester need not be an admin to record their own results.
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { tenantOf } from '../featureRoute.js';
import { listRuns, getRun, saveRun } from './manualTestsService.js';

const BASE = '/v1/host/openwop-app/manual-tests';

/** The authenticated caller's subject (matches the ADR 0071 uiState convention). */
function subjectOf(req: Request): string {
  return `user:${req.userId ?? req.principal?.principalId ?? '_anon'}`;
}

export function registerManualTestsRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // All of the caller's runs (for restoring progress across suites/devices).
  app.get(`${BASE}/runs`, async (req, res, next) => {
    try { res.json({ runs: await listRuns(tenantOf(req), subjectOf(req)) }); } catch (err) { next(err); }
  });

  // One suite's run for the caller (null → empty progress).
  app.get(`${BASE}/runs/:suiteKey`, async (req, res, next) => {
    try { res.json({ run: await getRun(tenantOf(req), subjectOf(req), req.params.suiteKey) }); } catch (err) { next(err); }
  });

  // Save the caller's results for a suite (full replace of that suite's result map).
  app.put(`${BASE}/runs/:suiteKey`, async (req, res, next) => {
    try {
      const b = (req.body ?? {}) as { results?: unknown };
      res.json({ run: await saveRun(tenantOf(req), subjectOf(req), req.params.suiteKey, b.results) });
    } catch (err) { next(err); }
  });
}
