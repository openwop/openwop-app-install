/**
 * ADVB-1 / ADVB-9 — the board context-snapshot RBAC boundary.
 *
 * The gap that let ADVB-1 ship was that NO test asserted on the composed system
 * prompt: `advisory-board-chat.test.ts` covers reuse/join/404/rename/cohort, and
 * `advisory-board-route.test.ts` asserts the PREVIEW for the user who set the
 * ref — which cannot discriminate, because the preview already filters for its
 * own caller. The leak lived one layer down, in what the MODEL is handed.
 *
 * So these assert on `composeChatContext(...).systemPrompt`, per caller:
 *
 *   1. a `workspace:write` curator attaches a `scope:'user'` strategy (creator
 *      -only) to a `shared` board and opens the canonical chat → the block IS
 *      composed for them;
 *   2. a `workspace:read`-only co-member opens the SAME conversation → their
 *      composed prompt MUST NOT contain the strategy's summary, even though the
 *      curator's render is sitting on the conversation meta;
 *   3. the persisted snapshot is still there (it is a provenance record) — which
 *      is what makes (2) a real assertion rather than a vacuous one: the leak
 *      material EXISTS in durable state and is withheld at composition.
 *
 * (3) is the anti-rot arm. If a later change makes the composer read
 * `meta.injectedContextBlock` again, (2) reddens; if a later change simply stops
 * persisting the snapshot, (3) reddens and tells you (2) is no longer proving
 * anything.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getConversationMeta } from '../src/host/conversationStore.js';
import { composeChatContext } from '../src/host/chatContext.js';

let BASE: string;
let server: http.Server;
let n = 0;

const SECRET_SUMMARY = 'Project Nightjar — the unannounced acquisition thesis';

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
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;

async function login(c: Client, tenantId: string): Promise<string> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('abc'), tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.userId as string;
}

describe('ADVB-1 — the board planning-context block is re-resolved per CALLER', () => {
  it('a read-only co-member never receives the curator-only strategy the snapshot carries', async () => {
    const tenantId = `org:abc-${Date.now()}-${n++}`;
    const curator = client();
    const curatorId = await login(curator, tenantId);

    const org = await curator.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    const orgId = org.body.orgId as string;

    // A creator-ONLY strategy: `scope:'user'` ⇒ `canSubjectReadStrategy` is
    // `subject === createdBy`. This is one of exactly two shapes where org
    // `workspace:write` (what the snapshot gate narrows on) diverges from the
    // real read predicate.
    const strategy = await curator.post('/v1/host/openwop-app/strategy', {
      orgId, scope: 'user', title: 'Nightjar', summary: SECRET_SUMMARY,
    });
    expect(strategy.status, JSON.stringify(strategy.body)).toBe(201);

    const advisor = await curator.post('/v1/host/openwop-app/roster', { persona: 'Ada Lovelace', agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
    expect(advisor.status, JSON.stringify(advisor.body)).toBe(201);
    const board = await curator.post(`${A}/boards`, {
      orgId, name: 'Founders', advisors: [advisor.body.rosterId], personaKind: 'historical', visibility: 'shared',
      contextRefs: [{ kind: 'strategy', strategyId: strategy.body.id }],
    });
    expect(board.status, JSON.stringify(board.body)).toBe(201);
    const boardId = board.body.boardId as string;

    const opened = await curator.post(`${A}/boards/${encodeURIComponent(boardId)}/chat`);
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const sessionId = opened.body.sessionId as string;

    // (3) the anti-rot arm — the leak material really is in durable state.
    const meta = await getConversationMeta(tenantId, sessionId);
    expect(meta?.boardId).toBe(boardId);
    expect(meta?.injectedContextBlock ?? '', 'the curator snapshot must be persisted, or (2) proves nothing').toContain(SECRET_SUMMARY);

    // (1) the curator's own turn IS grounded — the fix must not be "compose
    // nothing for everyone", which would pass (2) while breaking the feature.
    const asCurator = await composeChatContext(tenantId, { conversationId: sessionId, callerUserId: curatorId, seedText: 'what should we do?' });
    expect(asCurator.systemPrompt).toContain(SECRET_SUMMARY);
    expect(asCurator.degraded).not.toContain('board_context');

    // (2) the co-member joins the SAME conversation (ADR 0278 join semantics)
    // with only `workspace:read`, and must NOT be grounded in it.
    const member = client();
    const memberId = await login(member, tenantId);
    // `viewer` = read-only org membership — NOT `workspace:write`, so this
    // caller is exactly the one the GRADE-8 snapshot gate excluded from
    // curating and (before the fix) silently included in reading.
    const added = await curator.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberId, roles: ['viewer'] });
    expect([200, 201]).toContain(added.status);
    const joined = await member.post(`${A}/boards/${encodeURIComponent(boardId)}/chat`);
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    expect(joined.body.sessionId).toBe(sessionId);

    const asMember = await composeChatContext(tenantId, { conversationId: sessionId, callerUserId: memberId, seedText: 'what should we do?' });
    expect(asMember.systemPrompt, 'a co-member must never be grounded in a creator-only strategy').not.toContain(SECRET_SUMMARY);
    // Withholding is an AUTHZ outcome, not a degradation — `degraded` is
    // caller-neutral by contract (chatContext.ts), so it must stay clean.
    expect(asMember.degraded).not.toContain('board_context');
    // M4 — and the SHORTFALL counter must stay silent for the same reason. This
    // caller's board resolves to ONE fewer ref than the curator's, and saying so
    // would reintroduce ADVB-1's leak in a new form ("someone here can see
    // planning material you cannot"). The count excludes authz drops upstream.
    expect(asMember.degraded, 'an authz-withheld ref must never be reported').not.toContain('board_context_partial');
  });
});

/**
 * M4 (2026-08-20 review) — the PARTIAL resolve.
 *
 * `resolveStrategyEntriesByIds` / `buildProjectContextBlock` DROP a missing or
 * archived ref and return a shorter list; they never throw. So the commonest real
 * degradation — a board referencing four strategies with three archived —
 * resolved to `{ block: <one strategy>, failed: false }`: a silently TRUNCATED
 * grounding served as complete, with no `degraded` entry and no GROUNDING NOTICE.
 * Same family as WF-BOA-4, and likelier in production than the total failure that
 * one covers.
 */
describe('M4 — a partially-resolved board context is reported, not served as complete', () => {
  it('names board_context_partial when a configured ref has been archived', async () => {
    const tenantId = `org:m4-${Date.now()}-${n++}`;
    const c = client();
    const userId = await login(c, tenantId);
    const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
    const orgId = org.body.orgId as string;

    const LIVE_SUMMARY = 'Nightingale — the surviving thesis';
    const live = await c.post('/v1/host/openwop-app/strategy', { orgId, title: 'Live', summary: LIVE_SUMMARY });
    const doomed = await c.post('/v1/host/openwop-app/strategy', { orgId, title: 'Doomed', summary: 'Vanishes' });
    expect(live.status).toBe(201);
    expect(doomed.status).toBe(201);

    const advisor = await c.post('/v1/host/openwop-app/roster', { persona: 'Ada Lovelace', agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
    const board = await c.post(`${A}/boards`, {
      orgId, name: 'Partial', advisors: [advisor.body.rosterId], personaKind: 'historical', visibility: 'shared',
      contextRefs: [{ kind: 'strategy', strategyId: live.body.id }, { kind: 'strategy', strategyId: doomed.body.id }],
    });
    expect(board.status, JSON.stringify(board.body)).toBe(201);
    const opened = await c.post(`${A}/boards/${encodeURIComponent(board.body.boardId)}/chat`);
    const sessionId = opened.body.sessionId as string;

    // Whole, before: both refs resolve, so nothing is reported. Without this arm
    // the assertion below could pass on a composer that always warns.
    const whole = await composeChatContext(tenantId, { conversationId: sessionId, callerUserId: userId, seedText: 'plan?' });
    expect(whole.systemPrompt).toContain(LIVE_SUMMARY);
    expect(whole.degraded, 'a whole board context must not be warned').not.toContain('board_context_partial');

    // Archive is a SOFT delete: the board's contextRef is deliberately NOT
    // mutated (un-archiving restores the context), so the ref outlives its target
    // and the block silently shrinks.
    const { archiveStrategy } = await import('../src/features/strategy/strategyService.js');
    await archiveStrategy(tenantId, doomed.body.id as string, userId);

    const partial = await composeChatContext(tenantId, { conversationId: sessionId, callerUserId: userId, seedText: 'plan?' });
    expect(partial.degraded, 'a truncated grounding must say so').toContain('board_context_partial');
    // …and it is a PARTIAL, not a failure: what survived is still served, and the
    // total-failure ledger entry stays off (they mean different things).
    expect(partial.systemPrompt).toContain(LIVE_SUMMARY);
    expect(partial.degraded).not.toContain('board_context');
    // …and the ledger entry carries a LABEL, so what the exchange folds into the
    // scaffold actually says something (an unlabelled entry is dropped silently by
    // `groundingHonestyNotice` — a ledger value with no label is a no-op).
    const { groundingHonestyNotice } = await import('../src/host/chatContext.js');
    const notice = groundingHonestyNotice(partial.degraded) ?? '';
    expect(notice).toContain('GROUNDING NOTICE');
    expect(notice).toContain('incomplete');
  });
});
