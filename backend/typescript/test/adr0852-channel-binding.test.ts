/**
 * ADR 0852 P3 — a channel bound to a project, and the ledger summaries.
 *
 * Real app, real sign-ins, the real chat composer:
 *
 *   - the channel OWNER with WRITE on an ORG-visible project binds it; the GET
 *     returns it; `null` unbinds;
 *   - refused: a non-owner member (403), an owner with only read on the project
 *     (403), a private project (409), an unknown project (404);
 *   - a bound channel's turns carry the project's ledger block; once the project
 *     is made private the binding goes INERT (nothing composed, even for a member
 *     who can still read the project);
 *   - `GET /team-ledger/summaries`: readable projects summarized, an unreadable
 *     private one OMITTED (not 403), a cap of 20, toggle off ⇒ 404.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createMember } from '../src/host/accessControlService.js';
import { composeChatContext } from '../src/host/chatContext.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) as any };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), put: (p: string, b?: unknown) => call('PUT', p, b) };
}
const email = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
const CH = '/host/openwop-app/channels';
const HEAD = 'Team intent ledger for project';

async function setup() {
  const tenantId = `org:cb-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: email('cb-owner'), tenantId })).body.user.userId as string;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'BindCo' })).body.orgId as string;
  const proj = (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body as { id: string };
  const L = `/host/openwop-app/team-ledger/projects/${proj.id}`;
  expect((await owner.post(L)).status).toBe(201);
  expect((await owner.post(`${L}/write`, { patch: { inScope: ['EU launch'] }, why: 'kickoff', baseVersion: 1 })).status).toBeLessThan(300);
  const ch = await owner.post(CH, { name: `launch-${n++}`, visibility: 'public' });
  expect(ch.status, JSON.stringify(ch.body)).toBe(201);
  const mate = client();
  const mateId = (await mate.post('/host/openwop-app/test/login', { email: email('cb-mate'), tenantId })).body.user.userId as string;
  await createMember({ tenantId, orgId, subject: mateId, displayName: 'Mate', roles: ['viewer'] });
  return { tenantId, orgId, owner, ownerId, mate, mateId, projectId: proj.id, L, channelId: ch.body.channel.conversationId as string };
}
const compose = (tenantId: string, conversationId: string, callerUserId: string) =>
  composeChatContext(tenantId, { conversationId, callerUserId, seedText: 'status?' });

describe('ADR 0852 P3 — binding a channel to a project', () => {
  it('the owner with write on an org-visible project binds it; GET returns it; null unbinds', async () => {
    const s = await setup();
    const r = await s.owner.put(`${CH}/${s.channelId}/project`, { projectId: s.projectId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.channel.channel.boundProjectId).toBe(s.projectId);
    expect((await s.owner.get(`${CH}/${s.channelId}`)).body.channel.channel.boundProjectId).toBe(s.projectId);
    const u = await s.owner.put(`${CH}/${s.channelId}/project`, { projectId: null });
    expect(u.status).toBe(200);
    expect(u.body.channel.channel.boundProjectId).toBeUndefined();
  });

  it('refused: a non-owner, an owner with only read on the project, a private project, an unknown project', async () => {
    const s = await setup();
    await s.mate.post(`${CH}/${s.channelId}/join`);
    expect((await s.mate.put(`${CH}/${s.channelId}/project`, { projectId: s.projectId })).status).toBe(403);
    // The mate owns their own channel but can only READ the project.
    const own = await s.mate.post(CH, { name: `mates-${n++}`, visibility: 'public' });
    expect((await s.mate.put(`${CH}/${own.body.channel.conversationId}/project`, { projectId: s.projectId })).status).toBe(403);
    expect((await s.owner.put(`${CH}/${s.channelId}/project`, { projectId: 'project-nope' })).status).toBe(404);
    expect((await s.owner.patch(`/host/openwop-app/projects/${s.projectId}/visibility`, { visibility: 'private' })).status).toBeLessThan(300);
    expect((await s.owner.put(`${CH}/${s.channelId}/project`, { projectId: s.projectId })).status).toBe(409);
    expect((await s.owner.put(`${CH}/${s.channelId}/project`, { projectId: 42 })).status).toBe(400);
  });

  it("a bound channel's turns carry the ledger; a project made private afterwards makes the binding inert", async () => {
    const s = await setup();
    expect((await compose(s.tenantId, s.channelId, s.ownerId)).systemPrompt).not.toContain(HEAD); // positive control below
    await s.owner.put(`${CH}/${s.channelId}/project`, { projectId: s.projectId });
    const bound = (await compose(s.tenantId, s.channelId, s.ownerId)).systemPrompt;
    expect(bound).toContain(`${HEAD} "Launch", version 2`);
    expect(bound).toContain('In scope: EU launch');
    expect((await s.owner.patch(`/host/openwop-app/projects/${s.projectId}/visibility`, { visibility: 'private' })).status).toBeLessThan(300);
    // The owner can still read the private project — and the channel still composes nothing.
    expect((await compose(s.tenantId, s.channelId, s.ownerId)).systemPrompt).not.toContain(HEAD);
  });
});

describe('ADR 0852 D4/D5 — ledger summaries', () => {
  it('summarizes readable projects, omits an unreadable private one, caps the list, 404s when off', async () => {
    const s = await setup();
    const other = (await s.owner.post('/host/openwop-app/projects', { orgId: s.orgId, name: 'Secret' })).body as { id: string };
    expect((await s.owner.patch(`/host/openwop-app/projects/${other.id}/visibility`, { visibility: 'private' })).status).toBeLessThan(300);
    const q = `/host/openwop-app/team-ledger/summaries?projectIds=${s.projectId},${other.id}`;
    const mine = await s.owner.get(q);
    expect(mine.status).toBe(200);
    expect(mine.body.summaries.map((x: any) => x.projectId).sort()).toEqual([s.projectId, other.id].sort());
    expect(mine.body.summaries.find((x: any) => x.projectId === s.projectId)).toMatchObject({ name: 'Launch', hasLedger: true, version: 2, pending: 0 });
    expect(mine.body.summaries.find((x: any) => x.projectId === other.id)).toMatchObject({ hasLedger: false });
    const theirs = await s.mate.get(q);
    expect(theirs.status).toBe(200);
    expect(theirs.body.summaries.map((x: any) => x.projectId)).toEqual([s.projectId]);
    const many = Array.from({ length: 21 }, (_, i) => `p${i}`).join(',');
    expect((await s.owner.get(`/host/openwop-app/team-ledger/summaries?projectIds=${many}`)).status).toBe(400);
  });
});
