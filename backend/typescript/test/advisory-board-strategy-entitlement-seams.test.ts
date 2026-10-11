/**
 * G7 (ADR 0820 §8.1, gating-audit "agents" + "leadership" rows) — the advisory-board
 * and strategy seams that core chat reaches must honour the plan.
 *
 * Core chat composes a boardroom turn through the board seam (`host/chatContext.ts`:
 * `resolveBoardConveneRefusal` + `resolveBoardContextResult`) and promotes a
 * conversation through `POST /chat/sessions/:id/board` (`resolveBoardCohortForCaller`).
 * None of them read the `advisory-board` toggle or plan, and the context they inject
 * is built by `buildStrategyContextBlock`, which never read `strategy`. So a tenant
 * that had lost either feature kept a boardroom grounded in paid strategy content.
 *
 * The contract: a refused tenant gets a chat WITHOUT the paid context, never an error.
 * Each refusal leg has a positive control (the same tenant, entitled) so it cannot
 * pass for the wrong reason.
 *
 * Sabotage-witnessed (/grade-tests w12): dropping each `boardSeamFeatureOn` /
 * `strategyContextAllowed` gate reds its case, and so does turning a refusal into a THROW
 * (that surfaces as `degraded: board_context` or a convene refusal — an error, not a plain
 * chat). The convene-gate leg uses an UNCONVENABLE board (living, unacknowledged): on a
 * convenable one `conveneRefusal` is null with or without the gate.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { registerTenantEntitlementCheck } from '../src/host/entitlementSeam.js';
import { OpenwopError } from '../src/types.js';
import { composeChatContext } from '../src/host/chatContext.js';
import { getBoard, __putBoardForTest } from '../src/features/advisory-board/service.js';

let BASE: string;
let server: http.Server;
let n = 0;
const SUMMARY = 'Operation Kestrel: the paid-only strategic thesis';

/** featureId → tenants refused it. Empty ⇒ everyone entitled. */
const refused = new Map<string, Set<string>>();
const refuse = (featureId: string, tenantId: string): void => { const s = refused.get(featureId) ?? new Set(); s.add(tenantId); refused.set(featureId, s); };
const clearRefusals = (): void => refused.clear();

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
  registerTenantEntitlementCheck(async (tenantId, featureId) => {
    if (refused.get(featureId)?.has(tenantId)) throw new OpenwopError('forbidden', 'not on plan', 403, {});
  });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: { user?: { userId: string }; orgId?: string; id?: string; rosterId?: string; boardId?: string; sessionId?: string } }
interface Client { post: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out ?? {} };
  };
  return { post: (p, b) => call('POST', p, b) };
}
const A = '/host/openwop-app/advisors';
const CHAT = '/host/openwop-app/chat/sessions';

async function world() {
  clearRefusals();
  const owner = client();
  const tenantId = `org:g7-${Date.now()}-${n++}`;
  const userId = (await owner.post('/host/openwop-app/test/login', { email: `g7-${Date.now()}-${n++}@acme.test`, tenantId })).body.user!.userId;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId!;
  const strategy = await owner.post('/host/openwop-app/strategy', { orgId, scope: 'org', title: 'FY27', summary: SUMMARY });
  expect(strategy.status, JSON.stringify(strategy.body)).toBe(201);
  const advisor = await owner.post('/host/openwop-app/roster', { persona: 'Ada Lovelace', agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
  const board = await owner.post(`${A}/boards`, {
    orgId, name: 'Founders', advisors: [advisor.body.rosterId], personaKind: 'historical', visibility: 'shared',
    contextRefs: [{ kind: 'strategy', strategyId: strategy.body.id }],
  });
  expect(board.status, JSON.stringify(board.body)).toBe(201);
  const opened = await owner.post(`${A}/boards/${encodeURIComponent(board.body.boardId!)}/chat`);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const scratch = await owner.post(CHAT, { title: 'scratch' });
  expect(scratch.status, JSON.stringify(scratch.body)).toBe(201);
  return { owner, tenantId, userId, boardId: board.body.boardId!, sessionId: opened.body.sessionId!, scratchId: scratch.body.sessionId! };
}

const compose = (tenantId: string, conversationId: string, callerUserId: string) =>
  composeChatContext(tenantId, { conversationId, callerUserId, seedText: 'what should we do?' });

describe('G7 — core chat drops the paid board / strategy context when the plan refuses it', () => {
  it('strategy refused: the boardroom turn composes, with no strategy content and no error', async () => {
    const w = await world();
    const entitled = await compose(w.tenantId, w.sessionId, w.userId);
    expect(entitled.systemPrompt, 'control: an entitled turn IS grounded').toContain(SUMMARY);

    refuse('strategy', w.tenantId);
    const out = await compose(w.tenantId, w.sessionId, w.userId);
    expect(out.systemPrompt).not.toContain(SUMMARY);
    expect(out.conveneRefusal).toBeNull();
    expect(out.degraded).not.toContain('board_context');
  });

  it('advisory-board refused: the turn composes as a plain chat — no board context, no convene refusal', async () => {
    const w = await world();
    expect((await compose(w.tenantId, w.sessionId, w.userId)).systemPrompt).toContain(SUMMARY); // control
    refuse('advisory-board', w.tenantId);
    const out = await compose(w.tenantId, w.sessionId, w.userId);
    expect(out.systemPrompt).not.toContain(SUMMARY);
    expect(out.conveneRefusal).toBeNull();
    expect(out.degraded).not.toContain('board_context');

    // The convene gate, made failable: an UNCONVENABLE board (living, no acknowledgement).
    const b = await getBoard(w.tenantId, w.userId, w.boardId);
    await __putBoardForTest({ ...b, personaKind: 'living' });
    clearRefusals();
    expect((await compose(w.tenantId, w.sessionId, w.userId)).conveneRefusal, 'control: entitled ⇒ the likeness gate refuses').not.toBeNull();
    refuse('advisory-board', w.tenantId);
    expect((await compose(w.tenantId, w.sessionId, w.userId)).conveneRefusal, 'refused ⇒ no board at all, so nothing to refuse').toBeNull();
  });

  it('advisory-board refused: core chat cannot PROMOTE a conversation into a boardroom', async () => {
    const w = await world();
    refuse('advisory-board', w.tenantId);
    const refusedAttach = await w.owner.post(`${CHAT}/${encodeURIComponent(w.scratchId)}/board`, { boardId: w.boardId });
    expect(refusedAttach.status, JSON.stringify(refusedAttach.body)).toBe(404);
    clearRefusals();
    const control = await w.owner.post(`${CHAT}/${encodeURIComponent(w.scratchId)}/board`, { boardId: w.boardId });
    expect(control.status, JSON.stringify(control.body)).toBe(200);
  });
});
