/**
 * ADR 0135 Phase 3 — capability-firewall rule REST (route + RBAC harness).
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
const T = 'cf-tenant';
const rulesPath = (orgId: string): string => `/v1/host/openwop-app/capability-firewall/orgs/${encodeURIComponent(orgId)}/rules`;
async function ownerWithOrg(email: string): Promise<{ c: ReturnType<typeof client>; orgId: string }> {
  const c = client();
  await c('POST', '/v1/host/openwop-app/test/login', { email, tenantId: T });
  const org = await c('POST', '/v1/host/openwop-app/orgs', { name: 'Acme' });
  return { c, orgId: org.body.orgId };
}

describe('capability-firewall routes (ADR 0135, always-on)', () => {
  it('serves without a toggle, RULE-LESS by default; PUT sets rules', async () => {
    await enable('users'); await enable('orgs'); // no capability-firewall toggle anymore
    const { c, orgId } = await ownerWithOrg('cf-owner@test.dev');
    const RULES_PATH = rulesPath(orgId);

    const def = await c('GET', RULES_PATH);
    expect(def.status).toBe(200);
    expect(def.body.isDefault).toBe(true);
    expect(def.body.rules).toEqual([]);                 // rule-less default — no friction
    expect(def.body.unknownToolPolicy).toBe('treat-as-risky'); // CGOV-1: fail-CLOSED default

    const put = await c('PUT', RULES_PATH, { rules: [{ id: 'no-exec', description: 'x', when: { with: [{ safetyTier: 'exec' }] }, verdict: 'deny', reason: 'no exec' }] });
    expect(put.status).toBe(200);
    expect(put.body.isDefault).toBe(false);

    const get = await c('GET', RULES_PATH);
    expect(get.body.isDefault).toBe(false);
    expect(get.body.rules.map((r: any) => r.id)).toEqual(['no-exec']);
  });

  it('invalid rule (bad verdict) ⇒ 400', async () => {
    await enable('users'); await enable('orgs');
    const { c, orgId } = await ownerWithOrg('cf-val@test.dev');
    const r = await c('PUT', rulesPath(orgId), { rules: [{ id: 'bad', verdict: 'nuke', when: {} }] });
    expect(r.status).toBe(400);
  });
});
