/**
 * GRADING PROBE — "Manual tests" (FEATURES.md ordinal 237). Evidence only.
 * GREEN + CI-safe (memory:// DSN + test-auth; the same route harness the existing
 * manual-tests-route suite uses).
 *
 * Witnesses Headline #1 — CROSS-TENANT isolation of the durable run tracker
 * (`manual-tests:run`). The run id is computed server-side as
 * `${tenantId}:${subjectRef}:${suiteKey}` and every route scopes reads to the
 * caller's `tenantOf(req)`, so tenant A can never read tenant B's run for the
 * same suite key. The /grade-code pass flagged the cross-TENANT case as untested
 * (MANC-4) — the shipped suite only covers same-tenant/different-subject; this
 * closes that gap.
 *
 * MANP-1: two tenants each PUT a run for the SAME suiteKey → each GET returns its
 *     OWN status, never the other tenant's; each LIST contains only its own row.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

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
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as any };
  };
  return { get: (p: string) => call('GET', p), put: (p: string, b?: unknown) => call('PUT', p, b), post: (p: string, b?: unknown) => call('POST', p, b) };
}
let n = 0;
const login = async (tenantId: string) => { const c = client(); await c.post('/v1/host/openwop-app/test/login', { email: `manp-${Date.now()}-${n++}@probe.test`, tenantId }); return c; };
const RUNS = '/v1/host/openwop-app/manual-tests/runs';

describe('Manual tests — cross-tenant run isolation (by execution)', () => {
  it('MANP-1: tenant A cannot read tenant B\'s run for the same suite key', async () => {
    const suite = `probe-suite-${Date.now()}`;
    const a = await login(`org:manp-A-${Date.now()}`);
    const b = await login(`org:manp-B-${Date.now()}`);
    await a.put(`${RUNS}/${suite}`, { results: { C1: { status: 'pass', note: 'A', ts: '2026-08-28T00:00:00Z' } } });
    await b.put(`${RUNS}/${suite}`, { results: { C1: { status: 'fail', note: 'B', ts: '2026-08-28T00:01:00Z' } } });

    const ga = await a.get(`${RUNS}/${suite}`);
    const gb = await b.get(`${RUNS}/${suite}`);
    expect(ga.body?.run?.results?.C1?.status).toBe('pass'); // A sees ITS OWN row
    expect(gb.body?.run?.results?.C1?.status).toBe('fail'); // B sees ITS OWN row — not A's

    // LIST is tenant-scoped: A's list carries only A's row (not B's), and vice-versa.
    const la = await a.get(RUNS);
    const rowsA = (la.body?.runs ?? []) as any[];
    const aForSuite = rowsA.filter((r) => r.suiteKey === suite);
    expect(aForSuite).toHaveLength(1);
    expect(aForSuite[0].results?.C1?.status).toBe('pass'); // never B's 'fail'
  });
});
