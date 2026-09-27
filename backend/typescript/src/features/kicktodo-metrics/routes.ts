/**
 * kicktodo-metrics REST (ADR 0432) — ADMIN-scoped, read-only outcome metrics.
 * Every response is counts/percentiles with k-floor withholding; no route here
 * can return a participant-level row by construction.
 */

import type { Request, Response, NextFunction, Express } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { callerSubject, tenantOf } from '../../host/requestSubject.js';
import { requireKicktodoManage, requireString } from '../featureRoute.js';
import { activationMetrics, engagementMetrics, factoryMetrics } from './metricsService.js';
import { sampleVerdict, SampleSubjectError, verifierQuality } from './verifierSampleService.js';

export const KICKTODO_METRICS_PREFIX = '/v1/host/openwop-app/kicktodo/metrics';

type Handler = (req: Request, res: Response) => Promise<void>;

function subjectOf(req: Request): string {
  const s = callerSubject(req);
  if (!s) throw new OpenwopError('unauthenticated', 'An identified caller is required.', 401);
  return s;
}

async function gate(req: Request): Promise<void> {
  // ADR 0434 (KTFULL-B17) — ADR 0432 documented these as tenant-admin reads
  // while the code gated on toggle + identity only. Tenant-wide outcome
  // metrics are an administrative view; this closes the doc-vs-code gap.
  await requireKicktodoManage(req, 'kicktodo-metrics', 'KickTodo Metrics');
}

export const KICKTODO_METRICS_ROUTES: ReadonlyArray<{ method: 'get' | 'post'; path: string; handler: Handler }> = [
  {
    method: 'get',
    path: `${KICKTODO_METRICS_PREFIX}/activation`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req);
      res.json(await activationMetrics(tenantOf(req)));
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_METRICS_PREFIX}/engagement`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req);
      res.json(await engagementMetrics(tenantOf(req)));
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_METRICS_PREFIX}/factory`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req);
      res.json(await factoryMetrics(tenantOf(req)));
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_METRICS_PREFIX}/verifier-sample`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      try {
        res.json(await sampleVerdict(tenantOf(req), {
          enrollmentId: requireString(b.enrollmentId, 'enrollmentId'),
          // KTFULL-B18: the verdict is READ FROM THE JUDGE, never from the body.
          submittedBy: subjectOf(req),
        }));
      } catch (err) {
        // ARCH-1 — `SampleSubjectError` is a domain error, and every sibling
        // route in this feature family maps its domain errors to a typed
        // envelope. Left unmapped it fell through `errorEnvelope` as a 500
        // `internal_error`, so "that enrollment has no verdict to grade" —
        // an ordinary, actionable caller mistake — read as a server fault.
        // 404 keeps the response uniform for "absent" and "not yet judged",
        // which also avoids probing whether an enrollment id exists.
        if (err instanceof SampleSubjectError) throw new OpenwopError('not_found', err.message, 404);
        throw err;
      }
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_METRICS_PREFIX}/verifier-quality`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req);
      res.json(await verifierQuality(tenantOf(req)));
    },
  },
];

export function registerKicktodoMetricsRoutes(deps: RouteDeps): void {
  const app: Express = deps.app;
  const wrap = (h: Handler) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await h(req, res);
    } catch (err) {
      next(err);
    }
  };
  for (const r of KICKTODO_METRICS_ROUTES) {
    app[r.method](r.path, wrap(r.handler));
  }
}
