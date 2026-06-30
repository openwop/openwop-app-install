/**
 * Board of Advisors (ADR 0040) — ROUTE harness. Boots the real app and drives the
 * advisory-board ENTITY surface over HTTP (the boardroom conversation itself runs
 * in the AI chat over chat.turn — ADR 0040 § Correction 2026-06-15 — not here):
 *   - toggle gating (404 when `advisory-board` is off)
 *   - create/list/get a board; cohort validation (empty / cross-tenant advisor)
 *   - living-persona ack gate (422 without the acknowledgement)
 *   - visibility: a `private` board is invisible to a co-tenant member (404),
 *     a `shared` board is visible; cross-tenant IDOR is fail-closed (404)
 *   - owner-only update/delete
 *   - `@@<handle>` resolution: by-handle → cohort, visibility-gated, 404 unknown
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
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'kb', 'advisory-board']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('ab'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const enable = async (id: string, status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };

async function makeAdvisor(c: Client, persona: string): Promise<string> {
  const r = await c.post('/v1/host/openwop-app/roster', { persona, agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.rosterId;
}

/** A tenant owner client + 2 advisor roster agents + a fresh org. */
async function ownerWithAdvisors(): Promise<{ owner: Client; userId: string; advisors: string[]; orgId: string }> {
  const owner = client();
  const u = await signup(owner);
  const a = await makeAdvisor(owner, 'Ada');
  const b = await makeAdvisor(owner, 'Boaz');
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, userId: u.userId, advisors: [a, b], orgId: org.body.orgId };
}

const B = '/v1/host/openwop-app/advisors/boards';

describe('advisory-board — toggle gating', () => {
  it('404s when the toggle is off', async () => {
    await enable('advisory-board', 'off');
    const owner = client();
    await signup(owner);
    expect((await owner.get(B)).status).toBe(404);
    await enable('advisory-board', 'on');
  });
});

describe('advisory-board — create + validate', () => {
  it('creates a board, lists + reads it, with a simulated-persona disclaimer', async () => {
    const { owner, advisors, orgId } = await ownerWithAdvisors();
    const r = await owner.post(B, { orgId, name: 'Founders Board', advisors, personaKind: 'historical' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.advisors).toEqual(advisors);
    expect(r.body.handle).toBe('founders-board');
    expect(r.body.disclaimer).toMatch(/simulated/i);
    const list = await owner.get(B);
    expect(list.body.boards).toHaveLength(1);
    const got = await owner.get(`${B}/${encodeURIComponent(r.body.boardId)}`);
    expect(got.status).toBe(200);
    expect(got.body.name).toBe('Founders Board');
  });

  it('rejects an empty cohort (400) and a cross-tenant advisor (404)', async () => {
    const { owner, orgId } = await ownerWithAdvisors();
    expect((await owner.post(B, { orgId, name: 'Empty', advisors: [] })).status).toBe(400);
    expect((await owner.post(B, { orgId, name: 'Foreign', advisors: ['host:advisory:not-mine'] })).status).toBe(404);
  });

  it('gates a living-persona board on the acknowledgement (422 without it)', async () => {
    const { owner, advisors, orgId } = await ownerWithAdvisors();
    const denied = await owner.post(B, { orgId, name: 'Living Legends', advisors, personaKind: 'living' });
    expect(denied.status, JSON.stringify(denied.body)).toBe(422);
    const ok = await owner.post(B, { orgId, name: 'Living Legends', advisors, personaKind: 'living', livingPersonaAck: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.livingPersonaAck).toBe(true);
  });
});

describe('advisory-board — visibility + IDOR', () => {
  it('a private board is invisible to a co-tenant member; a shared board is visible', async () => {
    const tenantId = `org:ab-${Date.now()}-${n++}`;
    const owner = client();
    await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    const a = await makeAdvisor(owner, 'Ada');
    const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
    const orgId = org.body.orgId;
    await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });

    const priv = await owner.post(B, { orgId, name: 'Private', advisors: [a], visibility: 'private' });
    const shared = await owner.post(B, { orgId, name: 'Shared', advisors: [a], visibility: 'shared' });
    expect(priv.status).toBe(201);
    expect(shared.status).toBe(201);

    // The member sees only the shared board; the private one 404s on direct read.
    const list = await member.get(B);
    expect(list.body.boards.map((x: any) => x.name)).toEqual(['Shared']);
    expect((await member.get(`${B}/${encodeURIComponent(priv.body.boardId)}`)).status).toBe(404);
    expect((await member.get(`${B}/${encodeURIComponent(shared.body.boardId)}`)).status).toBe(200);
  });

  it('a cross-tenant stranger cannot see a board (404, fail-closed)', async () => {
    const { owner, advisors, orgId } = await ownerWithAdvisors();
    const board = await owner.post(B, { orgId, name: 'Secret', advisors, visibility: 'shared' });
    const stranger = client();
    await signup(stranger);
    // Fail-closed either way: the board isn't in the stranger's tenant (404), or
    // they lack workspace:read there (403). Both deny; neither reveals the board.
    expect([403, 404]).toContain((await stranger.get(`${B}/${encodeURIComponent(board.body.boardId)}`)).status);
  });

  it('only the owner can update or delete a board', async () => {
    const tenantId = `org:ab-${Date.now()}-${n++}`;
    const owner = client();
    await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    const a = await makeAdvisor(owner, 'Ada');
    const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
    await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(org.body.orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });
    const board = await owner.post(B, { orgId: org.body.orgId, name: 'Shared', advisors: [a], visibility: 'shared' });
    const bid = board.body.boardId;
    // Member can read (shared) but not mutate.
    expect((await member.patch(`${B}/${encodeURIComponent(bid)}`, { name: 'Hijack' })).status).toBe(403);
    expect((await member.del(`${B}/${encodeURIComponent(bid)}`)).status).toBe(403);
    // Owner can.
    expect((await owner.patch(`${B}/${encodeURIComponent(bid)}`, { name: 'Renamed' })).body.name).toBe('Renamed');
    expect((await owner.del(`${B}/${encodeURIComponent(bid)}`)).status).toBe(204);
  });
});

describe('advisory-board — @@<handle> resolution (for the AI chat)', () => {
  it('resolves a board by its handle → cohort; 404s an unknown handle; private board hidden from a co-tenant member', async () => {
    const tenantId = `org:ab-${Date.now()}-${n++}`;
    const owner = client();
    await signup(owner, { tenantId });
    const member = client();
    const memberUser = await signup(member, { tenantId });
    const a = await makeAdvisor(owner, 'Ada');
    const b = await makeAdvisor(owner, 'Boaz');
    const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
    const orgId = org.body.orgId;
    await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });

    const shared = await owner.post(B, { orgId, name: 'Council', advisors: [a, b], visibility: 'shared' });
    const priv = await owner.post(B, { orgId, name: 'Private', advisors: [a], visibility: 'private' });
    expect(shared.status).toBe(201);

    // Owner resolves the shared board by handle → the advisor cohort.
    const r = await owner.get(`${B}/by-handle/${encodeURIComponent(shared.body.handle)}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.advisors).toEqual([a, b]);
    expect(r.body.disclaimer).toMatch(/simulated/i);

    // Unknown handle → 404.
    expect((await owner.get(`${B}/by-handle/does-not-exist`)).status).toBe(404);

    // A co-tenant member resolves the SHARED board but not the PRIVATE one.
    expect((await member.get(`${B}/by-handle/${encodeURIComponent(shared.body.handle)}`)).status).toBe(200);
    expect((await member.get(`${B}/by-handle/${encodeURIComponent(priv.body.handle)}`)).status).toBe(404);
  });
});

describe('advisory-board — strategy context (ADR 0079 Phase 5)', () => {
  const S = '/v1/host/openwop-app/strategy';
  it('carries readable strategy contextRefs, rejects unreadable, and previews them', async () => {
    await enable('advisory-board', 'on');
    await enable('strategy', 'on');
    const { owner, advisors, orgId } = await ownerWithAdvisors();
    const s = (await owner.post(S, { orgId, title: 'Win FY26', scope: 'org', summary: 'Grow ARR' })).body;
    expect(s.id).toBeTruthy();

    // a board carrying the strategy as context
    const board = (await owner.post(B, { name: 'Founders', orgId, advisors, contextRefs: [{ kind: 'strategy', strategyId: s.id }] })).body;
    expect(board.contextRefs).toHaveLength(1);

    // preview resolves the strategy (RBAC-filtered for the caller)
    const preview = await owner.get(`${B}/${encodeURIComponent(board.boardId)}/strategy-context`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.strategies.map((x: any) => x.id)).toContain(s.id);
    expect(preview.body.strategies[0].title).toBe('Win FY26');

    // an unreadable / absent strategy ref is rejected at board-save (404)
    const bad = await owner.post(B, { name: 'Bad', orgId, advisors, contextRefs: [{ kind: 'strategy', strategyId: 'strategy-does-not-exist' }] });
    expect(bad.status).toBe(404);

    // an UNKNOWN ref kind is rejected (400); a valid 'project' kind with a bogus id
    // is not-found (404) — project context is now a supported kind (ADR 0100).
    const badKind = await owner.post(B, { name: 'Bad2', orgId, advisors, contextRefs: [{ kind: 'banana', strategyId: 'x' }] });
    expect(badKind.status).toBe(400);
    const badProject = await owner.post(B, { name: 'Bad3', orgId, advisors, contextRefs: [{ kind: 'project', projectId: 'project-does-not-exist' }] });
    expect(badProject.status).toBe(404);
  });

  it('carries readable PROJECT contextRefs (ADR 0100 — project context parity)', async () => {
    await enable('advisory-board', 'on');
    await enable('projects', 'on');
    const { owner, advisors, orgId } = await ownerWithAdvisors();
    const proj = (await owner.post('/v1/host/openwop-app/projects', { orgId, name: 'Launch Q3' })).body;
    expect(proj.id).toBeTruthy();
    const board = (await owner.post(B, { name: 'PMO Board', orgId, advisors, contextRefs: [{ kind: 'project', projectId: proj.id }] })).body;
    expect(board.contextRefs).toEqual([{ kind: 'project', projectId: proj.id }]);
  });

  it('cross-org: a board owner cannot attach a strategy they cannot read', async () => {
    await enable('advisory-board', 'on');
    await enable('strategy', 'on');
    const tenantId = `org:abs-${Date.now()}-${n++}`;
    const owner = client(); await signup(owner, { tenantId });
    const member = client(); const memberUser = await signup(member, { tenantId });
    const orgA = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Alpha' })).body.orgId;
    const orgB = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Bravo' })).body.orgId;
    await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });
    const adv = await makeAdvisor(member, 'Cleo');
    // an org-scoped strategy in org B (the member can't read it)
    const sB = (await owner.post(S, { orgId: orgB, title: 'Secret plan', scope: 'org' })).body;
    // the member builds a board in org A but tries to attach the org-B strategy → 404
    const res = await member.post(B, { name: 'Member board', orgId: orgA, advisors: [adv], contextRefs: [{ kind: 'strategy', strategyId: sB.id }] });
    expect(res.status).toBe(404);
  });
});
