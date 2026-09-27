/**
 * Teams approval-card delivery (ADR 0198 Phase B) — HTTP self-service pref
 * routes (signed-in only; per-user; tenant-scoped). Service-layer semantics
 * live in teams-approval-delivery.unit.test.ts (it re-inits the host-ext
 * persistence singleton the running app owns).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';

let BASE = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: any }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return {
    get: (p: string) => call('GET', p),
    put: (p: string, b?: unknown) => call('PUT', p, b),
    del: (p: string) => call('DELETE', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
  };
}

const PATH = '/v1/host/openwop-app/approval-delivery/teams';
let n = 0;

describe('teams delivery pref routes — self-service through HTTP', () => {
  it('PUT validates, GET round-trips per user, DELETE clears; users never see each other', async () => {
    const tenantId = `org:teams-${Date.now()}-${n++}`;
    const alice = client();
    const bob = client();
    expect((await alice.post('/v1/host/openwop-app/test/login', { email: `a-${Date.now()}@t.test`, tenantId })).status).toBe(201);
    expect((await bob.post('/v1/host/openwop-app/test/login', { email: `b-${Date.now()}@t.test`, tenantId })).status).toBe(201);

    expect((await alice.put(PATH, { connectionId: '', chatId: '' })).status).toBe(400);
    expect((await alice.put(PATH, { connectionId: 'conn-9', chatId: '19:abc' })).status).toBe(200);
    expect((await alice.get(PATH)).body.pref).toMatchObject({ connectionId: 'conn-9', chatId: '19:abc' });
    // Per-user: Bob has no pref.
    expect((await bob.get(PATH)).body.pref).toBeNull();

    expect((await alice.del(PATH)).body.removed).toBe(true);
    expect((await alice.get(PATH)).body.pref).toBeNull();
  });
});
