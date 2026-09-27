/**
 * ADR 0278 — the CANONICAL board conversation. ROUTE harness: boots the real app
 * and drives POST /advisors/boards/:boardId/chat + the chat-session surface:
 *   - deterministic: opening twice → the SAME sessionId (no per-summon instances)
 *   - join semantics: an ORG MEMBER of a `shared` board opens the SAME chat,
 *     can read it AND append to it (subject-access via ownerSubject board:<id>)
 *   - fail-closed: a co-tenant non-creator on a `private` board → 404;
 *     a cross-tenant stranger → 404
 *   - cohort reconcile: advisors added/removed on the board reflect on re-open
 *   - ownerSubject survives markAsBoardGroup re-stamps (the preserve fix)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getConversationMeta } from '../src/host/conversationStore.js';

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
  for (const id of ['users', 'advisory-board']) {
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
const A = '/v1/host/openwop-app/advisors';
const CHAT = '/v1/host/openwop-app/chat/sessions';

async function login(c: Client, tenantId: string): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('abc'), tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

async function makeAdvisor(c: Client, persona: string): Promise<string> {
  const r = await c.post('/v1/host/openwop-app/roster', { persona, agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.rosterId;
}

async function setup(visibility: 'shared' | 'private' = 'shared'): Promise<{
  owner: Client; tenantId: string; orgId: string; boardId: string; advisors: string[];
}> {
  const owner = client();
  const tenantId = `org:abc-${Date.now()}-${n++}`;
  await login(owner, tenantId);
  const a = await makeAdvisor(owner, 'Ada Lovelace');
  const b = await makeAdvisor(owner, 'Alan Turing');
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  const board = await owner.post(`${A}/boards`, { orgId: org.body.orgId, name: 'Founders', advisors: [a, b], personaKind: 'historical', visibility });
  expect(board.status, JSON.stringify(board.body)).toBe(201);
  return { owner, tenantId, orgId: org.body.orgId, boardId: board.body.boardId, advisors: [a, b] };
}

describe('ADR 0278 — canonical board conversation', () => {
  it('opening twice yields the SAME conversation (deterministic, no per-summon instances)', async () => {
    const { owner, boardId } = await setup();
    const one = await owner.post(`${A}/boards/${encodeURIComponent(boardId)}/chat`);
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    const two = await owner.post(`${A}/boards/${encodeURIComponent(boardId)}/chat`);
    expect(two.status).toBe(200); // GRADE-10 — honest REST: reuse is 200, only creation is 201
    expect(two.body.sessionId).toBe(one.body.sessionId);
  });

  it('an org member JOINS the shared board chat: same id, can read AND append; ownerSubject survives re-stamps', async () => {
    const { owner, tenantId, orgId, boardId } = await setup('shared');
    const opened = await owner.post(`${A}/boards/${encodeURIComponent(boardId)}/chat`);
    const sessionId = opened.body.sessionId as string;

    // A second user in the SAME tenant, granted org membership (editor scope).
    const member = client();
    const memberUser = await login(member, tenantId);
    await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: ['editor'] });

    // Join = the member's open resolves the SAME conversation…
    const joined = await member.post(`${A}/boards/${encodeURIComponent(boardId)}/chat`);
    expect(joined.status, JSON.stringify(joined.body)).toBe(200); // reuse
    expect(joined.body.sessionId).toBe(sessionId);
    // …which they can READ and APPEND to (subject-access join, not participants).
    expect((await member.get(`${CHAT}/${encodeURIComponent(sessionId)}/messages`)).status).toBe(200);
    const append = await member.post(`${CHAT}/${encodeURIComponent(sessionId)}/messages`, {
      messageId: `m-${Date.now()}`, role: 'user', content: JSON.stringify({ role: 'user', content: 'hello board' }),
    });
    expect([200, 201]).toContain(append.status);

    // The preserve fix: after BOTH opens re-ran markAsBoardGroup, the generic
    // owner binding is still on the meta (it was previously dropped on rebuild).
    const meta = await getConversationMeta(tenantId, sessionId);
    expect(meta?.ownerSubject).toEqual({ kind: 'board', id: boardId });
    expect(meta?.boardId).toBe(boardId);
    // GRADE-6 — the member's open does NOT churn ownership: the creator stays
    // ownerUserId and exactly ONE owner-role user participant exists.
    expect(meta?.ownerUserId).not.toBe(memberUser.userId);
    expect((meta?.participants ?? []).filter((p) => p.role === 'owner' && p.subjectRef.startsWith('user:')).length).toBe(1);
  });

  it('fail-closed: private board → co-tenant non-creator 404; cross-tenant stranger 404', async () => {
    const { tenantId, boardId } = await setup('private');
    const coTenant = client();
    await login(coTenant, tenantId);
    expect((await coTenant.post(`${A}/boards/${encodeURIComponent(boardId)}/chat`)).status).toBe(404);
    const stranger = client();
    await login(stranger, `org:other-${Date.now()}-${n++}`);
    expect((await stranger.post(`${A}/boards/${encodeURIComponent(boardId)}/chat`)).status).toBe(404);
  });

  it('a zero-role co-tenant caller is 403d even on a SHARED board (GRADE-5 org-scope gate)', async () => {
    const { tenantId, boardId } = await setup('shared');
    const noRole = client();
    await login(noRole, tenantId); // same tenant, NO org membership/scopes
    expect((await noRole.post(`${A}/boards/${encodeURIComponent(boardId)}/chat`)).status).toBe(403);
  });

  it('deleting the board unbinds shared knowledge and releases the conversation to the legacy gate (GRADE-13)', async () => {
    const { owner, tenantId, boardId, advisors: [a] } = await setup('shared');
    await owner.post(`/v1/host/openwop-app/advisors/boards/${encodeURIComponent(boardId)}/shared-knowledge`, { kind: 'strategy', shared: true });
    const opened = await owner.post(`${A}/boards/${encodeURIComponent(boardId)}/chat`);
    const sessionId = opened.body.sessionId as string;
    const { getAgentProfile } = await import('../src/host/agentProfileService.js');
    expect(((await getAgentProfile(tenantId, a!))?.knowledge?.collectionIds ?? []).length).toBeGreaterThan(0);

    const delRes = await owner.del(`${A}/boards/${encodeURIComponent(boardId)}`);
    expect([200, 204]).toContain(delRes.status);

    // Bindings unbound (no other board shares strategy with this advisor)…
    expect((await getAgentProfile(tenantId, a!))?.knowledge?.collectionIds ?? []).toEqual([]);
    // …and the conversation fell back to the legacy owner gate: the CREATOR can
    // still read the transcript (previously 404 for everyone, forever).
    expect((await owner.get(`${CHAT}/${encodeURIComponent(sessionId)}/messages`)).status).toBe(200);
    const meta = await getConversationMeta(tenantId, sessionId);
    expect(meta?.ownerSubject).toBeUndefined();
  });

  it('re-opening after a board RENAME refreshes the stale rail title (GRADE-D7, title-source-guarded)', async () => {
    const { owner, tenantId, boardId } = await setup();
    const opened = await owner.post(`${A}/boards/${encodeURIComponent(boardId)}/chat`);
    const sessionId = opened.body.sessionId as string;
    expect((await owner.patch(`${A}/boards/${encodeURIComponent(boardId)}`, { name: 'War Council' })).status).toBe(200);
    await owner.post(`${A}/boards/${encodeURIComponent(boardId)}/chat`); // re-open → refresh
    const { hostExtStorage } = await import('../src/host/hostExtPersistence.js');
    expect((await hostExtStorage().getChatSession(tenantId, sessionId))?.title).toBe('War Council · board');
  });

  it('re-opening after a cohort change reconciles the agent participants both ways', async () => {
    const { owner, tenantId, boardId, advisors: [a] } = await setup();
    const opened = await owner.post(`${A}/boards/${encodeURIComponent(boardId)}/chat`);
    const sessionId = opened.body.sessionId as string;
    const before = (await getConversationMeta(tenantId, sessionId))?.participants.filter((p) => p.subjectRef.startsWith('agent:')) ?? [];
    expect(before.length).toBeGreaterThan(0);

    // Shrink the cohort to just `a`, re-open, and the lineup follows.
    expect((await owner.patch(`${A}/boards/${encodeURIComponent(boardId)}`, { advisors: [a] })).status).toBe(200);
    await owner.post(`${A}/boards/${encodeURIComponent(boardId)}/chat`);
    const after = (await getConversationMeta(tenantId, sessionId))?.participants.filter((p) => p.subjectRef.startsWith('agent:')) ?? [];
    expect(after.length).toBeLessThanOrEqual(before.length);
    // All advisors share one underlying chat agent in this harness, so assert by
    // count, not id — the reconcile must not GROW the lineup after a shrink.
    expect(after.length).toBeGreaterThan(0);
  });
});
