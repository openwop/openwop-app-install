/**
 * Manual-test run persistence (ADR 0183) — ROUTE harness. Save→get round-trip, untested-row
 * pruning, listRuns, and the structural own-rows-only isolation (a second user in the same
 * tenant cannot see another user's run).
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

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), put: (p: string, b?: unknown) => call('PUT', p, b), post: (p: string, b?: unknown) => call('POST', p, b) };
}
let n = 0;
const login = async (tenantId: string) => { const c = client(); await c.post('/v1/host/openwop-app/test/login', { email: `mt-${Date.now()}-${n++}@acme.test`, tenantId }); return c; };
const RUNS = '/v1/host/openwop-app/manual-tests/runs';

describe('manual-tests — durable per-user runs', () => {
  it('saves and reads back a run; prunes untested rows; preserves notes', async () => {
    const u = await login(`org:mt-${Date.now()}-${n++}`);
    const put = await u.put(`${RUNS}/chat`, { results: {
      'CHAT-01': { status: 'pass', note: '', ts: '2026-07-01T00:00:00Z' },
      'CHAT-02': { status: 'fail', note: 'streaming stalled', ts: '2026-07-01T00:01:00Z' },
      'CHAT-03': { status: 'untested', note: '' },              // pruned (untested, no note)
      'CHAT-04': { status: 'untested', note: 'will retry' },    // kept (has a note)
    } });
    expect(put.status).toBe(200);
    expect(put.body.run.suiteKey).toBe('chat');
    expect(Object.keys(put.body.run.results).sort()).toEqual(['CHAT-01', 'CHAT-02', 'CHAT-04']);
    expect(put.body.run.results['CHAT-02'].note).toBe('streaming stalled');

    const got = await u.get(`${RUNS}/chat`);
    expect(got.body.run.results['CHAT-01'].status).toBe('pass');
    const list = await u.get(RUNS);
    expect(list.body.runs).toHaveLength(1);
    expect(list.body.runs[0].suiteKey).toBe('chat');
  });

  it('own-rows-only: a second user in the SAME tenant cannot see the first user\'s run', async () => {
    const tenantId = `org:mt-shared-${Date.now()}-${n++}`;
    const a = await login(tenantId);
    const b = await login(tenantId);
    await a.put(`${RUNS}/agents`, { results: { 'AGENTS-01': { status: 'pass', note: '', ts: '' } } });
    // B (same tenant, different subject) sees neither A's suite run nor A's list.
    expect((await b.get(`${RUNS}/agents`)).body.run).toBeNull();
    expect((await b.get(RUNS)).body.runs).toHaveLength(0);
    // A still sees their own.
    expect((await a.get(`${RUNS}/agents`)).body.run.results['AGENTS-01'].status).toBe('pass');
  });

  it('an invalid status coerces to untested (and is therefore pruned)', async () => {
    const u = await login(`org:mt-${Date.now()}-${n++}`);
    const put = await u.put(`${RUNS}/runs`, { results: { 'RUNS-01': { status: 'bogus', note: '' } } });
    expect(put.body.run.results['RUNS-01']).toBeUndefined();
  });
});
