/**
 * ADR 0622 D1 / D5 — the four `host.orgs.invitation.*` lifecycle events: ONE
 * emit site each, TRANSITION-guarded, ids-only payloads, and the D5
 * composition owner's supersede-or-rollback decision observed THROUGH the
 * events it does (and does not) fan out.
 *
 * Over the REAL app (`createApp` — the routes are the emit site for `revoked`
 * and the ONLY caller of `createInvitationAndDeliver` this file drives) with the
 * host-event dispatcher re-pointed at FAKE fanout deps (the
 * `users-surface-authz.test.ts` shape), so every emit is observable as a
 * captured envelope + a captured `startRun` call — "bind → exactly one run".
 *
 * What is pinned and WHY each pin is load-bearing:
 *   - the LITERAL payload key set per event — the recipient email and the token
 *     are never placed in a payload (the emitter's discipline; `stripPiiPayload`
 *     is the dispatcher's belt, not the rule);
 *   - `created` fires from the composition owner AFTER the decision: a re-mint
 *     over a live (org, email) row carries `superseded: true` + `previousStatus`
 *     and fans out NO `revoked` (replace-at-mint is a row death, not a business
 *     event); a mint that was ROLLED BACK (prod, undeliverable) starts NO run;
 *   - the `ORGINV-7` witness: prod mode, a prior pending invite, an inviter with
 *     no email connection → 422, the NEW row is gone, the PRIOR token still
 *     previews, and the 422 names that the earlier invitation is still valid;
 *   - `accepted` fires ONCE per successful claim (the `alreadyMember` branch is
 *     the same site, a flag) and NOT on the restore-on-failure path;
 *   - `revoked` fires from the admin route on a row that existed — a 404 revoke
 *     emits nothing; `declined` fires on the CAS-won transition only — an
 *     idempotent re-decline emits nothing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const { createMemberMock } = vi.hoisted(() => ({ createMemberMock: vi.fn() }));
vi.mock('../src/host/accessControlService.js', async (orig) => {
  const real = await orig<typeof import('../src/host/accessControlService.js')>();
  createMemberMock.mockImplementation(real.createMember);
  return { ...real, createMember: createMemberMock };
});

import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { getSetCookies } from './headerCookies.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setSenderAddress } from '../src/features/email/emailService.js';
import {
  createHostEventBinding,
  initHostEventDispatcher,
  __clearHostEventBindings,
  type HostEventEnvelope,
} from '../src/host/hostEventDispatcher.js';
import {
  INVITATION_ACCEPTED_EVENT,
  INVITATION_CREATED_EVENT,
  INVITATION_DECLINED_EVENT,
  INVITATION_REVOKED_EVENT,
} from '../src/features/orgs/emit.js';

let BASE = '';
let server: http.Server;
let storage: Storage;
let delivered: HostEventEnvelope[] = [];
let startRunCalls: Array<{ tenantId: string; workflowId: string; metadata?: Record<string, unknown> }> = [];
const settle = () => new Promise((r) => setTimeout(r, 15));
const ofType = (t: string) => delivered.filter((e) => e.type === t);
const ALL_EVENTS = [INVITATION_CREATED_EVENT, INVITATION_ACCEPTED_EVENT, INVITATION_REVOKED_EVENT, INVITATION_DECLINED_EVENT];
/** The keys the emitter must never place in a payload. */
const FORBIDDEN_KEY = /email|token|hash|displayname|principalid/i;

interface Res { status: number; body: any }
function client(): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const sc of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}
let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: ReturnType<typeof client>, email: string): Promise<{ userId: string; email: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
/** An owner + an org in the owner's personal tenant (the implicit-manager lane). */
async function ownerOrg(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const owner = client();
  await signup(owner, uniqEmail('owner'));
  const org = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body;
  expect(org.orgId).toBeTruthy();
  return { owner, orgId: org.orgId as string, tenantId: org.tenantId as string };
}
const invitesPath = (orgId: string) => `/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/invites`;
const bind = (tenantId: string, eventType: string, workflowId: string) =>
  createHostEventBinding({ tenantId, eventType, workflowId, createdBy: 'test' });

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'orgs']) {
    const def = getToggleDefault(id);
    if (def) await saveConfig({ ...def, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

beforeEach(async () => {
  delivered = [];
  startRunCalls = [];
  createMemberMock.mockClear();
  await __clearHostEventBindings();
  const hostSuite: StartRunDeps['hostSuite'] = {
    workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
    providerPolicyResolver: { resolveForRun: async () => [] },
  };
  initHostEventDispatcher({
    storage,
    hostSuite,
    deliverWebhooks: async (event) => { delivered.push(event); },
    startRun: async (_deps, input) => { startRunCalls.push(input); return `run:fake-${startRunCalls.length}`; },
  });
});
afterEach(() => { process.env.NODE_ENV = 'test'; });

describe('host.orgs.invitation.created — ONE site (createInvitationAndDeliver), after the delivery decision', () => {
  it('bind → a mint starts exactly ONE run with the pinned ids-only payload; never the email, never the token', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    await bind(tenantId, INVITATION_CREATED_EVENT, 'wf:welcome');
    const email = uniqEmail('bob');
    const inv = await owner.post(invitesPath(orgId), { email, role: 'editor' });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    await settle();
    const evs = ofType(INVITATION_CREATED_EVENT);
    expect(evs).toHaveLength(1);
    expect(Object.keys(evs[0]!.payload).sort()).toEqual(['delivery', 'inviteId', 'orgId', 'role', 'superseded', 'tenantId']);
    expect(evs[0]!.payload).toEqual({ inviteId: inv.body.invite.inviteId, orgId, tenantId, role: 'editor', delivery: 'skipped', superseded: false });
    expect(evs[0]!.tenantId).toBe(tenantId);
    expect('origin' in evs[0]!).toBe(false); // the route lane stamps no origin
    expect(JSON.stringify(evs[0]!.payload)).not.toContain(email);
    expect(JSON.stringify(evs[0]!.payload)).not.toContain(inv.body.token);
    expect(startRunCalls.map((c) => c.workflowId)).toEqual(['wf:welcome']);
    expect(startRunCalls[0]!.metadata?.triggerData).toEqual({ eventName: INVITATION_CREATED_EVENT, payload: evs[0]!.payload });
  });

  it('a re-mint over a LIVE (org, email) row → created{superseded:true, previousStatus:"pending"} and NO revoked event; one row remains', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    await bind(tenantId, INVITATION_REVOKED_EVENT, 'wf:audit');
    const email = uniqEmail('dup');
    const first = await owner.post(invitesPath(orgId), { email, role: 'viewer' });
    const second = await owner.post(invitesPath(orgId), { email, role: 'admin' });
    expect(second.status).toBe(201);
    await settle();
    const evs = ofType(INVITATION_CREATED_EVENT);
    expect(evs).toHaveLength(2);
    expect(evs[0]!.payload).toMatchObject({ inviteId: first.body.invite.inviteId, superseded: false });
    expect(evs[0]!.payload).not.toHaveProperty('previousStatus');
    expect(evs[1]!.payload).toMatchObject({ inviteId: second.body.invite.inviteId, role: 'admin', superseded: true, previousStatus: 'pending' });
    // Replace-at-mint is a row death, never a business event.
    expect(ofType(INVITATION_REVOKED_EVENT)).toEqual([]);
    expect(startRunCalls).toEqual([]);
    const list = await owner.get(invitesPath(orgId));
    expect(list.body.invites.map((i: { inviteId: string }) => i.inviteId)).toEqual([second.body.invite.inviteId]);
    // The first token is dead; the second previews.
    expect((await client().get(`/v1/host/openwop-app/orgs/invitations/preview?token=${encodeURIComponent(first.body.token)}`)).status).toBe(400);
    expect((await client().get(`/v1/host/openwop-app/orgs/invitations/preview?token=${encodeURIComponent(second.body.token)}`)).status).toBe(200);
  });

  it('a re-mint over a DECLINED row carries previousStatus:"declined" (ADR 0564 open question 1: no cooldown)', async () => {
    const { owner, orgId } = await ownerOrg();
    const email = uniqEmail('decl');
    const first = await owner.post(invitesPath(orgId), { email, role: 'viewer' });
    const bob = client();
    await signup(bob, email);
    expect((await bob.post('/v1/host/openwop-app/orgs/invitations/decline', { token: first.body.token })).status).toBe(200);
    const second = await owner.post(invitesPath(orgId), { email, role: 'viewer' });
    expect(second.status).toBe(201);
    await settle();
    const created = ofType(INVITATION_CREATED_EVENT);
    expect(created).toHaveLength(2);
    expect(created[1]!.payload).toMatchObject({ superseded: true, previousStatus: 'declined' });
  });

  it('ORGINV-7 witness: PROD mode, a prior pending invite, an inviter with no email connection → 422, the NEW row rolled back, NO created event, NO run, and the PRIOR token still previews', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    await bind(tenantId, INVITATION_CREATED_EVENT, 'wf:welcome');
    const email = uniqEmail('prior');
    const prior = await owner.post(invitesPath(orgId), { email, role: 'viewer' }); // non-prod: reachable via the echoed token
    expect(prior.status).toBe(201);
    await settle();
    expect(startRunCalls).toHaveLength(1);
    // The precheck passes (a sender exists); delivery then skips: no connection.
    await setSenderAddress(tenantId, orgId, 'invites@acme.test', 'test');
    process.env.NODE_ENV = 'production';
    let again: Res;
    try {
      again = await owner.post(invitesPath(orgId), { email, role: 'admin' });
    } finally { process.env.NODE_ENV = 'test'; }
    expect(again.status, JSON.stringify(again.body)).toBe(422);
    expect(again.body.details).toEqual({ reason: 'undeliverable', cause: 'no_connection', priorInviteStillValid: true });
    expect(again.body.message).toMatch(/earlier invitation .* may still be valid/);
    await settle();
    // A rolled-back mint never emits and never starts a run.
    expect(ofType(INVITATION_CREATED_EVENT)).toHaveLength(1);
    expect(startRunCalls).toHaveLength(1);
    // The prior invite is untouched: still listed (alone), still previews, still accepts.
    const list = await owner.get(invitesPath(orgId));
    expect(list.body.invites.map((i: { inviteId: string; role: string }) => [i.inviteId, i.role])).toEqual([[prior.body.invite.inviteId, 'viewer']]);
    const preview = await client().get(`/v1/host/openwop-app/orgs/invitations/preview?token=${encodeURIComponent(prior.body.token)}`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.role).toBe('viewer');
  });

  it('PROD mode with NO sender is refused BEFORE any mint (the moved R2-F3 precheck): 422 no_sender, no row, no event', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    await bind(tenantId, INVITATION_CREATED_EVENT, 'wf:welcome');
    process.env.NODE_ENV = 'production';
    let r: Res;
    try { r = await owner.post(invitesPath(orgId), { email: uniqEmail('nosender'), role: 'viewer' }); } finally { process.env.NODE_ENV = 'test'; }
    expect(r.status).toBe(422);
    expect(r.body.details).toMatchObject({ reason: 'undeliverable', cause: 'no_sender' });
    expect(r.body.details.priorInviteStillValid).toBeUndefined();
    await settle();
    // (`delivered` also carries the signup's `host.users.user.provisioned`.)
    expect(delivered.filter((e) => ALL_EVENTS.includes(e.type))).toEqual([]);
    expect(startRunCalls).toEqual([]);
    expect((await owner.get(invitesPath(orgId))).body.invites).toHaveLength(0);
  });
});

describe('host.orgs.invitation.accepted — ONE site after the claim/restore try-catch', () => {
  it('bind → an accept starts exactly ONE run with {inviteId, orgId, tenantId, memberId, userId, role, alreadyMember}', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    await bind(tenantId, INVITATION_ACCEPTED_EVENT, 'wf:onboard');
    const email = uniqEmail('bob');
    const inv = await owner.post(invitesPath(orgId), { email, role: 'editor' });
    const bobC = client();
    const bob = await signup(bobC, email);
    const acc = await bobC.post('/v1/host/openwop-app/orgs/invitations/accept', { token: inv.body.token });
    expect(acc.status, JSON.stringify(acc.body)).toBe(201);
    await settle();
    const evs = ofType(INVITATION_ACCEPTED_EVENT);
    expect(evs).toHaveLength(1);
    expect(Object.keys(evs[0]!.payload).sort()).toEqual(['alreadyMember', 'inviteId', 'memberId', 'orgId', 'role', 'tenantId', 'userId']);
    expect(evs[0]!.payload).toEqual({ inviteId: inv.body.invite.inviteId, orgId, tenantId, memberId: acc.body.memberId, userId: bob.userId, role: 'editor', alreadyMember: false });
    expect(startRunCalls.map((c) => c.workflowId)).toEqual(['wf:onboard']);

    // A second invite accepted by an existing member: the SAME site, `alreadyMember: true`.
    const inv2 = await owner.post(invitesPath(orgId), { email, role: 'admin' });
    const acc2 = await bobC.post('/v1/host/openwop-app/orgs/invitations/accept', { token: inv2.body.token });
    expect(acc2.status).toBe(200);
    await settle();
    expect(ofType(INVITATION_ACCEPTED_EVENT)).toHaveLength(2);
    expect(ofType(INVITATION_ACCEPTED_EVENT)[1]!.payload).toMatchObject({ inviteId: inv2.body.invite.inviteId, memberId: acc.body.memberId, alreadyMember: true });
    expect(startRunCalls).toHaveLength(2);
  });

  it('the restore-on-failure path (createMember throws after the claim) emits NOTHING; the retry emits once', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    await bind(tenantId, INVITATION_ACCEPTED_EVENT, 'wf:onboard');
    const email = uniqEmail('restore');
    const inv = await owner.post(invitesPath(orgId), { email, role: 'viewer' });
    const bobC = client();
    await signup(bobC, email);
    createMemberMock.mockRejectedValueOnce(new Error('db down'));
    const failed = await bobC.post('/v1/host/openwop-app/orgs/invitations/accept', { token: inv.body.token });
    expect(failed.status).toBe(500);
    await settle();
    expect(ofType(INVITATION_ACCEPTED_EVENT)).toEqual([]);
    expect(startRunCalls).toEqual([]);
    const retry = await bobC.post('/v1/host/openwop-app/orgs/invitations/accept', { token: inv.body.token });
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    await settle();
    expect(ofType(INVITATION_ACCEPTED_EVENT)).toHaveLength(1);
    expect(startRunCalls).toHaveLength(1);
  });
});

describe('host.orgs.invitation.revoked — the admin route only, on a row that existed', () => {
  it('bind → DELETE starts exactly ONE run with {inviteId, orgId, tenantId}; a 404 revoke emits nothing', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    await bind(tenantId, INVITATION_REVOKED_EVENT, 'wf:audit');
    const inv = await owner.post(invitesPath(orgId), { email: uniqEmail('rev'), role: 'viewer' });
    const del = await owner.del(`${invitesPath(orgId)}/${encodeURIComponent(inv.body.invite.inviteId)}`);
    expect(del.status).toBe(204);
    await settle();
    const evs = ofType(INVITATION_REVOKED_EVENT);
    expect(evs).toHaveLength(1);
    expect(Object.keys(evs[0]!.payload).sort()).toEqual(['inviteId', 'orgId', 'tenantId']);
    expect(evs[0]!.payload).toEqual({ inviteId: inv.body.invite.inviteId, orgId, tenantId });
    expect(startRunCalls.map((c) => c.workflowId)).toEqual(['wf:audit']);
    // Already gone → 404, no second event.
    expect((await owner.del(`${invitesPath(orgId)}/${encodeURIComponent(inv.body.invite.inviteId)}`)).status).toBe(404);
    await settle();
    expect(ofType(INVITATION_REVOKED_EVENT)).toHaveLength(1);
    expect(startRunCalls).toHaveLength(1);
  });
});

describe('host.orgs.invitation.declined — the CAS-won transition only', () => {
  it('bind → a decline starts exactly ONE run with {inviteId, orgId, tenantId}; an idempotent re-decline emits nothing', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    await bind(tenantId, INVITATION_DECLINED_EVENT, 'wf:notify-inviter');
    const email = uniqEmail('no');
    const inv = await owner.post(invitesPath(orgId), { email, role: 'viewer' });
    const bobC = client();
    await signup(bobC, email);
    const d1 = await bobC.post('/v1/host/openwop-app/orgs/invitations/decline', { token: inv.body.token });
    expect(d1.status, JSON.stringify(d1.body)).toBe(200);
    expect(d1.body).toMatchObject({ inviteId: inv.body.invite.inviteId, orgId, status: 'declined' });
    const d2 = await bobC.post('/v1/host/openwop-app/orgs/invitations/decline', { token: inv.body.token });
    expect(d2.status).toBe(200);
    expect(d2.body.declinedAt).toBe(d1.body.declinedAt);
    await settle();
    const evs = ofType(INVITATION_DECLINED_EVENT);
    expect(evs).toHaveLength(1);
    expect(Object.keys(evs[0]!.payload).sort()).toEqual(['inviteId', 'orgId', 'tenantId']);
    expect(evs[0]!.payload).toEqual({ inviteId: inv.body.invite.inviteId, orgId, tenantId });
    expect(startRunCalls.map((c) => c.workflowId)).toEqual(['wf:notify-inviter']);
  });
});

describe('payload discipline — no PII-shaped key or value ever leaves the emitter', () => {
  it('across every captured event of all four types, no key matches email|token|hash and no value carries the recipient address', async () => {
    const { owner, orgId } = await ownerOrg();
    const email = uniqEmail('pii.probe');
    const inv = await owner.post(invitesPath(orgId), { email, role: 'viewer' });
    const bobC = client();
    await signup(bobC, email);
    await bobC.post('/v1/host/openwop-app/orgs/invitations/decline', { token: inv.body.token });
    const inv2 = await owner.post(invitesPath(orgId), { email, role: 'viewer' });
    await bobC.post('/v1/host/openwop-app/orgs/invitations/accept', { token: inv2.body.token });
    const inv3 = await owner.post(invitesPath(orgId), { email, role: 'viewer' });
    await owner.del(`${invitesPath(orgId)}/${encodeURIComponent(inv3.body.invite.inviteId)}`);
    await settle();
    const ours = delivered.filter((e) => e.type.startsWith('host.orgs.'));
    expect(new Set(ours.map((e) => e.type))).toEqual(new Set(ALL_EVENTS));
    for (const ev of ours) {
      for (const key of Object.keys(ev.payload)) expect(key, `${ev.type} leaked key ${key}`).not.toMatch(FORBIDDEN_KEY);
      const json = JSON.stringify(ev.payload);
      expect(json).not.toContain('pii.probe');
      for (const t of [inv.body.token, inv2.body.token, inv3.body.token]) expect(json).not.toContain(t);
    }
  });
});
