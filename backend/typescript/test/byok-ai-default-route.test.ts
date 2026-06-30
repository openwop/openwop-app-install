/**
 * /byok/ai-default route (ADR 0110 Phase 1) — the HTTP boundary: get-when-unset, set-time
 * validation against the caller's OWN BYOK store (rejecting an unstored/foreign ref), provider
 * validation, and delete. The happy-path round-trip (which needs a STORED secret, blocked here
 * by the test harness's lack of a tenant KMS — same reason byok secret routes aren't route-
 * tested) is covered by the service test `headless-ai.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';

let server: Server;
let BASE = '';
let n = 0;
const AID = '/v1/host/openwop-app/byok/ai-default';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function getSetCookies(h: Headers): string[] { const v = (h as { getSetCookie?: () => string[] }).getSetCookie?.(); return v ?? (h.get('set-cookie') ? [h.get('set-cookie')!] : []); }
interface Res<T = { default?: { provider?: string; model?: string; credentialRef?: string } | null; error?: string }> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? {} : await res.json().catch(() => ({}));
    return { status: res.status, body: out as Res['body'] };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b), del: (p: string) => call('DELETE', p) };
}
async function loggedIn(who: string) { const c = client(); await c.post('/v1/host/openwop-app/test/login', { email: `${who}-${Date.now()}-${n++}@acme.test` }); return c; }

describe('/byok/ai-default route (ADR 0110)', () => {
  it('GET returns null when no default is set', async () => {
    const c = await loggedIn('aid-get');
    const r = await c.get(AID);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.default).toBeNull();
  });

  it('PUT 400s when the credentialRef is not one of the caller\'s stored secrets (scope-bounded)', async () => {
    const c = await loggedIn('aid-badref');
    const r = await c.put(AID, { provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'never-stored' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
    // and nothing got persisted
    expect((await c.get(AID)).body.default).toBeNull();
  });

  it('PUT 400s on an unknown provider before touching the secret store', async () => {
    const c = await loggedIn('aid-badprov');
    expect((await c.put(AID, { provider: 'cohere', model: 'x', credentialRef: 'r' })).status).toBe(400);
  });

  it('DELETE on an unset default is a no-op 204', async () => {
    const c = await loggedIn('aid-del');
    expect((await c.del(AID)).status).toBe(204);
  });
});
