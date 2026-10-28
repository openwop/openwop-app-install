/**
 * Teams approval-card delivery (ADR 0198 Phase B) — HTTP self-service pref
 * routes (signed-in only; per-user; tenant-scoped). Service-layer semantics
 * live in teams-approval-delivery.unit.test.ts (it re-inits the host-ext
 * persistence singleton the running app owns).
 *
 * What breaks it: dropping the PUT validation (an empty target is saved), keying
 * the pref on anything but the caller's own userId (Bob reads Alice's target),
 * a DELETE that reports success without clearing, or a caller with no userId
 * (an anonymous session) reaching the pref store (routes/approvalDeliveryTeams.ts
 * `callerUserId`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { TeamsApprovalDeliveryPref } from '../src/host/teamsApprovalDelivery.js';

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

interface Res<T> { status: number; body: T }
interface PrefBody { pref: TeamsApprovalDeliveryPref | null }
interface RemovedBody { removed: boolean }
interface ErrorBody { error: string; message: string }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = await res.json().catch(() => undefined);
    // The one JSON boundary: each call site names the body's type (product types or a local interface).
    return { status: res.status, body: out as T };
  };
  return {
    get: <T>(p: string) => call<T>('GET', p),
    put: <T>(p: string, b?: unknown) => call<T>('PUT', p, b),
    del: <T>(p: string) => call<T>('DELETE', p),
    post: <T>(p: string, b?: unknown) => call<T>('POST', p, b),
  };
}

const PATH = '/host/openwop-app/approval-delivery/teams';
let n = 0;

describe('teams delivery pref routes — self-service through HTTP', () => {
  it('PUT validates, GET round-trips per user, DELETE clears; users never see each other', async () => {
    const tenantId = `org:teams-${Date.now()}-${n++}`;
    const alice = client();
    const bob = client();
    expect((await alice.post('/host/openwop-app/test/login', { email: `a-${Date.now()}@t.test`, tenantId })).status).toBe(201);
    expect((await bob.post('/host/openwop-app/test/login', { email: `b-${Date.now()}@t.test`, tenantId })).status).toBe(201);

    const invalid = await alice.put<ErrorBody>(PATH, { connectionId: '', chatId: '' });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ error: 'validation_error', message: 'connectionId and chatId are required.' });
    expect((await alice.get<PrefBody>(PATH)).body.pref).toBeNull(); // the refused PUT saved nothing
    expect((await alice.put<PrefBody>(PATH, { connectionId: 'conn-9', chatId: '19:abc' })).status).toBe(200);
    expect((await alice.get<PrefBody>(PATH)).body.pref).toMatchObject({ tenantId, connectionId: 'conn-9', chatId: '19:abc' });
    // Per-user: Bob has no pref.
    expect((await bob.get<PrefBody>(PATH)).body.pref).toBeNull();

    expect((await alice.del<RemovedBody>(PATH)).body.removed).toBe(true);
    expect((await alice.get<PrefBody>(PATH)).body.pref).toBeNull();
  });

  it('signed-in only: a caller with no userId is refused on every verb', async () => {
    const anon = client(); // no login
    for (const r of [await anon.get<ErrorBody>(PATH), await anon.put<ErrorBody>(PATH, { connectionId: 'c', chatId: 'x' }), await anon.del<ErrorBody>(PATH)]) {
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ error: 'forbidden', message: 'Managing approval delivery requires a signed-in user.' });
    }
  });
});
