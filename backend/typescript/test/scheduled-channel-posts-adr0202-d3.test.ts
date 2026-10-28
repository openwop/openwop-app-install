/**
 * ADR 0202 D3 + D6 — scheduled agent posts, route-level coverage.
 *
 * D3 (channel scope): owner-gated create / member-gated list on
 * `/scheduled-chats/channels/:channelId/chats`, the bound agent MUST be a channel
 * member, and `conversationId` is FORCED to the channelId (a channel schedule can't
 * target a foreign conversation). Composes the EXISTING scheduler — one job per chat.
 *
 * D6 (org create-path hardening): the agent must resolve and the caller must be able
 * to SEE the bound conversation (else 404) — closing the pre-existing "validates
 * nothing" gap on the org path.
 *
 * Every refusal asserts its BODY (the exact error and message), not only the status,
 * so a different, earlier refusal with the same status cannot stand in for it.
 *
 * The D6 org cases bind NON-channel conversations (a private chat session). Since ADR
 * 0879 D7 every channel target is refused 400 `channel_use_channel_schedule` AFTER the
 * visibility check, so a case that bound a channel went red under a sabotaged
 * visibility or agent check only because 400 ≠ 404 — its own check was witnessed by a
 * neighbour's status (round 1: `8fw2g3-scp-idor`, `-scp-agentresolve`). "Nothing was
 * bound" is read from the service (`listScheduledChats`), not the org list route,
 * which filters out schedules the caller cannot see and so could hide a bound one.
 *
 * Sabotage witnessed red (8f grade-tests wave 2): the forced conversationId
 * overridable (`8fw2g3-scp-forced`), the agent-member check removed
 * (`-scp-agentmember`), the create / pause owner gates replaced by the member read
 * (`-scp-creategate`, `-scp-pausegate`), the list gate removed (`-scp-listgate`),
 * the delete scope check removed (`-scp-delscope`), the OQ-3 cleanup unwired
 * (`-scp-oq3`), the org-lane channel refusal removed (`-scp-orgchannel`), the agent
 * resolve removed (`-scp-agentresolve-r2`), the IDOR visibility check removed
 * (`-scp-idor-r2`), and the trim removed (`-scp-trim-r2`).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createMember } from '../src/host/accessControlService.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { getJob } from '../src/host/schedulingService.js';
import { createOrg } from '../src/host/accessControlService.js';
import { listScheduledChats } from '../src/features/scheduled-agent-chats/scheduledChatService.js';

const CH = '/host/openwop-app/channels';
const schedCh = (id: string, suffix = ''): string => `/host/openwop-app/scheduled-chats/channels/${encodeURIComponent(id)}/chats${suffix}`;
const schedOrg = (orgId: string, suffix = ''): string => `/host/openwop-app/scheduled-chats/orgs/${encodeURIComponent(orgId)}/chats${suffix}`;

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const reg = getAgentRegistry();
  reg.register({ agentId: 'sch.a', persona: 'Scheduler Agent A', modelClass: 'general', systemPrompt: 'You post scheduled updates.', packName: 'test.scheduler-agents', packVersion: '1.0.0' });
  reg.register({ agentId: 'sch.b', persona: 'Scheduler Agent B', modelClass: 'general', systemPrompt: 'You post scheduled updates.', packName: 'test.scheduler-agents', packVersion: '1.0.0' });
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: unknown }
/** Narrow response bodies, typed at each call site (no `any`). */
interface ErrorBody { error: string; message: string; details?: { code?: string } }
interface ChatBody { chat: { chatId: string; channelId?: string; orgId?: string; conversationId: string } }
interface ChatsBody { chats: Array<{ chatId: string }> }
const errOf = (r: Res): ErrorBody => r.body as ErrorBody;
const chatOf = (r: Res): ChatBody['chat'] => (r.body as ChatBody).chat;
const chatIds = (r: Res): string[] => (r.body as ChatsBody).chats.map((x) => x.chatId);
const FORBIDDEN = { error: 'forbidden', message: 'Only the channel owner or a workspace admin can manage this channel.' };
const CHANNEL_404 = { error: 'not_found', message: 'Channel not found.' };
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), del: (p: string) => call('DELETE', p) };
}
type Client = ReturnType<typeof client>;

const TENANT = `t-d3-${Date.now()}`;
async function login(name: string): Promise<{ c: Client; userId: string }> {
  const c = client();
  const r = await c.post('/host/openwop-app/test/login', { email: `d3-${name}-${Date.now()}-${n++}@acme.test`, displayName: `${name} P`, tenantId: TENANT });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const userId = (r.body as { user: { userId: string } }).user.userId;
  // ADR 0879 D1 — a co-tenant login gets no member row from the seam (it founds the
  // workspace for the FIRST login only), and channel writes now ask the ROLE. Make
  // every person a real Editor of the workspace, the production shape (idempotent: a
  // founder keeps their owner row).
  await createMember({ orgId: TENANT, tenantId: TENANT, displayName: name, subject: userId, roles: ['editor'] });
  return { c, userId };
}
async function newChannel(c: Client, body: Record<string, unknown>): Promise<string> {
  const r = await c.post(CH, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body as { channel: { conversationId: string } }).channel.conversationId;
}
/** A private chat session owned by `c` (a NON-channel conversation). */
async function newSession(c: Client, title: string): Promise<string> {
  const r = await c.post('/host/openwop-app/chat/sessions', { title });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body as { sessionId: string }).sessionId;
}

const CRON = '0 9 * * *';

/** Poll until `pred` holds or the timeout elapses (for async event-bus propagation). */
async function waitFor(pred: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('ADR 0202 D3 — channel-scoped scheduled posts', () => {
  it('owner schedules a recurring post for a channel-member agent; conversationId is forced to the channel; one job binds', async () => {
    const { c } = await login('owner');
    const id = await newChannel(c, { name: `d3-${n}`, visibility: 'public', agentIds: ['sch.a'] });

    // A body conversationId is IGNORED — the schedule always posts in-channel.
    const created = await c.post(schedCh(id), { agentId: 'sch.a', prompt: 'daily standup', cronExpr: CRON, conversationId: 'attacker-controlled' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const chat = chatOf(created);
    expect(chat.channelId).toBe(id);
    expect(chat.orgId).toBeUndefined();
    expect(chat.conversationId).toBe(id); // forced, not the body value
    expect(await getJob(`schedchat-${chat.chatId}`)).not.toBeNull();

    const list = await c.get(schedCh(id));
    expect(list.status).toBe(200);
    expect(chatIds(list)).toEqual([chat.chatId]);
  });

  it('rejects scheduling an agent that is NOT a channel member (M3)', async () => {
    const { c } = await login('owner');
    const id = await newChannel(c, { name: `d3m-${n}`, visibility: 'public', agentIds: ['sch.a'] });
    const r = await c.post(schedCh(id), { agentId: 'sch.b', prompt: 'x', cronExpr: CRON }); // sch.b not added
    expect(r.status).toBe(400);
    expect(errOf(r)).toMatchObject({ error: 'validation_error', message: 'Agent "sch.b" is not a member of this channel.' });
  });

  it('create is owner-gated; list is member-gated; a non-member learns nothing (404)', async () => {
    const { c: owner } = await login('owner');
    const { c: member, userId: memberId } = await login('member');
    const { c: stranger } = await login('stranger');
    const id = await newChannel(owner, { name: `d3g-${n}`, visibility: 'private', agentIds: ['sch.a'] });
    await owner.post(`${CH}/${id}/members`, { userId: memberId });

    // Non-owner member: may list, may NOT create.
    const memberCreate = await member.post(schedCh(id), { agentId: 'sch.a', prompt: 'p', cronExpr: CRON });
    expect(memberCreate.status).toBe(403);
    expect(errOf(memberCreate)).toMatchObject(FORBIDDEN);
    const memberList = await member.get(schedCh(id));
    expect(memberList.status).toBe(200);
    expect(chatIds(memberList)).toEqual([]); // nothing was created by the refused post

    // Non-member of a private channel: 404-masked on both.
    const strangerList = await stranger.get(schedCh(id));
    expect(strangerList.status).toBe(404);
    expect(errOf(strangerList)).toMatchObject(CHANNEL_404);
    const strangerCreate = await stranger.post(schedCh(id), { agentId: 'sch.a', prompt: 'p', cronExpr: CRON });
    expect(strangerCreate.status).toBe(404);
    expect(errOf(strangerCreate)).toMatchObject(CHANNEL_404);
  });

  it('owner can pause then delete a channel schedule; a non-owner cannot pause; the job deregisters', async () => {
    const { c: owner } = await login('owner');
    const { c: member, userId: memberId } = await login('member');
    const id = await newChannel(owner, { name: `d3d-${n}`, visibility: 'private', agentIds: ['sch.a'] });
    await owner.post(`${CH}/${id}/members`, { userId: memberId });
    const chatId = chatOf(await owner.post(schedCh(id), { agentId: 'sch.a', prompt: 'p', cronExpr: CRON })).chatId;

    // Pause is owner-gated: a member cannot (and the job stays enabled); the owner can.
    const memberPause = await member.post(schedCh(id, `/${chatId}/pause`), { enabled: false });
    expect(memberPause.status).toBe(403);
    expect(errOf(memberPause)).toMatchObject(FORBIDDEN);
    expect((await getJob(`schedchat-${chatId}`))!.enabled).toBe(true);
    expect((await owner.post(schedCh(id, `/${chatId}/pause`), { enabled: false })).status).toBe(200);
    expect((await getJob(`schedchat-${chatId}`))!.enabled).toBe(false);

    expect((await owner.del(schedCh(id, `/${chatId}`))).status).toBe(204);
    expect(await getJob(`schedchat-${chatId}`)).toBeNull();
    expect(chatIds(await owner.get(schedCh(id)))).not.toContain(chatId);
  });

  it('ADR 0202 OQ-3 — removing the agent from the channel auto-cleans its scheduled posts (event-wired)', async () => {
    const { c } = await login('owner');
    const id = await newChannel(c, { name: `oq3-${n}`, visibility: 'public', agentIds: ['sch.a'] });
    const chatId = chatOf(await c.post(schedCh(id), { agentId: 'sch.a', prompt: 'daily', cronExpr: CRON })).chatId;
    expect(await getJob(`schedchat-${chatId}`)).not.toBeNull();

    // Remove the agent — the participant-removed event fans out to scheduled-agent-chats.
    expect((await c.del(`${CH}/${id}/agents/sch.a`)).status).toBe(200);
    await waitFor(async () => (await getJob(`schedchat-${chatId}`)) === null);

    expect(await getJob(`schedchat-${chatId}`)).toBeNull();
    expect(chatIds(await c.get(schedCh(id)))).not.toContain(chatId);
  });

  it('a channel schedule is isolated by scope — another channel owner cannot delete it via their own channel route', async () => {
    const { c } = await login('owner');
    const a = await newChannel(c, { name: `d3iA-${n}`, visibility: 'public', agentIds: ['sch.a'] });
    const b = await newChannel(c, { name: `d3iB-${n}`, visibility: 'public', agentIds: ['sch.a'] });
    const chatId = chatOf(await c.post(schedCh(a), { agentId: 'sch.a', prompt: 'p', cronExpr: CRON })).chatId;
    // Same owner, but addressing channel B's route with A's chatId → keyed miss → 404.
    const wrongScope = await c.del(schedCh(b, `/${chatId}`));
    expect(wrongScope.status).toBe(404);
    expect(errOf(wrongScope)).toMatchObject({ error: 'not_found', message: 'Scheduled chat not found.' });
    expect(await getJob(`schedchat-${chatId}`)).not.toBeNull(); // untouched
  });
});

describe('ADR 0202 D6 — org create-path hardening', () => {
  async function orgOwner(): Promise<{ c: Client; orgId: string }> {
    const { c, userId } = await login('orgowner');
    // ADR 0815 D1a — creating an org inside a multi-member tenant is owner-tier
    // over HTTP; this suite is about the schedule door, so the caller's org is
    // minted directly with them as its owner (the shape `POST /orgs` produces).
    const orgId = (await createOrg({ tenantId: TENANT, createdBy: userId, name: 'Ops', ownerSubject: userId })).orgId;
    return { c, orgId };
  }

  it('binds a schedule when the agent resolves and the caller can see the conversation', async () => {
    const { c, orgId } = await orgOwner();
    const conv = await newSession(c, `d6ok-${n}`);
    const r = await c.post(schedOrg(orgId), { agentId: 'sch.a', prompt: 'digest', conversationId: conv, cronExpr: CRON });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(chatOf(r)).toMatchObject({ orgId, conversationId: conv });
  });

  // ADR 0879 D7 (architect C3) — the org lane checks only that the caller can SEE the
  // conversation, and any member sees a public channel; channel posts go through the
  // channel's own owner-gated schedule lane.
  it('refuses an org schedule that targets a channel', async () => {
    const { c, orgId } = await orgOwner();
    const conv = await newChannel(c, { name: `d6ch-${n}`, visibility: 'public', agentIds: ['sch.a'] });
    const r = await c.post(schedOrg(orgId), { agentId: 'sch.a', prompt: 'digest', conversationId: conv, cronExpr: CRON });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(errOf(r)).toMatchObject({ error: 'validation_error', message: 'Schedule channel posts from the channel itself.', details: { code: 'channel_use_channel_schedule' } });
  });

  it('rejects an agent that does not resolve (404)', async () => {
    const { c, orgId } = await orgOwner();
    // The caller's OWN session: visible and not a channel, so only the agent check can refuse.
    const conv = await newSession(c, `d6a-${n}`);
    const r = await c.post(schedOrg(orgId), { agentId: 'ghost-agent', prompt: 'x', conversationId: conv, cronExpr: CRON });
    expect(r.status).toBe(404);
    expect(errOf(r)).toMatchObject({ error: 'not_found', message: 'Agent "ghost-agent" not found.' });
  });

  it('rejects binding a private conversation the caller cannot see (IDOR — 404-masked)', async () => {
    const { c, orgId } = await orgOwner();
    // A DIFFERENT user's private chat session (not a channel, so the D7 channel refusal
    // cannot answer for the visibility check).
    const { c: other } = await login('convowner');
    const foreign = await newSession(other, `d6idor-${n}`);
    const r = await c.post(schedOrg(orgId), { agentId: 'sch.a', prompt: 'x', conversationId: foreign, cronExpr: CRON });
    expect(r.status).toBe(404);
    expect(errOf(r)).toMatchObject({ error: 'not_found', message: 'Conversation not found.' });
    expect(await listScheduledChats(TENANT, { orgId })).toEqual([]); // nothing was bound
  });

  it('the IDOR check is not bypassable with a whitespace-padded conversationId (check == store)', async () => {
    const { c, orgId } = await orgOwner();
    const { c: other } = await login('convowner2');
    const foreign = await newSession(other, `d6pad-${n}`);
    // Padding once slipped past the exact-match access check while the service trimmed
    // and stored the real foreign id (architect H1). Must be rejected the same as exact.
    const r = await c.post(schedOrg(orgId), { agentId: 'sch.a', prompt: 'x', conversationId: `  ${foreign}`, cronExpr: CRON });
    expect(r.status).toBe(404);
    expect(errOf(r)).toMatchObject({ error: 'not_found', message: 'Conversation not found.' });
    expect(await listScheduledChats(TENANT, { orgId })).toEqual([]); // nothing was bound
  });
});
