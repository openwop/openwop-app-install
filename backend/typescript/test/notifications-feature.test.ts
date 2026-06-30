/**
 * Notifications-as-a-feature (ADR 0010) — the regression oracle.
 *
 * Notifications is CORE platform infrastructure: the toggle was removed
 * (2026-06-11 — § Correction) because the emit path was never gated, so a toggle
 * only hid the UI while rows + Web-Push kept flowing. This asserts:
 *   1. Always-on — there is NO `notifications` toggle, and the WHOLE surface
 *      (inbox, the `…notifications:mark-all-read` colon sub-resource, push,
 *      prefs) serves without any toggle config.
 *   2. Durable, per-(tenant, user) preferences — the real control: GET returns
 *      seeded defaults, PUT validates + persists + round-trips, bad bodies 400.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; snapshot: () => string }
function client(initialCookie = ''): Client {
  let cookie = initialCookie;
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const sc = getSetCookies(res.headers);
    for (const ck of sc as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), snapshot: () => cookie };
}

let n = 0;
// ADR 0026: real sign-in is Firebase OIDC; tests mint an authenticated user via
// the env-gated auth test seam.
async function signedIn(): Promise<Client> {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `notif-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return c;
}
const BASE_PATH = '/v1/host/openwop-app/notifications';

describe('notifications feature — core, always-on (no toggle)', () => {
  it('has NO `notifications` toggle (it is core platform infrastructure)', () => {
    expect(getToggleDefault('notifications')).toBeNull();
  });

  it('serves the WHOLE surface with no toggle config — inbox, colon mark-all-read, push, prefs', async () => {
    const c = await signedIn();
    expect((await c.get(BASE_PATH)).status).toBe(200);
    // The colon sub-resource — a `/`-boundary gate used to be able to leak it.
    expect((await c.post(`${BASE_PATH}:mark-all-read`)).status).toBe(200);
    expect((await c.get(`${BASE_PATH}/push/config`)).status).toBe(200);
    expect((await c.get(`${BASE_PATH}/preferences`)).status).toBe(200);
  });
});

describe('notifications feature — durable preferences (Phase 2)', () => {
  it('GET returns seeded defaults for a user who never saved', async () => {
    const c = await signedIn();
    const r = await c.get(`${BASE_PATH}/preferences`);
    expect(r.status).toBe(200);
    expect(r.body.preferences.globalMute).toBe(false);
    expect(Array.isArray(r.body.preferences.types)).toBe(true);
    expect(r.body.preferences.quietHours.enabled).toBe(false);
  });

  it('PUT validates, persists, and round-trips across requests', async () => {
    const c = await signedIn();
    const put = await c.put(`${BASE_PATH}/preferences`, {
      globalMute: true,
      types: [{ type: 'workflow.failed', muted: true, desktop: false }],
      quietHours: { enabled: true, start: '23:00', end: '07:30', days: [1, 2, 3], allowUrgent: false },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.preferences.globalMute).toBe(true);
    // Durable: a fresh GET (same user) sees the saved blob.
    const got = await c.get(`${BASE_PATH}/preferences`);
    expect(got.body.preferences.globalMute).toBe(true);
    expect(got.body.preferences.quietHours.start).toBe('23:00');
    expect(got.body.preferences.types[0]).toMatchObject({ type: 'workflow.failed', muted: true, desktop: false });
  });

  it('is per-(tenant, user): a second user does NOT inherit the first user\'s prefs', async () => {
    const a = await signedIn();
    await a.put(`${BASE_PATH}/preferences`, { globalMute: true, types: [], quietHours: { enabled: false, start: '22:00', end: '08:00', days: [], allowUrgent: true } });
    const b = await signedIn();
    expect((await b.get(`${BASE_PATH}/preferences`)).body.preferences.globalMute).toBe(false);
  });

  it('rejects malformed bodies with 400', async () => {
    const c = await signedIn();
    expect((await c.put(`${BASE_PATH}/preferences`, { globalMute: 'yes', types: [], quietHours: { enabled: false, start: '22:00', end: '08:00', days: [], allowUrgent: true } })).status).toBe(400);
    expect((await c.put(`${BASE_PATH}/preferences`, { globalMute: false, types: [], quietHours: { enabled: false, start: '25:00', end: '08:00', days: [], allowUrgent: true } })).status).toBe(400);
    expect((await c.put(`${BASE_PATH}/preferences`, { globalMute: false, types: [], quietHours: { enabled: false, start: '22:00', end: '08:00', days: [9], allowUrgent: true } })).status).toBe(400);
  });

  it('requires sign-in (anonymous cannot read prefs)', async () => {
    const anon = client();
    expect((await anon.get(`${BASE_PATH}/preferences`)).status).toBe(401);
  });
});
