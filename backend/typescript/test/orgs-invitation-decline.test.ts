/**
 * ADR 0564 P1 (implemented by ADR 0622 D4) + D6 + D7 — the recipient-side
 * DECLINE, the email-ownership PROVENANCE gate, and the invitation store's
 * reachable SubjectEraser.
 *
 * Two harnesses: the ROUTE lane over the real app (the gate chain over HTTP —
 * signed-in, invite-tenant toggle, expiry, email ownership + provenance,
 * idempotent 200, the accept page's `declined` reason on preview + accept,
 * the inviter's list carrying `status`/`declinedAt`), and a SERVICE lane over
 * sqlite for the two things HTTP cannot pin: the decline-vs-accept RACE
 * (CAS vs claim-by-delete ⇒ exactly one outcome) and the eraser's two keys.
 *
 * D7 — the four provenance lanes the ADR names: login after mint → OK (`idp`);
 * a shared-workspace admin PATCHes a member's email → OK (`admin`, vouched);
 * a personal-tenant self-PATCH → 403 `email_unverified` (`self`);
 * SAML/IdP-refreshed (`upsertFromPrincipal` with an email) → OK (`idp`).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { enableTenantOverride, saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault, registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { DurableCollection, __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __resetUsersStore, createUser, getUser, updateUser, upsertFromPrincipal, usersEmailKeyResolver, type User } from '../src/features/users/usersService.js';
import { __resetAccessStores, createOrg, listMembers } from '../src/host/accessControlService.js';
import {
  __resetOrgInvites,
  acceptInvitation,
  createInvitation,
  declineInvitation,
  eraseOrgInvitationsSubject,
  listInvitations,
  previewInvitation,
  type OrgInvitation,
} from '../src/features/orgs/invitationsService.js';
import { eraseSubject, registeredSubjectEraserIds } from '../src/host/subjectErasure.js';
import { EXPECTED_SUBJECT_ERASERS } from '../src/host/subjectEraserManifest.js';

// ─────────────────────────── ROUTE lane ───────────────────────────
let BASE = '';
let server: http.Server;
interface Res { status: number; body: any }
function client(): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const sc of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}
let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: ReturnType<typeof client>, email: string, extra: Record<string, unknown> = {}): Promise<{ userId: string; email: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
async function ownerOrg(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const owner = client();
  await signup(owner, uniqEmail('owner'));
  const org = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body;
  return { owner, orgId: org.orgId as string, tenantId: org.tenantId as string };
}
const invitesPath = (orgId: string) => `/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/invites`;
const DECLINE = '/v1/host/openwop-app/orgs/invitations/decline';
const ACCEPT = '/v1/host/openwop-app/orgs/invitations/accept';
const preview = (token: string) => client().get(`/v1/host/openwop-app/orgs/invitations/preview?token=${encodeURIComponent(token)}`);

describe('ADR 0564 P1 / ADR 0622 D4 — POST /orgs/invitations/decline over HTTP', () => {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    delete process.env.OPENWOP_DEMO_MODE;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    for (const id of ['users', 'orgs']) {
      const def = getToggleDefault(id);
      if (def) await saveConfig({ ...def, status: 'on' }, 'test');
    }
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it('the gate chain: signed-out → 401; unknown token → 400; expired → 400 expired; wrong email → 403; the invite tenant\'s toggle OFF → 400 invalid_invite', async () => {
    expect((await client().post(DECLINE, { token: 'whatever' })).status).toBe(401);
    const { owner, orgId, tenantId } = await ownerOrg();
    const email = uniqEmail('bob');
    const inv = await owner.post(invitesPath(orgId), { email, role: 'viewer' });
    const bobC = client();
    await signup(bobC, email);
    expect((await bobC.post(DECLINE, { token: 'orginv_nope' })).status).toBe(400);
    expect((await bobC.post(DECLINE, {})).status).toBe(400);
    // Wrong email: a stranger holding the token cannot decline on bob's behalf.
    const strangerC = client();
    await signup(strangerC, uniqEmail('stranger'));
    const stranger = await strangerC.post(DECLINE, { token: inv.body.token });
    expect(stranger.status).toBe(403);
    expect(stranger.body.details?.reason).toBeUndefined();
    // Expired: age the row past expiry (direct store surgery).
    const store = new DurableCollection<{ inviteId: string; expiresAt: string }>('orgs:invite', (i) => i.inviteId);
    const row = (await store.get(inv.body.invite.inviteId))!;
    await store.put({ ...row, expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const expired = await bobC.post(DECLINE, { token: inv.body.token });
    expect(expired.status).toBe(400);
    expect(expired.body.details?.reason).toBe('expired');
    await store.put(row);
    // The INVITE tenant's toggle, not the caller's (the ORGINV-1 class).
    const def = getToggleDefault('orgs')!;
    try {
      await saveConfig({ ...def, status: 'off' }, 'test');
      const off = await bobC.post(DECLINE, { token: inv.body.token });
      expect(off.status).toBe(400);
      expect(off.body.details?.code).toBe('invalid_invite');
      expect(await enableTenantOverride('orgs', tenantId, 'test')).toBe('enabled');
      expect((await bobC.post(DECLINE, { token: inv.body.token })).status).toBe(200); // bob's own tenant is still OFF
    } finally { await saveConfig({ ...def, status: 'on' }, 'test'); }
    // Nothing above minted a member or burned the row.
    expect((await owner.get(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`)).body.members.some((m: { email?: string }) => m.email === email)).toBe(false);
  });

  it('decline flips the row to declined (visible to the inviter with declinedAt), is idempotent (same 200), and preview + accept then answer reason=declined without burning the row', async () => {
    const { owner, orgId } = await ownerOrg();
    const email = uniqEmail('bob');
    const inv = await owner.post(invitesPath(orgId), { email, role: 'editor' });
    const bobC = client();
    await signup(bobC, email);
    expect((await preview(inv.body.token)).status).toBe(200);
    const d1 = await bobC.post(DECLINE, { token: inv.body.token });
    expect(d1.status, JSON.stringify(d1.body)).toBe(200);
    expect(d1.body).toEqual({ inviteId: inv.body.invite.inviteId, orgId, status: 'declined', declinedAt: expect.any(String) });
    const d2 = await bobC.post(DECLINE, { token: inv.body.token });
    expect(d2.status).toBe(200);
    expect(d2.body).toEqual(d1.body);
    // The inviter SEES it: the list row carries status + declinedAt, and Revoke stays available.
    const list = await owner.get(invitesPath(orgId));
    const listed = list.body.invites.find((i: { inviteId: string }) => i.inviteId === inv.body.invite.inviteId);
    expect(listed).toMatchObject({ status: 'declined', declinedAt: d1.body.declinedAt, expired: false });
    expect(listed.tokenHash).toBeUndefined();
    // Preview and accept: the declined reason, and the row is NOT burned.
    const p = await preview(inv.body.token);
    expect(p.status).toBe(400);
    expect(p.body.details).toMatchObject({ code: 'invalid_invite', reason: 'declined' });
    const a = await bobC.post(ACCEPT, { token: inv.body.token });
    expect(a.status).toBe(400);
    expect(a.body.details).toMatchObject({ code: 'invalid_invite', reason: 'declined' });
    expect((await owner.get(invitesPath(orgId))).body.invites).toHaveLength(1);
    expect((await owner.get(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`)).body.members.some((m: { email?: string }) => m.email === email)).toBe(false);
  });

  describe('ADR 0622 D7 — the email-ownership PROVENANCE gate on accept AND decline', () => {
    it('login after mint (the test seam / IdP lane) → accept OK; the row carries emailProvenance idp', async () => {
      const { owner, orgId } = await ownerOrg();
      const email = uniqEmail('idp');
      const inv = await owner.post(invitesPath(orgId), { email, role: 'viewer' });
      const bobC = client();
      const bob = await signup(bobC, email);
      expect((await getUser(bob.userId))!.emailProvenance).toBe('idp');
      expect((await bobC.post(ACCEPT, { token: inv.body.token })).status).toBe(201);
    });

    it('a SHARED-workspace admin PATCHes a member\'s email → vouched (admin) → accept OK', async () => {
      const { owner, orgId } = await ownerOrg();
      const email = uniqEmail('vouched');
      const inv = await owner.post(invitesPath(orgId), { email, role: 'viewer' });
      // A shared `ws:` workspace: the admin founds it; the member is minted in it with NO email.
      const WS = `ws:d7-${Date.now()}-${n++}`;
      const adminC = client();
      await signup(adminC, uniqEmail('ws-admin'), { tenantId: WS });
      const memberC = client();
      const member = await signup(memberC, uniqEmail('ws-member-login'), { tenantId: WS, subject: `oidc:d7-member-${n++}` });
      const seeded = (await getUser(member.userId))!;
      // The admin vouches for the member's address (another user's row, no personal short-circuit in a ws: tenant).
      const patched = await adminC.patch(`/v1/host/openwop-app/users/users/${encodeURIComponent(seeded.userId)}`, { email });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      expect(patched.body.emailProvenance).toBe('admin');
      // The member accepts the invite issued to that address from their session.
      const acc = await memberC.post(ACCEPT, { token: inv.body.token });
      expect(acc.status, JSON.stringify(acc.body)).toBe(201);
    });

    it('a PERSONAL-tenant self-PATCH of the email → self → accept AND decline refuse 403 email_unverified; the row is not burned', async () => {
      const { owner, orgId } = await ownerOrg();
      const email = uniqEmail('target');
      const inv = await owner.post(invitesPath(orgId), { email, role: 'viewer' });
      // Mallory signs in under her own address, then renames herself to the invitee's.
      const malloryC = client();
      const mallory = await signup(malloryC, uniqEmail('mallory'));
      const patched = await malloryC.patch(`/v1/host/openwop-app/users/users/${encodeURIComponent(mallory.userId)}`, { email });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      expect(patched.body.emailProvenance).toBe('self');
      for (const path of [ACCEPT, DECLINE]) {
        const r = await malloryC.post(path, { token: inv.body.token });
        expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBe(403);
        expect(r.body.details).toMatchObject({ code: 'forbidden', reason: 'email_unverified' });
      }
      expect((await preview(inv.body.token)).status).toBe(200); // still live for the real recipient
      expect((await owner.get(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`)).body.members.some((m: { subject?: string }) => m.subject === mallory.userId)).toBe(false);
    });

    it('review S1 — a PERSONAL-tenant owner POSTing a "saml" user with the victim\'s email gets a SELF row (provenance is the lane\'s, never the body\'s source) → accept 403 email_unverified', async () => {
      const { owner, orgId } = await ownerOrg();
      const email = uniqEmail('victim');
      const inv = await owner.post(invitesPath(orgId), { email, role: 'viewer' });
      // Mallory, in her own personal tenant, is its implicit owner — the admin
      // POST is open to her there. She claims the row is SAML-provisioned.
      const malloryC = client();
      await signup(malloryC, uniqEmail('mallory-s1'));
      const forged = await malloryC.post('/v1/host/openwop-app/users/users', { principalId: `saml:forged-${n++}`, source: 'saml', email });
      expect(forged.status, JSON.stringify(forged.body)).toBe(201);
      expect(forged.body.source).toBe('saml'); // the claim is recorded as what it is…
      expect(forged.body.emailProvenance).toBe('self'); // …but the address is hers, unvouched.
      // The forged row cannot accept the invite (service lane — the row has no session).
      const row = (await getUser(forged.body.userId))!;
      await expect(acceptInvitation(inv.body.token, row)).rejects.toMatchObject({ reason: 'email_unverified' });
      expect((await preview(inv.body.token)).status).toBe(200); // not burned
    });

    it('an IdP refresh (upsertFromPrincipal with an email — SAML/SCIM lane) re-asserts idp and clears a self provenance → accept OK', async () => {
      const { owner, orgId } = await ownerOrg();
      const email = uniqEmail('saml');
      const inv = await owner.post(invitesPath(orgId), { email, role: 'viewer' });
      const bobC = client();
      const bob = await signup(bobC, uniqEmail('bob-old'));
      await updateUser(bob.userId, { email, emailProvenance: 'self' });
      expect((await bobC.post(ACCEPT, { token: inv.body.token })).status).toBe(403);
      const row = (await getUser(bob.userId))!;
      await upsertFromPrincipal({ tenantId: row.tenantId, principalId: row.principalId, source: 'saml', email });
      expect((await getUser(bob.userId))!.emailProvenance).toBe('idp');
      expect((await bobC.post(ACCEPT, { token: inv.body.token })).status).toBe(201);
    });
  });
});

// ─────────────────────────── SERVICE lane ───────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'owop-orginv-decline-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const mkUser = (tenantId: string, email?: string): Promise<User> =>
  createUser({ tenantId, principalId: `password:${email ?? tenantId}`, source: 'password', ...(email ? { email, emailProvenance: 'idp' as const } : {}) });

describe('ADR 0622 D4 — the decline-vs-accept race and the replay posture (service lane)', () => {
  beforeEach(async () => {
    __resetHostExtPersistence();
    initHostExtPersistence(openSqliteStorage(join(dir, `decline-${n++}.db`)));
    await __resetUsersStore();
    await __resetAccessStores();
    await __resetOrgInvites();
    registerToggleDefault({ id: 'orgs', label: 'Orgs', status: 'on' as const, salt: 'orgs', bucketUnit: 'tenant' as const });
    await saveConfig({ id: 'orgs', label: 'Orgs', status: 'on' as const, salt: 'orgs', bucketUnit: 'tenant' as const }, 'test');
  });
  afterEach(() => { __resetHostExtPersistence(); });

  it('a concurrent accept + decline of ONE token yields EXACTLY ONE outcome — never a member AND a declined row, never a resurrected row', async () => {
    const org = await createOrg({ tenantId: 't', createdBy: 'owner', name: 'Acme' });
    const bob = await mkUser('t', 'bob@acme.test');
    const { token, invite } = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'bob@acme.test', role: 'editor' });
    const results = await Promise.allSettled([acceptInvitation(token, bob), declineInvitation(token, bob)]);
    const wins = results.filter((r) => r.status === 'fulfilled');
    expect(wins, 'exactly one of accept/decline wins').toHaveLength(1);
    const rows = await listInvitations('t', org.orgId);
    const member = (await listMembers('t', org.orgId)).some((m) => m.subject === bob.userId);
    if (results[0]!.status === 'fulfilled') {
      // Accept won: the row is GONE (claim-by-delete) — the decline's CAS must not have resurrected it.
      expect(member).toBe(true);
      expect(rows).toEqual([]);
      expect(results[1]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ code: 'invalid_invite' }) });
    } else {
      // Decline won: the row is DECLINED and no membership was minted.
      expect(member).toBe(false);
      expect(rows.map((r) => [r.inviteId, r.status])).toEqual([[invite.inviteId, 'declined']]);
      expect(results[0]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ code: 'invalid_invite', reason: 'declined' }) });
    }
  });

  it('two CONCURRENT declines: one CAS winner, both callers get the same declined answer', async () => {
    const org = await createOrg({ tenantId: 't', createdBy: 'owner', name: 'Acme' });
    const bob = await mkUser('t', 'bob@acme.test');
    const { token } = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'bob@acme.test', role: 'viewer' });
    const [a, b] = await Promise.all([declineInvitation(token, bob), declineInvitation(token, bob)]);
    expect(a.status).toBe('declined');
    expect(b).toEqual(a);
  });

  it('replay after decline is a UNIFORM failure on every lane: accept, preview, and a second accept — the token-hash index stays until age-out', async () => {
    const org = await createOrg({ tenantId: 't', createdBy: 'owner', name: 'Acme' });
    const bob = await mkUser('t', 'bob@acme.test');
    const { token, invite } = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'bob@acme.test', role: 'viewer' });
    await declineInvitation(token, bob);
    for (let i = 0; i < 2; i++) {
      await expect(acceptInvitation(token, bob)).rejects.toMatchObject({ code: 'invalid_invite', reason: 'declined' });
      await expect(previewInvitation(token)).rejects.toMatchObject({ code: 'invalid_invite', reason: 'declined' });
    }
    const idx = new DurableCollection<{ key: string; inviteId: string }>('orgs:invite-hashidx', (r) => r.key);
    expect((await idx.list()).map((r) => r.inviteId)).toEqual([invite.inviteId]);
    expect((await listMembers('t', org.orgId)).some((m) => m.subject === bob.userId)).toBe(false);
    // A re-mint over the declined row replaces it (the inviter's explicit choice) and the new token works.
    const again = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'bob@acme.test', role: 'viewer' });
    expect(again.superseded.map((r) => [r.inviteId, r.status])).toEqual([[invite.inviteId, 'declined']]);
    expect((await acceptInvitation(again.token, bob)).alreadyMember).toBe(false);
  });

  it('the mint primitive reports what it superseded (ADR 0622 D5) and `replace:false` leaves the prior row live', async () => {
    const org = await createOrg({ tenantId: 't', createdBy: 'owner', name: 'Acme' });
    const first = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'x@acme.test', role: 'viewer' });
    expect(first.superseded).toEqual([]);
    const second = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'x@acme.test', role: 'admin' }, { replace: false });
    expect(second.superseded).toEqual([]);
    expect((await listInvitations('t', org.orgId)).map((r) => r.inviteId).sort()).toEqual([first.invite.inviteId, second.invite.inviteId].sort());
    const third = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'x@acme.test', role: 'editor' });
    expect(third.superseded.map((r) => r.inviteId).sort()).toEqual([first.invite.inviteId, second.invite.inviteId].sort());
    expect((await listInvitations('t', org.orgId)).map((r) => r.inviteId)).toEqual([third.invite.inviteId]);
  });
});

describe('ADR 0622 D6 — `orgs:invite` SubjectEraser: both keys, reachable by userId through the users resolver', () => {
  beforeEach(async () => {
    __resetHostExtPersistence();
    initHostExtPersistence(openSqliteStorage(join(dir, `erase-${n++}.db`)));
    await __resetUsersStore();
    await __resetAccessStores();
    await __resetOrgInvites();
    registerToggleDefault({ id: 'orgs', label: 'Orgs', status: 'on' as const, salt: 'orgs', bucketUnit: 'tenant' as const });
    await saveConfig({ id: 'orgs', label: 'Orgs', status: 'on' as const, salt: 'orgs', bucketUnit: 'tenant' as const }, 'test');
  });
  afterEach(() => { __resetHostExtPersistence(); });

  it('is registered under its manifest name (the three-layer gate sees it)', () => {
    expect(EXPECTED_SUBJECT_ERASERS.has('eraseOrgInvitationsSubject')).toBe(true);
    expect(registeredSubjectEraserIds()).toContain('eraseOrgInvitationsSubject');
  });

  it('the RECIPIENT key (email): rows for that address are deleted INDEX-FIRST (the token stops resolving); other rows and other tenants untouched; idempotent', async () => {
    const org = await createOrg({ tenantId: 't', createdBy: 'owner', name: 'Acme' });
    const foreignOrg = await createOrg({ tenantId: 'other', createdBy: 'owner', name: 'Other' });
    const mine = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'Gone@Acme.Test', role: 'viewer' });
    const keep = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'stay@acme.test', role: 'viewer' });
    const foreign = await createInvitation({ tenantId: 'other', orgId: foreignOrg.orgId, email: 'gone@acme.test', role: 'viewer' });
    expect(await eraseOrgInvitationsSubject('t', 'gone@acme.test')).toEqual({ rowsTouched: 1 });
    await expect(previewInvitation(mine.token)).rejects.toMatchObject({ code: 'invalid_invite' });
    expect((await listInvitations('t', org.orgId)).map((r) => r.inviteId)).toEqual([keep.invite.inviteId]);
    await expect(previewInvitation(foreign.token)).resolves.toMatchObject({ orgId: foreignOrg.orgId }); // tenant-scoped
    expect(await eraseOrgInvitationsSubject('t', 'gone@acme.test')).toEqual({ rowsTouched: 0 }); // idempotent
    expect(await eraseOrgInvitationsSubject('', 'gone@acme.test')).toEqual({ rowsTouched: 0 }); // fail-closed
  });

  it('the INVITER key (userId): createdByName is scrubbed and createdBy tombstoned; the invite stays LIVE for its recipient', async () => {
    const org = await createOrg({ tenantId: 't', createdBy: 'owner', name: 'Acme' });
    const inviter = await mkUser('t', 'ana@acme.test');
    const { token, invite } = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'bob@acme.test', role: 'viewer', createdBy: inviter.userId, createdByName: 'Ana Silva' });
    expect((await previewInvitation(token)).invitedBy).toBe('Ana Silva');
    expect(await eraseOrgInvitationsSubject('t', inviter.userId)).toEqual({ rowsTouched: 1 });
    const row = (await listInvitations('t', org.orgId)).find((r) => r.inviteId === invite.inviteId) as OrgInvitation;
    expect(row.createdBy).toBe('erased:subject');
    expect(row.createdByName).toBeUndefined();
    expect((await previewInvitation(token)).invitedBy).toBeUndefined();
    expect(await eraseOrgInvitationsSubject('t', inviter.userId)).toEqual({ rowsTouched: 0 }); // idempotent
    const bob = await mkUser('t', 'bob@acme.test');
    expect((await acceptInvitation(token, bob)).alreadyMember).toBe(false); // still the org's live door
  });

  it('REACHABILITY: erasing a joined user BY USERID (the users erase route\'s key) reaches the pending invite to their address through usersEmailKeyResolver', async () => {
    const org = await createOrg({ tenantId: 't', createdBy: 'owner', name: 'Acme' });
    const bob = await mkUser('t', 'Bob@Acme.Test');
    expect(await usersEmailKeyResolver('t', bob.userId)).toEqual(['bob@acme.test']);
    expect(await usersEmailKeyResolver('other', bob.userId)).toEqual([]); // tenant-guarded
    expect(await usersEmailKeyResolver('t', 'bob@acme.test')).toEqual([]); // never a heuristic match on an email key
    const { token } = await createInvitation({ tenantId: 't', orgId: org.orgId, email: 'bob@acme.test', role: 'viewer' });
    const result = await eraseSubject('t', bob.userId);
    expect(result.failed).toBe(0);
    expect(result.keysResolved).toBeGreaterThanOrEqual(2);
    await expect(previewInvitation(token)).rejects.toMatchObject({ code: 'invalid_invite' });
    expect(await listInvitations('t', org.orgId)).toEqual([]);
  });
});
