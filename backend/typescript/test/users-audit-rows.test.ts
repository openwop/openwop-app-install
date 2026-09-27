/**
 * USERS-16 — lifecycle writes that were OFF the ADR 0301 audit chain are now on
 * it, ids-only:
 *   - admin create  → `users.lifecycle.create`  { userId, source, groupCount, actor }
 *   - admin PATCH   → `users.lifecycle.patch`   { userId, changed: [field names], actor }
 *   - /scim/v2 PATCH/DELETE (the IdP-driven leaver) and the seam's
 *     deactivate-user → `users.lifecycle.disable|enable` with `actor: 'scim'`.
 * Every row is asserted to carry NO email / userName / principalId / value —
 * the exportable chain must never hold a SAML email NameID or a display name.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { listChain } from '../src/host/auditChainService.js';
import { getSetCookies } from './headerCookies.js';

const SCIM_TENANT = 'scim-audit';
const SCIM_BEARER = 'scim-audit-bearer-0123456789abcdef';
let BASE = '';
let server: http.Server;

async function call(method: string, path: string, opts: { body?: unknown; bearer?: string; cookie?: string } = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}), ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined), headers: res.headers };
}
const FORBIDDEN = /email|userName|principalId|displayName|nameId/i;
function assertIdsOnly(payload: Record<string, unknown>): void {
  for (const k of Object.keys(payload)) expect(k).not.toMatch(FORBIDDEN);
  expect(JSON.stringify(payload)).not.toMatch(/@acme\.test|Audit Target/);
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_SCIM_BEARER = SCIM_BEARER;
  process.env.OPENWOP_SCIM_TENANT = SCIM_TENANT;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const k of ['OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_SCIM_BEARER', 'OPENWOP_SCIM_TENANT']) delete process.env[k];
});

describe('USERS-16 — admin create + PATCH are on the chain, ids-only', () => {
  it('create → users.lifecycle.create; PATCH → users.lifecycle.patch with changed field NAMES only', async () => {
    const login = await call('POST', '/v1/host/openwop-app/test/login', { body: { subject: 'oidc:audit-admin', displayName: 'Audit Admin' } });
    expect(login.status).toBe(201);
    const cookie = (getSetCookies(login.headers) as string[]).map((c) => /(__session=[^;]+)/.exec(c)?.[1]).find(Boolean)!;
    const me = await call('GET', '/v1/host/openwop-app/users/me', { cookie });
    const tenantId = me.body.tenantId as string;
    const actor = me.body.userId as string;

    const created = await call('POST', '/v1/host/openwop-app/users/users', { cookie, body: { principalId: 'scim:target@acme.test', email: 'target@acme.test', displayName: 'Audit Target', groups: ['eng'] } });
    expect(created.status).toBe(201);
    const userId = created.body.userId as string;
    const patched = await call('PATCH', `/v1/host/openwop-app/users/users/${encodeURIComponent(userId)}`, { cookie, body: { displayName: 'Audit Target 2', groups: ['eng', 'admins'] } });
    expect(patched.status).toBe(200);

    const chain = await listChain(tenantId);
    const create = chain.find((e) => e.kind === 'users.lifecycle.create')!;
    expect(create, 'create row missing').toBeTruthy();
    expect(create.payload).toMatchObject({ tenantId, userId, source: 'manual', groupCount: 1, actor });
    assertIdsOnly(create.payload as Record<string, unknown>);
    const patch = chain.find((e) => e.kind === 'users.lifecycle.patch')!;
    expect(patch, 'patch row missing').toBeTruthy();
    expect(patch.payload).toMatchObject({ tenantId, userId, actor });
    expect((patch.payload as { changed: string[] }).changed.sort()).toEqual(['displayName', 'groups']);
    assertIdsOnly(patch.payload as Record<string, unknown>);
  });
});

describe('USERS-16 — the IdP-driven joiner + leaver are on the chain with actor:scim', () => {
  it('/scim/v2 POST (new) → create row; POST again (mover) → no second create; PATCH active:false, PATCH active:true, DELETE → disable / enable / disable rows', async () => {
    const created = await call('POST', '/scim/v2/Users', { bearer: SCIM_BEARER, body: { userName: 'leaver@acme.test', externalId: 'ext-audit', displayName: 'Audit Target' } });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    // Mover re-provision (review NIT-1): refreshes the profile, appends NO create row.
    expect((await call('POST', '/scim/v2/Users', { bearer: SCIM_BEARER, body: { userName: 'leaver@acme.test', externalId: 'ext-audit', displayName: 'Audit Target Moved' } })).status).toBe(201);
    expect((await call('PATCH', `/scim/v2/Users/${encodeURIComponent(id)}`, { bearer: SCIM_BEARER, body: { active: false } })).status).toBe(200);
    expect((await call('PATCH', `/scim/v2/Users/${encodeURIComponent(id)}`, { bearer: SCIM_BEARER, body: { active: true } })).status).toBe(200);
    expect((await call('DELETE', `/scim/v2/Users/${encodeURIComponent(id)}`, { bearer: SCIM_BEARER })).status).toBe(200);

    const rows = (await listChain(SCIM_TENANT)).filter((e) => (e.payload as { userId?: string }).userId === id);
    expect(rows.map((e) => e.kind)).toEqual(['users.lifecycle.create', 'users.lifecycle.disable', 'users.lifecycle.enable', 'users.lifecycle.disable']);
    for (const r of rows) {
      expect(r.payload).toMatchObject({ tenantId: SCIM_TENANT, userId: id, actor: 'scim' });
      assertIdsOnly(r.payload as Record<string, unknown>);
    }
    expect(rows[0]!.payload).toMatchObject({ source: 'scim', groupCount: 0 });
    expect(rows[1]!.payload.status).toBe('disabled');
    expect(rows[2]!.payload.status).toBe('active');
  });

  it('the conformance seam `create-user` op appends the same ids-only create row (review NIT-1)', async () => {
    process.env.OPENWOP_TEST_SCIM_URL = 'http://scim.test.invalid';
    try {
      const login = await call('POST', '/v1/host/openwop-app/test/login', { body: { subject: 'oidc:audit-seam-admin', displayName: 'Seam Admin' } });
      expect(login.status).toBe(201);
      const cookie = (getSetCookies(login.headers) as string[]).map((c) => /(__session=[^;]+)/.exec(c)?.[1]).find(Boolean)!;
      // With OPENWOP_SCIM_BEARER configured the seam honours the bearer too; the
      // session cookie rides along so the global middleware admits the call.
      // USERS-21: the seam takes ONE body shape now — flat, like real SCIM 2.0.
      // This call was the repo's only sender of the legacy nested `user:{}` form,
      // and its `displayName` was the reason that form could not be dropped.
      const body = { scimUrl: 'http://scim.test.invalid', op: 'create-user', userName: 'seam.joiner@acme.test', displayName: 'Audit Target' };
      const seam = await call('POST', '/v1/host/openwop-app/auth/scim/provision', { cookie, bearer: SCIM_BEARER, body });
      expect(seam.status, JSON.stringify(seam.body)).toBe(201);
      // The lift is load-bearing, so assert it rather than assuming: if `displayName`
      // stopped being read from the top level it would silently fall back to the
      // DEFAULT_SCIM_USER value and every other assertion here would still pass.
      expect(seam.body.principal.displayName).toBe('Audit Target');
      const userId = seam.body.principal.userId as string;
      const tenantId = seam.body.principal.tenantId as string;
      const again = await call('POST', '/v1/host/openwop-app/auth/scim/provision', { cookie, bearer: SCIM_BEARER, body });
      expect(again.status).toBe(201);
      const rows = (await listChain(tenantId)).filter((e) => e.kind === 'users.lifecycle.create' && (e.payload as { userId?: string }).userId === userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toMatchObject({ tenantId, userId, source: 'scim', groupCount: 0, actor: 'scim' });
      assertIdsOnly(rows[0]!.payload as Record<string, unknown>);
    } finally {
      delete process.env.OPENWOP_TEST_SCIM_URL;
    }
  });
});
