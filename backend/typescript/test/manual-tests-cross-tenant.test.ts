/**
 * MANC-4 / TST-DKF-1 (grade-tests wave 72; renamed from
 * `man-grade-probe.test.ts` — it began as a grading probe for
 * "Manual tests", FEATURES.md ordinal 237). CROSS-TENANT isolation of the
 * durable manual-test run tracker (`manual-tests:run`).
 *
 * The isolation is a DOUBLE GUARD BY CONSTRUCTION, and the test says which:
 *   1. the run id is `${tenantId}:${subjectRef}:${suiteKey}` and every route
 *      scopes to `tenantOf(req)` (`getRun` also re-checks the row's tenant), and
 *   2. `subjectRef` is `user:<userId>`, and `userIdFor(tenantId, principal)` is
 *      PER TENANT — so even the same person gets a different subjectRef in each
 *      tenant.
 * Over HTTP the two cannot be split, so the probes break each layer in ONE edit:
 * the run id losing its scope (w72 probe man-id: B's write lands on A's row and
 * A's read is refused by the tenant re-check), and the list losing BOTH its
 * tenant slice and its subject filter (man-list). Each tenant must read back
 * exactly its own row; both writes are asserted to have landed first, so a
 * refused write cannot read as "isolated".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

interface RunBody { run: { suiteKey: string; results: Record<string, { status: string; note?: string }> } | null }
interface ListBody { runs: Array<{ suiteKey: string; results: Record<string, { status: string }> }> }
interface Reply<T> { status: number; body: T | undefined }

let BASE: string; let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  async function call<T>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    // The response is typed at the call site with the route's narrow shape (RunBody / ListBody).
    const parsed = res.status === 204 ? undefined : ((await res.json().catch(() => undefined)) as T | undefined);
    return { status: res.status, body: parsed };
  }
  return {
    get: <T>(p: string) => call<T>('GET', p),
    put: <T>(p: string, b?: unknown) => call<T>('PUT', p, b),
    post: <T>(p: string, b?: unknown) => call<T>('POST', p, b),
  };
}
let n = 0;
const login = async (tenantId: string) => {
  const c = client();
  const r = await c.post<unknown>('/host/openwop-app/test/login', { email: `manp-${process.pid}-${++n}@probe.test`, tenantId });
  expect(r.status, 'test login must succeed — a failed login would make every read below "isolated"').toBe(201);
  return c;
};
const RUNS = '/host/openwop-app/manual-tests/runs';

describe('Manual tests — cross-tenant run isolation (by execution)', () => {
  it('MANP-1: tenant A cannot read tenant B\'s run for the same suite key', async () => {
    const id = `${process.pid}-${++n}`;
    const suite = `probe-suite-${id}`;
    const a = await login(`org:manp-A-${id}`);
    const b = await login(`org:manp-B-${id}`);
    const pa = await a.put<RunBody>(`${RUNS}/${suite}`, { results: { C1: { status: 'pass', note: 'A', ts: '2026-08-28T00:00:00Z' } } });
    const pb = await b.put<RunBody>(`${RUNS}/${suite}`, { results: { C1: { status: 'fail', note: 'B', ts: '2026-08-28T00:01:00Z' } } });
    expect([pa.status, pb.status]).toEqual([200, 200]);
    expect(pa.body?.run?.results.C1?.status).toBe('pass');
    expect(pb.body?.run?.results.C1?.status).toBe('fail');

    const ga = await a.get<RunBody>(`${RUNS}/${suite}`);
    const gb = await b.get<RunBody>(`${RUNS}/${suite}`);
    expect(ga.body?.run?.results.C1).toMatchObject({ status: 'pass', note: 'A' }); // A sees ITS OWN row
    expect(gb.body?.run?.results.C1).toMatchObject({ status: 'fail', note: 'B' }); // B sees ITS OWN row — not A's

    // LIST is tenant-scoped both ways: each list carries exactly its own row for the suite.
    const la = await a.get<ListBody>(RUNS);
    const lb = await b.get<ListBody>(RUNS);
    const aForSuite = (la.body?.runs ?? []).filter((r) => r.suiteKey === suite);
    const bForSuite = (lb.body?.runs ?? []).filter((r) => r.suiteKey === suite);
    expect(aForSuite.map((r) => r.results.C1?.status)).toEqual(['pass']); // never B's 'fail'
    expect(bForSuite.map((r) => r.results.C1?.status)).toEqual(['fail']); // never A's 'pass'
  });
});
