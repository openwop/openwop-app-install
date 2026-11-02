/**
 * ADR 1001 R12 — a duplicate of an exchange that is still in flight is refused
 * with `conflict`, NEVER `interrupt_already_resolved`.
 *
 * The chat client's `DEAD_RUN_CODES` (`useTurnTransport.ts`) reads
 * `interrupt_already_resolved` as "this conversation's run is dead" and drops the
 * run binding, so a retried or double-sent turn that carried the same
 * `exchangeKey` used to orphan a LIVE conversation. P2 fixed this for chat
 * question answers only (`clarify:<askId>` keys); this pins every other key.
 *
 * Through the real conversation route (`POST /runs/{id}/interrupts/gate`) on a
 * real conversation gate. The one stand-in is the managed model round, slowed so
 * the second POST lands while the first exchange still holds its claim.
 *
 * Pins:
 *  1. the in-flight duplicate is 409 `openwop-app.conflict`, and once the first
 *     settles the conversation has exactly one user turn for that key;
 *  2. the gate is still open after the refusal: a new key exchanges normally;
 *  3. a genuinely dead run still answers `interrupt_already_resolved` (the
 *     client's dead-run teardown is correct there and must keep firing).
 *
 * Red on `origin/main` @ f382e70d1: pin 1 reads `interrupt_already_resolved`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface Round { text: string; toolUses: never[]; delayMs?: number }
const script = vi.hoisted(() => ({ rounds: [] as Round[] }));
vi.mock('../src/providers/managedProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/managedProvider.js')>();
  return {
    ...actual,
    dispatchManagedToolsRound: vi.fn(async () => {
      const next = script.rounds.shift() ?? { text: 'Done.', toolUses: [] };
      if (next.delayMs) await new Promise((res) => setTimeout(res, next.delayMs));
      return next;
    }),
  };
});

import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { __clearAgentIdentityCache } from '../src/host/agentIdentity.js';

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };
const AGENT = 'probe.r12.helper';
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  getAgentRegistry().register({
    agentId: AGENT, persona: 'Helper', modelClass: 'chat', systemPrompt: 'You help.',
    packName: 'test.r12', packVersion: '0.0.1', toolAllowlist: [],
  });
  __clearAgentIdentityCache();
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(() => { script.rounds = []; });

async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function openChat(): Promise<string> {
  const workflowId = `adr1001.r12.chat-${n++}`;
  await api('/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'x' } }], edges: [] }) });
  const runId = (await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: {}, tenantId: '_anon' }) })).body.runId;
  await vi.waitFor(async () => {
    expect((await api<{ status: string }>(`/runs/${runId}`)).body.status).toMatch(/^waiting/);
  }, { timeout: 5000, interval: 20 });
  return runId;
}

interface Ev { type?: string; payload?: { turn?: { role?: string; content?: unknown } } }
async function userTurns(runId: string): Promise<unknown[]> {
  const evs = (await api<{ events?: Ev[] }>(`/runs/${encodeURIComponent(runId)}/events/poll?fromSeq=0&limit=1000`)).body.events ?? [];
  return evs.filter((e) => e.type === 'conversation.exchanged' && e.payload?.turn?.role === 'user').map((e) => e.payload?.turn?.content);
}
async function agentTurnCount(runId: string): Promise<number> {
  const evs = (await api<{ events?: Ev[] }>(`/runs/${encodeURIComponent(runId)}/events/poll?fromSeq=0&limit=1000`)).body.events ?? [];
  return evs.filter((e) => e.type === 'conversation.exchanged' && e.payload?.turn?.role === 'agent').length;
}
const send = (runId: string, content: string, exchangeKey: string) =>
  api(`/runs/${runId}/interrupts/gate`, { method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content, to: AGENT }, exchangeKey } }) });

describe('ADR 1001 R12 — the exchange claim refuses an in-flight duplicate with conflict', () => {
  it('a double-sent turn (same exchangeKey, first still in flight) is 409 openwop-app.conflict, and one turn is recorded', async () => {
    const runId = await openChat();
    script.rounds = [{ text: 'one', toolUses: [], delayMs: 400 }, { text: 'two', toolUses: [] }];
    const r1 = await send(runId, 'hello', 'k-double');
    const r2 = await send(runId, 'hello', 'k-double');
    expect(r1.status, JSON.stringify(r1.body).slice(0, 300)).toBe(200);
    expect(r2.status, 'the in-flight claim refuses the duplicate').toBe(409);
    expect(r2.body.error, 'not the dead-run code the chat client tears down on').toBe('openwop-app.conflict');
    await vi.waitFor(async () => { expect(await agentTurnCount(runId)).toBe(1); }, { timeout: 8000, interval: 25 });
    expect(await userTurns(runId), 'the duplicate appended nothing').toEqual(['hello']);

    // The run is alive: the next turn, under a new key, exchanges normally.
    const r3 = await send(runId, 'next', 'k-next');
    expect(r3.status, JSON.stringify(r3.body).slice(0, 300)).toBe(200);
    await vi.waitFor(async () => { expect(await agentTurnCount(runId)).toBe(2); }, { timeout: 8000, interval: 25 });
  });

  it('a closed conversation still answers interrupt_already_resolved (the dead-run code is kept where the run IS dead)', async () => {
    const runId = await openChat();
    const close = await api(`/runs/${runId}/interrupts/gate`, { method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'close' } }) });
    expect(close.status, JSON.stringify(close.body).slice(0, 300)).toBe(200);
    await vi.waitFor(async () => {
      expect((await api<{ status: string }>(`/runs/${runId}`)).body.status).toBe('completed');
    }, { timeout: 5000, interval: 20 });
    const late = await send(runId, 'anyone there?', 'k-late');
    expect(late.status).toBe(409);
    expect(late.body.error).toBe('interrupt_already_resolved');
  });
});
