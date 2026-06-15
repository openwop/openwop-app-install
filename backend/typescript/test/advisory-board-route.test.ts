/**
 * Board of Advisors (ADR 0040) — ROUTE + orchestration harness. Boots the real
 * app and drives the advisory-board surface over HTTP, plus exercises the convene
 * orchestration directly with an injected reply stub (deterministic, no model):
 *   - toggle gating (404 when `advisory-board` is off)
 *   - create/list/get a board; cohort validation (empty / cross-tenant advisor)
 *   - living-persona ack gate (422 without the acknowledgement)
 *   - visibility: a `private` board is invisible to a co-tenant member (404),
 *     a `shared` board is visible; cross-tenant IDOR is fail-closed (404)
 *   - owner-only update/delete
 *   - convene: one user turn + one attributed turn per advisor + a moderator turn;
 *     resolved cohort stamped; a 2nd advisor sees the 1st narrative-cast `[Name]:`
 *     (cross-talk); continuing a session appends turns
 */

import http from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { convene } from '../src/features/advisory-board/service.js';
import { createBoundCollection, ingestDocToAgent } from '../src/features/agent-knowledge/service.js';
import type { ChatMessage } from '../src/providers/dispatch.js';

const PORT = 18761;
const BASE = `http://127.0.0.1:${PORT}`;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
  for (const id of ['users', 'kb', 'agent-knowledge', 'advisory-board']) {
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

describe('advisory-board — convene orchestration (injected reply)', () => {
  it('fans the prompt to each advisor + a moderator, attributes turns, and narrative-casts cross-talk', async () => {
    const { owner, userId, advisors, orgId } = await ownerWithAdvisors();
    const created = await owner.post(B, { orgId, name: 'Council', advisors });
    const board = created.body;

    // A reply stub: echo who's answering (the LAST system line names the persona
    // via the scaffold) and record the messages so we can assert cross-talk casting.
    const seen: ChatMessage[][] = [];
    let call = 0;
    const reply = async ({ messages }: { messages: ChatMessage[] }): Promise<string> => {
      seen.push(messages);
      return `reply-${call++}`;
    };

    const session = await convene(board.tenantId, userId, 'Dana', board.boardId, { prompt: 'How do we grow?' }, reply);

    // 1 user + 2 advisors + 1 moderator (synthesize defaults true).
    expect(session.turns).toHaveLength(4);
    expect(session.turns[0]).toMatchObject({ role: 'user', speakerId: 'user', speakerName: 'Dana', content: 'How do we grow?' });
    expect(session.turns[1]).toMatchObject({ role: 'advisor', speakerId: advisors[0], speakerName: 'Ada' });
    expect(session.turns[2]).toMatchObject({ role: 'advisor', speakerId: advisors[1], speakerName: 'Boaz' });
    expect(session.turns[3]).toMatchObject({ role: 'moderator', speakerName: 'Moderator' });
    // Cohort stamped at first convene.
    expect(session.resolvedCohort.advisors).toEqual(advisors);

    // The 2nd advisor (Boaz) saw Ada's prior turn narrative-cast as `[Ada]: …`.
    const boazMessages = seen[1];
    const hasAdaCast = boazMessages.some((m) => typeof m.content === 'string' && m.content.startsWith('[Ada]: '));
    expect(hasAdaCast).toBe(true);

    // Continuing the session appends (does not replace) turns.
    const session2 = await convene(board.tenantId, userId, 'Dana', board.boardId, { prompt: 'And costs?', sessionId: session.sessionId }, reply);
    expect(session2.sessionId).toBe(session.sessionId);
    expect(session2.turns).toHaveLength(8);
    expect(session2.turns[4]).toMatchObject({ role: 'user', content: 'And costs?' });
  });

  it('grounds an advisor from its OWN bound corpus, keyed by rosterId (regression: not the shared manifest id)', async () => {
    const { owner, userId, advisors, orgId } = await ownerWithAdvisors();
    const created = await owner.post(B, { orgId, name: 'Council', advisors });
    const board = created.body;

    // Bind a KB collection + a relevant doc to the FIRST advisor ONLY, keyed by
    // its rosterId (the agentProfile.profileId), exactly as ADR 0038 binds.
    const col = await createBoundCollection(board.tenantId, orgId, userId, advisors[0], { name: 'Ada corpus' });
    await ingestDocToAgent(board.tenantId, orgId, userId, advisors[0], col.collectionId, {
      title: 'Growth playbook',
      text: 'To grow the company, expand into adjacent markets and double down on the highest-retention customer segment.',
    });

    const reply = async (): Promise<string> => 'noted';
    const session = await convene(board.tenantId, userId, 'Dana', board.boardId, { prompt: 'How should we grow the company?' }, reply);

    // The bound advisor's turn resolves grounding; the unbound advisor's does not.
    // Before the fix (keyed by the shared agentRef.agentId), NEITHER resolved.
    expect(session.turns[1]).toMatchObject({ role: 'advisor', speakerId: advisors[0], grounded: true });
    expect(session.turns[2].grounded ?? false).toBe(false);
  });
});
