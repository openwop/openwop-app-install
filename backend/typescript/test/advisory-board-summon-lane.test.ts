/**
 * WF-BOA-2 / WF-BOA-3 — the `@@`-summon attach lane
 * (`POST /v1/host/openwop-app/chat/sessions/:sessionId/board`).
 *
 * This lane had ZERO tests, which is how both blockers survived:
 *
 *   - WF-BOA-3: it validated `boardId` as a STRING and then stamped it — plus a
 *     caller-supplied speak-set — onto a durable conversation with no board read
 *     anywhere in the handler, falsifying the precondition the context resolver
 *     documents ("the convener already passed board RBAC at the `@@` summon").
 *   - WF-BOA-2: it passed the resolver's fail-soft `null` straight into
 *     `markAsBoardGroup`, whose contract is `null ⇒ CLEAR` — so a TRANSIENT
 *     strategy-read failure wiped the room's snapshot, while the sibling
 *     canonical lane deliberately passes `undefined ⇒ keep` and calls that
 *     "the SAFE direction".
 *
 * The failure-direction pair is asserted BOTH ways (the symmetric-pair rule): a
 * FAILED resolve must keep, an honest EMPTY must clear. A test that only pinned
 * "keep" would pass a resolver that never clears anything, which is a different
 * bug (a board whose context refs are all removed keeps stale grounding).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getConversationMeta } from '../src/host/conversationStore.js';
import { registerBoardContextResolver } from '../src/host/boardContextResolver.js';
import { resolveBoardStrategyContext } from '../src/features/advisory-board/service.js';

let BASE: string;
let server: http.Server;
let n = 0;

const SUMMARY = 'Ratchet the gross margin to 61% before the raise';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'advisory-board', 'strategy']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

const A = '/v1/host/openwop-app/advisors';
const CHAT = '/v1/host/openwop-app/chat/sessions';
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;

async function login(c: Client, tenantId: string): Promise<string> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('abc'), tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.userId as string;
}

interface World { owner: Client; tenantId: string; orgId: string; boardId: string; strategyId: string; agentRef: string }

async function world(visibility: 'shared' | 'private' = 'shared'): Promise<World> {
  const owner = client();
  const tenantId = `org:abc-${Date.now()}-${n++}`;
  await login(owner, tenantId);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  const orgId = org.body.orgId as string;
  const strategy = await owner.post('/v1/host/openwop-app/strategy', { orgId, scope: 'org', title: 'FY26', summary: SUMMARY });
  expect(strategy.status, JSON.stringify(strategy.body)).toBe(201);
  const advisor = await owner.post('/v1/host/openwop-app/roster', { persona: 'Ada Lovelace', agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
  const board = await owner.post(`${A}/boards`, {
    orgId, name: 'Founders', advisors: [advisor.body.rosterId], personaKind: 'historical', visibility,
    contextRefs: [{ kind: 'strategy', strategyId: strategy.body.id }],
  });
  expect(board.status, JSON.stringify(board.body)).toBe(201);
  return { owner, tenantId, orgId, boardId: board.body.boardId, strategyId: strategy.body.id, agentRef: `agent:${advisor.body.agentRef.agentId}` };
}

async function newSession(c: Client): Promise<string> {
  const r = await c.post(CHAT, { title: 'scratch' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.conversationId ?? r.body.sessionId ?? r.body.id;
}

describe('WF-BOA-3 — the summon lane gates on the BOARD and derives the speak-set', () => {
  it('a caller who cannot read the board gets 404, on their own conversation', async () => {
    const { boardId, tenantId } = await world('private');
    const stranger = client();
    await login(stranger, tenantId); // same tenant, cannot read a private board they do not own
    const sessionId = await newSession(stranger);
    const attach = await stranger.post(`${CHAT}/${encodeURIComponent(sessionId)}/board`, { boardId });
    expect(attach.status, JSON.stringify(attach.body)).toBe(404);
    expect((await getConversationMeta(tenantId, sessionId))?.boardId, 'no board provenance may be stamped').toBeUndefined();
  });

  it('a caller-supplied speak-set is IGNORED — participants come from the board cohort', async () => {
    const { owner, tenantId, boardId, agentRef } = await world('shared');
    const sessionId = await newSession(owner);
    const attach = await owner.post(`${CHAT}/${encodeURIComponent(sessionId)}/board`, {
      boardId, participants: ['agent:core.openwop.agents.brief-writer-IMPOSTOR'],
    });
    expect(attach.status, JSON.stringify(attach.body)).toBe(200);
    const refs = (await getConversationMeta(tenantId, sessionId))?.participants.map((p) => p.subjectRef) ?? [];
    expect(refs).toContain(agentRef);
    expect(refs.some((r) => r.includes('IMPOSTOR')), 'the body must not be able to seat an agent').toBe(false);
  });
});

describe('WF-BOA-2 — a transient resolve failure must not WIPE the snapshot', () => {
  it('failed ⇒ keep; honest empty ⇒ clear', async () => {
    const { owner, tenantId, boardId } = await world('shared');
    const sessionId = await newSession(owner);
    expect((await owner.post(`${CHAT}/${encodeURIComponent(sessionId)}/board`, { boardId })).status).toBe(200);
    expect((await getConversationMeta(tenantId, sessionId))?.injectedContextBlock ?? '').toContain(SUMMARY);

    // (a) the resolver THROWS — the block is UNKNOWN, not empty. Keep.
    registerBoardContextResolver(async () => { throw new Error('strategy store unavailable'); });
    try {
      expect((await owner.post(`${CHAT}/${encodeURIComponent(sessionId)}/board`, { boardId })).status).toBe(200);
      expect(
        (await getConversationMeta(tenantId, sessionId))?.injectedContextBlock ?? '',
        'a transient read failure must never wipe the boardroom snapshot',
      ).toContain(SUMMARY);
    } finally {
      registerBoardContextResolver(resolveBoardStrategyContext);
    }

    // (b) the board honestly resolves to NOTHING (its refs were dropped) — clear.
    // The symmetric half: `block ?? undefined` swallowed this and kept stale
    // grounding forever.
    expect((await owner.patch(`${A}/boards/${encodeURIComponent(boardId)}`, { contextRefs: [] })).status).toBe(200);
    expect((await owner.post(`${CHAT}/${encodeURIComponent(sessionId)}/board`, { boardId })).status).toBe(200);
    expect((await getConversationMeta(tenantId, sessionId))?.injectedContextBlock ?? '').not.toContain(SUMMARY);
  });
});
