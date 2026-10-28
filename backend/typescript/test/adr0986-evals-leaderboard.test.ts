/**
 * ADR 0986 — the evals leaderboard ranks models by what really answered, and the
 * arena's verdicts are bound to real runs (feature loop round 2, row 59).
 *
 * Route-level, through the production chat path: a cookie-authed workspace admin
 * opens a conversation run bound to a chat session (the ONE chat's shape), the
 * mock provider answers, the admin rates the agent turn, and the leaderboard is
 * read back. Each `EV2-*` case was RED on `f3a80dd9e`:
 *
 *  - EV2-1  a rating on a real chat turn never reached the board. The join read
 *           `meta.model` off `chat_messages`, which the conversation transport
 *           never writes (prod 2026-10-26: 0 of 62 assistant rows carry a model).
 *  - EV2-2  attribution was client-authored: an appended assistant row with a
 *           forged `meta.model` ranked first.
 *  - EV2-3  the thumbs "Elo" depended on storage key order, not on the votes.
 *  - EV2-4  an arena verdict needed no runs: two model strings were enough.
 *  - EV2-5  verdicts never reached the leaderboard.
 *  - EV2-6  a verdict could name models other than the ones that answered.
 *  - EV2-7  the same pair of runs could be voted twice.
 *  - EV2-8  another member's runs could be voted on.
 *  - EV2-9  DSAR erasure left the rater's subject on every arena match.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// EV2CD-11 — observe, at the moment the turn becomes durable, whether its
// attribution row already exists (a rating can arrive the instant it is visible).
const persistProbe = vi.hoisted(() => ({ tenant: '', attributedAtPersist: new Map<string, boolean>() }));
vi.mock('../src/host/exchange/persistExchange.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/exchange/persistExchange.js')>();
  const { getTurnAttribution } = await import('../src/host/turnAttribution.js');
  const { conversationMessageId } = await import('../src/host/conversationMessageId.js');
  return {
    ...actual,
    persistExchangedPair: async (input: Parameters<typeof actual.persistExchangedPair>[0]) => {
      for (const [, turn] of input.entries) {
        if (turn.role !== 'agent') continue;
        persistProbe.attributedAtPersist.set(turn.messageId, (await getTurnAttribution(persistProbe.tenant, conversationMessageId(turn.messageId))) !== null);
      }
      return actual.persistExchangedPair(input);
    },
  };
});
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { programMock, resetMockPrograms } from '../src/providers/dispatchMock.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { combineLeaderboard } from '../src/features/evals/leaderboard.js';
import { conversationMessageId } from '../src/host/conversationMessageId.js';
import { getTurnAttribution } from '../src/host/turnAttribution.js';

let BASE: string;
let server: http.Server;
let wsTenant: string;
let adminCookie: string;
let adminUserId: string;
let editorCookie: string;

const craftCookie = (userId: string, activeTenant: string, personalTenant: string): string => {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: activeTenant, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
};
const seat = async (principalId: string, roles: string[]): Promise<{ cookie: string; userId: string }> => {
  const user = await upsertFromPrincipal({ tenantId: wsTenant, principalId, source: 'oidc' });
  await createMember({ tenantId: wsTenant, orgId: wsTenant, subject: user.userId, displayName: principalId, roles });
  return { cookie: craftCookie(user.userId, wsTenant, `ws:home-${principalId}`), userId: user.userId };
};

interface Res<T> { status: number; body: T }
async function call<T>(method: string, path: string, cookie: string, body?: unknown): Promise<Res<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { 'content-type': 'application/json', cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = res.status === 204 ? '' : await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

interface Turn { messageId: string; role: string }
interface Ev { type?: string; payload?: { turn?: Turn } }
async function waitSuspended(runId: string, cookie: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const s = (await call<{ status: string }>('GET', `/runs/${runId}`, cookie)).body.status;
    if (s.startsWith('waiting')) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`run ${runId} never suspended`);
}
async function agentTurnIds(runId: string, cookie: string): Promise<string[]> {
  const events = (await call<{ events?: Ev[] }>('GET', `/runs/${runId}/debug-bundle`, cookie)).body.events ?? [];
  return events.filter((e) => e.type === 'conversation.exchanged' && e.payload?.turn?.role === 'agent').map((e) => e.payload!.turn!.messageId);
}

/** Open a conversation run the way the ONE chat does, exchange one prompt, and
 *  return the agent turn's message id. */
async function chatTurn(cookie: string, opts: { model: string; prompt: string; reply: string; chatSessionId?: string }): Promise<{ runId: string; agentMessageId: string }> {
  const created = await call<{ runId: string }>('POST', '/runs', cookie, {
    workflowId: 'openwop-app.conversation',
    inputs: { provider: 'mock', model: opts.model },
    ...(opts.chatSessionId ? { metadata: { chatSessionId: opts.chatSessionId } } : {}),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const runId = created.body.runId;
  await waitSuspended(runId, cookie);
  resetMockPrograms();
  programMock('', [{ content: opts.reply }]);
  const ex = await call('POST', `/runs/${runId}/interrupts/gate`, cookie, { resumeValue: { operation: 'exchange', turn: { content: opts.prompt } } });
  expect(ex.status, JSON.stringify(ex.body)).toBe(200);
  const ids = await agentTurnIds(runId, cookie);
  expect(ids.length, 'precondition: the exchange produced an agent turn').toBe(1);
  // Close it: open conversation runs count against the tenant's concurrent-session cap.
  expect((await call('POST', `/runs/${runId}/interrupts/gate`, cookie, { resumeValue: { operation: 'close' } })).status).toBe(200);
  return { runId, agentMessageId: ids[0]! };
}

async function newChatSession(cookie: string): Promise<string> {
  const sessionId = `ev2-${randomBytes(6).toString('hex')}`;
  const r = await call('POST', '/host/openwop-app/chat/sessions', cookie, { sessionId, title: 'Leaderboard probe' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return sessionId;
}
const rate = (cookie: string, conversationId: string, messageId: string, rating: 'up' | 'down') =>
  call('POST', `/host/openwop-app/chat/messages/${encodeURIComponent(messageId)}/feedback`, cookie, { conversationId, rating });

interface Board {
  leaderboard?: Array<{ model: string; provider?: string; up: number; down: number }>;
  arena?: Array<{ model: string; provider?: string; matches: number }>;
  coverage?: { attributed: number; unattributed: number };
}
const board = async (): Promise<Board> => {
  const r = await call<Board>('GET', `/host/openwop-app/evals/orgs/${wsTenant}/leaderboard`, adminCookie);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true'; // the mock provider
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('evals');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  const ws = await createWorkspace({ name: 'Evals probe', ownerSubject: 'oidc:ev2-owner' });
  wsTenant = ws.tenantId;
  persistProbe.tenant = wsTenant;
  const admin = await seat('oidc:ev2-admin', ['admin']);
  adminCookie = admin.cookie;
  adminUserId = admin.userId;
  editorCookie = (await seat('oidc:ev2-editor', ['editor'])).cookie;
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 0986 — the leaderboard ranks what really answered', () => {
  it('EV2-1: a thumbs-up on a real chat turn reaches the board, attributed to the model that answered', async () => {
    const sessionId = await newChatSession(adminCookie);
    const { agentMessageId } = await chatTurn(adminCookie, { model: 'mock-ev2-1', prompt: 'Summarise our Q3.', reply: 'Q3 grew 12%.', chatSessionId: sessionId });
    // The SPA rates the CANONICAL id (`conversationMessageId`), never the wire id (architect B1).
    expect((await rate(adminCookie, sessionId, conversationMessageId(agentMessageId), 'up')).status).toBe(200);
    const b = await board();
    expect(b.leaderboard?.find((r) => r.model === 'mock-ev2-1')).toMatchObject({ provider: 'mock', up: 1, down: 0 });
  });

  it('EV2CD-11: the attribution exists BEFORE the turn becomes visible, so an instant rating counts', async () => {
    const sessionId = await newChatSession(adminCookie);
    const { agentMessageId } = await chatTurn(adminCookie, { model: 'mock-early', prompt: 'Quick one?', reply: 'Yes.', chatSessionId: sessionId });
    expect(persistProbe.attributedAtPersist.get(agentMessageId)).toBe(true);
  });

  it('EV2-1b: a turn that produced nothing is not attributed (nothing to rank)', async () => {
    const sessionId = await newChatSession(adminCookie);
    const { agentMessageId } = await chatTurn(adminCookie, { model: 'mock-silent', prompt: 'Anything?', reply: '', chatSessionId: sessionId });
    expect(await getTurnAttribution(wsTenant, conversationMessageId(agentMessageId))).toBeNull();
  });

  it('EV2-2: a client-written model name never reaches the board', async () => {
    const sessionId = await newChatSession(adminCookie);
    for (let i = 0; i < 3; i++) {
      const messageId = `forged${i}`;
      const app = await call('POST', `/host/openwop-app/chat/sessions/${sessionId}/messages`, adminCookie, {
        messageId, role: 'assistant', content: JSON.stringify({ role: 'assistant', content: 'hi' }), meta: JSON.stringify({ provider: 'openai', model: 'forged-model' }),
      });
      expect(app.status, 'precondition: the forged row was stored').toBe(201);
      expect((await rate(adminCookie, sessionId, messageId, 'up')).status).toBe(200);
    }
    const b = await board();
    expect(b.leaderboard?.some((r) => r.model === 'forged-model')).toBe(false);
    expect(b.coverage?.unattributed).toBeGreaterThanOrEqual(3);
  });

  it('EV2-3: the ranking is a function of the votes, not of the order they are stored in', () => {
    const votes = [
      { provider: 'p', model: 'a', rating: 'up' as const, rater: 'u1' }, { provider: 'p', model: 'a', rating: 'down' as const, rater: 'u1' },
      { provider: 'p', model: 'a', rating: 'up' as const, rater: 'u2' }, { provider: 'p', model: 'b', rating: 'down' as const, rater: 'u1' },
      { provider: 'p', model: 'b', rating: 'up' as const, rater: 'u2' },
    ];
    expect(combineLeaderboard([...votes].reverse())).toEqual(combineLeaderboard(votes));
  });
});

describe('ADR 0986 — an arena verdict is bound to two real runs', () => {
  const match = (cookie: string, body: Record<string, unknown>) =>
    call<{ match?: { modelA: string; modelB: string } }>('POST', `/host/openwop-app/evals/orgs/${wsTenant}/arena/match`, cookie, body);

  it('EV2-4: a verdict that names no runs is refused', async () => {
    const r = await match(adminCookie, { modelA: 'alpha', modelB: 'beta', winner: 'A' });
    expect(r.status).toBe(400);
    // The old (model-name) contract is refused with a reason that names the new one.
    expect(r.body).toMatchObject({ details: { reason: 'arena_contract_changed', required: ['runIdA', 'runIdB', 'winner'] } });
  });

  it('EV2-5/6/7: a bound verdict records the models that answered, reaches the board, and counts once', async () => {
    const a = await chatTurn(adminCookie, { model: 'mock-arena-a', prompt: 'Write a haiku about rain.', reply: 'Rain on the tin roof.' });
    const b = await chatTurn(adminCookie, { model: 'mock-arena-b', prompt: 'Write a haiku about rain.', reply: 'Grey sky, soft drumming.' });
    const body = { runIdA: a.runId, runIdB: b.runId, modelA: 'claimed-x', modelB: 'claimed-y', winner: 'A' };
    const first = await match(adminCookie, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.match).toMatchObject({ modelA: 'mock-arena-a', modelB: 'mock-arena-b' });
    const again = await call<{ replayed?: boolean; match?: { winner: string } }>('POST', `/host/openwop-app/evals/orgs/${wsTenant}/arena/match`, adminCookie, { ...body, winner: 'B' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, match: { winner: 'A' } }); // the stored verdict, not the new one
    const arena = (await board()).arena ?? [];
    expect(arena.find((r) => r.model === 'mock-arena-a')).toMatchObject({ matches: 1 });
    expect(arena.find((r) => r.model === 'mock-arena-b')).toMatchObject({ matches: 1 });
    expect(arena.some((r) => r.model === 'claimed-x')).toBe(false);
  });

  it('EV2-8: another member\'s runs cannot be voted on', async () => {
    const a = await chatTurn(adminCookie, { model: 'mock-own-a', prompt: 'Name a colour.', reply: 'Teal.' });
    const b = await chatTurn(adminCookie, { model: 'mock-own-b', prompt: 'Name a colour.', reply: 'Ochre.' });
    const r = await match(editorCookie, { runIdA: a.runId, runIdB: b.runId, winner: 'B' });
    expect(r.status).toBe(404);
  });

  it('EV2-9: DSAR erasure removes the rater from every arena match', async () => {
    const a = await chatTurn(adminCookie, { model: 'mock-dsar-a', prompt: 'Pick a number.', reply: 'Seven.' });
    const b = await chatTurn(adminCookie, { model: 'mock-dsar-b', prompt: 'Pick a number.', reply: 'Three.' });
    // Recorded through whichever lane the build has: the bound body, or the legacy strings.
    const r = await match(adminCookie, { runIdA: a.runId, runIdB: b.runId, modelA: 'mock-dsar-a', modelB: 'mock-dsar-b', winner: 'tie' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const ledger = new DurableCollection<{ tenantId: string; raterSubject: string }>('evals:arena-match', (m) => JSON.stringify(m));
    const mine = async () => (await ledger.listByPrefix('')).filter((m) => m.tenantId === wsTenant && m.raterSubject.includes(adminUserId));
    expect((await mine()).length, 'precondition: the verdict names its rater').toBeGreaterThan(0);
    const feedback = new DurableCollection<{ tenantId: string; subjectRef: string }>('chat:message-feedback', (f) => JSON.stringify(f));
    const myRatings = async () => (await feedback.listByPrefix(`${wsTenant}:`)).filter((f) => f.subjectRef.includes(adminUserId));
    expect((await myRatings()).length, 'precondition: the admin rated turns above').toBeGreaterThan(0);
    await eraseSubject(wsTenant, adminUserId);
    expect(await mine()).toEqual([]);
    expect(await myRatings(), 'the ratings that feed the board go too').toEqual([]);
  });
});
