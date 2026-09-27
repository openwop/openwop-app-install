/**
 * ADR 0556 P2 — the SLO projection at the HTTP boundary.
 *
 * Route-level because the three things this phase's gate names are only
 * observable here: the RBAC tier, the flat S22 error envelope, and — the one
 * that matters most — that the projection reads the SAME instruments the host
 * records into. `slo-projection.test.ts` proves the arithmetic against
 * fixtures; fixtures cannot prove that the local-scrape reader is wired to the
 * meter provider the seams emit through. So this suite records through the real
 * `metricSeams` helpers and asserts the numbers come back out of the route.
 *
 * That distinction is not academic. A projection that reads a reader nobody
 * writes to answers `empty` for everything, forever, and every fixture test
 * stays green — which is exactly the "gate that cannot fail" shape this program
 * keeps finding.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { _resetMetricsProviderForTest, collectLocalScrape, localScrapeEnabled } from '../src/observability/metrics.js';
import { flattenSnapshot } from '../src/observability/sloProjection.js';
import { recordEffectBlocked, recordRunTerminal, recordRunStarted, recordProviderCall } from '../src/observability/metricSeams.js';
import { requireSuperadmin } from '../src/host/superadmin.js';
import type { OpenwopError } from '../src/types.js';

const SUPER_TENANT = 'org:test-slo-super';
const OPS = '/v1/host/openwop-app/operations';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_SUPERADMIN_TENANTS = SUPER_TENANT;
  // The operator profile under test. Reset first: `createMetrics` is idempotent
  // and would hand back a provider built before this env var existed, leaving
  // the route to answer `unknown` for a reason unrelated to the code.
  process.env.OPENWOP_METRICS_LOCAL_SCRAPE = 'true';
  _resetMetricsProviderForTest();
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 60_000);

afterAll(async () => {
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  delete process.env.OPENWOP_METRICS_LOCAL_SCRAPE;
  _resetMetricsProviderForTest();
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res { status: number; body: any }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

let n = 0;
async function login(tenantId: string) {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `slo-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return c;
}

describe('ADR 0556 P2 — RBAC on the SLO projection', () => {
  it('refuses a caller who never signed in', async () => {
    const r = await client().get(`${OPS}/slo/summary`);
    // MEASURED 403, not 401 — and the difference is a fact about this host, not
    // a gap in this phase.
    //
    // There is no unauthenticated state to 401 on: `middleware/auth.ts` issues
    // a caller with no session a private `anon:<sid>` tenant (ADR 0015), so the
    // request arrives AUTHENTICATED as an anonymous principal and reaches
    // `requireSuperadmin`, which refuses it exactly as it refuses any other
    // non-operator. Asserting 401 here would have pinned a behaviour this host
    // does not have, and "fixing" the route to produce one would change the
    // auth posture of every Operations endpoint to make one test match a
    // guess. Both refusals are fail-closed, which is the property that matters.
    expect(r.status).toBe(403);
    expect(r.body?.rows).toBeUndefined();
    expect(r.body?.alerts).toBeUndefined();
  });

  it('refuses an authenticated member of a non-operator workspace', async () => {
    const c = await login('org:not-an-operator');
    const r = await c.get(`${OPS}/slo/summary`);
    expect(r.status).toBe(403);
    // FAIL-CLOSED, not cosmetic: no row, no alert, no window leaks past the gate.
    expect(r.body?.rows).toBeUndefined();
    expect(r.body?.alerts).toBeUndefined();
    // The SAME predicate the rest of this surface uses, so the two agree.
    expect((await c.get(`${OPS}/health/summary`)).status).toBe(403);
  });

  it('serves an operator', async () => {
    const c = await login(SUPER_TENANT);
    const r = await c.get(`${OPS}/slo/summary`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Array.isArray(r.body.rows)).toBe(true);
    expect(r.body.rows.length).toBeGreaterThan(25);
  });

  it('pins the ACTUAL refusal code across the whole Operations surface', () => {
    // Turning a doc comment into a test, because it was WRONG for months.
    // `features/operations/routes.ts` claimed the superadmin reads answered a
    // "uniform 404" — a non-disclosure property — while `requireSuperadmin` has
    // always thrown 403, which deliberately does not have it. Nothing behaved
    // on the false claim, but a reader hardening this surface would have
    // believed a defence that was not there.
    //
    // Asserted at the PREDICATE rather than through a route, so it covers every
    // endpoint the gate protects and cannot be satisfied by one that happens to
    // 404 for an unrelated reason.
    const err = (() => {
      try { requireSuperadmin({ principal: undefined, tenantId: 'org:nobody' } as never); return null; }
      catch (e) { return e as OpenwopError; }
    })();
    expect(err, 'requireSuperadmin admitted a non-operator').not.toBeNull();
    expect(err!.httpStatus).toBe(403);
    expect(err!.code).toBe('forbidden');
  });

  it('answers in the FLAT S22 error envelope, never a nested one', async () => {
    const c = await login('org:not-an-operator');
    const r = await c.get(`${OPS}/slo/summary`);
    expect(typeof r.body.error).toBe('string');
    expect(r.body.error).toBe('forbidden');
    expect(typeof r.body.message).toBe('string');
    // The 2026-06→08 drift this shape was settled to end: `error` is a STRING,
    // never an object carrying code/message/retriable.
    expect(typeof r.body.error).not.toBe('object');
  });
});

describe('ADR 0556 P2 — the projection reads THIS host\'s own instruments', () => {
  it('has the local-scrape profile actually active', () => {
    // The precondition every assertion below rests on. Without it the route
    // answers `unknown` for everything and the suite would still be "green"
    // while proving nothing.
    expect(localScrapeEnabled()).toBe(true);
  });

  it('surfaces a value recorded through the real metric seam', async () => {
    recordProviderCall('anthropic', 'ok');
    recordProviderCall('anthropic', 'ok');
    recordProviderCall('anthropic', 'ok');
    recordProviderCall('anthropic', 'provider_timed_out');

    const c = await login(SUPER_TENANT);
    const r = await c.get(`${OPS}/slo/summary`);
    const m1 = (r.body.rows as any[]).find((row) => row.id === 'M1');
    expect(m1.state).toBe('breaching'); // 75% against a 97% objective
    expect(m1.observed).toBeCloseTo(0.75, 6);
    expect(m1.sampleCount).toBe(4);
    expect(m1.lastSampleAt).toBeGreaterThan(0);
    const alert = (r.body.alerts as any[]).find((a) => a.id === 'M1');
    expect(alert.severity).toBe('ticket');
    expect(alert.runbook).toContain('docs/runbooks/slo-alerts.md#');
  });

  it('raises the zero-target page alert on a single blocked effect', async () => {
    recordEffectBlocked('network-egress');
    const c = await login(SUPER_TENANT);
    const r = await c.get(`${OPS}/slo/summary`);
    const r1 = (r.body.rows as any[]).find((row) => row.id === 'R1');
    expect(r1.state).toBe('breaching');
    expect(r1.observed).toBeGreaterThanOrEqual(1);
    expect((r.body.alerts as any[]).find((a) => a.id === 'R1').severity).toBe('page');
  });

  it('reports the window as process uptime and the read as per-instance', async () => {
    recordRunStarted({ runId: 'slo-window', kind: 'chain', trigger: 'api' });
    recordRunTerminal('slo-window', 'completed');
    const c = await login(SUPER_TENANT);
    const r = await c.get(`${OPS}/slo/summary`);
    expect(r.body.window.kind).toBe('process_uptime');
    expect(typeof r.body.window.startedAt).toBe('string');
    expect(r.body.window.seconds).toBeGreaterThanOrEqual(0);
    // `docs/SLO.md` declares 28 days rolling, fleet-wide. This is neither, and
    // the response says so rather than letting the panel imply attainment.
    expect(r.body.perInstance).toBe(true);
    expect(r.body.source).toBe('local-scrape');
  });

  it('carries the not-projectable rows with their reasons, not a fabricated number', async () => {
    const c = await login(SUPER_TENANT);
    const r = await c.get(`${OPS}/slo/summary`);
    for (const id of ['C2', 'Q1']) {
      const found = (r.body.rows as any[]).find((row) => row.id === id);
      expect(found.state).toBe('not_projectable');
      expect(found.observed).toBeNull();
      expect(typeof found.reason).toBe('string');
      expect((r.body.alerts as any[]).some((a) => a.id === id)).toBe(false);
    }
  });

  it('reports the dispatch rows from the QUEUE TABLE, with a labelled source', async () => {
    // The same authoritative number the dispatch-outbox panel renders. Reading
    // the gauge here would put two numbers for one quantity on one page.
    const c = await login(SUPER_TENANT);
    const r = await c.get(`${OPS}/slo/summary`);
    const q2 = (r.body.rows as any[]).find((row) => row.id === 'Q2');
    expect(q2.source).toBe('dispatch-outbox-stats');
    expect(q2.state).toBe('healthy'); // empty queue in this fixture
    expect(q2.observed).toBe(0);
  });

  it('surfaces the series count and ceiling for the cardinality guard', async () => {
    const c = await login(SUPER_TENANT);
    const r = await c.get(`${OPS}/slo/summary`);
    expect(r.body.series.count).toBeGreaterThan(0);
    expect(r.body.series.limit).toBeGreaterThanOrEqual(20_000);
    expect(r.body.series.overflowed).toBe(false);
  });

  it('labels HTTP samples with `stream`, so the latency rows can exclude streams', async () => {
    // End-to-end proof that the middleware sets the label the A2/A3 filter
    // depends on. Without it the filter is a no-op and nobody would notice
    // until a long-lived stream skewed the panel in production.
    const c = await login(SUPER_TENANT);
    await c.get(`${OPS}/slo/summary`);
    const rm = await collectLocalScrape();
    const http = flattenSnapshot(rm!).find((x) => x.name === 'openwop.http.server.duration');
    expect(http, 'no http.server.duration series').toBeDefined();
    expect(http!.points.length).toBeGreaterThan(0);
    expect(http!.points.every((pt) => pt.attributes.stream === 'false' || pt.attributes.stream === 'true')).toBe(true);
  });

  it('leaks no forbidden label value anywhere in the response', async () => {
    // Structural rather than a spot-check: the P0 guard drops tenant/run/user
    // ids before they reach an instrument, so none can reach this response —
    // and this asserts the whole serialized body, which is the only place a
    // regression in that chain would show up on this surface.
    recordRunStarted({ runId: 'slo-secret-run-id', kind: 'chain', trigger: 'api' });
    recordRunTerminal('slo-secret-run-id', 'completed');
    const c = await login(SUPER_TENANT);
    const body = JSON.stringify((await c.get(`${OPS}/slo/summary`)).body);
    expect(body).not.toContain('slo-secret-run-id');
    expect(body).not.toContain(SUPER_TENANT);
  });
});
