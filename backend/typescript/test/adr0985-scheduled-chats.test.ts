/**
 * ADR 0985 — scheduled agent chats: the fire gate and one honest list (feature loop
 * round 2, row 58).
 *
 * Every probe was written RED against `origin/main` @ `95aaef11e` before the fix.
 * Each refusal is paired with the accept that proves the door is not simply shut.
 *
 *   D1  the target is asked BEFORE the model is paid. A schedule whose conversation
 *       its person can no longer post to (deleted, not visible, an archived
 *       channel) started a run and paid a managed-key model call on every fire,
 *       then failed `conversation_write_refused` and stayed armed forever.
 *   D2  the cadence floor holds on the USE lane. "At most hourly" was checked only
 *       by the chat tool at create; the org create route took `*\/5 * * * *`, and a
 *       generic scheduler PATCH re-cadenced a tool job below the floor.
 *   D3  the feature owns its `schedchat-` jobs. The generic scheduler route
 *       re-enabled and re-cadenced them, so the page said "Paused" while the job fired.
 *   D4  the list reads the job, not a copy of it: `enabled`, a missing job and the
 *       last skip come from the scheduler row.
 *   D5  pause/resume says which, and an erased creator's schedule is not resumed.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import type { Storage } from '../src/storage/storage.js';
import { deleteJob, eraseSubjectSchedules, getJob, registerJob, setJobEnabled, updateJob } from '../src/host/schedulingService.js';
import { fireJob, processDueSchedules } from '../src/host/scheduleDaemon.js';
import { ensureConversationMeta } from '../src/host/conversationStore.js';
import {
  createScheduledChat, eraseScheduledChatsSubject, listScheduledChatsWithStatus, setScheduledChatEnabled, SCHEDULED_AGENT_CHATS_TOGGLE,
} from '../src/features/scheduled-agent-chats/scheduledChatService.js';
import { SCHEDULE_FOLLOWUP_TOOL_ID, SCHEDULE_RECURRING_TOOL_ID } from '../src/features/scheduled-agent-chats/agentTools.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { SCHEDULED_CHAT_TURN_WORKFLOW_ID } from '../src/features/scheduled-agent-chats/scheduledChatTurnWorkflow.js';

let BASE: string; let server: http.Server; let storage: Storage; let deps: StartRunDeps;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  getAgentRegistry().register({ agentId: 's985.agent', persona: 'Digest Agent', modelClass: 'general', systemPrompt: 'Post the digest.', packName: 'test.s985', packVersion: '0.0.1' });
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  deps = { storage, hostSuite: app.locals.hostSuite as HostAdapterSuite };
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface ResBody { user?: { userId: string }; chat?: { enabled?: boolean }; schedules?: Array<{ jobId: string; kind: string; prompt: string; enabled: boolean; spent?: boolean; lastSkip?: { reason: string } }>; schedule?: { enabled: boolean }; error?: string; message?: string; code?: string; details?: Record<string, unknown> }
interface Res { status: number; body: ResBody }
function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as ResBody) };
  };
}
type Client = ReturnType<typeof client>;
let n = 0;
/** Founds a fresh tenant: the first login owns it (orgId === tenantId on this host). */
async function owner(): Promise<{ c: Client; userId: string; tenant: string }> {
  const c = client();
  const tenant = `org:s985-${Date.now()}-${n++}`;
  const r = await c('POST', '/host/openwop-app/test/login', { email: `owner-${n++}@s985.test`, tenantId: tenant });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { c, userId: r.body.user!.userId, tenant };
}
/** A second person in `tenant`, as a real member with `role`. */
async function member(own: Client, tenant: string, role: 'editor' | 'viewer'): Promise<{ c: Client; userId: string }> {
  const c = client();
  const r = await c('POST', '/host/openwop-app/test/login', { email: `${role}-${n++}@s985.test`, tenantId: tenant });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const userId = r.body.user!.userId;
  const add = await own('POST', `/host/openwop-app/orgs/${encodeURIComponent(tenant)}/members`, { displayName: role, subject: userId, roles: [role] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { c, userId };
}
/** A conversation that exists in `tenant`, owned by `ownerUserId`. */
async function conversation(tenant: string, ownerUserId: string): Promise<string> {
  const id = `conv-s985-${n++}`;
  const now = new Date().toISOString();
  await storage.createChatSession({ sessionId: id, tenantId: tenant, title: 'Digest', createdAt: now, updatedAt: now, messageCount: 0 });
  await ensureConversationMeta(tenant, id, { type: 'agent', ownerUserId });
  return id;
}
/** A public channel in `tenant` owned by `ownerUserId` with `agent:<agentId>` as a member. */
async function channel(tenant: string, ownerUserId: string, agentId: string): Promise<string> {
  const id = `chan-s985-${n++}`;
  const now = new Date().toISOString();
  await storage.createChatSession({ sessionId: id, tenantId: tenant, title: 'Team', createdAt: now, updatedAt: now, messageCount: 0 });
  await ensureConversationMeta(tenant, id, { type: 'channel', ownerUserId, participants: [`agent:${agentId}`], channel: { name: `team-${n}`, visibility: 'public' } });
  return id;
}
/** A chat-tool style job (`recurring:`), stamped the way the tool stamps it. */
async function toolJob(tenant: string, userId: string, conversationId: string, over: { cronExpr?: string; personalTenant?: string } = {}): Promise<string> {
  const jobId = `recurring:s985-${n++}`;
  const reg = await registerJob({
    jobId, tenantId: tenant, cronExpr: over.cronExpr ?? '0 9 * * *', timezone: 'UTC', workflowId: SCHEDULED_CHAT_TURN_WORKFLOW_ID,
    featureId: SCHEDULED_AGENT_CHATS_TOGGLE, ownerSubject: { kind: 'user', id: userId }, agentId: 'iris', enabled: true,
    metadata: { tool: SCHEDULE_RECURRING_TOOL_ID, actingUserId: userId, ...(over.personalTenant ? { personalTenant: over.personalTenant } : {}) },
    configurable: { agentId: 'iris', task: 't', conversationId, credentialRef: 'managed:openwop-free' },
  });
  expect(reg.ok).toBe(true);
  return jobId;
}
const fire = async (jobId: string) => fireJob(deps, (await getJob(jobId))!, { trigger: 'manual', applyBudget: false });
const firedRuns = async (jobId: string): Promise<number> => (await storage.listRuns({ limit: 500 })).filter((r) => {
  const s: unknown = r.metadata['schedule'];
  return typeof s === 'object' && s !== null && 'jobId' in s && s.jobId === jobId;
}).length;
const ORG = (tenant: string, suffix = ''): string => `/host/openwop-app/scheduled-chats/orgs/${encodeURIComponent(tenant)}/chats${suffix}`;
const JOB = (jobId: string): string => `/host/openwop-app/scheduler/jobs/${encodeURIComponent(jobId)}`;

describe('D1 — the target is asked before the model is paid', () => {
  it('a schedule whose conversation no longer exists is skipped, starts no run, and says why', async () => {
    const o = await owner();
    const chat = await createScheduledChat(o.tenant, { orgId: o.tenant }, o.userId, { agentId: 'iris', prompt: 'digest', conversationId: 'conv-gone', cronExpr: '0 9 * * *' });
    const jobId = `schedchat-${chat.chatId}`;
    const outcome = await fireJob(deps, (await getJob(jobId))!, { trigger: 'manual', applyBudget: false });
    expect(outcome).toEqual({ skipped: 'target-refused' });
    expect(await firedRuns(jobId)).toBe(0);
    const [listed] = await listScheduledChatsWithStatus(o.tenant, { orgId: o.tenant });
    expect(listed!.lastSkip?.reason).toBe('target-refused');
  });

  it('a conversation its person can no longer see is refused; their own conversation fires', async () => {
    const o = await owner();
    const foreign = await conversation(o.tenant, 'someone-else');
    const refused = await createScheduledChat(o.tenant, { orgId: o.tenant }, o.userId, { agentId: 'iris', prompt: 'p', conversationId: foreign, cronExpr: '0 9 * * *' });
    expect(await fireJob(deps, (await getJob(`schedchat-${refused.chatId}`))!, { trigger: 'manual', applyBudget: false })).toEqual({ skipped: 'target-refused' });
    // Positive control: the same schedule into the creator's own conversation is not refused by the gate.
    const mine = await conversation(o.tenant, o.userId);
    const ok = await createScheduledChat(o.tenant, { orgId: o.tenant }, o.userId, { agentId: 'iris', prompt: 'p', conversationId: mine, cronExpr: '0 9 * * *' });
    const outcome = await fireJob(deps, (await getJob(`schedchat-${ok.chatId}`))!, { trigger: 'manual', applyBudget: false });
    expect(outcome).toHaveProperty('runId');
  });
});

describe('D1 — positive controls (architect H4): the gate does not refuse what should fire', () => {
  it('a chat-tool job carrying only `actingUserId` fires into its owner\'s conversation', async () => {
    const o = await owner();
    const jobId = await toolJob(o.tenant, o.userId, await conversation(o.tenant, o.userId));
    expect(await fire(jobId)).toHaveProperty('runId');
  });

  it('a channel schedule fires when its agent is a member and its poster may post', async () => {
    const o = await owner();
    const ch = await channel(o.tenant, o.userId, 'iris');
    const chat = await createScheduledChat(o.tenant, { channelId: ch }, o.userId, { agentId: 'iris', prompt: 'standup', conversationId: ch, cronExpr: '0 9 * * 1-5' });
    expect(await fire(`schedchat-${chat.chatId}`)).toHaveProperty('runId');
    // ...and is refused when the agent is not a member of that channel.
    const other = await createScheduledChat(o.tenant, { channelId: ch }, o.userId, { agentId: 'atlas', prompt: 'p', conversationId: ch, cronExpr: '0 9 * * 1-5' });
    expect(await fire(`schedchat-${other.chatId}`)).toEqual({ skipped: 'target-refused' });
  });

  it('a schedule in a personal workspace fires (the implicit-owner shortcut)', async () => {
    const personal = `user:s985p${n++}`;
    const conv = await conversation(personal, personal);
    const jobId = await toolJob(personal, personal, conv, { personalTenant: personal });
    expect(await fire(jobId)).toHaveProperty('runId');
  });
});

describe('D1 — the person behind the job (architect H2)', () => {
  it('a job whose person is now a Viewer is skipped; an Editor\'s fires (grade-code SC2CD-5)', async () => {
    const o = await owner();
    const viewer = await member(o.c, o.tenant, 'viewer');
    const editor = await member(o.c, o.tenant, 'editor');
    expect(await fire(await toolJob(o.tenant, viewer.userId, await conversation(o.tenant, viewer.userId)))).toEqual({ skipped: 'target-refused' });
    expect(await fire(await toolJob(o.tenant, editor.userId, await conversation(o.tenant, editor.userId)))).toHaveProperty('runId');
  });

  it('a creator who is not a member of the workspace is refused even into their own conversation', async () => {
    const o = await owner();
    const outsider = `user:s985-outsider-${n++}`;
    const conv = await conversation(o.tenant, outsider);
    const chat = await createScheduledChat(o.tenant, { orgId: o.tenant }, outsider, { agentId: 'iris', prompt: 'p', conversationId: conv, cronExpr: '0 9 * * *' });
    expect(await fire(`schedchat-${chat.chatId}`)).toEqual({ skipped: 'target-refused' });
  });
});

describe('D2 — the cadence floor holds on the use lane', () => {
  it('create refuses a cadence finer than hourly; an hourly one is accepted', async () => {
    const o = await owner();
    await expect(createScheduledChat(o.tenant, { orgId: o.tenant }, o.userId, { agentId: 'iris', prompt: 'p', conversationId: 'c', cronExpr: '*/5 * * * *' }))
      .rejects.toMatchObject({ code: 'validation_error', details: { field: 'cronExpr', code: 'cadence_too_frequent' } });
    await expect(createScheduledChat(o.tenant, { orgId: o.tenant }, o.userId, { agentId: 'iris', prompt: 'p', conversationId: 'c', cronExpr: '0 * * * *' })).resolves.toHaveProperty('chatId');
  });

  it('a chat-tool job re-cadenced below the floor is skipped at fire time', async () => {
    const o = await owner();
    const conv = await conversation(o.tenant, o.userId);
    const jobId = await toolJob(o.tenant, o.userId, conv);
    // The generic scheduler PATCH (the owner's Schedules tab) can change a cadence.
    await updateJob(jobId, { cronExpr: '* * * * *' });
    expect(await fireJob(deps, (await getJob(jobId))!, { trigger: 'manual', applyBudget: false })).toEqual({ skipped: 'cadence-too-frequent' });
    expect(await firedRuns(jobId)).toBe(0);
  });

  it('the scheduler route refuses a re-cadence below the floor (400) and accepts an hourly one', async () => {
    const o = await owner();
    const jobId = await toolJob(o.tenant, o.userId, await conversation(o.tenant, o.userId));
    const fine = await o.c('PATCH', JOB(jobId), { cronExpr: '*/10 * * * *' });
    expect(fine.status, JSON.stringify(fine.body)).toBe(400);
    expect((await getJob(jobId))!.cronExpr).toBe('0 9 * * *');
    expect((await o.c('PATCH', JOB(jobId), { cronExpr: '0 * * * *' })).status).toBe(200);
  });
});

describe('D3 — the generic scheduler route does not re-arm a feature-owned job', () => {
  it('re-enable and re-cadence are refused (409); disabling stays allowed', async () => {
    const o = await owner();
    const conv = await conversation(o.tenant, o.userId);
    const chat = await createScheduledChat(o.tenant, { orgId: o.tenant }, o.userId, { agentId: 'iris', prompt: 'p', conversationId: conv, cronExpr: '0 9 * * *' });
    const jobId = `schedchat-${chat.chatId}`;
    await setScheduledChatEnabled(o.tenant, { orgId: o.tenant }, chat.chatId, false);
    const reEnable = await o.c('PATCH', JOB(jobId), { enabled: true });
    expect(reEnable.status, JSON.stringify(reEnable.body)).toBe(409);
    expect((await getJob(jobId))!.enabled).toBe(false);
    const reCadence = await o.c('PATCH', JOB(jobId), { cronExpr: '0 10 * * *' });
    expect(reCadence.status).toBe(409);
    expect(reCadence.body.message).toMatch(/scheduled chat/i);
    // The 409 names its real owner (it said "standing goal" for every prefix).
    expect(reCadence.body.details).toMatchObject({ managedBy: 'scheduled-chat' });
    // "Run now" on the paused job is the feature's resume to make, not this door's.
    expect((await o.c('POST', `${JOB(jobId)}/trigger`)).status).toBe(409);
    // Resume through the feature: allowed.
    await setScheduledChatEnabled(o.tenant, { orgId: o.tenant }, chat.chatId, true);
    expect((await o.c('PATCH', JOB(jobId), { enabled: false })).status).toBe(200);
  });

  it('a chat tool job\'s `tool` marker cannot be rewritten through the scheduler route (review M2)', async () => {
    const o = await owner();
    const jobId = await toolJob(o.tenant, o.userId, await conversation(o.tenant, o.userId));
    expect((await o.c('PATCH', JOB(jobId), { metadata: { tool: 'something-else', label: 'x' } })).status).toBe(200);
    expect((await getJob(jobId))!.metadata).toMatchObject({ tool: SCHEDULE_RECURRING_TOOL_ID, label: 'x' });
  });
});

describe('D4 — the list reads the job', () => {
  it('a job disabled by another door reads paused; a missing job reads unscheduled', async () => {
    const o = await owner();
    const conv = await conversation(o.tenant, o.userId);
    const a = await createScheduledChat(o.tenant, { orgId: o.tenant }, o.userId, { agentId: 'iris', prompt: 'a', conversationId: conv, cronExpr: '0 9 * * *' });
    const b = await createScheduledChat(o.tenant, { orgId: o.tenant }, o.userId, { agentId: 'iris', prompt: 'b', conversationId: conv, cronExpr: '0 9 * * *' });
    expect((await o.c('PATCH', JOB(`schedchat-${a.chatId}`), { enabled: false })).status).toBe(200);
    expect((await o.c('DELETE', JOB(`schedchat-${b.chatId}`))).status).toBe(200);
    const rows = await listScheduledChatsWithStatus(o.tenant, { orgId: o.tenant });
    const ra = rows.find((r) => r.chatId === a.chatId)!;
    const rb = rows.find((r) => r.chatId === b.chatId)!;
    expect(ra.enabled).toBe(false);
    expect(rb.enabled).toBe(false);
    expect(rb.unscheduled).toBe(true);
    expect(ra.unscheduled).toBeUndefined();
  });
});

describe('D5 — pause/resume says which; an erased creator is not resumed', () => {
  it('POST …/pause without a boolean `enabled` is a 400, not a resume', async () => {
    const o = await owner();
    const conv = await conversation(o.tenant, o.userId);
    const chat = await createScheduledChat(o.tenant, { orgId: o.tenant }, o.userId, { agentId: AGENT, prompt: 'p', conversationId: conv, cronExpr: '0 9 * * *' });
    await setScheduledChatEnabled(o.tenant, { orgId: o.tenant }, chat.chatId, false);
    const r = await o.c('POST', ORG(o.tenant, `/${chat.chatId}/pause`), {});
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect((await getJob(`schedchat-${chat.chatId}`))!.enabled).toBe(false);
    const ok = await o.c('POST', ORG(o.tenant, `/${chat.chatId}/pause`), { enabled: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await getJob(`schedchat-${chat.chatId}`))!.enabled).toBe(true);
  });

  it('a schedule paused by its creator\'s erasure cannot be resumed', async () => {
    const o = await owner();
    const conv = await conversation(o.tenant, o.userId);
    const chat = await createScheduledChat(o.tenant, { orgId: o.tenant }, o.userId, { agentId: 'iris', prompt: 'p', conversationId: conv, cronExpr: '0 9 * * *' });
    await eraseScheduledChatsSubject(o.tenant, o.userId);
    await expect(setScheduledChatEnabled(o.tenant, { orgId: o.tenant }, chat.chatId, true)).rejects.toMatchObject({ code: 'conflict' });
    expect((await getJob(`schedchat-${chat.chatId}`))!.enabled).toBe(false);
  });

  it('after the HOST eraser alone, the job cannot be re-armed at any door (architect H3)', async () => {
    const o = await owner();
    const conv = await conversation(o.tenant, o.userId);
    const chat = await createScheduledChat(o.tenant, { orgId: o.tenant }, o.userId, { agentId: 'iris', prompt: 'p', conversationId: conv, cronExpr: '0 9 * * *' });
    const jobId = `schedchat-${chat.chatId}`;
    await eraseSubjectSchedules(o.tenant, o.userId);
    expect((await getJob(jobId))!.enabled).toBe(false);
    await expect(setScheduledChatEnabled(o.tenant, { orgId: o.tenant }, chat.chatId, true)).rejects.toMatchObject({ code: 'conflict', details: { code: 'creator_erased' } });
    await expect(setJobEnabled(jobId, true)).rejects.toThrow();
    expect((await getJob(jobId))!.enabled).toBe(false);
  });

  it('resuming a schedule whose job is gone is a 409, not a silent no-op (architect M5)', async () => {
    const o = await owner();
    const conv = await conversation(o.tenant, o.userId);
    const chat = await createScheduledChat(o.tenant, { orgId: o.tenant }, o.userId, { agentId: 'iris', prompt: 'p', conversationId: conv, cronExpr: '0 9 * * *' });
    await setScheduledChatEnabled(o.tenant, { orgId: o.tenant }, chat.chatId, false);
    await deleteJob(`schedchat-${chat.chatId}`);
    await expect(setScheduledChatEnabled(o.tenant, { orgId: o.tenant }, chat.chatId, true)).rejects.toMatchObject({ code: 'conflict', details: { code: 'unscheduled' } });
  });
});

/** A registered agent (beforeAll), so the create route's agent check passes. */
const AGENT = 's985.agent';
const MINE = (suffix = ''): string => `/host/openwop-app/scheduled-chats/mine${suffix}`;

describe('D6 — schedules created from chat are listed and managed by their owner', () => {
  it('a job in a SHARED workspace is listed to its owner, and to nobody else', async () => {
    const o = await owner();
    const editor = await member(o.c, o.tenant, 'editor');
    const jobId = await toolJob(o.tenant, o.userId, await conversation(o.tenant, o.userId));
    const mine = await o.c('GET', MINE());
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.schedules!.map((x) => x.jobId)).toEqual([jobId]);
    expect(mine.body.schedules![0]).toMatchObject({ kind: 'recurring', prompt: 't', enabled: true });
    // Another member of the same workspace neither sees nor touches it.
    expect((await editor.c('GET', MINE())).body.schedules).toEqual([]);
    expect((await editor.c('POST', MINE(`/${encodeURIComponent(jobId)}/pause`), { enabled: false })).status).toBe(404);
    expect((await editor.c('DELETE', MINE(`/${encodeURIComponent(jobId)}`))).status).toBe(404);
    expect((await getJob(jobId))!.enabled).toBe(true);
  });

  it('the owner pauses, resumes and deletes; pause needs a boolean', async () => {
    const o = await owner();
    const jobId = await toolJob(o.tenant, o.userId, await conversation(o.tenant, o.userId));
    const path = MINE(`/${encodeURIComponent(jobId)}`);
    expect((await o.c('POST', `${path}/pause`, {})).status).toBe(400);
    const paused = await o.c('POST', `${path}/pause`, { enabled: false });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(paused.body.schedule!.enabled).toBe(false);
    expect((await getJob(jobId))!.enabled).toBe(false);
    expect((await o.c('POST', `${path}/pause`, { enabled: true })).body.schedule!.enabled).toBe(true);
    expect((await o.c('DELETE', path)).status).toBe(204);
    expect(await getJob(jobId)).toBeNull();
  });

  it('a Viewer who owns a job may pause it but not re-arm it', async () => {
    const o = await owner();
    const viewer = await member(o.c, o.tenant, 'viewer');
    const jobId = await toolJob(o.tenant, viewer.userId, await conversation(o.tenant, viewer.userId));
    const path = MINE(`/${encodeURIComponent(jobId)}/pause`);
    expect((await viewer.c('POST', path, { enabled: false })).status).toBe(200);
    const resume = await viewer.c('POST', path, { enabled: true });
    expect(resume.status, JSON.stringify(resume.body)).toBe(403);
    expect((await getJob(jobId))!.enabled).toBe(false);
  });

  it('a follow-up that RAN leaves the list; one whose only slot was skipped stays, with its skip', async () => {
    const o = await owner();
    const conv = await conversation(o.tenant, o.userId);
    const register = async (jobId: string, conversationId: string) => {
      const r = await registerJob({
        jobId, tenantId: o.tenant, cronExpr: 'once', firstFireAtMs: Date.now() + 3_600_000, workflowId: SCHEDULED_CHAT_TURN_WORKFLOW_ID,
        featureId: SCHEDULED_AGENT_CHATS_TOGGLE, ownerSubject: { kind: 'user', id: o.userId }, agentId: 'iris', enabled: true,
        metadata: { tool: SCHEDULE_FOLLOWUP_TOOL_ID, actingUserId: o.userId },
        configurable: { agentId: 'iris', task: 'remind', conversationId, credentialRef: 'managed:openwop-free' },
      });
      expect(r.ok).toBe(true);
    };
    const ran = `followup:s985-ran-${n++}`;
    const missed = `followup:s985-missed-${n++}`;
    await register(ran, conv);
    await register(missed, 'conv-gone');
    for (const id of [ran, missed]) {
      const due = (await getJob(id))!.nextFireAt!;
      await processDueSchedules(deps, due + 1000);
    }
    const listed = (await o.c('GET', MINE())).body.schedules!;
    expect(listed.map((x) => x.jobId)).toEqual([missed]);
    expect(listed[0]!.lastSkip?.reason).toBe('target-refused');
    expect(listed[0]!.spent).toBe(true); // it can never fire again (review M3)
  });

  it('an anonymous caller lists nothing', async () => {
    const anon = client();
    const r = await anon('GET', MINE());
    expect(r.status).toBe(200);
    expect(r.body.schedules).toEqual([]);
  });
});

describe('D6 — arming standing work from chat needs workspace:write', () => {
  const runTool = (tenantId: string, actingUserId: string, conversationId: string) =>
    createAgentToolProvider({ tenantId, actingUserId, agentProfileId: 'host:iris', conversationId, runId: `run-s985-${n++}` })
      .executeTool({ name: SCHEDULE_RECURRING_TOOL_ID, input: { task: 'Post the summary.', cronExpr: '0 9 * * *', timezone: 'UTC' } });

  it('a Viewer is refused; an Editor schedules', async () => {
    const o = await owner();
    const viewer = await member(o.c, o.tenant, 'viewer');
    const editor = await member(o.c, o.tenant, 'editor');
    const refused = await runTool(o.tenant, viewer.userId, await conversation(o.tenant, viewer.userId));
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content)).toMatchObject({ error: 'forbidden_scope' });
    const ok = await runTool(o.tenant, editor.userId, await conversation(o.tenant, editor.userId));
    expect(ok.isError, ok.content).toBeFalsy();
  });

  it('in a personal workspace the tool stamps `personalTenant`, and the job fires (architect M2)', async () => {
    const personal = `user:s985t${n++}`;
    const conv = await conversation(personal, personal);
    const out = await createAgentToolProvider({ tenantId: personal, personalTenant: personal, actingUserId: personal, agentProfileId: 'host:iris', conversationId: conv, runId: `run-s985-${n++}` })
      .executeTool({ name: SCHEDULE_RECURRING_TOOL_ID, input: { task: 'Post the summary.', cronExpr: '0 9 * * *', timezone: 'UTC' } });
    expect(out.isError, out.content).toBeFalsy();
    const jobId = (JSON.parse(out.content) as { jobId: string }).jobId;
    expect((await getJob(jobId))!.metadata).toMatchObject({ personalTenant: personal });
    expect(await fire(jobId)).toHaveProperty('runId');
  });

  it('an anonymous actor is refused', async () => {
    const out = await runTool('anon:s985', 'anon:s985', 'conv-anon');
    expect(JSON.parse(out.content)).toMatchObject({ error: 'sign_in_required' });
  });
});

describe('D6 — the org create route refuses a conversation that does not exist (architect M8)', () => {
  it('404 for an absent conversation; the caller\'s own conversation is accepted', async () => {
    const o = await owner();
    const absent = await o.c('POST', ORG(o.tenant), { agentId: AGENT, prompt: 'p', conversationId: 'conv-never', cronExpr: '0 9 * * *' });
    expect(absent.status, JSON.stringify(absent.body)).toBe(404);
    expect(absent.body.message).toMatch(/Conversation not found/);
    const ok = await o.c('POST', ORG(o.tenant), { agentId: AGENT, prompt: 'p', conversationId: await conversation(o.tenant, o.userId), cronExpr: '0 9 * * *' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    // D5 (grade-code SC2CD-7) — a resume re-asks whether the agent exists.
    const ghost = await createScheduledChat(o.tenant, { orgId: o.tenant }, o.userId, { agentId: 's985.ghost', prompt: 'p', conversationId: await conversation(o.tenant, o.userId), cronExpr: '0 9 * * *' });
    await setScheduledChatEnabled(o.tenant, { orgId: o.tenant }, ghost.chatId, false);
    const resume = await o.c('POST', ORG(o.tenant, `/${ghost.chatId}/pause`), { enabled: true });
    expect(resume.status, JSON.stringify(resume.body)).toBe(409);
    expect(resume.body.details).toMatchObject({ code: 'agent_missing' });
    // D4 — the list names the agent by its persona.
    expect((await listScheduledChatsWithStatus(o.tenant, { orgId: o.tenant })).find((r) => r.agentId === AGENT)!.agentName).toBe('Digest Agent');
  });
});
