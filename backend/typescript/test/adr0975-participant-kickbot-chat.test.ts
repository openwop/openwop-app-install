/**
 * ADR 0975 D11 — a KickTodo participant (an auto-join `viewer` in `host-kicktodo`)
 * can open and continue a KickBot chat with authorization ENFORCED, and nothing
 * wider.
 *
 * MEASURED on kicktodo.com (2026-10-31 13:25:23Z, rev 00065-dmc): a participant's
 * first chat message got `forbidden: Missing required scope: runs:create`
 * (`POST /api/runs` 403, `authorization.denied scope=runs:create`). Enforcement has
 * been on since 2026-10-26, and D8 opened only the operator's Challenge Author chat.
 *
 * Everything here runs the REAL stack: cookie sessions, the real scope check with
 * real viewer memberships in the real declared default workspace (createApp
 * provisions `host-kicktodo`), the real KickBot provisioning, and a real
 * conversation turn through KickBot's tool loop. The ONE stand-in is the managed
 * free tier's network round (`dispatchManagedToolsRound`): it asks for KickBot's
 * `openwop:kicktodo.today` tool once and then answers, so the turn runs a real
 * tool call as the participant.
 *
 * Pins (headline first): a viewer opens a KickBot conversation (201, stamped, no
 * challenge) and a turn to KickBot is answered by KickBot; an unscoped chat or
 * another agent is still 403 + insufficient_scope; a non-member is refused; a
 * member removed mid-conversation has their next turn refused; a `bypass` turn is
 * refused; someone else's KickBot conversation is refused; a narrowed API key is
 * not widened; the Challenge Author grant is not reachable through this one.
 *
 * Red when (sabotage-witnessed in the PR): the KickBot registration in
 * `registerKicktodoCoreRoutes` is removed; the agent check in either predicate is
 * removed; the root-membership check in the turn predicate is removed; the bypass
 * check is removed; the owner check is removed; the named registry keeps only one
 * grant per workflow (the Challenge Author grant then shadows this one); the
 * conversation gate dispatches an opening turn taken from the START inputs.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type Round = { tools?: Array<{ name: string }>; messages: Array<{ role: string; content: unknown }> };
const model = vi.hoisted(() => ({ rounds: [] as Round[] }));
vi.mock('../src/providers/managedProvider.js', async (orig) => ({
  ...(await orig<typeof import('../src/providers/managedProvider.js')>()),
  dispatchManagedToolsRound: async (req: Round) => {
    model.rounds.push(req);
    const today = (req.tools ?? []).find((t) => /kicktodo.*today/.test(t.name));
    // The loop feeds a tool's result back as a `Result of <tool>:` message.
    const last = req.messages[req.messages.length - 1];
    const askedAlready = typeof last?.content === 'string' && last.content.startsWith('Result of ');
    if (today && !askedAlready) return { text: '', toolUses: [{ id: 'call-1', name: today.name, input: {} }] };
    return { text: 'Start with one tiny habit today.', toolUses: [] };
  },
}));
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createWorkspace, deleteMember, listMembers, isDeclaredDefaultWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { ensureKickBot, KICKBOT_AGENT_ID } from '../src/features/kicktodo-core/kickbotService.js';
import { KICKBOT_CHAT_GRANT, kickbotChatStartGrant, kickbotChatTurnGrant } from '../src/features/kicktodo-core/kickbotChatGrant.js';
import { CHALLENGE_AUTHOR_AGENT_ID } from '../src/features/kicktodo-creator/challengeAuthorService.js';
import { RUN_START_GRANT_METADATA_KEY } from '../src/host/runStartGrant.js';
import { CONVERSATION_WORKFLOW_ID } from '../src/host/conversation.js';
import type { Storage } from '../src/storage/storage.js';

const WS = 'host-kicktodo';
const TOGGLES = ['users', 'kicktodo-core'];
const OTHER_AGENT = 'vendor.openwop-app.example.agents.someone-else';

let BASE = '';
let server: http.Server;
let storage: Storage;
const saved: Record<string, string | undefined> = {};
interface Seat { cookie: string; userId: string; memberId: string }
let alice: Seat;
let bob: Seat;

const cookieFor = (userId: string): string => {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: WS, tier: 'user', userId, personalTenant: `user:${randomBytes(16).toString('hex')}`, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
};
const seatViewer = async (principalId: string): Promise<Seat> => {
  const user = await upsertFromPrincipal({ tenantId: WS, principalId, source: 'oidc' });
  // Binding a principal may already auto-join it (ADR 0684); seat it either way.
  const m = (await listMembers(WS, WS)).find((x) => x.subject === user.userId)
    ?? await createMember({ tenantId: WS, orgId: WS, subject: user.userId, displayName: principalId, roles: ['viewer'] });
  return { cookie: cookieFor(user.userId), userId: user.userId, memberId: m.memberId };
};
const json = { 'content-type': 'application/json' };
const startChat = (cookie: string, metadata: Record<string, unknown>): Promise<Response> =>
  fetch(`${BASE}/runs`, { method: 'POST', headers: { cookie, ...json }, body: JSON.stringify({ workflowId: CONVERSATION_WORKFLOW_ID, inputs: { provider: 'mock', model: 'mock-1' }, metadata }) });
const bareRunId = (runId: string): string => (runId.includes('/') ? runId.slice(runId.indexOf('/') + 1) : runId);
const openKickbotChat = async (seat: Seat): Promise<string> => {
  const res = await startChat(seat.cookie, { chatSessionId: `s-${randomBytes(4).toString('hex')}`, agentScope: KICKBOT_AGENT_ID });
  expect(res.status).toBe(201);
  const runId = bareRunId(((await res.json()) as { runId: string }).runId);
  await vi.waitFor(async () => { expect((await storage.getRun(runId))?.status).toBe('waiting-input'); }, { timeout: 5000, interval: 20 });
  return runId;
};
const turn = (cookie: string, runId: string, resumeValue: unknown): Promise<Response> =>
  fetch(`${BASE}/runs/${encodeURIComponent(`${WS}/${runId}`)}/interrupts/gate`, { method: 'POST', headers: { cookie, ...json }, body: JSON.stringify({ resumeValue }) });
// `permissionMode` rides the resume body, beside `turn` (`parseResolveBody`).
const toKickbot = (content: string, extra: Record<string, unknown> = {}): unknown => ({ operation: 'exchange', turn: { content, to: KICKBOT_AGENT_ID }, ...extra });

beforeAll(async () => {
  for (const k of ['OPENWOP_AUTHORIZATION_ENFORCEMENT', 'OPENWOP_SESSION_SECRET', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_TEST_SEAM_ENABLED']) saved[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true'; // the keyless `mock` provider
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0975-d11', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of TOGGLES) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  await ensureKickBot(WS);
  alice = await seatViewer('oidc:d11-alice');
  bob = await seatViewer('oidc:d11-bob');
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const id of TOGGLES) {
    const d = getToggleDefault(id);
    if (d) await saveConfig(d, 'test');
  }
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('ADR 0975 D11 — a participant chats with KickBot (enforcement on, real stack)', () => {
  it('precondition: the workspace is KickTodo\'s declared default, and a viewer there holds no runs:create', async () => {
    expect(isDeclaredDefaultWorkspace(WS)).toBe(true);
    const res = await startChat(alice.cookie, { chatSessionId: 's-pre' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message?: string }).message ?? '').toMatch(/runs:create/);
  });

  it('HEADLINE: a viewer opens a KickBot conversation (201, stamped, no challenge) and KickBot answers their turn', async () => {
    const res = await startChat(alice.cookie, { chatSessionId: 's-headline', agentScope: KICKBOT_AGENT_ID });
    expect(res.status).toBe(201);
    expect(res.headers.get('www-authenticate')).toBeNull();
    const runId = bareRunId(((await res.json()) as { runId: string }).runId);
    expect((await storage.getRun(runId))?.metadata?.[RUN_START_GRANT_METADATA_KEY]).toEqual({ grant: KICKBOT_CHAT_GRANT, agentId: KICKBOT_AGENT_ID });
    await vi.waitFor(async () => { expect((await storage.getRun(runId))?.status).toBe('waiting-input'); }, { timeout: 5000, interval: 20 });

    const ex = await turn(alice.cookie, runId, toKickbot('What habits can I learn?'));
    expect(ex.status).toBe(200);
    expect(ex.headers.get('www-authenticate')).toBeNull();
    const events = await storage.listEvents(runId);
    const agentTurns = events.filter((e) => e.type === 'conversation.exchanged' && (e.payload as { turn?: { role?: string } }).turn?.role === 'agent');
    expect(agentTurns).toHaveLength(1);
    const turnPayload = (agentTurns[0]!.payload as { turn: { content?: string } }).turn;
    expect(turnPayload.content).toContain('Start with one tiny habit today.');
    // KickBot's read tool ran AS the participant and returned their data (not a refusal).
    const returned = events.filter((e) => e.type === 'agent.toolReturned').map((e) => e.payload as { toolName?: string; status?: string });
    expect(returned).toEqual([expect.objectContaining({ toolName: 'openwop:kicktodo.today', status: 'ok' })]);
    expect((agentTurns[0]!.payload as { turn: { agent?: { agentId?: string } } }).turn.agent?.agentId).toBe(KICKBOT_AGENT_ID);
    // …and the participant can keep going, and can close it.
    expect((await turn(alice.cookie, runId, toKickbot('And tomorrow?'))).status).toBe(200);
    expect((await turn(alice.cookie, runId, { operation: 'close' })).status).toBe(200);
  });

  it('the START cannot address anyone: an opening message in the inputs naming another agent reaches no agent; every message is a gated turn', async () => {
    // The conversation workflow is one fixed `core.conversationGate` node
    // (`host/index.ts`): opening emits a fixed system turn and suspends. It reads
    // no turn from the inputs, and `agentScope` pins no dispatch target. So the
    // first message the participant sends is an exchange, which the turn grant
    // checks (addressed to KickBot, never bypass).
    const before = model.rounds.length;
    const res = await fetch(`${BASE}/runs`, {
      method: 'POST', headers: { cookie: alice.cookie, ...json },
      body: JSON.stringify({
        workflowId: CONVERSATION_WORKFLOW_ID,
        inputs: { provider: 'mock', model: 'mock-1', turn: { content: 'hi', to: OTHER_AGENT }, message: 'hi', to: OTHER_AGENT, agentId: OTHER_AGENT },
        metadata: { chatSessionId: 's-open', agentScope: KICKBOT_AGENT_ID },
      }),
    });
    expect(res.status).toBe(201);
    const runId = bareRunId(((await res.json()) as { runId: string }).runId);
    await vi.waitFor(async () => { expect((await storage.getRun(runId))?.status).toBe('waiting-input'); }, { timeout: 5000, interval: 20 });
    const types = (await storage.listEvents(runId)).map((e) => e.type);
    expect(types).toContain('conversation.opened');
    expect(types.filter((t) => t === 'conversation.exchanged' || t.startsWith('agent.'))).toEqual([]);
    expect(model.rounds.length).toBe(before);
    // …and the first real message to that agent is refused at the gate.
    expect((await turn(alice.cookie, runId, { operation: 'exchange', turn: { content: 'hi', to: OTHER_AGENT } })).status).toBe(403);
  });

  it('an unscoped chat, another agent, or the Challenge Author is still runs:create (403 + insufficient_scope)', async () => {
    for (const metadata of [{ chatSessionId: 's-none' }, { agentScope: OTHER_AGENT }, { agentScope: CHALLENGE_AUTHOR_AGENT_ID }]) {
      const res = await startChat(alice.cookie, metadata);
      expect(res.status).toBe(403);
      expect(res.headers.get('www-authenticate') ?? '').toMatch(/insufficient_scope/);
    }
  });

  it('only in KickTodo\'s participant workspace: a viewer of another shared workspace is refused the same KickBot chat', async () => {
    const other = (await createWorkspace({ name: 'Elsewhere D11', ownerSubject: 'oidc:d11-elsewhere-owner' })).tenantId;
    await createMember({ tenantId: other, orgId: other, subject: alice.userId, displayName: 'alice', roles: ['viewer'] });
    const now = Math.floor(Date.now() / 1000);
    const cookie = `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: other, tier: 'user', userId: alice.userId, personalTenant: `user:${randomBytes(16).toString('hex')}`, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
    const res = await startChat(cookie, { agentScope: KICKBOT_AGENT_ID });
    expect(res.status).toBe(403);
  });

  it('a non-member gains nothing: their chat lands in their own workspace, unstamped, and the grant refuses them in this one', async () => {
    const outsider = await seatViewer('oidc:d11-outsider');
    expect(await deleteMember(outsider.memberId)).toBe(true);
    const r = await startChat(outsider.cookie, { agentScope: KICKBOT_AGENT_ID });
    const run = await storage.getRun(bareRunId(((await r.json()) as { runId: string }).runId));
    expect(run?.tenantId).not.toBe(WS);
    expect(run?.metadata?.[RUN_START_GRANT_METADATA_KEY]).toBeUndefined();
    const asOutsider = { tenantId: WS, userId: outsider.userId, principal: { principalId: outsider.userId, tenants: [WS] }, headers: {}, header: () => undefined } as unknown as Request;
    await expect(kickbotChatStartGrant(asOutsider, { tenantId: WS, workflowId: CONVERSATION_WORKFLOW_ID, metadata: { agentScope: KICKBOT_AGENT_ID } })).resolves.toBeNull();
    const asAlice = { ...asOutsider, userId: alice.userId, principal: { principalId: alice.userId, tenants: [WS] } } as unknown as Request;
    await expect(kickbotChatStartGrant(asAlice, { tenantId: WS, workflowId: CONVERSATION_WORKFLOW_ID, metadata: { agentScope: KICKBOT_AGENT_ID } })).resolves.toEqual({ grant: KICKBOT_CHAT_GRANT, agentId: KICKBOT_AGENT_ID });
  });

  it('in the conversation: a turn to another agent, a bypass turn, and someone else\'s run are refused', async () => {
    const runId = await openKickbotChat(alice);
    expect((await turn(alice.cookie, runId, { operation: 'exchange', turn: { content: 'hi', to: OTHER_AGENT } })).status).toBe(403);
    expect((await turn(alice.cookie, runId, { operation: 'exchange', turn: { content: 'hi' } })).status).toBe(403);
    expect((await turn(alice.cookie, runId, toKickbot('do it without asking', { permissionMode: 'bypass' }))).status).toBe(403);
    expect((await turn(bob.cookie, runId, toKickbot('let me in'))).status).toBe(403);
    expect((await turn(alice.cookie, runId, toKickbot('still mine'))).status).toBe(200);
  });

  it('a member removed mid-conversation has their next turn refused', async () => {
    const carol = await seatViewer('oidc:d11-carol');
    const runId = await openKickbotChat(carol);
    expect((await turn(carol.cookie, runId, toKickbot('first'))).status).toBe(200);
    const asCarol = { tenantId: WS, userId: carol.userId, principal: { principalId: carol.userId, tenants: [WS] }, headers: {}, header: () => undefined, body: { resumeValue: toKickbot('second') } } as unknown as Request;
    const run = (await storage.getRun(runId))!;
    await expect(kickbotChatTurnGrant(asCarol, run)).resolves.toBe(true);
    expect(await deleteMember(carol.memberId)).toBe(true);
    // Over HTTP the run load (`runs:read`) already refuses a removed member, so the
    // grant's own membership check is pinned directly: it must not admit them either.
    expect((await turn(carol.cookie, runId, toKickbot('second'))).status).toBe(403);
    await expect(kickbotChatTurnGrant(asCarol, run)).resolves.toBe(false);
  });

  it('a narrowed API key is never widened, even for KickBot in the participant workspace', async () => {
    const mint = await fetch(`${BASE}/host/openwop-app/developer-keys`, { method: 'POST', headers: { cookie: alice.cookie, ...json }, body: JSON.stringify({ name: 'd11-read', scopes: ['runs:read'] }) });
    expect(mint.status).toBe(201); // a viewer may mint a key that narrows their own access
    const { token } = (await mint.json()) as { token: string };
    const res = await fetch(`${BASE}/runs`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-openwop-tenant': WS, ...json }, body: JSON.stringify({ workflowId: CONVERSATION_WORKFLOW_ID, inputs: { provider: 'mock', model: 'mock-1' }, metadata: { agentScope: KICKBOT_AGENT_ID } }) });
    expect(res.status).toBe(403);
  });
});
