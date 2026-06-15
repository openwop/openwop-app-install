/**
 * core.conversationGate — full open → exchange → close lifecycle (RFC 0005).
 *
 * End-to-end against a real run: the gate opens + suspends; each `exchange`
 * resolve appends the user turn + a (mock) agent reply as conversation.exchanged
 * events and leaves the run suspended; `close` emits conversation.closed and
 * completes the run. Proves the host now backs `capabilities.conversationPrimitive`.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
const PORT = 18255;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'dev-token';
const TENANT = '_anon';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true'; // allow the mock provider
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

interface Ev { type?: string; payload?: Record<string, unknown> }
async function poll(runId: string): Promise<{ status: string; events: Ev[] }> {
  let status = 'pending';
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 20));
    status = (await api<{ status: string }>(`/v1/runs/${runId}`)).body.status;
    if (['completed', 'failed', 'cancelled'].includes(status) || status.startsWith('waiting')) break;
  }
  const events = (await api<{ events?: Ev[] }>(`/v1/runs/${runId}/debug-bundle`)).body.events ?? [];
  return { status, events };
}
const conv = (events: Ev[], type: string): Ev[] => events.filter((e) => e.type === type);

describe('core.conversationGate — open/exchange/close', () => {
  it('advertises conversationPrimitive', async () => {
    const wk = await api<{ capabilities?: { conversationPrimitive?: boolean } }>('/.well-known/openwop');
    expect(wk.body.capabilities?.conversationPrimitive).toBe(true);
  });

  it('opens, exchanges (user + agent turns), and closes the run', async () => {
    const workflowId = 'openwop-app.conversation.test';
    await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({
      workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'How can the team help?' } }], edges: [],
    }) });
    const create = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({
      workflowId, inputs: { provider: 'mock', model: 'mock-1' }, tenantId: TENANT,
    }) });
    expect(create.status).toBe(201);
    const runId = create.body.runId;

    // Opened + suspended.
    const opened = await poll(runId);
    expect(opened.status.startsWith('waiting')).toBe(true);
    expect(conv(opened.events, 'conversation.opened')).toHaveLength(1);

    // Exchange 1 — user turn + agent reply, run STAYS suspended.
    const ex1 = await api<{ conversation?: { operation: string; turns: number } }>(
      `/v1/runs/${runId}/interrupts/gate`,
      { method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: 'What can you do?' } } }) },
    );
    expect(ex1.status).toBe(200);
    expect(ex1.body.conversation?.operation).toBe('exchange');
    const after1 = await poll(runId);
    expect(after1.status.startsWith('waiting')).toBe(true); // still suspended
    const exchanged1 = conv(after1.events, 'conversation.exchanged');
    expect(exchanged1.length).toBe(2); // user + agent
    const roles1 = exchanged1.map((e) => (e.payload?.turn as { role?: string })?.role);
    expect(roles1).toEqual(['user', 'agent']);
    const agentTurn = (exchanged1[1]!.payload!.turn as { content?: unknown; turnIndex?: number; from?: string });
    expect(typeof agentTurn.content).toBe('string'); // mock returns '' w/o a program; real providers fill it
    expect(agentTurn.turnIndex).toBe(2); // open=0, user=1, agent=2

    // Exchange 2 — turnIndexes keep climbing; still suspended.
    await api(`/v1/runs/${runId}/interrupts/gate`, { method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: 'And again?' } } }) });
    const after2 = await poll(runId);
    expect(after2.status.startsWith('waiting')).toBe(true);
    expect(conv(after2.events, 'conversation.exchanged').length).toBe(4); // 2 turns x 2 exchanges

    // Close — conversation.closed + run completes.
    const close = await api(`/v1/runs/${runId}/interrupts/gate`, { method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'close' } }) });
    expect(close.status).toBe(200);
    const done = await poll(runId);
    expect(done.status).toBe('completed');
    expect(conv(done.events, 'conversation.closed')).toHaveLength(1);
  });

  it('the synthesized openwop-app.conversation workflow opens with no registration', async () => {
    // No POST /v1/host/openwop-app/workflows — the host synthesizes this one.
    const runId = (await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId: 'openwop-app.conversation', inputs: { provider: 'mock', model: 'mock-1' }, tenantId: TENANT }) })).body.runId;
    const opened = await poll(runId);
    expect(opened.status.startsWith('waiting')).toBe(true);
    expect(conv(opened.events, 'conversation.opened')).toHaveLength(1);
    await api(`/v1/runs/${runId}/interrupts/gate`, { method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'close' } }) });
    expect((await poll(runId)).status).toBe('completed');
  });

  it('rejects an empty exchange turn with 422 and persists no turn', async () => {
    const workflowId = 'openwop-app.conversation.empty';
    await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({
      workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: {} }], edges: [],
    }) });
    const runId = (await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: { provider: 'mock', model: 'mock-1' }, tenantId: TENANT }) })).body.runId;
    await poll(runId);
    const bad = await api(`/v1/runs/${runId}/interrupts/gate`, { method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: '   ' } } }) });
    expect(bad.status).toBe(422);
    const after = await poll(runId);
    expect(conv(after.events, 'conversation.exchanged')).toHaveLength(0); // nothing persisted
    expect(after.status.startsWith('waiting')).toBe(true); // conversation still open
  });
});
