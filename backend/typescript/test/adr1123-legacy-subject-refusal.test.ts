/**
 * ADR 1123 follow-up (#5945, PR-2) — the members routes refuse a typed `user:`
 * subject. A person is added through add-existing (D3) or linked (D4).
 *
 * Pinned:
 *  - POST with a `user:` subject is `409 use_add_existing` and writes no row,
 *    even when that person is already in the caller's D1 pool;
 *  - PATCH binding a `user:` subject to a placeholder is `409 use_link`;
 *  - service and IdP subjects (`oidc:`) and subject-less placeholders still work;
 *  - a superadmin is exempt, and still audited on the legacy lane;
 *  - the auth test seam (`/test/orgs/…`) is exempt, which is what fixtures use.
 *
 * Sabotage witnesses: drop the `refuseLegacyPersonSubject` call in either handler
 * and its 409 case fails; drop the `isSuperadmin` exemption and the superadmin
 * case fails; drop `allowLegacySubject` and the seam case fails.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { listChain } from '../src/host/auditChainService.js';
import { seedMemberPath, seedMembersPath } from './helpers/seedMember.js';

let server: http.Server;
let BASE = '';
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => { delete process.env.OPENWOP_SUPERADMIN_TENANTS; });

interface Res<T = unknown> { status: number; body: T }
interface Member { memberId: string; subject?: string }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const text = res.status === 204 ? '' : await res.text();
    let out: unknown;
    try { out = text ? JSON.parse(text) : undefined; } catch { out = text; }
    return { status: res.status, body: out as T };
  };
  return {
    get: <T = unknown>(p: string) => call<T>('GET', p),
    post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b),
    patch: <T = unknown>(p: string, b?: unknown) => call<T>('PATCH', p, b),
  };
}
type Client = ReturnType<typeof client>;
interface Person { c: Client; userId: string; tenantId: string }
async function person(): Promise<Person> {
  const c = client();
  const r = await c.post<{ user: { userId: string; tenantId: string } }>('/host/openwop-app/test/login', { email: `p5945-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { c, userId: r.body.user.userId, tenantId: r.body.user.tenantId };
}
const enc = encodeURIComponent;
const M = (orgId: string) => `/host/openwop-app/orgs/${enc(orgId)}/members`;

async function agency() {
  const owner = await person();
  const ws = (await owner.c.post<{ workspaceId: string }>('/host/openwop-app/workspaces', { name: `Agency5945-${n++}` })).body.workspaceId;
  expect((await owner.c.post(`/host/openwop-app/workspaces/${enc(ws)}/switch`)).status).toBe(200);
  const orgA = (await owner.c.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Client A' })).body.orgId;
  const subjects = async (orgId: string) => (await owner.c.get<{ members: Member[] }>(M(orgId))).body.members.map((m) => m.subject);
  return { owner, ws, orgA, subjects };
}

describe('ADR 1123 follow-up — a typed user: subject is refused on the members routes', () => {
  it('POST: 409 use_add_existing and no row, even for a person in the caller\'s pool; oidc: and placeholders still work', async () => {
    const a = await agency();
    const p = await person();
    // In the workspace root, so p is in the owner's D1 pool for client A.
    expect((await a.owner.c.post(seedMembersPath(a.ws), { displayName: 'P', subject: p.userId, roles: ['viewer'] })).status).toBe(201);

    const refused = await a.owner.c.post<{ error?: { code?: string }; details?: { reason?: string } }>(M(a.orgA), { displayName: 'P', subject: p.userId, roles: ['viewer'] });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('use_add_existing');
    expect(await a.subjects(a.orgA), 'no row was written').not.toContain(p.userId);

    expect((await a.owner.c.post(M(a.orgA), { displayName: 'CI bot', subject: 'oidc:svc-5945', roles: ['viewer'] })).status, 'a service subject keeps the lane').toBe(201);
    expect((await a.owner.c.post(M(a.orgA), { displayName: 'Placeholder', roles: ['viewer'] })).status, 'a placeholder keeps the lane').toBe(201);
  });

  it('PATCH: binding a user: subject to a placeholder is 409 use_link; an oidc: bind still works', async () => {
    const a = await agency();
    const p = await person();
    const ph = (await a.owner.c.post<Member>(M(a.orgA), { displayName: 'Pat', roles: ['viewer'] })).body;
    const refused = await a.owner.c.patch(`${M(a.orgA)}/${enc(ph.memberId)}`, { subject: p.userId });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('use_link');
    expect(await a.subjects(a.orgA)).not.toContain(p.userId);
    const svc = await a.owner.c.patch(`${M(a.orgA)}/${enc(ph.memberId)}`, { subject: 'oidc:svc-5945-b' });
    expect(svc.status, JSON.stringify(svc.body)).toBe(200);
  });

  it('a superadmin is exempt, and the bind is still audited on the legacy lane', async () => {
    const a = await agency();
    const p = await person();
    process.env.OPENWOP_SUPERADMIN_TENANTS = a.owner.tenantId;
    const r = await a.owner.c.post<Member>(M(a.orgA), { displayName: 'P', subject: p.userId, roles: ['viewer'] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const chain = await listChain(a.ws);
    expect(chain.some((e) => e.kind === 'security.org.member-added-direct' && (e.payload as { memberId?: string }).memberId === r.body.memberId)).toBe(true);
  });

  it('the auth test seam is exempt: fixtures bind through it, with the same rules', async () => {
    const a = await agency();
    const p = await person();
    expect((await a.owner.c.post(seedMembersPath(a.orgA), { displayName: 'P', subject: p.userId, roles: ['viewer'] })).status).toBe(201);
    expect(await a.subjects(a.orgA)).toContain(p.userId);
    const twin = await a.owner.c.post(seedMembersPath(a.orgA), { displayName: 'P again', subject: p.userId, roles: ['viewer'] });
    expect(twin.status, 'the real rules still run: identity_taken').toBe(409);
    const ph = (await a.owner.c.post<Member>(M(a.orgA), { displayName: 'Q', roles: ['viewer'] })).body;
    const q = await person();
    expect((await a.owner.c.patch(seedMemberPath(a.orgA, ph.memberId), { subject: q.userId })).status).toBe(200);
    const viewer = await person();
    expect((await a.owner.c.post(seedMembersPath(a.ws), { displayName: 'V', subject: viewer.userId, roles: ['viewer'] })).status).toBe(201);
    expect((await viewer.c.post(`/host/openwop-app/workspaces/${enc(a.ws)}/switch`)).status).toBe(200);
    expect((await viewer.c.post(seedMembersPath(a.orgA), { displayName: 'X', subject: 'oidc:x-5945', roles: ['viewer'] })).status, 'and the scope check: a viewer cannot').toBe(403);
  });
});
