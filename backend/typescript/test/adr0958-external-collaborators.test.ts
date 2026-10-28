/**
 * ADR 0958 P0 — external collaborators: records, grants, the per-use check, the
 * `collab_invite` link and accept with verified-email binding.
 *
 *   Witness 2 — a grant for client A cannot reach a client-B resource: not by its
 *     id, not as a crafted `target`, not by naming client B anywhere (tenant and
 *     org come from the grant).
 *   Witness 3 — a revoked grant, an expired grant, a suspended collaborator and an
 *     archived client are each refused on the NEXT use.
 *   Witness 4 — two users in two IdP tenants with the SAME principal string: only
 *     the user the collaborator is bound to passes.
 *   Accept — refused for an anonymous caller (sign in), a different email, a
 *     self-asserted (non-IdP) email, a second use, a revoked invite and a disabled
 *     sub-toggle; the binding is single and the link dies after it.
 *   RBAC — inviting needs `host:members:manage` on the client org.
 *   Granter re-check (ADR 0886 D3 / ADR 0887 D1, reconciled at integration) — a
 *     grant stops working when the member who GRANTED it loses the scope on the
 *     client, leaves the workspace or is disabled, and works again when restored;
 *     a collaborator disabled in their own home tenant is refused too.
 *
 * Sabotage notes (2026-10-20): drop the `boundUserId` compare → red (witness 4);
 * evaluate expiry against the creation time → red (witness 3); skip
 * `kind.contains` for a foreign target → red (witness 2); accept `emailProvenance
 * 'admin'|'self'` → red; skip the purge after bind → red (the link still
 * resolves; a second accept is ALSO refused by the status guard, correctly); drop the
 * org gate → red (archived client).
 * Sabotage notes (2026-10-26, integration): drop the granter check from
 * `checkGrantUse` → red (lost scope, left workspace, disabled granter, erased
 * granter); drop the bound-user disable check → red (disabled collaborator);
 * let a fault in the granter read fall through as an allow → red (fault test);
 * let the outer wrapper rethrow a fault instead of the uniform 404 → red (flaky
 * kind test); drop the onMemberAuthorityLost invalidation → red (removal test).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember, deleteMember, listMembers, getOrg } from '../src/host/accessControlService.js';
import { registerSessionAuthority } from '../src/host/sessionAuthority.js';
import { usersSessionAuthority } from '../src/features/users/feature.js';
import { getUser, updateUser, setUserStatus } from '../src/features/users/usersService.js';
import { updateClient } from '../src/features/campaign-ops/clientService.js';
import { resolveActiveResource } from '../src/features/sharing/sharingService.js';
import {
  checkGrantUse, registerGrantResourceKind, setCollaboratorStatus, revokeGrant, bindCollaborator,
  eraseExternalCollaboratorSubject, getCollaborator, __resetGranterVerdictsForTests, __granterAllowCountForTests,
  type CollaboratorGrant, type ExternalCollaborator,
} from '../src/host/externalCollaborators.js';

let BASE: string;
let server: http.Server;

/** A test resource kind: `doc` ids live per (tenant, org); a `doc` contains `page`s. */
const DOCS = new Map<string, Set<string>>(); // `${tenant}::${org}` -> doc ids
const PAGES = new Map<string, string>(); // page id -> parent doc id
const FLAKY = new Set<string>(); // doc ids whose existence read faults
registerGrantResourceKind('test-doc', {
  featureId: null,
  actions: ['view', 'comment'],
  async exists(t, o, id) {
    if (FLAKY.has(id)) throw new Error('doc store unavailable');
    return DOCS.get(`${t}::${o}`)?.has(id) ?? false;
  },
  async contains(_t, _o, parentId, child) { return child.kind === 'test-page' && PAGES.get(child.id) === parentId; },
  async project(_t, _o, id) { return { title: `Doc ${id}`, body: { id } }; },
});

async function setToggle(id: string, on: boolean): Promise<void> {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status: on ? 'on' : 'off' }, 'test');
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'cms', 'campaign-ops', 'campaign-ops.external-collab']) await setToggle(id, true);
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
interface ErrBody { error: string; message: string; details?: Record<string, unknown> }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1] ?? cookie; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b), del: <T>(p: string) => call<T>('DELETE', p) };
}

let n = 0;
interface Agency { tenantId: string; admin: ReturnType<typeof client>; orgA: string; orgB: string; docA: string; docB: string }
async function agency(): Promise<Agency> {
  const tenantId = `ws:t-collab-${n++}`;
  const admin = client();
  expect((await admin.post('/host/openwop-app/test/login', { email: `agency-${n}@agency.test`, tenantId })).status).toBe(201);
  const orgs: string[] = [];
  for (const name of ['Client A', 'Client B']) {
    const org = await admin.post<{ orgId: string }>('/host/openwop-app/orgs', { name });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    const c = await admin.post('/host/openwop-app/campaign-ops/clients', { name, orgId: org.body.orgId });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    orgs.push(org.body.orgId);
  }
  const [orgA = '', orgB = ''] = orgs;
  const docA = `doc-a-${n}`; const docB = `doc-b-${n}`;
  DOCS.set(`${tenantId}::${orgA}`, new Set([docA]));
  DOCS.set(`${tenantId}::${orgB}`, new Set([docB]));
  PAGES.set(`page-a-${n}`, docA);
  PAGES.set(`page-b-${n}`, docB);
  return { tenantId, admin, orgA, orgB, docA, docB };
}
const C = (orgId: string): string => `/host/openwop-app/campaign-ops/clients/${orgId}/collaborators`;

/** A vendor signed in to their OWN home tenant, with an IdP-asserted email. */
async function vendor(email: string, subject?: string): Promise<{ http: ReturnType<typeof client>; userId: string }> {
  const v = client();
  const r = await v.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email, ...(subject ? { subject } : {}) });
  expect(r.status).toBe(201);
  return { http: v, userId: r.body.user.userId };
}

async function invite(a: Agency, orgId: string, email: string): Promise<{ collaborator: ExternalCollaborator; token: string }> {
  const r = await a.admin.post<{ collaborator: ExternalCollaborator; invite: { token: string } }>(C(orgId), { kind: 'vendor', email, displayName: 'Pixel Studio' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { collaborator: r.body.collaborator, token: r.body.invite.token };
}
const accept = (v: ReturnType<typeof client>, token: string) => v.post<ErrBody & { collaborator?: ExternalCollaborator }>('/host/openwop-app/collab/invites/accept', { token });
async function grant(a: Agency, orgId: string, collaboratorId: string, docId: string, extra: Record<string, unknown> = {}): Promise<CollaboratorGrant> {
  const r = await a.admin.post<{ grant: CollaboratorGrant }>(`${C(orgId)}/${collaboratorId}/grants`, { resource: { kind: 'test-doc', id: docId }, actions: ['view'], ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.grant;
}
const refused = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ httpStatus: 404 });

describe('ADR 0958 D2 — accept with verified-email binding', () => {
  it('binds once to the IdP-verified email; the invite then dies', async () => {
    const a = await agency();
    const v = await vendor(`photo-${n}@vendor.test`);
    const { collaborator, token } = await invite(a, a.orgA, `PHOTO-${n}@vendor.test `);
    // The public invite shows who it is for, never the email.
    const shared = await fetch(`${BASE}/host/openwop-app/shared/${token}`);
    expect(shared.status).toBe(200);
    expect(await shared.text()).not.toContain('@vendor.test');
    const r = await accept(v.http, token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.collaborator).toMatchObject({ collaboratorId: collaborator.collaboratorId, status: 'active' });
    expect((await accept(v.http, token)).status).toBe(404); // single use (the status guard)
    // ...and the link itself is gone, not merely refused (the purge guard).
    await expect(resolveActiveResource(token, 'collab_invite')).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('refuses an anonymous caller, another email and a self-asserted email', async () => {
    const a = await agency();
    const { token } = await invite(a, a.orgA, `exact-${n}@vendor.test`);
    expect((await accept(client(), token)).status).toBe(401);
    const other = await vendor(`someone-else-${n}@vendor.test`);
    const mismatch = await accept(other.http, token);
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.details?.reason).toBe('invite_email_mismatch');
    const selfAsserted = await vendor(`exact-${n}@vendor.test`);
    await updateUser(selfAsserted.userId, { email: `exact-${n}@vendor.test`, emailProvenance: 'self' });
    expect((await accept(selfAsserted.http, token)).body.details?.reason).toBe('invite_email_mismatch');
    const adminVouched = await vendor(`exact-${n}@vendor.test`, `oidc:other-idp-${n}`);
    await updateUser(adminVouched.userId, { email: `exact-${n}@vendor.test`, emailProvenance: 'admin' });
    expect((await getUser(adminVouched.userId))?.emailProvenance).toBe('admin');
    expect((await accept(adminVouched.http, token)).body.details?.reason).toBe('invite_email_mismatch');
  });

  it('refuses a revoked invite and a disabled sub-toggle', async () => {
    const a = await agency();
    const v = await vendor(`late-${n}@vendor.test`);
    const revoked = await invite(a, a.orgA, `late-${n}@vendor.test`);
    expect((await a.admin.post(`${C(a.orgA)}/${revoked.collaborator.collaboratorId}/status`, { status: 'revoked' })).status).toBe(200);
    expect((await accept(v.http, revoked.token)).status).toBe(404);
    const v2 = await vendor(`toggle-${n}@vendor.test`);
    const live = await invite(a, a.orgA, `toggle-${n}@vendor.test`);
    await setToggle('campaign-ops.external-collab', false);
    try {
      expect((await accept(v2.http, live.token)).status).toBe(404);
    } finally {
      await setToggle('campaign-ops.external-collab', true);
    }
  });

  it('only an agency admin of the client invites', async () => {
    const a = await agency();
    const op = client();
    const login = await op.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `op-${n}@agency.test`, tenantId: a.tenantId, sharedWorkspace: true });
    await createMember({ tenantId: a.tenantId, orgId: a.tenantId, subject: login.body.user.userId, displayName: 'Op', roles: ['viewer'] });
    await createMember({ tenantId: a.tenantId, orgId: a.orgA, subject: login.body.user.userId, displayName: 'Op', roles: ['editor'] });
    expect([403, 404]).toContain((await op.post(C(a.orgA), { kind: 'vendor', email: 'x@vendor.test', displayName: 'X' })).status);
  });
});

describe('ADR 0958 D2 — the per-use check (witnesses 2, 3, 4)', () => {
  async function boundVendor(a: Agency, orgId: string, docId: string) {
    const v = await vendor(`w-${n}-${Math.random()}@vendor.test`);
    const email = (await getUser(v.userId))?.email ?? '';
    const { collaborator, token } = await invite(a, orgId, email);
    expect((await accept(v.http, token)).status).toBe(200);
    const g = await grant(a, orgId, collaborator.collaboratorId, docId);
    return { v, collaborator, g };
  }

  it('witness 2 — a grant for client A never reaches client B', async () => {
    const a = await agency();
    const { v, g } = await boundVendor(a, a.orgA, a.docA);
    const ok = await checkGrantUse({ grantId: g.grantId, via: { userId: v.userId }, action: 'view' });
    expect(ok).toMatchObject({ tenantId: a.tenantId, orgId: a.orgA });
    await refused(checkGrantUse({ grantId: g.grantId, via: { userId: v.userId }, action: 'view', target: { kind: 'test-doc', id: a.docB } }));
    await refused(checkGrantUse({ grantId: g.grantId, via: { userId: v.userId }, action: 'view', target: { kind: 'test-page', id: `page-b-${n - 1}` } }));
    // A page inside the granted doc is covered by `contains`.
    const page = [...PAGES.entries()].find(([, doc]) => doc === a.docA)?.[0] ?? '';
    await expect(checkGrantUse({ grantId: g.grantId, via: { userId: v.userId }, action: 'view', target: { kind: 'test-page', id: page } })).resolves.toBeTruthy();
    // An action the grant does not name.
    await refused(checkGrantUse({ grantId: g.grantId, via: { userId: v.userId }, action: 'comment' }));
    // Granting client A's collaborator a client-B doc is a 404 too.
    const r = await a.admin.post(`${C(a.orgA)}/${g.collaboratorId}/grants`, { resource: { kind: 'test-doc', id: a.docB }, actions: ['view'] });
    expect(r.status).toBe(404);
  });

  it('witness 3 — revoked, expired, suspended and archived are each refused on the next use', async () => {
    const a = await agency();
    const use = (g: CollaboratorGrant, userId: string, now?: Date) => checkGrantUse({ grantId: g.grantId, via: { userId }, action: 'view', ...(now ? { now } : {}) });

    const r1 = await boundVendor(a, a.orgA, a.docA);
    await expect(use(r1.g, r1.v.userId)).resolves.toBeTruthy();
    await revokeGrant(a.tenantId, a.orgA, r1.g.grantId, 'admin');
    await refused(use(r1.g, r1.v.userId));

    const r2 = await boundVendor(a, a.orgA, a.docA);
    await refused(use(r2.g, r2.v.userId, new Date(Date.parse(r2.g.expiresAt) + 1)));
    await expect(use(r2.g, r2.v.userId, new Date(Date.parse(r2.g.expiresAt) - 60_000))).resolves.toBeTruthy();

    const r3 = await boundVendor(a, a.orgA, a.docA);
    await setCollaboratorStatus(a.tenantId, a.orgA, r3.collaborator.collaboratorId, 'suspended', 'admin');
    await refused(use(r3.g, r3.v.userId));
    await setCollaboratorStatus(a.tenantId, a.orgA, r3.collaborator.collaboratorId, 'active', 'admin');
    await expect(use(r3.g, r3.v.userId)).resolves.toBeTruthy();

    const r4 = await boundVendor(a, a.orgA, a.docA);
    await updateClient(a.tenantId, a.orgA, { status: 'archived' });
    await refused(use(r4.g, r4.v.userId));
  });

  it('witness 4 — the same principal string in two IdP tenants: only the bound user passes', async () => {
    const a = await agency();
    const principal = `scim:jsmith-${n}`;
    // Two different people, each in their own home tenant, with the same principal.
    const x = await vendor(`jsmith-${n}@idp-a.test`, principal);
    const y = client();
    const yLogin = await y.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `jsmith-${n}@idp-b.test`, subject: principal, tenantId: `user:other-home-${n}` });
    expect(yLogin.body.user.userId).not.toBe(x.userId);
    const { collaborator, token } = await invite(a, a.orgA, `jsmith-${n}@idp-a.test`);
    expect((await accept(x.http, token)).status).toBe(200);
    const g = await grant(a, a.orgA, collaborator.collaboratorId, a.docA);
    await expect(checkGrantUse({ grantId: g.grantId, via: { userId: x.userId }, action: 'view' })).resolves.toBeTruthy();
    await refused(checkGrantUse({ grantId: g.grantId, via: { userId: yLogin.body.user.userId }, action: 'view' }));
    // And Y cannot take over the binding.
    await refused(bindCollaborator(a.tenantId, a.orgA, collaborator.collaboratorId, yLogin.body.user.userId));
  });

  it('erasing the person in their home tenant removes the binding in every agency (D7)', async () => {
    const a = await agency();
    const { v, collaborator, g } = await boundVendor(a, a.orgA, a.docA);
    const home = (await getUser(v.userId))?.tenantId;
    expect(home).toBeTruthy();
    expect(home).not.toBe(a.tenantId);
    // D2 /architect H1: `subjectKey` is caller-supplied, so an erasure run in ANY
    // other tenant (here: the agency's own, and a stranger's workspace) touches
    // none of the person's bindings. Only their home tenant erases them.
    for (const foreign of [a.tenantId, `ws:stranger-${n}`]) {
      expect((await eraseExternalCollaboratorSubject(foreign, v.userId)).rowsTouched).toBe(0);
      expect(await getCollaborator(a.tenantId, a.orgA, collaborator.collaboratorId)).not.toBeNull();
      await expect(checkGrantUse({ grantId: g.grantId, via: { userId: v.userId }, action: 'view' })).resolves.toBeTruthy();
    }
    const report = await eraseExternalCollaboratorSubject(home!, v.userId);
    // The record and its one grant, revoked (ADR 0958 P5 counts the revoke).
    expect(report.rowsTouched).toBe(2);
    expect(await getCollaborator(a.tenantId, a.orgA, collaborator.collaboratorId)).toBeNull();
    await refused(checkGrantUse({ grantId: g.grantId, via: { userId: v.userId }, action: 'view' }));
  });

  it('a grant must expire within 180 days and name only the kind\'s actions', async () => {
    const a = await agency();
    const v = await vendor(`limits-${n}@vendor.test`);
    const { collaborator, token } = await invite(a, a.orgA, `limits-${n}@vendor.test`);
    expect((await accept(v.http, token)).status).toBe(200);
    expect((await a.admin.post(`${C(a.orgA)}/${collaborator.collaboratorId}/grants`, { resource: { kind: 'test-doc', id: a.docA }, actions: ['view'], expiresInDays: 365 })).status).toBe(400);
    expect((await a.admin.post(`${C(a.orgA)}/${collaborator.collaboratorId}/grants`, { resource: { kind: 'test-doc', id: a.docA }, actions: ['decide'] })).status).toBe(400);
    expect((await a.admin.post(`${C(a.orgA)}/${collaborator.collaboratorId}/grants`, { resource: { kind: 'nope', id: a.docA }, actions: ['view'] })).status).toBe(400);
  });
});

describe('ADR 0958 × ADR 0886/0887 — the granter and the bound user are re-checked on every use', () => {
  /** A member who may grant on client A only: viewer at the root (present in the
   *  shared workspace), admin (host:members:manage) on the client org. */
  async function pm(a: Agency) {
    // The production identity path (personal login → member rows under the HOME
    // userId → switch), so the org gate and the re-check key on the same user.
    const http = client();
    const login = await http.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `pm-${n}-${Math.random()}@agency.test` });
    expect(login.status).toBe(201);
    const userId = login.body.user.userId;
    await createMember({ tenantId: a.tenantId, orgId: a.tenantId, subject: userId, displayName: 'PM', roles: ['viewer'] });
    await createMember({ tenantId: a.tenantId, orgId: a.orgA, subject: userId, displayName: 'PM', roles: ['admin'] });
    const sw = await http.post(`/host/openwop-app/workspaces/${encodeURIComponent(a.tenantId)}/switch`);
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    return { http, userId };
  }
  async function pmGrant(a: Agency) {
    const p = await pm(a);
    const v = await vendor(`g-${n}-${Math.random()}@vendor.test`);
    const email = (await getUser(v.userId))?.email ?? '';
    const { collaborator, token } = await invite(a, a.orgA, email);
    expect((await accept(v.http, token)).status).toBe(200);
    const r = await p.http.post<{ grant: CollaboratorGrant }>(`${C(a.orgA)}/${collaborator.collaboratorId}/grants`, { resource: { kind: 'test-doc', id: a.docA }, actions: ['view'] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.grant.createdBy, 'non-vacuity: the PM, not the agency admin, granted it').toBe(p.userId);
    const use = () => checkGrantUse({ grantId: r.body.grant.grantId, via: { userId: v.userId }, action: 'view' });
    await expect(use()).resolves.toBeTruthy();
    return { p, v, g: r.body.grant, use };
  }
  const rowOf = async (a: Agency, orgId: string, subject: string) => (await listMembers(a.tenantId, orgId)).find((m) => m.subject === subject);

  it('the granter loses host:members:manage on the client: refused; restored: works again', async () => {
    const a = await agency();
    const { p, use } = await pmGrant(a);
    const row = await rowOf(a, a.orgA, p.userId);
    expect(row).toBeTruthy();
    await deleteMember(row!.memberId);
    await createMember({ tenantId: a.tenantId, orgId: a.orgA, subject: p.userId, displayName: 'PM', roles: ['editor'] }); // demoted
    __resetGranterVerdictsForTests();
    await refused(use());
    const demoted = await rowOf(a, a.orgA, p.userId);
    await deleteMember(demoted!.memberId);
    await createMember({ tenantId: a.tenantId, orgId: a.orgA, subject: p.userId, displayName: 'PM', roles: ['admin'] });
    __resetGranterVerdictsForTests();
    await expect(use()).resolves.toBeTruthy(); // a live re-check, not a revocation
  });

  it('the granter leaves the shared workspace (the client-org row survives): refused', async () => {
    const a = await agency();
    const { p, use } = await pmGrant(a);
    await deleteMember((await rowOf(a, a.tenantId, p.userId))!.memberId);
    expect(await rowOf(a, a.orgA, p.userId), 'non-vacuity: the client-org twin still grants the scope').toBeTruthy();
    __resetGranterVerdictsForTests();
    await refused(use());
  });

  it('the granter is disabled: refused', async () => {
    const a = await agency();
    const { p, use } = await pmGrant(a);
    await setUserStatus(p.userId, 'disabled', { reason: 'admin' });
    __resetGranterVerdictsForTests();
    await refused(use());
  });

  it('the granter is erased in the agency: the tombstoned grant is dark', async () => {
    const a = await agency();
    const { p, g, use } = await pmGrant(a);
    const report = await eraseExternalCollaboratorSubject(a.tenantId, p.userId);
    expect(report.rowsTouched).toBeGreaterThanOrEqual(1);
    __resetGranterVerdictsForTests();
    await refused(use());
    const { listGrants } = await import('../src/host/externalCollaborators.js');
    expect((await listGrants(a.tenantId, a.orgA)).find((x) => x.grantId === g.grantId)?.createdBy).toBe('erased');
  });

  it('the collaborator is disabled in their own home tenant: refused', async () => {
    const a = await agency();
    const { v, use } = await pmGrant(a);
    await setUserStatus(v.userId, 'disabled', { reason: 'scim' });
    await refused(use());
  });

  it('a personal-workspace owner\'s grant passes the granter check (no false darkening)', async () => {
    const owner = client();
    const login = await owner.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `solo-${n++}@agency.test` });
    expect(login.status).toBe(201);
    const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Solo client' });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    expect((await owner.post('/host/openwop-app/campaign-ops/clients', { name: 'Solo client', orgId: org.body.orgId })).status).toBe(201);
    const tenantId = (await getOrg(org.body.orgId))?.tenantId ?? '';
    expect(tenantId.startsWith('ws:'), 'non-vacuity: a personal tenant, not a shared workspace').toBe(false);
    DOCS.set(`${tenantId}::${org.body.orgId}`, new Set(['solo-doc']));
    const v = await vendor(`solo-v-${n}@vendor.test`);
    const inv = await owner.post<{ collaborator: ExternalCollaborator; invite: { token: string } }>(C(org.body.orgId), { kind: 'vendor', email: (await getUser(v.userId))?.email, displayName: 'Solo vendor' });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect((await accept(v.http, inv.body.invite.token)).status).toBe(200);
    const g = await owner.post<{ grant: CollaboratorGrant }>(`${C(org.body.orgId)}/${inv.body.collaborator.collaboratorId}/grants`, { resource: { kind: 'test-doc', id: 'solo-doc' }, actions: ['view'] });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    __resetGranterVerdictsForTests();
    await expect(checkGrantUse({ grantId: g.body.grant.grantId, via: { userId: v.userId }, action: 'view' })).resolves.toBeTruthy();
  });

  it('a fault in the granter authority read refuses the use (uniform 404) and is not remembered', async () => {
    const a = await agency();
    const { p, use } = await pmGrant(a);
    __resetGranterVerdictsForTests();
    registerSessionAuthority(async (uid) => {
      if (uid === p.userId) throw new Error('session store unavailable');
      return usersSessionAuthority(uid);
    });
    try {
      await expect(use()).rejects.toMatchObject({ httpStatus: 404, code: 'not_found' });
    } finally {
      registerSessionAuthority(usersSessionAuthority);
    }
    expect(__granterAllowCountForTests(), 'a fault leaves nothing memoized').toBe(0);
    await expect(use()).resolves.toBeTruthy(); // the next use retries and passes
  });

  it('a fault in a resource kind\'s existence read is the same uniform 404', async () => {
    const a = await agency();
    const { g, v } = await (async () => {
      const r = await pmGrant(a);
      return { g: r.g, v: r.v };
    })();
    FLAKY.add(a.docA);
    try {
      await expect(checkGrantUse({ grantId: g.grantId, via: { userId: v.userId }, action: 'view' })).rejects.toMatchObject({ httpStatus: 404, code: 'not_found' });
    } finally {
      FLAKY.delete(a.docA);
    }
  });

  it('a removal the host performs drops the memoized allow at once (no 30 s wait on this instance)', async () => {
    const a = await agency();
    const { p, use } = await pmGrant(a);
    __resetGranterVerdictsForTests();
    await expect(use()).resolves.toBeTruthy();
    expect(__granterAllowCountForTests(), 'non-vacuity: the allow is memoized').toBe(1);
    await deleteMember((await rowOf(a, a.orgA, p.userId))!.memberId);
    expect(__granterAllowCountForTests()).toBe(0);
    await refused(use()); // no reset: the hook did it
  });
});
