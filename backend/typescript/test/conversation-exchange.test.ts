/**
 * core.conversationGate — full open → exchange → close lifecycle (RFC 0005).
 *
 * End-to-end against a real run: the gate opens + suspends; each `exchange`
 * resolve appends the user turn + a (mock) agent reply as conversation.exchanged
 * events and leaves the run suspended; `close` emits conversation.closed and
 * completes the run. Proves the host now backs `capabilities.conversationPrimitive`.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { programMock, resetMockPrograms } from '../src/providers/dispatchMock.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';
const TENANT = '_anon';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true'; // allow the mock provider
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
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

  it('streams the reply as ai.message.chunk events before the final conversation.exchanged (ADR 0079 §Phase 1)', async () => {
    // The conversation mock path dispatches with no nodeId → the mock program is
    // keyed by '' (see dispatchReply / dispatchMock). Register a multi-word reply
    // so it chunks into several deltas.
    resetMockPrograms();
    programMock('', [{ content: 'Hello there friend' }]);
    try {
      const workflowId = 'openwop-app.conversation.stream';
      await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({
        workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'Hi' } }], edges: [],
      }) });
      const runId = (await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({
        workflowId, inputs: { provider: 'mock', model: 'mock-1' }, tenantId: TENANT,
      }) })).body.runId;
      expect((await poll(runId)).status.startsWith('waiting')).toBe(true);

      await api(`/v1/runs/${runId}/interrupts/gate`, { method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: 'hello?' } } }) });
      const after = await poll(runId);
      const chunks = conv(after.events, 'ai.message.chunk');
      // Multiple deltas, concatenating to the full reply.
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.map((e) => (e.payload as { chunk?: string }).chunk).join('')).toBe('Hello there friend');
      // The deltas precede the agent's authoritative conversation.exchanged turn.
      const lastChunkIdx = after.events.lastIndexOf(chunks[chunks.length - 1]!);
      const exchanged = conv(after.events, 'conversation.exchanged');
      const agentExchanged = exchanged.find((e) => (e.payload?.turn as { role?: string })?.role === 'agent')!;
      expect(after.events.indexOf(agentExchanged)).toBeGreaterThan(lastChunkIdx);
      // The agent's final turn content matches the streamed text.
      expect((agentExchanged.payload!.turn as { content?: string }).content).toBe('Hello there friend');
    } finally {
      resetMockPrograms();
    }
  });

  it('redacts secrets from the streamed ai.message.chunk deltas, not just the final turn (SR-1 parity)', async () => {
    // A reply that echoes the conformance canary must be scrubbed in the
    // PERSISTED chunk stream too — the transient delta lands in the durable
    // event log, so it must honor the same strip-on-persist as the turn.
    const CANARY = 'CANARY-openwop-CONFORMANCE-NEVER-SECRET';
    resetMockPrograms();
    programMock('', [{ content: `here is the key ${CANARY} keep it safe` }]);
    try {
      const workflowId = 'openwop-app.conversation.redact';
      await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({
        workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'Hi' } }], edges: [],
      }) });
      const runId = (await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({
        workflowId, inputs: { provider: 'mock', model: 'mock-1' }, tenantId: TENANT,
      }) })).body.runId;
      expect((await poll(runId)).status.startsWith('waiting')).toBe(true);

      await api(`/v1/runs/${runId}/interrupts/gate`, { method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: 'the key?' } } }) });
      const after = await poll(runId);
      const chunkText = conv(after.events, 'ai.message.chunk').map((e) => (e.payload as { chunk?: string }).chunk).join('');
      expect(chunkText).not.toContain(CANARY);          // raw secret scrubbed from the stream
      expect(chunkText).toContain('<<redacted');         // replaced by the redaction marker
      // The authoritative turn is redacted too (unchanged behavior).
      const agentTurn = conv(after.events, 'conversation.exchanged').find((e) => (e.payload?.turn as { role?: string })?.role === 'agent')!;
      expect((agentTurn.payload!.turn as { content?: string }).content).not.toContain(CANARY);
    } finally {
      resetMockPrograms();
    }
  });

  it('async exchange acks BEFORE the reply, then streams the turns on the SSE (ADR 0079 §Phase 3)', async () => {
    // Flag the exchange async: the POST acks with the PRE-exchange turns and the
    // user+agent turns + deltas land in the background on the run event log.
    process.env.OPENWOP_CONVERSATION_EXCHANGE_ASYNC = 'true';
    resetMockPrograms();
    programMock('', [{ content: 'Async reply here' }]);
    try {
      const workflowId = 'openwop-app.conversation.async';
      await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({
        workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'Hi' } }], edges: [],
      }) });
      const runId = (await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({
        workflowId, inputs: { provider: 'mock', model: 'mock-1' }, tenantId: TENANT,
      }) })).body.runId;
      expect((await poll(runId)).status.startsWith('waiting')).toBe(true);

      // The ack reports only the pre-exchange turns (the open turn) — NOT the new
      // user+agent pair (which a synchronous exchange would have returned as 3).
      const ex = await api<{ conversation?: { operation: string; turns: number } }>(
        `/v1/runs/${runId}/interrupts/gate`,
        { method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: 'go async?' } } }) },
      );
      expect(ex.status).toBe(200);
      expect(ex.body.conversation?.turns).toBe(1); // ack-early: just the open turn

      // The background finishes: the user+agent turns + streamed deltas appear.
      const after = await poll(runId);
      expect(after.status.startsWith('waiting')).toBe(true); // still suspended
      const exchanged = conv(after.events, 'conversation.exchanged');
      expect(exchanged.map((e) => (e.payload?.turn as { role?: string })?.role)).toEqual(['user', 'agent']);
      const chunks = conv(after.events, 'ai.message.chunk');
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.map((e) => (e.payload as { chunk?: string }).chunk).join('')).toBe('Async reply here');
      // No terminal error on the happy path.
      expect(conv(after.events, 'ai.message.error')).toHaveLength(0);
    } finally {
      delete process.env.OPENWOP_CONVERSATION_EXCHANGE_ASYNC;
      resetMockPrograms();
    }
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

  it('an idempotent retry of the same exchangeKey does NOT duplicate turns', async () => {
    const workflowId = 'openwop-app.conversation.idem';
    await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({
      workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: {} }], edges: [],
    }) });
    const runId = (await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: { provider: 'mock', model: 'mock-1' }, tenantId: TENANT }) })).body.runId;
    await poll(runId);

    const body = JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: 'idempotent please' }, exchangeKey: 'ex-key-1' } });
    const first = await api(`/v1/runs/${runId}/interrupts/gate`, { method: 'POST', body });
    expect(first.status).toBe(200);
    const afterFirst = await poll(runId);
    expect(conv(afterFirst.events, 'conversation.exchanged').length).toBe(2); // user + agent

    // Replay the SAME exchangeKey + content (a retried POST). Must short-circuit:
    // still 200, but no new turns appended (the committed claim is returned).
    const retry = await api(`/v1/runs/${runId}/interrupts/gate`, { method: 'POST', body });
    expect(retry.status).toBe(200);
    const afterRetry = await poll(runId);
    expect(conv(afterRetry.events, 'conversation.exchanged').length).toBe(2); // unchanged — no duplicate

    // A DIFFERENT key appends a new pair.
    await api(`/v1/runs/${runId}/interrupts/gate`, { method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: 'another' }, exchangeKey: 'ex-key-2' } }) });
    expect(conv((await poll(runId)).events, 'conversation.exchanged').length).toBe(4);
  });

  it('a BYOK exchange with an unresolvable key fails closed with credential_unavailable (422), persisting no turn', async () => {
    const workflowId = 'openwop-app.conversation.byok';
    await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({
      workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: {} }], edges: [],
    }) });
    // A non-managed, non-mock provider with a credentialRef the host can't resolve.
    const runId = (await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({
      workflowId, inputs: { provider: 'anthropic', model: 'claude-x', credentialRef: 'byok:anthropic:does-not-exist' }, tenantId: TENANT,
    }) })).body.runId;
    await poll(runId);
    const r = await api<{ error?: string }>(`/v1/runs/${runId}/interrupts/gate`, { method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: 'hi' } } }) });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('credential_unavailable');
    const after = await poll(runId);
    expect(conv(after.events, 'conversation.exchanged')).toHaveLength(0); // dispatch-first: nothing persisted
    expect(after.status.startsWith('waiting')).toBe(true); // gate still open, retryable
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
