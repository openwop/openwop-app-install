/**
 * ADR 0135 Phase 3 — capability-firewall rule REST (route + RBAC harness).
 *
 * Tracker TST-CBF-5. Pins: a tenant with no stored set reads RULE-LESS with the
 * fail-CLOSED `unknownToolPolicy: 'treat-as-risky'` default (CGOV-1); a PUT persists
 * (read back by GET) and leaves an audit row (CS-TL-2 — a silent rule weakening was the
 * finding); an invalid verdict is a typed 400; and the tenant-wide write needs
 * `host:members:manage` (vuln-scan H3) — a same-tenant member without it is refused 403
 * and nothing is written.
 * Red when: GET stops reading the stored rules; the unknown-tool default flips to
 * `skip`; the audit action or its ruleCount changes; the verdict check is dropped; the
 * PUT's scope is weakened (w67g1-route-* probes, wave 67).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';

interface RulesBody { rules: Array<{ id: string }>; unknownToolPolicy: string; isDefault: boolean }
interface ErrBody { error: string; message: string }
interface LoginBody { user: { userId: string } }

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
  return async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    // The body is untyped JSON (JSON.parse); each call site names the shape it reads.
    const text = await res.text();
    const parsed: T = res.status === 204 || text === '' ? undefined : JSON.parse(text);
    return { status: res.status, body: parsed };
  };
}
async function enable(id: string): Promise<void> { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
const T = 'cf-tenant';
const rulesPath = (orgId: string): string => `/host/openwop-app/capability-firewall/orgs/${encodeURIComponent(orgId)}/rules`;
async function ownerWithOrg(email: string, tenantId: string = T): Promise<{ c: ReturnType<typeof client>; orgId: string }> {
  const c = client();
  const who = await c<LoginBody>('POST', '/host/openwop-app/test/login', { email, tenantId });
  // ADR 0815 D1a — creating an org inside a SHARED tenant is owner-tier over HTTP,
  // and every test here shares the tenant; the org under test is minted directly,
  // owned by this caller (the shape `POST /orgs` produces for an owner).
  const org = await createOrg({ tenantId, createdBy: who.body.user.userId, name: 'Acme', ownerSubject: who.body.user.userId });
  return { c, orgId: org.orgId };
}

describe('capability-firewall routes (ADR 0135, always-on)', () => {
  it('serves without a toggle, RULE-LESS by default; PUT sets rules', async () => {
    await enable('users'); await enable('orgs'); // no capability-firewall toggle anymore
    const { c, orgId } = await ownerWithOrg('cf-owner@test.dev');
    const RULES_PATH = rulesPath(orgId);

    const def = await c<RulesBody>('GET', RULES_PATH);
    expect(def.status).toBe(200);
    expect(def.body.isDefault).toBe(true);
    expect(def.body.rules).toEqual([]);                 // rule-less default — no friction
    expect(def.body.unknownToolPolicy).toBe('treat-as-risky'); // CGOV-1: fail-CLOSED default

    const put = await c<RulesBody>('PUT', RULES_PATH, { rules: [{ id: 'no-exec', description: 'x', when: { with: [{ safetyTier: 'exec' }] }, verdict: 'deny', reason: 'no exec' }] });
    expect(put.status).toBe(200);
    expect(put.body.isDefault).toBe(false);

    const get = await c<RulesBody>('GET', RULES_PATH);
    expect(get.body.isDefault).toBe(false);
    expect(get.body.rules.map((r) => r.id)).toEqual(['no-exec']);

    // CS-TL-2 — the mutation left an audit trail (symmetric with the ADR 0104
    // allowlist grants; a silent rule weakening was the audit finding).
    const audits = await hostExtStorage().listAudit({ actionPrefix: 'capability-firewall.rules.set', resource: T });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'capability-firewall.rules.set', resource: T, outcome: 'ok' });
    expect(audits[0].payload).toMatchObject({ ruleCount: 1, unknownToolPolicy: 'treat-as-risky' });
  });

  it('invalid rule (bad verdict) ⇒ 400', async () => {
    await enable('users'); await enable('orgs');
    const { c, orgId } = await ownerWithOrg('cf-val@test.dev');
    const r = await c<ErrBody>('PUT', rulesPath(orgId), { rules: [{ id: 'bad', verdict: 'nuke', when: {} }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
    expect(r.body.message).toContain("rules[0].verdict MUST be 'deny', 'require-approval', or 'allow'");
  });

  it('RBAC: a same-tenant member without host:members:manage cannot PUT the tenant rule set (403, nothing written)', async () => {
    await enable('users'); await enable('orgs');
    // Its own tenant, so the stored rule set never leaks into another case under shuffle.
    const T2 = 'cf-tenant-rbac';
    const { c: owner, orgId } = await ownerWithOrg('cf-rbac-owner@test.dev', T2);
    const keep = await owner<RulesBody>('PUT', rulesPath(orgId), { rules: [{ id: 'keep', description: 'x', when: { with: [{ safetyTier: 'exec' }] }, verdict: 'deny', reason: 'r' }] });
    expect(keep.status).toBe(200);

    // A co-tenant user: logs into the EXISTING workspace, so it gets a session and no role.
    // (Not `sharedWorkspace: true` — that bounces a non-member to their OWN personal
    // tenant, where a PUT legitimately writes that tenant's rules; see authTestSeam.ts.)
    const stranger = client();
    await stranger('POST', '/host/openwop-app/test/login', { email: 'cf-rbac-member@test.dev', tenantId: T2 });
    const denied = await stranger<ErrBody>('PUT', rulesPath(orgId), { rules: [] });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('forbidden_scope');
    expect(denied.body.message).toBe('Missing required scope: host:members:manage');

    const after = await owner<RulesBody>('GET', rulesPath(orgId));
    expect(after.body.rules.map((r) => r.id)).toEqual(['keep']);
  });
});
