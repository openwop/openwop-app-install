/**
 * ADR 0815 — the row-12 orgs residual, through the REAL production identity path
 * (personal sign-in → real `ws:` workspace → invite → accept → switch; demo mode
 * OFF, so no gate is vacuous). Every leg was RED on `origin/main 0b772c45e`.
 *
 *  D1 — a sub-org is not a door to workspace authority (create is owner-tier;
 *       tenant-wide authority in a `ws:` workspace is the ROOT membership's).
 *  D2 — the owner tier is judged per PERSON (group-derived, legacy twin).
 *  D3 — an identity is not edited in place; an update cannot resurrect; a
 *       demotion holds against a twin.
 *  D4 — removal (and demotion) takes down invites; leaving the workspace pauses
 *       the schedules that act as you, and a paused job cannot run as you again.
 *  D5 — member lifecycle events.
 *
 * Every refusal leg also re-reads state, so a 403 from an unrelated gate cannot pass.
 *
 * Sabotage that turns it red (each witnessed by /grade-tests probe):
 *  D1  `requireOrgCreate` owner check dropped; group owners ignored by
 *      `holdsOwnerRoleInTenant`; the tenant union / distinct-holder counting sub-org
 *      rows in a `ws:` workspace (or root-only OUTSIDE one)
 *  D2  `isEffectiveOwner` reading only the row's direct roles
 *  D3  identity_locked / identity_taken (POST + PATCH) / transfer_to_self refusals
 *      dropped; `updateMember` not propagating roles to twins; its CAS made a blind put
 *  D4  the `orgs.pending-invites` hook a no-op; the member-PATCH or group-PATCH
 *      demotion cascade dropped; the inviter row taken from act-as;
 *      `disableSchedulesActingAs` a no-op; trigger not refusing a paused job;
 *      re-registration re-arming it; `jobActorIsInactive` never true
 *  D5  role-set equality no-op removed (rename fires roles-changed); saml subject not redacted
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { getSetCookies } from './headerCookies.js';
import {
  createGroup, createMember, createOrg, deleteMember, getMember, hasDistinctScopeHolder, isWorkspaceMember, resolveTenantLevelScopes, resolveSubjectScopesUnion, updateMember,
} from '../src/host/accessControlService.js';
import { getJob, jobActorIsInactive, registerJob, updateJob } from '../src/host/schedulingService.js';
import { registerSessionAuthority } from '../src/host/sessionAuthority.js';
import { initHostEventDispatcher, type HostEventEnvelope } from '../src/host/hostEventDispatcher.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';

const H = '/host/openwop-app';
let BASE = '';
let server: http.Server;
let storage: Storage;
let n = 0;
const saved: Record<string, string | undefined> = {};

interface M { memberId: string; roles: string[]; subject?: string; email?: string }
/** The fields these legs read off a response. Every leg asserts the status
 *  first, so a field it then reads is present (hence the `!`s below). */
interface ResBody {
  token?: string; workspaceId?: string; orgId?: string; memberId?: string; jobId?: string; groupId?: string;
  members?: M[]; keys?: Array<{ keyId: string }>; key?: { keyId: string }; roles?: string[];
  user?: { userId: string }; metadata?: { actingUserId?: string; disabledReason?: string };
  details?: { reason?: string; code?: string };
}
interface Res { status: number; body: ResBody }

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', connection: 'close', ...(cookie ? { cookie } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    const parsed = res.status === 204 ? undefined : ((await res.json().catch(() => undefined)) as ResBody | undefined);
    return { status: res.status, body: parsed ?? {} };
  };
  return {
    call,
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    patch: (p: string, b?: unknown) => call('PATCH', p, b),
    del: (p: string) => call('DELETE', p),
  };
}
type Client = ReturnType<typeof client>;

async function signIn(c: Client, email: string, tenantId?: string): Promise<void> {
  const r = await c.post(`${H}/test/login`, { email, ...(tenantId ? { tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

const membersPath = (ws: string) => `${H}/orgs/${encodeURIComponent(ws)}/members`;
const groupsPath = (ws: string) => `${H}/orgs/${encodeURIComponent(ws)}/groups`;
const reasonOf = (r: Res) => r.body.details?.reason ?? r.body.details?.code;

async function members(c: Client, ws: string): Promise<M[]> {
  const r = await c.get(membersPath(ws));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.members!;
}

async function joinAs(owner: Client, ws: string, role: string): Promise<{ c: Client; m: M }> {
  const email = `r815-${role}-${n++}@acme.test`;
  const invite = await owner.post(`${H}/orgs/${encodeURIComponent(ws)}/invites`, { email, role });
  expect(invite.status, JSON.stringify(invite.body)).toBe(201);
  const c = client();
  await signIn(c, email);
  expect((await c.post(`${H}/orgs/invitations/accept`, { token: invite.body.token })).status).toBe(201);
  expect((await c.post(`${H}/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
  const m = (await members(owner, ws)).find((x) => x.email === email)!;
  return { c, m };
}

/** A shared workspace: one owner (+ its member row) and one member at `role`. */
async function fixture(role: string) {
  const owner = client();
  await signIn(owner, `r815-owner-${n++}@acme.test`);
  const ws = await owner.post(`${H}/workspaces`, { name: `R815 ${n++}` });
  expect(ws.status, JSON.stringify(ws.body)).toBe(201);
  const id = ws.body.workspaceId!;
  expect((await owner.post(`${H}/workspaces/${encodeURIComponent(id)}/switch`)).status).toBe(200);
  const ownerMember = (await members(owner, id)).find((m) => m.roles.includes('owner'))!;
  const { c: other, m: otherMember } = await joinAs(owner, id, role);
  return { owner, ws: id, ownerMember, other, otherMember };
}

/** A legacy twin row (ADR 0697), planted the way the race wrote them. */
async function plantTwin(ws: string, memberId: string, subject: string, roles: string[]): Promise<void> {
  const storage = __hostExtStorage()!;
  const now = '2026-01-01T00:00:00.000Z'; // a fixed fixture stamp — nothing here compares times
  await storage.kvSet(`hostext:access-members:${memberId}`, JSON.stringify({ memberId, orgId: ws, tenantId: ws, subject, displayName: 'Twin', roles, teamIds: [], createdAt: now, updatedAt: now }));
}

beforeAll(async () => {
  for (const k of ['OPENWOP_STORAGE_DSN', 'OPENWOP_SESSION_SECRET', 'OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_DEMO_MODE']) saved[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_DEMO_MODE;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0815', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'orgs', 'cdp', 'environments', 'entities']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
}, 120_000);

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('ADR 0815 D1 — a sub-org is not a door to workspace authority', () => {
  it('a Viewer cannot mint a sub-org in the shared workspace (and so cannot reach environments); the owner can', async () => {
    const { owner, other } = await fixture('viewer');
    const r = await other.post(`${H}/orgs`, { name: 'door' });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(reasonOf(r)).toBe('owner_required');
    expect((await other.post(`${H}/environments`, { name: 'after' })).status).toBe(403);
    expect((await owner.post(`${H}/orgs`, { name: 'Team A' })).status).toBe(201);
  });

  it('owning a SUB-org confers no workspace-wide authority: no environments, no key admin, root roles on /access/effective', async () => {
    const { owner, ws, other, otherMember } = await fixture('viewer');
    const sub = await owner.post(`${H}/orgs`, { name: 'Team B' });
    expect(sub.status).toBe(201);
    const add = await owner.post(`${H}/orgs/${encodeURIComponent(sub.body.orgId!)}/members`, { displayName: 'v', subject: otherMember.subject, roles: ['owner'] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect((await other.post(`${H}/environments`, { name: 'y' })).status).toBe(403);
    // Key oversight is workspace management: a sub-org owner sees only its own keys.
    const ownerKey = await owner.post(`${H}/developer-keys`, { name: 'owner-ci', scopes: ['*'] });
    expect(ownerKey.status, JSON.stringify(ownerKey.body)).toBe(201);
    const list = await other.get(`${H}/developer-keys`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.keys!.map((k) => k.keyId)).not.toContain(ownerKey.body.key!.keyId);
    // Tenant-level resolution is the root row: viewer, never the sub-org's owner.
    expect((await resolveTenantLevelScopes(ws, otherMember.subject!)).scopes).not.toContain('host:members:manage');
    expect((await resolveSubjectScopesUnion(ws, otherMember.subject!)).scopes).not.toContain('workspace:write');
    // …while it IS authority inside that sub-org.
    expect((await other.post(`${H}/orgs/${encodeURIComponent(sub.body.orgId!)}/teams`, { name: 'inside' })).status).toBe(201);
  });

  it('in a ROOT-LESS shared tenant (the SAML `default` shape) only an existing owner creates orgs; the bootstrap still works', async () => {
    const T = `t-r815-${n++}`;
    const first = client();
    await signIn(first, `r815-saml-a-${n++}@acme.test`, T);
    expect((await first.post(`${H}/orgs`, { name: 'first' })).status).toBe(201);
    const mallory = client();
    await signIn(mallory, `r815-saml-m-${n++}@acme.test`, T);
    const r = await mallory.post(`${H}/orgs`, { name: 'mine' });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(reasonOf(r)).toBe('owner_required');
    expect((await first.post(`${H}/orgs`, { name: 'second' })).status).toBe(201);
  });
});

describe('ADR 0815 D1 — regressions: what must keep working', () => {
  it('an OWNER-created sub-org keeps its owners: root owners manage it and the workspace (the prod shape)', async () => {
    const { owner, ws, ownerMember } = await fixture('viewer');
    const { c: second, m: secondM } = await joinAs(owner, ws, 'viewer');
    expect((await owner.post(`${membersPath(ws)}/${encodeURIComponent(secondM.memberId)}/transfer-ownership`, {})).status).toBe(200);
    const sub = await owner.post(`${H}/orgs`, { name: 'Owner-made' });
    expect(sub.status).toBe(201);
    const subMembers = `${H}/orgs/${encodeURIComponent(sub.body.orgId!)}/members`;
    expect((await owner.post(subMembers, { displayName: 's', subject: secondM.subject, roles: ['owner'] })).status).toBe(201);
    for (const c of [owner, second]) {
      expect((await c.post(`${H}/orgs/${encodeURIComponent(sub.body.orgId!)}/teams`, { name: `t-${n++}` })).status).toBe(201);
      expect((await c.post(`${H}/environments`, { name: `e-${n++}` })).status).toBe(201);
    }
    expect((await resolveTenantLevelScopes(ws, ownerMember.subject!)).scopes).toContain('host:org:manage');
  });

  it('OUTSIDE a ws: workspace the RFC 0049 protocol-scope union is unchanged (viewer in A + editor in B ⇒ workspace:write)', async () => {
    const T = `acme-r815-${n++}`;
    const a = await createOrg({ tenantId: T, createdBy: 'user:x', name: 'A' });
    const b = await createOrg({ tenantId: T, createdBy: 'user:x', name: 'B' });
    await createMember({ orgId: a.orgId, tenantId: T, displayName: 'u', subject: 'user:r815-union', roles: ['viewer'] });
    await createMember({ orgId: b.orgId, tenantId: T, displayName: 'u', subject: 'user:r815-union', roles: ['editor'] });
    expect((await resolveSubjectScopesUnion(T, 'user:r815-union')).scopes).toContain('workspace:write');
  });
});

describe('ADR 0815 D1b — every tenant-level reader sees the root row', () => {
  it('/access/effective (no orgId) and the distinct-approver check read the ROOT membership, not a sub-org owner row', async () => {
    const { owner, ws, other, otherMember, ownerMember } = await fixture('viewer');
    const sub = await owner.post(`${H}/orgs`, { name: 'Sub' });
    expect((await owner.post(`${H}/orgs/${encodeURIComponent(sub.body.orgId!)}/members`, { displayName: 'v', subject: otherMember.subject, roles: ['owner'] })).status).toBe(201);
    const eff = await other.call('GET', `${H}/access/effective`);
    expect(eff.status).toBe(200);
    expect(eff.body.roles).toEqual(['viewer']);
    // A sub-org owner is not a second workspace decider: the real owner is alone.
    expect(await hasDistinctScopeHolder(ws, 'host:members:manage', ownerMember.subject!)).toBe(false);
  });

  it('in a root-less tenant, an owner through a GROUP may create orgs', async () => {
    const T = `t-r815-grp-${n++}`;
    const first = client();
    await signIn(first, `r815-g-a-${n++}@acme.test`, T);
    const boot = await first.post(`${H}/orgs`, { name: 'first' });
    expect(boot.status).toBe(201);
    const g = client();
    const login = await g.call('POST', `${H}/test/login`, { email: `r815-g-b-${n++}@acme.test`, tenantId: T });
    const subject = login.body.user!.userId;
    const row = await createMember({ orgId: boot.body.orgId!, tenantId: T, displayName: 'G', subject, roles: ['viewer'] });
    expect((await g.post(`${H}/orgs`, { name: 'not yet' })).status).toBe(403);
    await createGroup({ orgId: boot.body.orgId!, tenantId: T, name: 'owners', roles: ['owner'], memberIds: [row.memberId] });
    expect((await g.post(`${H}/orgs`, { name: 'now' })).status).toBe(201);
  });
});

describe('ADR 0815 D2 — the owner tier is judged per person', () => {
  it('an admin cannot remove a GROUP-derived owner, nor re-point its row at itself', async () => {
    const { owner, ws, other, otherMember } = await fixture('admin');
    const { m: v } = await joinAs(owner, ws, 'viewer');
    expect((await owner.post(groupsPath(ws), { name: 'owners', roles: ['owner'], memberIds: [v.memberId] })).status).toBe(201);
    const rebind = await other.patch(`${membersPath(ws)}/${encodeURIComponent(v.memberId)}`, { subject: otherMember.subject });
    expect(rebind.status, JSON.stringify(rebind.body)).toBe(403);
    const drop = await other.del(`${membersPath(ws)}/${encodeURIComponent(v.memberId)}`);
    expect(drop.status, JSON.stringify(drop.body)).toBe(403);
    expect(reasonOf(drop)).toBe('owner_required');
    expect((await getMember(v.memberId))?.subject).toBe(v.subject);
  });

  it('an admin cannot re-role a GROUP-derived owner either (D2 alone — no identity change involved)', async () => {
    const { owner, ws, other } = await fixture('admin');
    const { m: v } = await joinAs(owner, ws, 'viewer');
    expect((await owner.post(groupsPath(ws), { name: 'owners', roles: ['owner'], memberIds: [v.memberId] })).status).toBe(201);
    const r = await other.patch(`${membersPath(ws)}/${encodeURIComponent(v.memberId)}`, { roles: ['editor'] });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(reasonOf(r)).toBe('owner_required');
    expect((await getMember(v.memberId))?.roles).toEqual(['viewer']);
  });

  it("an admin cannot remove an OWNER by deleting the owner's legacy non-owner twin", async () => {
    const { owner, ws, ownerMember, other } = await fixture('admin');
    const { m: second } = await joinAs(owner, ws, 'viewer');
    expect((await owner.post(`${membersPath(ws)}/${encodeURIComponent(second.memberId)}/transfer-ownership`, {})).status).toBe(200);
    const twinId = `mbr-r815-twin-${n++}`;
    await plantTwin(ws, twinId, ownerMember.subject!, ['viewer']);
    const drop = await other.del(`${membersPath(ws)}/${twinId}`);
    expect(drop.status, JSON.stringify(drop.body)).toBe(403);
    expect((await members(other, ws)).some((m) => m.memberId === ownerMember.memberId)).toBe(true);
  });
});

describe('ADR 0815 D3 — identity is not edited in place; updates neither resurrect nor half-apply', () => {
  it('an owner cannot re-point a member at another identity: the old person would have kept the workspace', async () => {
    const { owner, ws, other, otherMember } = await fixture('editor');
    const r = await owner.patch(`${membersPath(ws)}/${encodeURIComponent(otherMember.memberId)}`, { subject: 'user:someone-else' });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(reasonOf(r)).toBe('identity_locked');
    expect((await getMember(otherMember.memberId))?.subject).toBe(otherMember.subject);
    expect((await other.get(membersPath(ws))).status).toBe(200);
  });

  it('a sub-org cannot hold the same identity twice', async () => {
    const { owner, otherMember } = await fixture('editor');
    const sub = await owner.post(`${H}/orgs`, { name: 'Twins' });
    const path = `${H}/orgs/${encodeURIComponent(sub.body.orgId!)}/members`;
    expect((await owner.post(path, { displayName: 'a', subject: otherMember.subject, roles: ['viewer'] })).status).toBe(201);
    const dup = await owner.post(path, { displayName: 'b', subject: otherMember.subject, roles: ['viewer'] });
    expect(dup.status, JSON.stringify(dup.body)).toBe(409);
    expect(reasonOf(dup)).toBe('identity_taken');
  });

  it('transfer-ownership with stepDown onto your own twin row is refused', async () => {
    const { owner, ws, ownerMember } = await fixture('viewer');
    const twinId = `mbr-r815-self-${n++}`;
    await plantTwin(ws, twinId, ownerMember.subject!, ['viewer']);
    const r = await owner.post(`${membersPath(ws)}/${twinId}/transfer-ownership`, { stepDown: true });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(reasonOf(r)).toBe('transfer_to_self');
    expect((await getMember(ownerMember.memberId))?.roles).toContain('owner');
  });

  it('a subject-less sub-org placeholder can be bound, but not onto an identity already there', async () => {
    const { owner, otherMember } = await fixture('editor');
    const sub = await owner.post(`${H}/orgs`, { name: 'Bind' });
    const path = `${H}/orgs/${encodeURIComponent(sub.body.orgId!)}/members`;
    expect((await owner.post(path, { displayName: 'real', subject: otherMember.subject, roles: ['viewer'] })).status).toBe(201);
    const ph = await owner.post(path, { displayName: 'placeholder', roles: ['viewer'] });
    expect(ph.status).toBe(201);
    const taken = await owner.patch(`${path}/${ph.body.memberId}`, { subject: otherMember.subject });
    expect(taken.status, JSON.stringify(taken.body)).toBe(409);
    expect(reasonOf(taken)).toBe('identity_taken');
    expect((await owner.patch(`${path}/${ph.body.memberId}`, { subject: 'user:r815-new-person' })).status).toBe(200);
  });

  it('a demotion holds against a legacy twin', async () => {
    const WS = `ws:r815-demote-${n++}`;
    await createMember({ orgId: WS, tenantId: WS, displayName: 'O', subject: 'user:r815-o', roles: ['owner'] });
    const visible = await createMember({ orgId: WS, tenantId: WS, displayName: 'A', subject: 'user:r815-adm', roles: ['admin'] });
    await plantTwin(WS, `mbr-r815-adm-twin-${n++}`, 'user:r815-adm', ['admin']);
    expect((await resolveTenantLevelScopes(WS, 'user:r815-adm')).scopes).toContain('host:members:manage');
    await updateMember(visible.memberId, { roles: ['viewer'] });
    expect((await resolveTenantLevelScopes(WS, 'user:r815-adm')).scopes, 'the demotion must hold').not.toContain('host:members:manage');
  });

  it('20 forced interleavings of deleteMember ∥ updateMember: the removal always holds', async () => {
    const WS = `ws:r815-race-${n++}`;
    await createMember({ orgId: WS, tenantId: WS, displayName: 'O', subject: 'user:r815-race-owner', roles: ['owner'] });
    for (let i = 0; i < 20; i++) {
      const subject = `user:r815-race-${i}`;
      const m = await createMember({ orgId: WS, tenantId: WS, displayName: 'M', subject, roles: ['editor'] });
      await Promise.all([deleteMember(m.memberId), updateMember(m.memberId, { displayName: `renamed-${i}` }).catch(() => null)]);
      expect(await getMember(m.memberId), `interleaving ${i} resurrected the row`).toBeNull();
      expect(await isWorkspaceMember(subject, WS)).toBe(false);
    }
  });
});

describe('ADR 0815 D4 — removal takes down what the member delegated', () => {
  it('a pending invite minted by an admin is not redeemable after that admin is removed — or demoted', async () => {
    for (const how of ['remove', 'demote'] as const) {
      const { owner, ws, other, otherMember } = await fixture('admin');
      const email = `r815-late-${n++}@acme.test`;
      const inv = await other.post(`${H}/orgs/${encodeURIComponent(ws)}/invites`, { email, role: 'editor' });
      expect(inv.status, JSON.stringify(inv.body)).toBe(201);
      const keep = `r815-kept-${n++}@acme.test`;
      const mine = await owner.post(`${H}/orgs/${encodeURIComponent(ws)}/invites`, { email: keep, role: 'viewer' });
      const d = how === 'remove'
        ? await owner.del(`${membersPath(ws)}/${encodeURIComponent(otherMember.memberId)}`)
        : await owner.patch(`${membersPath(ws)}/${encodeURIComponent(otherMember.memberId)}`, { roles: ['viewer'] });
      expect([200, 204], JSON.stringify(d.body)).toContain(d.status);
      const late = client();
      await signIn(late, email);
      const refused = await late.post(`${H}/orgs/invitations/accept`, { token: inv.body.token });
      expect(refused.status, how).toBe(400);
      expect(reasonOf(refused), how).toBe('invalid_invite');
      // The owner's own invite is untouched.
      const kept = client();
      await signIn(kept, keep);
      expect((await kept.post(`${H}/orgs/invitations/accept`, { token: mine.body.token })).status, how).toBe(201);
    }
  });

  it('losing `host:members:manage` through a GROUP edit also cancels the pending invites', async () => {
    const { owner, ws, other, otherMember } = await fixture('viewer');
    const g = await owner.post(groupsPath(ws), { name: 'admins', roles: ['admin'], memberIds: [otherMember.memberId] });
    expect(g.status).toBe(201);
    const email = `r815-grp-${n++}@acme.test`;
    const inv = await other.post(`${H}/orgs/${encodeURIComponent(ws)}/invites`, { email, role: 'viewer' });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect((await owner.patch(`${groupsPath(ws)}/${g.body.groupId}`, { memberIds: [] })).status).toBe(200);
    const late = client();
    await signIn(late, email);
    const refused = await late.post(`${H}/orgs/invitations/accept`, { token: inv.body.token });
    expect(refused.status).toBe(400);
    expect(reasonOf(refused)).toBe('invalid_invite');
  });

  it("an invite minted while viewing as someone is the CALLER's: removing the viewed member leaves it alive", async () => {
    const { owner, ws, otherMember } = await fixture('admin');
    const email = `r815-actas-${n++}@acme.test`;
    const inv = await owner.call('POST', `${H}/orgs/${encodeURIComponent(ws)}/invites`, { email, role: 'viewer' }, { 'x-openwop-act-as': otherMember.memberId });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect((await owner.del(`${membersPath(ws)}/${encodeURIComponent(otherMember.memberId)}`)).status).toBe(204);
    const c = client();
    await signIn(c, email);
    expect((await c.post(`${H}/orgs/invitations/accept`, { token: inv.body.token })).status).toBe(201);
  });

  it("leaving the workspace pauses the schedules that act as you; the owner's are untouched; Resume re-owns", async () => {
    const { owner, ws, other, otherMember, ownerMember } = await fixture('editor');
    const mine = await other.post(`${H}/scheduler/jobs`, { cronExpr: '0 9 * * *', enabled: true });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    expect(mine.body.metadata?.actingUserId).toBe(otherMember.subject);
    const theirs = await owner.post(`${H}/scheduler/jobs`, { cronExpr: '0 10 * * *', enabled: true });
    expect(theirs.status).toBe(201);
    expect((await owner.del(`${membersPath(ws)}/${encodeURIComponent(otherMember.memberId)}`)).status).toBe(204);
    const a = await getJob(mine.body.jobId!);
    expect(a?.enabled).toBe(false);
    expect(a?.metadata?.disabledReason).toBe('acting_member_removed');
    expect((await getJob(theirs.body.jobId!))?.enabled).toBe(true);
    // "Run now" refuses to run it as the ex-member.
    const run = await owner.post(`${H}/scheduler/jobs/${encodeURIComponent(mine.body.jobId!)}/trigger`, {});
    expect(run.status, JSON.stringify(run.body)).toBe(409);
    expect(reasonOf(run)).toBe('acting_member_removed');
    // The marker is server-owned: a client metadata patch cannot clear it.
    await owner.patch(`${H}/scheduler/jobs/${encodeURIComponent(mine.body.jobId!)}`, { metadata: { disabledReason: 'x' } });
    expect((await getJob(mine.body.jobId!))?.metadata?.disabledReason).toBe('acting_member_removed');
    // Resume RE-OWNS it.
    const re = await owner.patch(`${H}/scheduler/jobs/${encodeURIComponent(mine.body.jobId!)}`, { enabled: true });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(re.body.metadata?.actingUserId).toBe(ownerMember.subject);
    expect(re.body.metadata?.disabledReason).toBeUndefined();
  });

  it('losing the ROOT row is leaving, even with a sub-org row left behind', async () => {
    const { owner, ws, other, otherMember } = await fixture('editor');
    const sub = await owner.post(`${H}/orgs`, { name: 'Kept' });
    expect((await owner.post(`${H}/orgs/${encodeURIComponent(sub.body.orgId!)}/members`, { displayName: 'k', subject: otherMember.subject, roles: ['viewer'] })).status).toBe(201);
    const job = await other.post(`${H}/scheduler/jobs`, { cronExpr: '0 9 * * *', enabled: true });
    expect(job.status).toBe(201);
    expect((await owner.del(`${membersPath(ws)}/${encodeURIComponent(otherMember.memberId)}`)).status).toBe(204);
    expect((await getJob(job.body.jobId!))?.enabled).toBe(false);
  });

  it('a feature re-registering a paused job does not re-arm it as the ex-member, and enabling without an actor is a typed 409', async () => {
    const T = `ws:r815-rereg-${n++}`;
    await createMember({ orgId: T, tenantId: T, displayName: 'O', subject: 'user:r815-rr-owner', roles: ['owner'] });
    const m = await createMember({ orgId: T, tenantId: T, displayName: 'L', subject: 'user:r815-rr-leaver', roles: ['editor'] });
    const id = `job-r815-${n++}`;
    const reg = await registerJob({ jobId: id, tenantId: T, cronExpr: '0 9 * * *', metadata: { actingUserId: 'user:r815-rr-leaver' } });
    expect(reg.ok).toBe(true);
    await deleteMember(m.memberId);
    expect((await getJob(id))?.enabled).toBe(false);
    const again = await registerJob({ jobId: id, tenantId: T, cronExpr: '0 9 * * *', metadata: { actingUserId: 'user:r815-rr-leaver' } });
    expect(again.ok).toBe(true);
    expect((await getJob(id))?.enabled, 're-registration re-armed the job').toBe(false);
    await expect(updateJob(id, { enabled: true })).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'acting_member_removed' } });
  });
});

describe('ADR 0815 D5 — member lifecycle events', () => {
  it('added / roles-changed / removed fire once per transition, ids only', async () => {
    const seen: HostEventEnvelope[] = [];
    const hostSuite: StartRunDeps['hostSuite'] = {
      workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
      providerPolicyResolver: { resolveForRun: async () => [] },
    };
    initHostEventDispatcher({ storage, hostSuite, deliverWebhooks: async (e) => { if (e.type.startsWith('host.orgs.member.')) seen.push(e); }, startRun: async () => 'run:fake' });
    const { owner, ws } = await fixture('viewer');
    // No settle wait: `emitHostEvent` hands the envelope to `deliverWebhooks`
    // before its first await, and every member emit runs inside the request
    // handler, so `seen` is complete when each response returns.
    seen.length = 0;
    const add = await owner.post(membersPath(ws), { displayName: 'Ada Lovelace', email: 'ada@acme.test', subject: `saml:ada-${n++}@acme.test`, roles: ['viewer'] });
    expect(add.status).toBe(201);
    await owner.patch(`${membersPath(ws)}/${add.body.memberId}`, { displayName: 'renamed' }); // not a role change
    await owner.patch(`${membersPath(ws)}/${add.body.memberId}`, { roles: ['editor'] });
    await owner.del(`${membersPath(ws)}/${add.body.memberId}`);
    await owner.del(`${membersPath(ws)}/${add.body.memberId}`); // nothing left to remove
    expect(seen.map((e) => e.type)).toEqual(['host.orgs.member.added', 'host.orgs.member.roles-changed', 'host.orgs.member.removed']);
    const blob = JSON.stringify(seen.map((e) => e.payload));
    expect(blob).not.toContain('ada@acme.test');
    expect(blob).not.toContain('Ada Lovelace');
    expect((seen[0]!.payload as Record<string, unknown>).subject).toBe('saml:(redacted)');
  });
});

// LAST: registers a session authority stub for the rest of the process.
describe('ADR 0815 D4 — deactivated accounts', () => {
  it('a deactivated actor: the fire is skipped (non-destructive)', async () => {
    registerSessionAuthority(async (userId) => (userId === 'user:r815-off' ? { status: 'disabled', sessionEpoch: 0 } : { status: 'active', sessionEpoch: 0 }));
    // Real stored jobs, not hand-built literals: the predicate reads the row the daemon reads.
    const on = await registerJob({ jobId: `j-r815-on-${n++}`, tenantId: 't', cronExpr: '* * * * *', metadata: { actingUserId: 'user:r815-on' } });
    const off = await registerJob({ jobId: `j-r815-off-${n++}`, tenantId: 't', cronExpr: '* * * * *', metadata: { actingUserId: 'user:r815-off' } });
    if (!on.ok || !off.ok) throw new Error('fixture: registerJob refused');
    expect(await jobActorIsInactive(on.job)).toBe(false);
    expect(await jobActorIsInactive(off.job)).toBe(true);
  });

});
