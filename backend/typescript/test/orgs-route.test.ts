/**
 * ADR 0004 (reconciled) — org invitations at the ROUTE layer. This harness boots
 * the real app and drives the RECONCILED flow over HTTP: an org is created
 * through the `accessControl` surface (the single owner, ADR 0006 explicit
 * owner member), an invite is issued through the `orgs` feature, a second user
 * accepts it and becomes an accessControl member. It exercises the session
 * binding (ADR 0003), the toggle gate (ORGINV-1: the INVITE tenant's, never the
 * caller's), the delegated `host:members:manage` authorization, the
 * email-ownership gate, the management wire shape (ORGINV-4) and the expired
 * envelope (R2 IN-SP-8) — none of which a service-level test can reach.
 *
 * The harness is also what caught the original namespace collision (my orgs
 * routes were shadowed by accessControl) and a real `isAnonymous` bug.
 *
 * IDOR is defended TWICE: the route's `assertOrgScope` tenant compare, then the
 * service's `requireOrgInTenant`. The outsider here is a NON-personal caller so
 * the first is load-bearing (a `user:` caller would pass it through the
 * personal-owner short-circuit and only the second would answer); the second
 * is a masked backstop no single sabotage can redden from this file.
 *
 * ADR 0006 note: the owner row binds `req.userId ?? principalId`. On every live
 * auth lane a set `req.userId` IS the principal (`middleware/auth.ts` cookie +
 * bound-bearer branches), so the `??` fallback is an equivalent mutant; what is
 * witnessed is that the explicit owner row is SEEDED and bound to the userId.
 *
 * Covered ELSEWHERE (cut): the prod no-sender precheck (422 undeliverable /
 * no_sender, the precheck's own "Email page" copy, nothing minted) →
 * `orgs-lifecycle-host-events.test.ts` "PROD mode with NO sender is refused
 * BEFORE any mint", same HTTP path, plus no event / no run.
 *
 * Sabotage that turns it red: `invitationsService.ts` the email-mismatch `if`
 * disabled; the accept route not resolving the caller (signed-in gate gone) or
 * gating on the CALLER's toggle; the invite-tenant toggle check disabled;
 * `routes.ts` `toClientInvite` keeping `tokenHash` or marking nothing expired;
 * the `'expired'` reason dropped; the accepted member's `roles` not the
 * invite's; `routes/accessControl.ts` POST /orgs not seeding the owner member;
 * `accessControlService.ts` `assertOrgScope` dropping its tenant compare.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { enableTenantOverride, saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  // Demo mode grants OWNER to an unknown subject in a single-principal tenant
  // (`resolveEffectiveAccessDirect`), which would mask the authz assertions.
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  for (const id of ['users', 'orgs']) {
    const def = getToggleDefault(id);
    if (def) await saveConfig({ ...def, status: 'on' }, 'test');
  }
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

interface InviteRow { inviteId: string; tenantId: string; email: string; tokenHash?: string; expired?: boolean }
interface MemberRow { subject: string; roles: string[] }
interface Body {
  orgId?: string; tenantId?: string; createdBy?: string; token?: string; delivery?: string;
  invite?: InviteRow; invites?: InviteRow[]; members?: MemberRow[];
  subject?: string; roles?: string[]; user?: { userId: string; email: string };
  error?: string; message?: string; details?: { code?: string; reason?: string; cause?: string };
}
interface Res {
  status: number;
  body: Body;
}
function client(): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const setCookies = getSetCookies(res.headers);
    for (const sc of setCookies as string[]) {
      const m = /(__session=[^;]+)/.exec(sc);
      if (m) cookie = m[1];
    }
    const parsed: unknown = res.status === 204 ? {} : await res.json().catch(() => ({}));
    return { status: res.status, body: (parsed ?? {}) as Body };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
// ADR 0026: real sign-in is Firebase OIDC; tests mint an authenticated user via
// the env-gated auth test seam (the email becomes the federated identity's email,
// which drives the invite email-ownership gate).
async function signup(c: ReturnType<typeof client>, email: string): Promise<{ userId: string; email: string }> {
  const r = await c.post('/host/openwop-app/test/login', { email });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user!;
}

describe('org invitations over HTTP (reconciled with accessControl)', () => {
  it('owner creates an org (accessControl), invites a user, the user accepts and becomes a member', async () => {
    const ownerC = client();
    await signup(ownerC, uniqEmail('owner'));
    // org is created through the accessControl surface (the single owner)
    const org = (await ownerC.post('/host/openwop-app/orgs', { name: 'Acme' })).body;
    expect(org.orgId).toBeTruthy();
    expect(org.createdBy).toBeTruthy(); // accessControl shape, not the old feature shape

    const bobEmail = uniqEmail('bob');
    const inv = await ownerC.post(`/host/openwop-app/orgs/${encodeURIComponent(org.orgId!)}/invites`, { email: bobEmail, role: 'editor' });
    expect(inv.status).toBe(201);
    expect(inv.body.token).toBeTruthy();
    // DEF-2 — the HTTP contract carries the delivery outcome (Deferred Phase A):
    // no sender identity / provider in this harness ⇒ 'skipped' (copy-link UX),
    // alongside the invite record itself.
    expect(inv.body.delivery).toBe('skipped');
    expect(inv.body.invite?.inviteId).toBeTruthy();
    expect(inv.body.invite?.email).toBe(bobEmail);

    const bobC = client();
    const bob = await signup(bobC, bobEmail);
    const acc = await bobC.post('/host/openwop-app/orgs/invitations/accept', { token: inv.body.token });
    expect(acc.status, JSON.stringify(acc.body)).toBe(201);
    expect(acc.body.subject).toBe(bob.userId);
    expect(acc.body.roles).toEqual(['editor']);

    // accessControl now lists bob as a member of the org
    const members = (await ownerC.get(`/host/openwop-app/orgs/${encodeURIComponent(org.orgId!)}/members`)).body.members!;
    expect(members.some((m) => m.subject === bob.userId)).toBe(true);
  });

  it('ADR 0006: creating an org seeds an EXPLICIT owner member bound to the creator userId', async () => {
    const ownerC = client();
    const owner = await signup(ownerC, uniqEmail('founder'));
    const org = (await ownerC.post('/host/openwop-app/orgs', { name: 'Founders' })).body;

    const members = (await ownerC.get(`/host/openwop-app/orgs/${encodeURIComponent(org.orgId!)}/members`)).body.members!;
    const ownerMember = members.find((m) => m.subject === owner.userId);
    expect(ownerMember, 'creator should be an explicit member').toBeTruthy();
    expect(ownerMember!.roles).toEqual(['owner']); // membership-derived ownership, bound to User.userId — not tenant==principal
  });

  it('email-ownership gate: a different user cannot accept someone else’s invite', async () => {
    const ownerC = client();
    await signup(ownerC, uniqEmail('owner'));
    const org = (await ownerC.post('/host/openwop-app/orgs', { name: 'Acme' })).body;
    const inviteEmail = uniqEmail('invitee');
    const inv = await ownerC.post(`/host/openwop-app/orgs/${encodeURIComponent(org.orgId!)}/invites`, { email: inviteEmail, role: 'viewer' });

    const strangerC = client();
    await signup(strangerC, uniqEmail('stranger'));
    const acc = await strangerC.post('/host/openwop-app/orgs/invitations/accept', { token: inv.body.token });
    expect(acc.status).toBe(403); // not your email
    // The MISMATCH branch, not the provenance one (no `email_unverified` reason).
    expect(acc.body.details).toEqual({ code: 'forbidden' });
    expect(acc.body.message).toMatch(/issued to a different email/);
  });

  it('IDOR: inviting into an org in another tenant is 404 (no existence leak)', async () => {
    const aC = client();
    await signup(aC, uniqEmail('a'));
    const org = (await aC.post('/host/openwop-app/orgs', { name: 'Private' })).body;

    // A NON-personal outsider (founds + owns an `org:` workspace): no personal-
    // owner short-circuit, so the route's own tenant compare is what answers.
    const bC = client();
    const b = await bC.post('/host/openwop-app/test/login', { email: uniqEmail('b'), tenantId: 'org:orgs-route-idor-b' });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const r = await bC.post(`/host/openwop-app/orgs/${encodeURIComponent(org.orgId!)}/invites`, { email: uniqEmail('x'), role: 'viewer' });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/not_found$/);
    // …and nothing was minted into A's org.
    expect((await aC.get(`/host/openwop-app/orgs/${encodeURIComponent(org.orgId!)}/invites`)).body.invites).toHaveLength(0);
  });

  it('the orgs invitation surface requires a signed-in session', async () => {
    const anonC = client(); // never signs up → anonymous session
    const r = await anonC.post('/host/openwop-app/orgs/invitations/accept', { token: 'whatever' });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/sign_in_required$/);
  });
});

describe('ORGINV-1 — accept gates on the INVITE tenant toggle, never the caller’s (the R2 F6 class, closed for accept)', () => {
  // The vacuity that hid this defect: the harness enables `orgs` GLOBALLY, so
  // the caller-tenant gate could never bite. This test configures a real
  // per-tenant rollout instead: global OFF, ON only for the invite's tenant.
  it('an invited outsider whose own tenant has the toggle OFF can still accept; both-off is refused', async () => {
    const ownerC = client();
    await signup(ownerC, uniqEmail('rollout-owner'));
    const org = (await ownerC.post('/host/openwop-app/orgs', { name: 'RollCo' })).body;
    const bobEmail = uniqEmail('rollout-bob');
    const carolEmail = uniqEmail('rollout-carol');
    // Mint BOTH invites while the toggle is still globally on.
    const invBob = await ownerC.post(`/host/openwop-app/orgs/${encodeURIComponent(org.orgId!)}/invites`, { email: bobEmail, role: 'viewer' });
    const invCarol = await ownerC.post(`/host/openwop-app/orgs/${encodeURIComponent(org.orgId!)}/invites`, { email: carolEmail, role: 'viewer' });
    expect(invBob.status).toBe(201);
    const inviteTenant = invBob.body.invite!.tenantId;
    expect(inviteTenant).toBeTruthy();

    const def = getToggleDefault('orgs')!;
    try {
      // Per-tenant rollout: OFF everywhere, ON only for the INVITE's tenant.
      // Bob's own (caller) tenant therefore resolves OFF — the exact shape
      // under which the old `h`-wrapped accept 404'd a perfectly valid invite.
      await saveConfig({ ...def, status: 'off' }, 'test');
      expect(await enableTenantOverride('orgs', inviteTenant, 'test')).toBe('enabled');

      const bobC = client();
      await signup(bobC, bobEmail);
      const acc = await bobC.post('/host/openwop-app/orgs/invitations/accept', { token: invBob.body.token });
      expect(acc.status, JSON.stringify(acc.body)).toBe(201); // the caller's tenant toggle is NOT the gate

      // Both off (the override gone): the service's invite-tenant gate refuses,
      // enumeration-uniform with a bad token.
      await saveConfig({ ...def, status: 'off' }, 'test');
      const carolC = client();
      await signup(carolC, carolEmail);
      const acc2 = await carolC.post('/host/openwop-app/orgs/invitations/accept', { token: invCarol.body.token });
      expect(acc2.status, JSON.stringify(acc2.body)).toBe(400);
      expect(acc2.body.details?.code).toBe('invalid_invite');
    } finally {
      await saveConfig({ ...def, status: 'on' }, 'test');
    }
  });
});

describe('ORGINV-4 — management wire shape: no tokenHash, expiry marked server-side', () => {
  it('create/list responses never serialize tokenHash, and an expired row lists as expired, not pending', async () => {
    const ownerC = client();
    await signup(ownerC, uniqEmail('shape-owner'));
    const org = (await ownerC.post('/host/openwop-app/orgs', { name: 'ShapeCo' })).body;
    const inv = await ownerC.post(`/host/openwop-app/orgs/${encodeURIComponent(org.orgId!)}/invites`, { email: uniqEmail('shape-bob'), role: 'viewer' });
    expect(inv.status).toBe(201);
    expect(inv.body.invite!.tokenHash, 'the at-rest representation must not reach clients').toBeUndefined();
    expect(inv.body.invite!.expired).toBe(false);

    // Age the row past expiry via direct store surgery.
    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
    const store = new DurableCollection<{ inviteId: string; expiresAt: string }>('orgs:invite', (i) => i.inviteId);
    const row = (await store.get(inv.body.invite!.inviteId))!;
    await store.put({ ...row, expiresAt: new Date(Date.now() - 60_000).toISOString() });

    const list = await ownerC.get(`/host/openwop-app/orgs/${encodeURIComponent(org.orgId!)}/invites`);
    expect(list.status).toBe(200);
    const listed = list.body.invites!.find((i) => i.inviteId === inv.body.invite!.inviteId);
    expect(listed).toBeTruthy();
    expect(listed!.tokenHash).toBeUndefined();
    expect(listed!.expired, 'a dead invite must not list as pending').toBe(true);
  });
});

describe('R2 IN-SP-1/IN-SP-8 — production mint honesty + the expired envelope (review F2: the wiring, not just the mechanism)', () => {
  it('an expired invite carries details.reason=expired over HTTP (preview AND accept)', async () => {
    const ownerC = client();
    await signup(ownerC, uniqEmail('expowner'));
    const org = (await ownerC.post('/host/openwop-app/orgs', { name: 'ExpCo' })).body;
    const bobEmail = uniqEmail('expbob');
    const inv = await ownerC.post(`/host/openwop-app/orgs/${encodeURIComponent(org.orgId!)}/invites`, { email: bobEmail, role: 'viewer' });
    expect(inv.status).toBe(201);

    // Age the row past expiry via direct store surgery.
    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
    const store = new DurableCollection<{ inviteId: string; expiresAt: string }>('orgs:invite', (i) => i.inviteId);
    const row = (await store.get(inv.body.invite!.inviteId))!;
    await store.put({ ...row, expiresAt: new Date(Date.now() - 60_000).toISOString() });

    const preview = await client().get(`/host/openwop-app/orgs/invitations/preview?token=${encodeURIComponent(inv.body.token!)}`);
    expect(preview.status).toBe(400);
    expect(preview.body.details?.reason).toBe('expired');

    const bobC = client();
    await signup(bobC, bobEmail);
    const accept = await bobC.post('/host/openwop-app/orgs/invitations/accept', { token: inv.body.token });
    expect(accept.status).toBe(400);
    expect(accept.body.details?.reason).toBe('expired');
  });
});
