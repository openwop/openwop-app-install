/**
 * Notifications-as-a-feature (ADR 0010) — the MIGRATION's regression oracle.
 *
 * The pre-existing notification surface kept working (see notifications.test.ts);
 * this asserts the NEW feature-package behavior the migration adds:
 *   1. Toggle gating — with the toggle OFF the WHOLE surface 404s, including the
 *      `…notifications:mark-all-read` colon sub-resource (a string-prefix gate
 *      would have leaked it) and the push-config read.
 *   2. Default ON — a fresh deploy keeps the surface (no regression on upgrade).
 *   3. Durable, per-(tenant, user) preferences (Phase 2): GET returns seeded
 *      defaults, PUT validates + persists + round-trips, bad bodies are 400.
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const PORT = 18689;
const BASE = `http://127.0.0.1:${PORT}`;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
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
    const sc = typeof (res.headers as any).getSetCookie === 'function' ? (res.headers as any).getSetCookie() : [];
    for (const ck of sc as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), snapshot: () => cookie };
}

let n = 0;
async function signedIn(): Promise<Client> {
  const c = client();
  const r = await c.post('/v1/host/sample/users/auth/signup', { email: `notif-${Date.now()}-${n++}@acme.test`, password: 'password123' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return c;
}
const enableNotifications = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('notifications');
  if (d) await saveConfig({ ...d, status }, 'test');
};

const BASE_PATH = '/v1/host/sample/notifications';

describe('notifications feature — default ON + surface works', () => {
  it('the toggle seeds ON (no regression on upgrade)', () => {
    const d = getToggleDefault('notifications');
    expect(d?.status).toBe('on');
  });

  it('serves the inbox, mark-all-read, and push-config when ON', async () => {
    await enableNotifications('on');
    const c = await signedIn();
    expect((await c.get(BASE_PATH)).status).toBe(200);
    expect((await c.post(`${BASE_PATH}:mark-all-read`)).status).toBe(200);
    expect((await c.get(`${BASE_PATH}/push/config`)).status).toBe(200);
  });
});

describe('notifications feature — toggle gating (backend authority)', () => {
  it('404s the WHOLE surface when OFF — inbox, the colon mark-all-read, push, prefs', async () => {
    const c = await signedIn();
    await enableNotifications('off');
    try {
      expect((await c.get(BASE_PATH)).status).toBe(404);
      // The colon sub-resource — a `/`-boundary string gate would have leaked it.
      expect((await c.post(`${BASE_PATH}:mark-all-read`)).status).toBe(404);
      expect((await c.get(`${BASE_PATH}/push/config`)).status).toBe(404);
      expect((await c.get(`${BASE_PATH}/preferences`)).status).toBe(404);
    } finally {
      await enableNotifications('on');
    }
  });
});

describe('notifications feature — durable preferences (Phase 2)', () => {
  it('GET returns seeded defaults for a user who never saved', async () => {
    await enableNotifications('on');
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
