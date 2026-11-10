/**
 * Sales Commissions — Phase 1 (plan CRUD + rule/accelerator config).
 * ROUTE-level harness (mirrors territories-lifecycle.test.ts). Covers:
 *   - toggle-off 404 (backend authority, ADR 0001 §3.4)
 *   - plan CRUD + rule/accelerator validation
 *   - RBAC: read = workspace:read; write = host:commissions:manage (admin/owner)
 *   - tenant/org IDOR isolation (cross-tenant AND a same-tenant non-member of the org)
 *
 * TST-CFE-2. Red when: plan writes need only `workspace:read`; currency stops being
 * normalised; a percentage (base or accelerator) above 100 is accepted; an
 * inverted effective range is accepted.
 *
 * Every case turns the `sales-commissions` toggle ON itself (its default is OFF),
 * so the file passes in any order.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

interface PlanBody {
  user?: { userId: string }; orgId?: string; planId?: string; name?: string; currency?: string;
  rules?: Array<{ type: string; accelerators?: Array<{ attainmentGte: number }> }>;
  error?: string; message?: string;
}
interface Res { status: number; body: PlanBody }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = (res.status === 204 ? {} : await res.json().catch(() => ({}))) as PlanBody;
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
const enable = async (status: 'on' | 'off'): Promise<void> => {
  const def = getToggleDefault('sales-commissions');
  if (def) await saveConfig({ ...def, status }, 'test');
};
beforeEach(async () => { await enable('on'); });

async function ownerWithMember(role: string): Promise<{ owner: Client; member: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:comm-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/host/openwop-app/test/login', { email: `owner-${Date.now()}-${n++}@acme.test`, tenantId });
  const member = client();
  const memberUser = (await member.post('/host/openwop-app/test/login', { email: `member-${Date.now()}-${n++}@acme.test`, tenantId })).body.user;
  expect(memberUser).toBeDefined();
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId ?? '';
  const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser?.userId, roles: [role] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, member, orgId, tenantId };
}
const base = (orgId: string): string => `/host/openwop-app/commissions/orgs/${encodeURIComponent(orgId)}`;
const validPlan = {
  name: 'AE Standard', currency: 'usd', assignment: { kind: 'role', ref: 'ae' }, effectiveFrom: '2026-01-01',
  rules: [{ basis: 'deal-won', type: 'percentage', rate: 5, accelerators: [{ attainmentGte: 100, rate: 8 }], cap: 50000 }],
};

describe('commissions — toggle gating', () => {
  it('404s every route when off, works when on', async () => {
    const { owner, orgId } = await ownerWithMember('admin');
    await enable('off');
    try {
      expect((await owner.get(`${base(orgId)}/plans`)).status).toBe(404);
    } finally {
      await enable('on');
    }
    expect((await owner.get(`${base(orgId)}/plans`)).status).toBe(200);
  });
});

describe('commissions — plan CRUD + RBAC', () => {
  it('creates/reads/updates/deletes plans; enforces read vs manage scopes', async () => {
    const { owner, member, orgId } = await ownerWithMember('editor'); // editor = workspace:write, NOT host:commissions:manage
    const B = base(orgId);

    const created = await owner.post(`${B}/plans`, validPlan);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.currency).toBe('USD'); // normalized
    expect(created.body.rules?.[0]?.accelerators?.[0]?.attainmentGte).toBe(100);
    const planId = created.body.planId;

    // editor member: can read, cannot write (needs host:commissions:manage)
    expect((await member.get(`${B}/plans`)).status).toBe(200);
    expect((await member.post(`${B}/plans`, validPlan)).status).toBe(403);
    expect((await member.patch(`${B}/plans/${planId}`, { name: 'x' })).status).toBe(403);
    expect((await member.del(`${B}/plans/${planId}`)).status).toBe(403);

    // owner updates + deletes
    const patched = await owner.patch(`${B}/plans/${planId}`, { name: 'AE Elite', rules: [{ basis: 'deal-won', type: 'fixed', rate: 250 }] });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.name).toBe('AE Elite');
    expect(patched.body.rules?.[0]?.type).toBe('fixed');
    expect((await owner.del(`${B}/plans/${planId}`)).status).toBe(200);
    expect((await owner.get(`${B}/plans/${planId}`)).status).toBe(404);
  });

  it('rejects invalid plans (currency, empty rules, bad type, effective range)', async () => {
    const { owner, orgId } = await ownerWithMember('admin');
    const B = base(orgId);
    expect((await owner.post(`${B}/plans`, { ...validPlan, currency: 'dollars' })).status).toBe(400);
    expect((await owner.post(`${B}/plans`, { ...validPlan, rules: [] })).status).toBe(400);
    expect((await owner.post(`${B}/plans`, { ...validPlan, rules: [{ basis: 'deal-won', type: 'bonus', rate: 5 }] })).status).toBe(400);
    expect((await owner.post(`${B}/plans`, { ...validPlan, rules: [{ basis: 'deal-won', type: 'percentage', rate: -1 }] })).status).toBe(400);
    expect((await owner.post(`${B}/plans`, { ...validPlan, assignment: { kind: 'nobody', ref: 'x' } })).status).toBe(400);
    expect((await owner.post(`${B}/plans`, { ...validPlan, effectiveFrom: '2026-06-01', effectiveTo: '2026-01-01' })).status).toBe(400);
    const blank = await owner.post(`${B}/plans`, { ...validPlan, name: '' });
    expect(blank.status).toBe(400);
    expect(blank.body.error).toBe('validation_error');
  });

  it('isolates plans across orgs (IDOR)', async () => {
    const a = await ownerWithMember('admin');
    const b = await ownerWithMember('admin');
    const planId = (await a.owner.post(`${base(a.orgId)}/plans`, validPlan)).body.planId ?? '';
    expect((await a.owner.get(`${base(a.orgId)}/plans/${planId}`)).status).toBe(200); // positive control
    // org B's owner (ANOTHER tenant) cannot read org A's plan via B's path (plan not in B) nor via A's path
    expect((await b.owner.get(`${base(b.orgId)}/plans/${planId}`)).status).toBe(404);
    expect((await b.owner.get(`${base(a.orgId)}/plans/${planId}`)).status).toBe(404);
    // …and inside ONE tenant: a second org's plan is not readable by a member of the first
    // org who holds no seat in the second (the org check, not the tenant lookup, refuses).
    const org2 = (await a.owner.post('/host/openwop-app/orgs', { name: 'Second' })).body.orgId ?? '';
    const plan2 = (await a.owner.post(`${base(org2)}/plans`, validPlan)).body.planId ?? '';
    expect((await a.owner.get(`${base(org2)}/plans/${plan2}`)).status).toBe(200); // positive control
    const denied = await a.member.get(`${base(org2)}/plans/${plan2}`);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('forbidden_scope');
  });
});

describe('R3 — a percentage rate is bounded (rate: 500 was a valid plan)', () => {
  it('rejects a percentage rate above 100 — base rule and accelerator alike', async () => {
    const { owner, orgId } = await ownerWithMember('editor');
    expect((await owner.post(`${base(orgId)}/plans`, { ...validPlan, rules: [{ basis: 'deal-won', type: 'percentage', rate: 500 }] })).status).toBe(400);
    expect((await owner.post(`${base(orgId)}/plans`, { ...validPlan, rules: [{ basis: 'deal-won', type: 'percentage', rate: 5, accelerators: [{ attainmentGte: 100, rate: 500 }] }] })).status).toBe(400);
  });
  it('still accepts 100% exactly, and a fixed rate above 100 (the bound is percentage-only)', async () => {
    const { owner, orgId } = await ownerWithMember('editor');
    expect((await owner.post(`${base(orgId)}/plans`, { ...validPlan, name: 'Cap edge', rules: [{ basis: 'deal-won', type: 'percentage', rate: 100 }] })).status).toBe(201);
    // A different assignment: ADR 1034 D4 refuses a second plan for the SAME assignment over
    // an overlapping window (`plan_window_overlap`), which is not what this case is about.
    expect((await owner.post(`${base(orgId)}/plans`, { ...validPlan, name: 'Flat 500', assignment: { kind: 'role', ref: 'sdr' }, rules: [{ basis: 'deal-won', type: 'fixed', rate: 500 }] })).status).toBe(201);
  });
});
