/**
 * ADR 1099 D7 (P3c) — a project's client threads.
 *
 *  - a collaborator's message is held for review and joins THEIR thread only when a
 *    member approves it; rejected, it never joins;
 *  - a member's reply joins at once, and the collaborator reads it as "the firm";
 *  - one thread per collaborator: a builder on the same project reads none of the
 *    client's thread;
 *  - a member replies only to a collaborator holding a LIVE grant on that project;
 *  - the collaborator's erasure deletes their thread; a member's DSAR anonymizes
 *    their replies.
 *
 * Sabotage notes: dropping the `collaboratorId` filter in `listClientThread` reds
 * "a builder reads none"; appending in `run` instead of `apply` reds "held for
 * review"; dropping `hasProjectGrant` reds "only to a collaborator with a grant".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getUser } from '../src/features/users/usersService.js';
import { eraseExternalCollaboratorSubject, type CollaboratorGrant } from '../src/host/externalCollaborators.js';
import { __resetCollabTurnCapsForTests, __setCollabTurnModelForTests } from '../src/host/collaboratorTurn.js';
import { listApprovals } from '../src/host/approvalService.js';
import { PROJECTS_CLIENT_PORTAL_TOGGLE } from '../src/features/projects/clientPortal.js';
import { CLIENT_MESSAGE_TOOL, eraseClientThreadSubject } from '../src/features/projects/clientThread.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  const portal = getToggleDefault(PROJECTS_CLIENT_PORTAL_TOGGLE);
  if (portal) await saveConfig({ ...portal, status: 'on' }, 'test');
}, 120_000);
afterEach(async () => { __setCollabTurnModelForTests(undefined); await __resetCollabTurnCapsForTests(); });
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T; raw: string }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1] ?? cookie; }
    const raw = res.status === 204 ? '' : await res.text();
    let parsed: unknown;
    try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
    return { status: res.status, body: parsed as T, raw };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b), del: <T>(p: string) => call<T>('DELETE', p) };
}
type Client = ReturnType<typeof client>;
const C = (orgId: string): string => `/host/openwop-app/orgs/${encodeURIComponent(orgId)}/collaborators`;
const THREADS = (projectId: string): string => `/host/openwop-app/projects/${projectId}/client-threads`;
const DECIDE = (approvalId: string, verb: 'claim' | 'reject'): string => `/host/openwop-app/approvals/${encodeURIComponent(approvalId)}/${verb}`;

interface Thread { collaboratorId: string; label: string; entries: Array<{ text: string; author: { kind: string } }> }

let n = 0;
async function firm() {
  const tenantId = `ws:t-1099p3c-${n++}`;
  const admin = client();
  const login = await admin.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `owner-p3c-${n}@studio.test`, tenantId });
  expect(login.status).toBe(201);
  const org = await admin.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Riverside renovation' });
  const p = await admin.post<{ id: string }>('/host/openwop-app/projects', { orgId: org.body.orgId, name: 'Kitchen and bath' });
  return { tenantId, orgId: org.body.orgId, projectId: p.body.id, admin, adminUserId: login.body.user.userId };
}
async function collaborator(f: { orgId: string; projectId: string; admin: Client }, displayName: string, kind = 'client-stakeholder') {
  const person = client();
  const v = await person.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `p3c-${n++}@outside.test` });
  const email = (await getUser(v.body.user.userId))?.email ?? '';
  const inv = await f.admin.post<{ collaborator: { collaboratorId: string }; invite: { token: string } }>(C(f.orgId), { kind, email, displayName });
  expect(inv.status, inv.raw).toBe(201);
  expect((await person.post('/host/openwop-app/collab/invites/accept', { token: inv.body.invite.token })).status).toBe(200);
  const collaboratorId = inv.body.collaborator.collaboratorId;
  const g = await f.admin.post<{ grant: CollaboratorGrant }>(`${C(f.orgId)}/${collaboratorId}/grants`, { resource: { kind: 'project', id: f.projectId }, actions: ['view', 'comment'], expiresInDays: 30 });
  expect(g.status, g.raw).toBe(201);
  return { person, email, collaboratorId, grantId: g.body.grant.grantId };
}
/** The model sends one message, then answers. */
function sending(message: string) {
  let round = 0;
  return async (_r: AiToolCallRequest): Promise<AiToolCallResult> =>
    round++ === 0 ? { content: '', toolCalls: [{ id: 'c1', name: CLIENT_MESSAGE_TOOL, input: { message } }] } : { content: 'Sent to the firm.', toolCalls: [] };
}
async function send(c: { person: Client; grantId: string }, message: string): Promise<void> {
  __setCollabTurnModelForTests(sending(message));
  const r = await c.person.post(`/host/openwop-app/collab/grants/${c.grantId}/turn`, { message: 'Please pass this on.' });
  expect(r.status, r.raw).toBe(200);
}
const pendingMessage = async (tenantId: string, text: string) =>
  (await listApprovals(tenantId, 'pending')).find((a) => a.kind === 'collab-proposal' && a.collabProposal?.toolId === CLIENT_MESSAGE_TOOL && a.collabProposal.summary === text);
const myMessages = async (c: { person: Client; grantId: string }) =>
  (await c.person.get<{ messages: Array<{ from: string; text: string }> }>(`/host/openwop-app/collab/grants/${c.grantId}/messages`)).body.messages;

describe('ADR 1099 P3c — a project\'s client threads', () => {
  it('a message is held for review and joins the collaborator\'s thread only when approved', async () => {
    const f = await firm();
    const garcia = await collaborator(f, 'The Garcias');
    await send(garcia, 'Can we move the walkthrough to Friday?');
    expect(await myMessages(garcia)).toEqual([]);
    expect((await f.admin.get<{ threads: Thread[] }>(THREADS(f.projectId))).body.threads).toEqual([]);
    const held = await pendingMessage(f.tenantId, 'Can we move the walkthrough to Friday?');
    expect(held).toBeDefined();
    expect((await f.admin.post(DECIDE(held!.approvalId, 'claim'))).status).toBe(200);
    expect(await myMessages(garcia)).toEqual([expect.objectContaining({ from: 'you', text: 'Can we move the walkthrough to Friday?' })]);
    const threads = (await f.admin.get<{ threads: Thread[] }>(THREADS(f.projectId))).body.threads;
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ collaboratorId: garcia.collaboratorId, label: 'The Garcias' });

    // Rejected: never joins.
    await send(garcia, 'Never mind, ignore that.');
    const other = await pendingMessage(f.tenantId, 'Never mind, ignore that.');
    expect((await f.admin.post(DECIDE(other!.approvalId, 'reject'))).status).toBe(200);
    expect((await myMessages(garcia)).map((m) => m.text)).toEqual(['Can we move the walkthrough to Friday?']);
  });

  it('a member\'s reply joins at once and reads as the firm; a builder reads none of the client\'s thread', async () => {
    const f = await firm();
    const garcia = await collaborator(f, 'The Garcias');
    const builder = await collaborator(f, 'Oak Builders', 'vendor');
    const r = await f.admin.post(`${THREADS(f.projectId)}/${garcia.collaboratorId}`, { text: 'Friday works. See you at 10.' });
    expect(r.status, r.raw).toBe(201);
    expect(await myMessages(garcia)).toEqual([expect.objectContaining({ from: 'firm', text: 'Friday works. See you at 10.' })]);
    expect(await myMessages(builder)).toEqual([]);
    expect(JSON.stringify(await myMessages(garcia))).not.toContain(f.adminUserId);
  });

  it('a member replies only to a collaborator holding a grant on that project', async () => {
    const f = await firm();
    const p2 = await f.admin.post<{ id: string }>('/host/openwop-app/projects', { orgId: f.orgId, name: 'Garage' });
    const garcia = await collaborator(f, 'The Garcias'); // granted the first project only
    expect((await f.admin.post(`${THREADS(p2.body.id)}/${garcia.collaboratorId}`, { text: 'Hello' })).status).toBe(404);
    expect((await f.admin.post(`${THREADS(f.projectId)}/ccb_00000000-0000-0000-0000-000000000000`, { text: 'Hello' })).status).toBe(404);
    expect((await f.admin.post(`${THREADS(f.projectId)}/${garcia.collaboratorId}`, { text: '' })).status).toBe(400);
    // A revoked grant takes no reply either: the person can no longer read it.
    expect((await f.admin.del(`${C(f.orgId)}/${garcia.collaboratorId}/grants/${garcia.grantId}`)).status).toBe(200);
    expect((await f.admin.post(`${THREADS(f.projectId)}/${garcia.collaboratorId}`, { text: 'Still there?' })).status).toBe(404);
  });

  it('the collaborator\'s erasure deletes their thread; a member\'s DSAR anonymizes their replies', async () => {
    const f = await firm();
    const garcia = await collaborator(f, 'The Garcias');
    const builder = await collaborator(f, 'Oak Builders', 'vendor');
    await f.admin.post(`${THREADS(f.projectId)}/${garcia.collaboratorId}`, { text: 'For the Garcias' });
    await f.admin.post(`${THREADS(f.projectId)}/${builder.collaboratorId}`, { text: 'For the builder' });
    await eraseExternalCollaboratorSubject(f.tenantId, `email:${garcia.email}`);
    const after = (await f.admin.get<{ threads: Thread[] }>(THREADS(f.projectId))).body.threads;
    expect(after.map((t) => t.collaboratorId)).toEqual([builder.collaboratorId]);
    await eraseClientThreadSubject(f.tenantId, f.adminUserId);
    const anon = (await f.admin.get<{ threads: Thread[] }>(THREADS(f.projectId))).body.threads[0]!.entries[0]!;
    expect(anon.text).toBe('[erased]');
    expect(JSON.stringify(anon)).not.toContain(f.adminUserId);
  });

  it('the switch off: every thread route is a 404', async () => {
    const f = await firm();
    const garcia = await collaborator(f, 'The Garcias');
    const portal = getToggleDefault(PROJECTS_CLIENT_PORTAL_TOGGLE);
    if (portal) await saveConfig({ ...portal, status: 'off' }, 'test');
    try {
      expect((await f.admin.get(THREADS(f.projectId))).status).toBe(404);
      expect((await f.admin.post(`${THREADS(f.projectId)}/${garcia.collaboratorId}`, { text: 'Hi' })).status).toBe(404);
      expect((await garcia.person.get(`/host/openwop-app/collab/grants/${garcia.grantId}/messages`)).status).toBe(404);
    } finally {
      if (portal) await saveConfig({ ...portal, status: 'on' }, 'test');
    }
  });
});
