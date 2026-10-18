/**
 * ADR 0202 — agent-native channels, Phase 1 route-level coverage.
 *
 * Guards (each sabotage-witnessed, wave 26):
 *  - D1 response policy: the FIRST agent added is stamped `all`, later ones
 *    `mention` (inverting `hasAgentAlready ? 'mention' : 'all'` reds case 1);
 *    only the OWNER may change it (403 for a joined member) and the route
 *    validates the value (400 for `bogus`).
 *  - D2 AI catch-up: a channel with no agent member 400s (no phantom host
 *    summarizer); a private channel 404-masks a non-member; a member's
 *    catch-up fires EXACTLY ONE channel-turn run WITHOUT `conversationId` in
 *    its configurable — the "summary is never posted in-channel" guarantee
 *    (ADR 0125 by construction) — carrying the unread transcript, the channel
 *    attribution metadata, and the exact unread count.
 *
 * `startWorkflowRun` is mocked (the channel-dispatch-integration precedent):
 * with no live model in the test env, the channel-turn run never replies, so a
 * message-count check could not fail when `conversationId` leaked into the
 * run (wave 26 probe `0202-catchup-no-append` proved it vacuous). The run
 * CONTRACT is the claim; the engine is not.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/host/runStarter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/host/runStarter.js')>()),
  startWorkflowRun: vi.fn(async () => 'run-catchup-1'),
}));

import { createApp } from '../src/index.js';
import { createMember } from '../src/host/accessControlService.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { startWorkflowRun } from '../src/host/runStarter.js';

const CH = '/host/openwop-app/channels';
const startRun = vi.mocked(startWorkflowRun);

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  for (const [agentId, persona] of [['nat.a', 'Agent A'], ['nat.b', 'Agent B']] as const) {
    getAgentRegistry().register({ agentId, persona, modelClass: 'general', systemPrompt: 'help', packName: 'test', packVersion: '0', toolAllowlist: [] });
  }
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface RosterRow { subjectRef: string; responsePolicy?: 'all' | 'mention' }
interface Body {
  channel?: { conversationId: string; roster?: RosterRow[] };
  messages?: Array<{ messageId: string }>;
  user?: { userId: string };
  runId?: string;
  unreadCount?: number;
  error?: { code?: string; message?: string };
  message?: string;
}
interface Res { status: number; body: Body }

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Body);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b), del: (p: string) => call('DELETE', p) };
}
type Client = ReturnType<typeof client>;

const TENANT = `t-adr0202-${Date.now()}`;
async function login(name: string): Promise<{ c: Client; userId: string }> {
  const c = client();
  const r = await c.post('/host/openwop-app/test/login', { email: `adr0202-${name}-${Date.now()}-${n++}@acme.test`, displayName: `${name} P`, tenantId: TENANT });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  // ADR 0879 D1 — a co-tenant login gets no member row from the seam (it founds the
  // workspace for the FIRST login only), and channel writes now ask the ROLE. Make
  // every person a real Editor of the workspace, the production shape (idempotent: a
  // founder keeps their owner row).
  await createMember({ orgId: TENANT, tenantId: TENANT, displayName: name, subject: r.body.user!.userId, roles: ['editor'] });
  return { c, userId: r.body.user!.userId };
}

async function createChannel(c: Client, body: Record<string, unknown>): Promise<string> {
  const r = await c.post(CH, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.channel!.conversationId;
}

function agentRow(detail: Res, agentId: string): RosterRow | undefined {
  return (detail.body.channel?.roster ?? []).find((r) => r.subjectRef === `agent:${agentId}`);
}

function errText(r: Res): string {
  return String(r.body.error?.message ?? r.body.message);
}

describe('ADR 0202 D1 — response policy', () => {
  it('the first agent added is stamped all; a second defaults to mention', async () => {
    const { c } = await login('owner');
    const id = await createChannel(c, { name: `p-${n}`, visibility: 'public', agentIds: ['nat.a'] });
    let detail = await c.get(`${CH}/${id}`);
    expect(agentRow(detail, 'nat.a')?.responsePolicy).toBe('all');

    expect((await c.post(`${CH}/${id}/members`, { agentId: 'nat.b' })).status).toBe(200);
    detail = await c.get(`${CH}/${id}`);
    expect(agentRow(detail, 'nat.a')?.responsePolicy).toBe('all'); // A retained
    expect(agentRow(detail, 'nat.b')?.responsePolicy).toBe('mention'); // B defaulted
  });

  it('the owner can change an agent policy; a non-owner cannot', async () => {
    const { c: ownerC } = await login('owner');
    const id = await createChannel(ownerC, { name: `p2-${n}`, visibility: 'public', agentIds: ['nat.a'] });
    expect((await ownerC.put(`${CH}/${id}/agents/nat.a/policy`, { policy: 'mention' })).status).toBe(200);
    expect(agentRow(await ownerC.get(`${CH}/${id}`), 'nat.a')?.responsePolicy).toBe('mention');

    const { c: memberC } = await login('member');
    expect((await memberC.post(`${CH}/${id}/join`)).status).toBe(200);
    expect((await memberC.put(`${CH}/${id}/agents/nat.a/policy`, { policy: 'all' })).status).toBe(403);
    const bogus = await ownerC.put(`${CH}/${id}/agents/nat.a/policy`, { policy: 'bogus' });
    expect(bogus.status).toBe(400);
    expect(errText(bogus)).toMatch(/policy/);
    // Neither refused write landed.
    expect(agentRow(await ownerC.get(`${CH}/${id}`), 'nat.a')?.responsePolicy).toBe('mention');
  });
});

describe('ADR 0202 D2 — AI catch-up', () => {
  it('a channel with NO agent member 400s (no phantom host summarizer)', async () => {
    const { c } = await login('owner');
    const id = await createChannel(c, { name: `c-${n}`, visibility: 'public' });
    const r = await c.post(`${CH}/${id}/catchup`);
    expect(r.status).toBe(400);
    expect(errText(r)).toMatch(/no agent member/);
  });

  it('a member gets a runId + unreadCount; the summary is NOT posted in-channel', async () => {
    const { c } = await login('owner');
    const id = await createChannel(c, { name: `c2-${n}`, visibility: 'public', agentIds: ['nat.a'] });
    expect((await c.post(`${CH}/${id}/messages`, { content: 'first' })).status).toBe(201);
    expect((await c.post(`${CH}/${id}/messages`, { content: 'second' })).status).toBe(201);

    const catchup = await c.post(`${CH}/${id}/catchup`);
    expect(catchup.status, JSON.stringify(catchup.body)).toBe(202);
    expect(catchup.body.runId).toBe('run-catchup-1');
    expect(catchup.body.unreadCount).toBe(2); // two posts, never marked read

    // EXACTLY ONE catch-up run for this channel (the posts' own agent dispatch
    // also calls the starter; filter to the catch-up attribution).
    const calls = startRun.mock.calls
      .map(([, input]) => input)
      .filter((input) => {
        const ch = input.metadata?.channel as { source?: string; channelId?: string } | undefined;
        return ch?.source === 'channel-catchup' && ch.channelId === id;
      });
    expect(calls).toHaveLength(1);
    const run = calls[0];
    // conversationId OMITTED → the agent-runner never appends in-channel.
    expect(run.configurable).not.toHaveProperty('conversationId');
    expect(run.configurable?.agentId).toBe('nat.a');
    expect(String(run.configurable?.task)).toContain('first');
    expect(String(run.configurable?.task)).toContain('second');
    expect(run.tenantId).toBe(TENANT);
  });

  it('a non-member is denied catch-up on a private channel (404 mask)', async () => {
    const { c } = await login('owner');
    const id = await createChannel(c, { name: `c3-${n}`, visibility: 'private', agentIds: ['nat.a'] });
    const { c: other } = await login('outsider');
    expect((await other.post(`${CH}/${id}/catchup`)).status).toBe(404);
  });
});
