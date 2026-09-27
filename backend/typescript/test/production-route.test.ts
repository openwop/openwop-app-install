/**
 * Production Intelligence (ADR 0172) — ROUTE-level harness. Boots the real app and
 * drives the Vendor Directory + production-plan surface over HTTP: toggle gating,
 * vendor CRUD + portfolio, the CRM companyId reference validation, RBAC
 * (owner/editor write, viewer read-only, cross-tenant fail-closed), and the plan
 * read + advisory status transition. Plan GENERATION is a workflow run (the
 * plan-generate node), out of scope for a route test.
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

interface Res<T = any> { status: number; body: T }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  patch: (p: string, b?: unknown) => Promise<Res>;
  put: (p: string, b?: unknown) => Promise<Res>;
  del: (p: string) => Promise<Res>;
}
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const cRaw of getSetCookies(res.headers) as string[]) {
      const m = /(__session=[^;]+)/.exec(cRaw);
      if (m) cookie = m[1];
    }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
    put: (p, b) => call('PUT', p, b),
    del: (p) => call('DELETE', p),
  };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('prod'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const enable = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const def = getToggleDefault(id);
  if (def) await saveConfig({ ...def, status }, 'test');
};

async function ownerWithMember(role: string): Promise<{ owner: Client; member: Client; orgId: string }> {
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const owner = client();
  await signup(owner, { tenantId });
  const member = client();
  const memberUser = await signup(member, { tenantId });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId;
  const add = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: [role] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, member, orgId };
}
const p = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/production/orgs/${encodeURIComponent(orgId)}${suffix}`;

describe('production — toggle gating', () => {
  it('404s when the production toggle is off', async () => {
    await enable('production', 'off');
    const { owner, orgId } = await ownerWithMember('viewer');
    expect((await owner.get(p(orgId, '/vendors'))).status).toBe(404);
    await enable('production', 'on');
  });
});

describe('production — vendor CRUD (owner)', () => {
  it('creates, reads, lists, patches, sets portfolio, and deletes a vendor', async () => {
    await enable('production', 'on');
    const { owner, orgId } = await ownerWithMember('owner');

    const created = await owner.post(p(orgId, '/vendors'), {
      type: 'agency',
      name: 'Bright Studio',
      region: 'EU',
      capabilities: [{ name: 'Brand design', category: 'design', qualityRating: 5 }, { name: 'Copywriting', category: 'writing' }],
      priceRanges: [{ capability: 'Brand design', min: 5000, max: 2000, unit: 'per-project' }],
      contractStatus: 'preferred',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const vendorId = created.body.vendorId;
    expect(created.body.type).toBe('agency');
    // inverted price range is normalized min<=max
    expect(created.body.priceRanges[0]).toMatchObject({ min: 2000, max: 5000 });

    expect((await owner.get(p(orgId, `/vendors/${vendorId}`))).body.name).toBe('Bright Studio');
    expect((await owner.get(p(orgId, '/vendors'))).body.vendors).toHaveLength(1);
    // filter by type
    expect((await owner.get(p(orgId, '/vendors?type=contractor'))).body.vendors).toHaveLength(0);

    const patched = await owner.patch(p(orgId, `/vendors/${vendorId}`), { contractStatus: 'active', notes: 'Great turnaround' });
    expect(patched.body.contractStatus).toBe('active');
    expect(patched.body.notes).toBe('Great turnaround');

    const port = await owner.put(p(orgId, `/vendors/${vendorId}/portfolio`), { tokens: ['media:abc', 'media:def'] });
    expect(port.body.portfolioAssetTokens).toEqual(['media:abc', 'media:def']);

    expect((await owner.del(p(orgId, `/vendors/${vendorId}`))).status).toBe(204);
    expect((await owner.get(p(orgId, `/vendors/${vendorId}`))).status).toBe(404);
  });

  it('rejects a foreign companyId reference (IDOR-safe)', async () => {
    await enable('production', 'on');
    const { owner, orgId } = await ownerWithMember('owner');
    const r = await owner.post(p(orgId, '/vendors'), { name: 'X', companyId: 'cmp:does-not-exist' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
  });

  it('accepts a valid same-org companyId (composes CRM)', async () => {
    await enable('production', 'on');
    await enable('crm', 'on');
    const { owner, orgId } = await ownerWithMember('owner');
    const company = await owner.post(`/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/companies`, { name: 'Globex' });
    expect(company.status, JSON.stringify(company.body)).toBe(201);
    const r = await owner.post(p(orgId, '/vendors'), { name: 'Contractor', companyId: company.body.companyId });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.companyId).toBe(company.body.companyId);
  });
});

describe('production — RBAC + isolation', () => {
  it('viewer reads but cannot write; a non-member/cross-tenant is fenced', async () => {
    await enable('production', 'on');
    const { member, orgId } = await ownerWithMember('viewer');
    // viewer read OK
    expect((await member.get(p(orgId, '/vendors'))).status).toBe(200);
    // viewer write forbidden
    expect((await member.post(p(orgId, '/vendors'), { name: 'Nope' })).status).toBe(403);

    // a user in another tenant cannot see the org at all (404, no existence leak)
    const outsider = client();
    await signup(outsider, { tenantId: `org:other-${Date.now()}-${n++}` });
    expect((await outsider.get(p(orgId, '/vendors'))).status).toBe(404);
  });
});

describe('production — plans (read + advisory status)', () => {
  it('404s an unknown plan and transitions a saved plan status', async () => {
    await enable('production', 'on');
    const { owner, orgId } = await ownerWithMember('owner');
    expect((await owner.get(p(orgId, '/plans'))).body.plans).toEqual([]);
    expect((await owner.get(p(orgId, '/plans/pln:nope'))).status).toBe(404);
    // invalid status rejected
    const bad = await owner.post(p(orgId, '/plans/pln:nope/status'), { status: 'bogus' });
    expect(bad.status).toBe(400);
    // unknown plan status transition → 404
    const missing = await owner.post(p(orgId, '/plans/pln:nope/status'), { status: 'approved' });
    expect(missing.status).toBe(404);
  });
});

describe('PROD2-R1 — a caller who cannot SEE rates cannot WIPE them (route level)', () => {
  it('an editor’s PATCH carrying priceRanges leaves the stored rates alone', async () => {
    // The two scopes differ: EDITING needs `workspace:write` (editor); SEEING
    // rates needs `host:members:manage` (admin+). So an editor's GET has the key
    // DELETED by `redactVendorPricing`, and the new price repeater initialised
    // from `vendor?.priceRanges ?? []` then sent `priceRanges: []` on save — the
    // route patches any key PRESENT in the body, so renaming a vendor destroyed
    // its rates under a "Vendor updated" toast. It also disarmed PROD2-B2,
    // whose entire purpose is grounding budgets on those rates.
    //
    // The client omits the key now; this pins the half that cannot regress —
    // no client can blind-overwrite a field it may not read.
    await enable('production', 'on');
    const { owner, member, orgId } = await ownerWithMember('editor');

    const created = await owner.post(p(orgId, '/vendors'), {
      name: 'Rate Holder', type: 'agency', contractStatus: 'active',
      capabilities: [{ name: 'Copywriting', category: 'writing' }],
      priceRanges: [{ capability: 'Copywriting', min: 100, max: 200, unit: 'per-hour' }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const vendorId = created.body.vendorId;

    // The editor genuinely cannot see them — the precondition this rests on.
    const asEditor = await member.get(p(orgId, '/vendors'));
    expect(asEditor.status).toBe(200);
    const seen = (asEditor.body.vendors as Array<Record<string, unknown>>).find((v) => v.vendorId === vendorId);
    expect(seen, 'the editor can read the vendor').toBeTruthy();
    expect('priceRanges' in seen!, 'the rates are redacted OUT for an editor').toBe(false);

    // …and their save — carrying exactly what the old form sent — must not wipe.
    const patched = await member.patch(p(orgId, `/vendors/${vendorId}`), { name: 'Rate Holder (renamed)', priceRanges: [] });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    const asOwner = await owner.get(p(orgId, '/vendors'));
    const after = (asOwner.body.vendors as Array<Record<string, unknown>>).find((v) => v.vendorId === vendorId);
    expect(after!.name).toBe('Rate Holder (renamed)');
    expect(after!.priceRanges, 'the rates survive the editor’s save').toHaveLength(1);
  });

  it('an ADMIN can still change them (the negative control)', async () => {
    // Without this, "rates survive" is satisfied by making them immutable.
    await enable('production', 'on');
    const { owner, orgId } = await ownerWithMember('editor');
    const created = await owner.post(p(orgId, '/vendors'), {
      name: 'Editable Rates', type: 'agency', contractStatus: 'active',
      priceRanges: [{ capability: 'Copywriting', min: 100, max: 200, unit: 'per-hour' }],
    });
    const vendorId = created.body.vendorId;
    const patched = await owner.patch(p(orgId, `/vendors/${vendorId}`), {
      priceRanges: [{ capability: 'Copywriting', min: 150, max: 250, unit: 'per-hour' }],
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.priceRanges[0].min).toBe(150);
  });
});
