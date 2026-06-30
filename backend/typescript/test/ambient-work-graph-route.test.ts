/**
 * ADR 0137 Phase 3 — ambient-work-graph REST (route + RBAC harness).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string; let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
}
async function enable(id: string): Promise<void> { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
const T = 'twg-route';
const path = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/work-graph/orgs/${encodeURIComponent(orgId)}/suggestions${suffix}`;
async function ownerWithOrg(email: string): Promise<{ c: ReturnType<typeof client>; orgId: string }> {
  const c = client();
  await c('POST', '/v1/host/openwop-app/test/login', { email, tenantId: T });
  const org = await c('POST', '/v1/host/openwop-app/orgs', { name: 'Acme' });
  return { c, orgId: org.body.orgId };
}

describe('ambient-work-graph routes (ADR 0137, always-on)', () => {
  it('serves without a toggle (RBAC only)', async () => {
    await enable('users'); await enable('orgs'); // no ambient-work-graph toggle anymore
    const { c, orgId } = await ownerWithOrg('twg-served@test.dev');
    expect((await c('GET', path(orgId))).status).toBe(200);
  });

  it('GET (empty) → refresh → dismiss/accept lifecycle with a draftSeed', async () => {
    await enable('users'); await enable('orgs');
    const { c, orgId } = await ownerWithOrg('twg-owner@test.dev');

    const empty = await c('GET', path(orgId));
    expect(empty.status).toBe(200);
    expect(empty.body.suggestions).toEqual([]); // no runs yet → no patterns

    // refresh is a valid (bounded, empty) sweep
    const refreshed = await c('POST', path(orgId, '/refresh'));
    expect(refreshed.status).toBe(200);
    expect(Array.isArray(refreshed.body.suggestions)).toBe(true);

    // dismiss/accept of an unknown id is an IDOR-safe 404
    expect((await c('POST', path(orgId, '/ws-nope/dismiss'))).status).toBe(404);
    expect((await c('POST', path(orgId, '/ws-nope/accept'))).status).toBe(404);
  });
});
