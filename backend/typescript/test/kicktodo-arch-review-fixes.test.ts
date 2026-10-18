/**
 * Architect-review fixes on the audit-remediation delta.
 *
 * ARCH-1/ARCH-2 — two domain errors I introduced were plain `Error`s, so
 * `errorEnvelope` fell through to a 500 `internal_error`. Every sibling route
 * in this feature family maps its domain errors to a typed envelope
 * (`kicktodo-accountability/routes.ts:62`, `kicktodo-creator/routes.ts:121`),
 * so this was a break with the established pattern, not a judgement call: an
 * ordinary caller mistake was reported as a server fault.
 *
 * ARCH-3 — `reconcileSeats` was called only from the expiry and release paths,
 * so a partial failure that skipped BOTH left no way to invoke it. "The sagas
 * are repairable" was true of the function and not of the system. B13's
 * entitlement repair already shipped an operator route; the seat repair now
 * has the matching one.
 *
 * w41 grade-tests: these used to grep `String(handler)` for the error class
 * names, so mapping either error to a 500 stayed green (probes
 * w41g4-arch-sample-status / -research-status were VACUOUS). They now drive the
 * REAL route handlers on a throwaway express app and assert the error the
 * handler raises. The manage gate is stubbed to admit (the gate itself is proven
 * over real HTTP, editor → 403, by `kicktodo-authz-http.test.ts`'s GATED row for
 * `circles/:id/reconcile-seats`); ARCH-3 here proves the handler CALLS that gate
 * before it touches the seat counter.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { OpenwopError } from '../src/types.js';
import { KICKTODO_METRICS_ROUTES } from '../src/features/kicktodo-metrics/routes.js';
import { KICKTODO_CIRCLES_ROUTES } from '../src/features/kicktodo-accountability/routes.js';
import { KICKTODO_CREATOR_ROUTES } from '../src/features/kicktodo-creator/routes.js';

const gateCalls: Array<{ toggleId: string }> = [];
let gateRefusal: Error | null = null;
vi.mock('../src/features/featureRoute.js', async (orig) => {
  const actual = await orig<typeof import('../src/features/featureRoute.js')>();
  return {
    ...actual,
    requireKicktodoManage: vi.fn(async (_req: Request, toggleId: string) => {
      gateCalls.push({ toggleId });
      if (gateRefusal) throw gateRefusal;
    }),
  };
});

type RouteRow = { method: 'get' | 'post'; path: string; handler: (req: Request, res: Response) => Promise<void> };

let server: http.Server;
let base = '';
let lastError: unknown = null;

function mount(app: express.Express, row: RouteRow): void {
  app[row.method](row.path, (req: Request, res: Response, next: NextFunction) => {
    row.handler(req, res).catch(next);
  });
}

function find(routes: ReadonlyArray<RouteRow>, suffix: string): RouteRow {
  const r = routes.find((x) => x.path.endsWith(suffix));
  if (!r) throw new Error(`no route ending ${suffix}`);
  return r;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stand-in for the auth middleware: an identified admin in one tenant.
  app.use((req: Request & { tenantId?: string; userId?: string }, _res, next) => {
    req.tenantId = 'tenant-arch';
    req.userId = 'user:arch-admin';
    next();
  });
  mount(app, find(KICKTODO_METRICS_ROUTES, '/verifier-sample'));
  mount(app, find(KICKTODO_CREATOR_ROUTES, '/candidates/:id/research'));
  mount(app, find(KICKTODO_CIRCLES_ROUTES, '/:id/reconcile-seats'));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    lastError = err;
    res.status(err instanceof OpenwopError ? err.httpStatus : 500).json({});
  });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  const addr: AddressInfo | string | null = server.address();
  if (!addr || typeof addr === 'string') throw new Error('test server has no TCP address');
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  gateCalls.length = 0;
  gateRefusal = null;
  lastError = null;
});
afterEach(() => {
  gateRefusal = null;
});

async function post(path: string, body: unknown): Promise<number> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.status;
}

describe('ARCH-1/2 — domain errors are typed envelopes, never 500s', () => {
  it('the verifier-sample route maps SampleSubjectError', async () => {
    const status = await post('/host/openwop-app/kicktodo/metrics/verifier-sample', { enrollmentId: 'enr:absent' });
    expect(lastError).toBeInstanceOf(OpenwopError);
    expect(lastError).toMatchObject({ code: 'not_found', httpStatus: 404, message: 'That enrollment cannot be sampled.' });
    expect(status).toBe(404);
  });

  it('the research route maps UnparsableSourceUrlError', async () => {
    const status = await post('/host/openwop-app/kicktodo/creator/candidates/cand:absent/research', {
      questions: [], claims: [], sources: [{ url: 'not a url', title: 't', engine: 'searx' }],
    });
    expect(lastError).toBeInstanceOf(OpenwopError);
    expect(lastError).toMatchObject({ code: 'validation_error', httpStatus: 422, details: { url: 'not a url' } });
    expect(status).toBe(422);
  });
});

describe('ARCH-3 — the seat repair is reachable, not just implemented', () => {
  it('exposes an admin-gated reconcile-seats route', async () => {
    // Reachable: once admitted the handler runs the REAL reconcileSeats, which
    // finds no such cohort — the 'Cohort not found.' 404 is only raised after it.
    const admitted = await post('/host/openwop-app/kicktodo/circles/circ-absent/reconcile-seats', {});
    expect(gateCalls).toEqual([{ toggleId: 'kicktodo-accountability' }]);
    expect(lastError).toMatchObject({ code: 'not_found', httpStatus: 404, message: 'Cohort not found.' });
    expect(admitted).toBe(404);

    // Admin-gated: a refused manage gate stops the handler BEFORE reconcileSeats
    // (a gate placed after it, or missing, would surface the 404 above instead).
    gateCalls.length = 0;
    lastError = null;
    gateRefusal = new OpenwopError('forbidden', 'manage required', 403);
    const refused = await post('/host/openwop-app/kicktodo/circles/circ-absent/reconcile-seats', {});
    expect(refused).toBe(403);
    expect(lastError).toBe(gateRefusal);
    expect(gateCalls).toEqual([{ toggleId: 'kicktodo-accountability' }]);
  });
});
