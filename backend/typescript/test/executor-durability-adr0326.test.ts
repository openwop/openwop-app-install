/**
 * ADR 0326 P1/P2 (CS-WF-3/4) — executor durability.
 *
 * P1 — bounded opt-in node retry: `config.retry.maxAttempts` re-queues a
 * failing node (each attempt = its own node.started/node.failed pair in the
 * event log; existing vocabulary), non-retryable classes and no-config nodes
 * fail exactly as before, and the recursion cap still bounds total work.
 *
 * P2 — cross-instance SSE fan-out: run-event ticks coalesce on the host-ext
 * bus, and the stream's per-connection watermark delivers each event at most
 * once even when the in-proc path AND a tick-triggered gap fetch both see it.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { publishRunEventTick, subscribeRunEventTicks } from '../src/host/runEventBus.js';

let server: http.Server;
let BASE: string;
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true'; // the mock provider for the SSE exchange leg
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });

  // A node that fails until its Nth call (per-run isolation via input marker).
  const callsByRun = new Map<string, number>();
  getNodeRegistry().register({
    typeId: 'test.flaky-until',
    version: '1.0.0',
    async execute(ctx) {
      const key = (ctx as { runId?: string }).runId ?? 'x';
      const n = (callsByRun.get(key) ?? 0) + 1;
      callsByRun.set(key, n);
      const succeedAt = Number((ctx as { config?: { succeedAt?: unknown } }).config?.succeedAt ?? 3);
      if (n < succeedAt) throw new Error(`transient failure #${n}`);
      return { status: 'success', outputs: { output: `ok after ${n}` } };
    },
  });
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function runToTerminal(workflowId: string, nodes: unknown[], inputs: Record<string, unknown> = {}): Promise<{ runId: string; status: string; events: Array<{ type?: string; nodeId?: string }> }> {
  await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({ workflowId, nodes, edges: [] }) });
  const create = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs, tenantId: '_anon' }) });
  expect(create.status).toBe(201);
  const runId = create.body.runId;
  let status = 'pending';
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 25));
    status = (await api<{ status: string }>(`/v1/runs/${runId}`)).body.status;
    if (['completed', 'failed', 'cancelled'].includes(status)) break;
  }
  const events = (await api<{ events?: Array<{ type?: string; nodeId?: string }> }>(`/v1/runs/${runId}/debug-bundle`)).body.events ?? [];
  return { runId, status, events };
}

describe('ADR 0326 P1 — bounded opt-in node retry', () => {
  it('a config.retry node retries to success; the event log records every attempt', async () => {
    const { status, events } = await runToTerminal('adr0326.retry-succeeds', [
      { nodeId: 'flaky', typeId: 'test.flaky-until', config: { succeedAt: 3, retry: { maxAttempts: 3 } } },
    ]);
    expect(status).toBe('completed');
    const started = events.filter((e) => e.type === 'node.started' && e.nodeId === 'flaky').length;
    const failed = events.filter((e) => e.type === 'node.failed' && e.nodeId === 'flaky').length;
    const completed = events.filter((e) => e.type === 'node.completed' && e.nodeId === 'flaky').length;
    expect(started).toBe(3);
    expect(failed).toBe(2);
    expect(completed).toBe(1);
  });

  it('retry budget exhausted → the run fails with the last error (attempts capped)', async () => {
    const { status, events } = await runToTerminal('adr0326.retry-exhausted', [
      { nodeId: 'flaky', typeId: 'test.flaky-until', config: { succeedAt: 99, retry: { maxAttempts: 2 } } },
    ]);
    expect(status).toBe('failed');
    expect(events.filter((e) => e.type === 'node.started' && e.nodeId === 'flaky').length).toBe(2);
  });

  it('no retry config → exactly one attempt (unchanged behavior)', async () => {
    const { status, events } = await runToTerminal('adr0326.no-retry', [
      { nodeId: 'flaky', typeId: 'test.flaky-until', config: { succeedAt: 2 } },
    ]);
    expect(status).toBe('failed');
    expect(events.filter((e) => e.type === 'node.started' && e.nodeId === 'flaky').length).toBe(1);
  });
});

describe('ADR 0326 P2 — run-event ticks + the SSE watermark', () => {
  it('ticks coalesce (many publishes → one bus frame carrying the max seq); terminal flushes immediately', async () => {
    const seen: number[] = [];
    const unsub = await subscribeRunEventTicks('run-tick-co', (seq) => { seen.push(seq); });
    publishRunEventTick('run-tick-co', 1);
    publishRunEventTick('run-tick-co', 2);
    publishRunEventTick('run-tick-co', 3);
    await new Promise((r) => setTimeout(r, 200)); // > coalesce window
    expect(seen).toEqual([3]);
    publishRunEventTick('run-tick-co', 4, true); // terminal — immediate
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([3, 4]);
    await unsub();
  });

  it('the SSE stream delivers each event exactly once despite in-proc + tick double-sighting', async () => {
    // A run that suspends (conversation gate) so the stream stays open.
    await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({ workflowId: 'adr0326.sse', nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'x' } }], edges: [] }) });
    const create = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId: 'adr0326.sse', inputs: { provider: 'mock', model: 'mock-1' }, tenantId: '_anon' }) });
    const runId = create.body.runId;
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 20)); const s = (await api<{ status: string }>(`/v1/runs/${runId}`)).body.status; if (s.startsWith('waiting')) break; }

    const ac = new AbortController();
    const res = await fetch(`${BASE}/v1/runs/${runId}/events?stream=1`, { headers: { ...H, accept: 'text/event-stream' }, signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let buf = '';
    const readAll = (async () => {
      const dec = new TextDecoder();
      for (;;) { const { value, done } = await reader.read(); if (done) return; buf += dec.decode(value, { stream: true }); }
    })();
    await new Promise((r) => setTimeout(r, 150)); // stream subscribed

    // One exchange appends events; the in-proc fanout AND the (self-)tick both fire.
    const ex = await api(`/v1/runs/${runId}/interrupts/gate`, { method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: 'watermark probe' } } }) });
    expect(ex.status).toBe(200);
    await new Promise((r) => setTimeout(r, 400)); // in-proc + coalesced tick + gap fetch settle
    ac.abort();
    await readAll.catch(() => undefined);

    // Every conversation.exchanged sequence number appears exactly once.
    const seqs = [...buf.matchAll(/"sequence":(\d+)/g)].map((m) => Number(m[1]));
    const dupes = seqs.filter((s, i) => seqs.indexOf(s) !== i);
    expect(seqs.length).toBeGreaterThan(0);
    expect(dupes).toEqual([]);
  });
});

describe('post-merge review fixes (architect findings 1-2)', () => {
  it('an out-of-order in-proc event does NOT skip the watermark past a durable gap (contiguity rule)', async () => {
    // A suspended run + open stream; then simulate "instance B appended 2
    // events straight to durable" (no in-proc fanout, no tick) followed by an
    // in-proc append from "instance A" — the non-contiguous in-proc event must
    // trigger a gap fetch so ALL events deliver, in order.
    await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({ workflowId: 'adr0326.gap', nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'x' } }], edges: [] }) });
    const create = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId: 'adr0326.gap', inputs: { provider: 'mock', model: 'mock-1' }, tenantId: '_anon' }) });
    const runId = create.body.runId;
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 20)); const s = (await api<{ status: string }>(`/v1/runs/${runId}`)).body.status; if (s.startsWith('waiting')) break; }

    const ac = new AbortController();
    const res = await fetch(`${BASE}/v1/runs/${runId}/events?stream=1`, { headers: { ...H, accept: 'text/event-stream' }, signal: ac.signal });
    const reader = res.body!.getReader();
    let buf = '';
    const readAll = (async () => { const dec = new TextDecoder(); for (;;) { const { value, done } = await reader.read(); if (done) return; buf += dec.decode(value, { stream: true }); } })();
    await new Promise((r) => setTimeout(r, 150));

    const { hostExtStorage } = await import('../src/host/hostExtPersistence.js');
    const storage = hostExtStorage();
    // "Instance B": two durable appends that bypass the in-proc fanout + tick.
    await storage.appendEvent({ eventId: `gapb-1-${runId}`, runId, type: 'custom.gap-b', payload: { i: 1 }, timestamp: new Date().toISOString() });
    await storage.appendEvent({ eventId: `gapb-2-${runId}`, runId, type: 'custom.gap-b', payload: { i: 2 }, timestamp: new Date().toISOString() });
    // "Instance A": an in-proc append — NON-contiguous with the stream's watermark.
    const { getEventLog } = await import('../src/executor/eventLog.js');
    await getEventLog().append({ runId, type: 'custom.gap-a', payload: { i: 3 } });
    await new Promise((r) => setTimeout(r, 300)); // gap fetch settles
    ac.abort();
    await readAll.catch(() => undefined);

    const kinds = [...buf.matchAll(/"type":"custom\.gap-([ab])"/g)].map((m) => m[1]);
    expect(kinds).toEqual(['b', 'b', 'a']); // nothing dropped, delivered in order
    const seqs = [...buf.matchAll(/"sequence":(\d+)/g)].map((m) => Number(m[1]));
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs); // strictly ordered
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
  });

  it('countChatSessionMessages is exact and agrees with the adapter-maintained counter', async () => {
    // Review correction: the adapter bumps message_count ATOMICALLY on append
    // (an earlier hardening moved it out of the racy route RMW) — the Storage
    // interface doc-comment claiming "caller updates" was stale. The COUNT
    // primitive is the belt-and-braces truth for unread math either way
    // (immune to any path that writes rows without the adapter). Pin both.
    const { hostExtStorage } = await import('../src/host/hostExtPersistence.js');
    const storage = hostExtStorage();
    const sessionId = `count-probe-${Date.now()}`;
    const now = new Date().toISOString();
    await storage.createChatSession({ sessionId, tenantId: '_anon', title: 'probe', createdAt: now, updatedAt: now, messageCount: 0 });
    for (let i = 1; i <= 4; i++) {
      await storage.appendChatMessage({ messageId: `cp-${i}`, sessionId, role: 'user', content: `m${i}`, meta: null, authorSubject: null, createdAt: new Date(Date.now() + i).toISOString() });
    }
    await expect(storage.countChatSessionMessages(sessionId)).resolves.toBe(4);
    const session = await storage.getChatSession('_anon', sessionId);
    expect(session?.messageCount).toBe(4); // adapter-maintained — both sources agree
  });
});

describe('ADR 0326 P3b — fork re-execution (branch resumes from the checkpoint; replay reads the source invocation log)', () => {
  type EvDoc = { sequence: number; type: string; nodeId?: string; payload?: { outputs?: Record<string, unknown> } };
  async function listRunEvents(runId: string): Promise<EvDoc[]> {
    const res = await fetch(`${BASE}/v1/runs/${runId}/events`, { headers: { ...H, accept: 'application/json' } });
    return ((await res.json()) as { events: EvDoc[] }).events;
  }
  async function pollTerminal(runId: string): Promise<string> {
    let status = 'pending';
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 25));
      status = (await api<{ status: string }>(`/v1/runs/${runId}`)).body.status;
      if (['completed', 'failed', 'cancelled'].includes(status)) break;
    }
    return status;
  }

  it('a branch fork from a mid-run checkpoint does NOT re-execute the copied prefix; its outputs flow into the suffix', async () => {
    const emitExecutions: string[] = [];
    getNodeRegistry().register({
      typeId: 'test.p3b.emit', version: '1.0.0',
      async execute(ctx) {
        emitExecutions.push((ctx as { runId?: string }).runId ?? '?');
        return { status: 'success', outputs: { output: 'prefix-payload' } };
      },
    });
    getNodeRegistry().register({
      typeId: 'test.p3b.consume', version: '1.0.0',
      async execute(ctx) {
        return { status: 'success', outputs: { output: `saw:${JSON.stringify(ctx.inputs)}` } };
      },
    });
    await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({
      workflowId: 'adr0326.p3b-branch',
      nodes: [
        { nodeId: 'emit', typeId: 'test.p3b.emit' },
        { nodeId: 'consume', typeId: 'test.p3b.consume' },
      ],
      edges: [{ edgeId: 'e1', sourceNodeId: 'emit', targetNodeId: 'consume' }],
    }) });
    const create = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId: 'adr0326.p3b-branch', inputs: {}, tenantId: '_anon' }) });
    expect(create.status).toBe(201);
    const sourceRunId = create.body.runId;
    expect(await pollTerminal(sourceRunId)).toBe('completed');

    // Checkpoint = the seq of emit's node.completed (before consume started).
    const sourceEvents = await listRunEvents(sourceRunId);
    const emitDone = sourceEvents.find((e) => e.type === 'node.completed' && e.nodeId === 'emit');
    expect(emitDone).toBeDefined();

    const fork = await api<{ runId: string }>(`/v1/runs/${sourceRunId}:fork`, {
      // `replay.md` §Endpoint: events with `sequence < fromSeq` are FIXED HISTORY.
      // To make everything through `emitDone` fixed, fork from the NEXT sequence.
      // This test previously passed `emitDone.sequence` and still saw emit treated
      // as history because the host's prefix copied `sequence <= fromSeq` — an
      // off-by-one the 1-based numbering hid, and which the 0-based fix corrected.
      method: 'POST', body: JSON.stringify({ fromSeq: emitDone!.sequence + 1, mode: 'branch' }),
    });
    expect(fork.status).toBe(201);
    const forkRunId = fork.body.runId;
    expect(await pollTerminal(forkRunId)).toBe('completed');

    const forkEvents = await listRunEvents(forkRunId);
    // The prefix was COPIED, not re-executed: exactly one emit start/complete
    // pair (the copied one), and emit's execute() never ran under the fork run.
    expect(forkEvents.filter((e) => e.type === 'node.started' && e.nodeId === 'emit').length).toBe(1);
    expect(forkEvents.filter((e) => e.type === 'node.completed' && e.nodeId === 'emit').length).toBe(1);
    expect(emitExecutions).toEqual([sourceRunId]);
    // The suffix DID re-execute, fed by the checkpoint snapshot's outputs.
    const consumeDone = forkEvents.filter((e) => e.type === 'node.completed' && e.nodeId === 'consume');
    expect(consumeDone.length).toBe(1);
    expect(JSON.stringify(consumeDone[0]!.payload?.outputs ?? {})).toContain('prefix-payload');
  });

  // CORRECTED (ADR 0751) — this pinned `501 fork_checkpoint_unsupported`, a
  // refusal neither runs.md §Fork nor replay.md licenses. The fork now inherits
  // the open gate as state and re-creates its live interrupt; the full contract
  // is witnessed in `adr0751-fork-suspended-checkpoint.test.ts`.
  it('a branch fork whose fromSeq lands on a suspended checkpoint inherits the gate (ADR 0751 — was a 501)', async () => {
    await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({
      workflowId: 'adr0326.p3b-suspended',
      nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'x' } }],
      edges: [],
    }) });
    const create = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId: 'adr0326.p3b-suspended', inputs: { provider: 'mock', model: 'mock-1' }, tenantId: '_anon' }) });
    const runId = create.body.runId;
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 20)); const s = (await api<{ status: string }>(`/v1/runs/${runId}`)).body.status; if (s.startsWith('waiting')) break; }

    const events = await listRunEvents(runId);
    const maxSeq = Math.max(...events.map((e) => e.sequence));
    const fork = await api<{ runId?: string; error?: string }>(`/v1/runs/${runId}:fork`, {
      method: 'POST', body: JSON.stringify({ fromSeq: maxSeq, mode: 'branch' }),
    });
    expect(fork.status).toBe(201);
    const forkId = String(fork.body.runId);
    let forkStatus = '';
    for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 20)); forkStatus = (await api<{ status: string }>(`/v1/runs/${forkId}`)).body.status; if (forkStatus.startsWith('waiting') || forkStatus === 'failed') break; }
    expect(forkStatus).toMatch(/^waiting/);
    const gates = await api<{ interrupts: Array<{ kind: string }> }>(`/v1/host/openwop-app/runs/${forkId}/interrupts`);
    expect(gates.body.interrupts.map((g) => g.kind)).toEqual(['conversation']);
  });

  it('a replay fork of a RETRIED run reproduces the attempt sequence from the source invocation log (P3a + P3b e2e)', async () => {
    const { programMock, resetMockPrograms } = await import('../src/providers/dispatchMock.js');
    getNodeRegistry().register({
      typeId: 'test.p3b.ai', version: '1.0.0',
      async execute(ctx) {
        const callAI = (ctx as { callAI?: (req: unknown) => Promise<{ content: string }> }).callAI;
        if (!callAI) throw new Error('callAI missing from node ctx');
        const res = await callAI({ provider: 'mock', model: 'mock-1', messages: [{ role: 'user', content: 'deterministic probe' }] });
        return { status: 'success', outputs: { output: res.content } };
      },
    });
    resetMockPrograms();
    // Live behavior: attempt 1 → provider failure (recorded, P3a); attempt 2 → success.
    programMock('ai', [{ errorCode: 'provider_unavailable' }, { content: 'recovered' }]);

    await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({
      workflowId: 'adr0326.p3b-replay',
      nodes: [{ nodeId: 'ai', typeId: 'test.p3b.ai', config: { retry: { maxAttempts: 2 } } }],
      edges: [],
    }) });
    const create = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId: 'adr0326.p3b-replay', inputs: {}, tenantId: '_anon' }) });
    const sourceRunId = create.body.runId;
    expect(await pollTerminal(sourceRunId)).toBe('completed');
    const sourceEvents = await listRunEvents(sourceRunId);
    expect(sourceEvents.filter((e) => e.type === 'node.started' && e.nodeId === 'ai').length).toBe(2);
    expect(sourceEvents.filter((e) => e.type === 'node.failed' && e.nodeId === 'ai').length).toBe(1);

    // Replay fork — the mock program is EXHAUSTED, so any live dispatch would
    // return the default ''. Reproducing the failed→recovered attempt pair
    // proves both reads came from the SOURCE run's invocation log.
    const fork = await api<{ runId: string }>(`/v1/runs/${sourceRunId}:fork`, {
      method: 'POST', body: JSON.stringify({ fromSeq: 0, mode: 'replay' }),
    });
    expect(fork.status).toBe(201);
    const forkRunId = fork.body.runId;
    expect(await pollTerminal(forkRunId)).toBe('completed');
    const forkEvents = await listRunEvents(forkRunId);
    expect(forkEvents.filter((e) => e.type === 'node.started' && e.nodeId === 'ai').length).toBe(2);
    expect(forkEvents.filter((e) => e.type === 'node.failed' && e.nodeId === 'ai').length).toBe(1);
    const done = forkEvents.filter((e) => e.type === 'node.completed' && e.nodeId === 'ai');
    expect(done.length).toBe(1);
    expect(JSON.stringify(done[0]!.payload?.outputs ?? {})).toContain('recovered');

    // Fork-of-a-fork: the fallback reads only ONE level up, so this stays
    // deterministic only because the first fork's log self-healed via
    // copy-on-read (architect finding). Same attempt shape, same output.
    const fork2 = await api<{ runId: string }>(`/v1/runs/${forkRunId}:fork`, {
      method: 'POST', body: JSON.stringify({ fromSeq: 0, mode: 'replay' }),
    });
    expect(fork2.status).toBe(201);
    expect(await pollTerminal(fork2.body.runId)).toBe('completed');
    const fork2Events = await listRunEvents(fork2.body.runId);
    expect(fork2Events.filter((e) => e.type === 'node.started' && e.nodeId === 'ai').length).toBe(2);
    expect(fork2Events.filter((e) => e.type === 'node.failed' && e.nodeId === 'ai').length).toBe(1);
    const done2 = fork2Events.filter((e) => e.type === 'node.completed' && e.nodeId === 'ai');
    expect(JSON.stringify(done2[0]?.payload?.outputs ?? {})).toContain('recovered');
  });
});

describe('ADR 0326 P3a — invocation-log attempt fidelity (record failures, replay them)', () => {
  it('a failed provider call records at its attempt key; the same attempt REPLAYS the failure; the next attempt succeeds', async () => {
    const { createAiProvidersAdapter } = await import('../src/aiProviders/aiProvidersHost.js');
    const { beginNodeActivity } = await import('../src/host/effectIdentity.js');
    const { programMock, resetMockPrograms } = await import('../src/providers/dispatchMock.js');
    resetMockPrograms();
    const nodeId = 'p3a.fidelity';
    // Program: call 1 throws (transient), call 2 succeeds.
    programMock(nodeId, [{ errorCode: 'provider_unavailable' }, { content: 'recovered' }]);
    const mk = (attempt: number) => createAiProvidersAdapter({
      runId: 'run-p3a-1', nodeId, tenantId: '_anon', attempt, secrets: {},
    } as Parameters<typeof createAiProvidersAdapter>[0]);
    const req = { provider: 'mock', model: 'mock-1', messages: [{ role: 'user' as const, content: 'x' }] } as Parameters<ReturnType<typeof createAiProvidersAdapter>['callAI']>[0];

    // ADR 0549 P3 — each "replay" below re-enters the NODE BODY, so it declares
    // that explicitly. Under RFC 0150 §B a bare second `callAI` at the same
    // attempt is a SECOND logical effect ("a node that calls the same provider
    // twice on purpose is performing two effects, and they MUST NOT deduplicate
    // against each other"), so the ordinal advances and nothing is replayed.
    // Before P3 the two cases were indistinguishable, which is the ambiguity the
    // ordinal exists to remove — the executor calls this at every node launch.
    const reenter = (attempt: number) => beginNodeActivity('run-p3a-1', nodeId, attempt);

    // Attempt 1 LIVE — the programmed failure throws AND records.
    reenter(1);
    await expect(mk(1).callAI(req)).rejects.toMatchObject({ name: 'AiProviderError' });
    // Attempt 1 "REPLAY" — the recorded failure re-throws WITHOUT reaching the
    // dispatch (the mock program cursor stays on behavior 2 — proven below,
    // since attempt 2 still gets 'recovered').
    reenter(1);
    await expect(mk(1).callAI(req)).rejects.toMatchObject({ name: 'AiProviderError' });
    // Attempt 2 LIVE — the identity is UNCHANGED (that is §B retry stability),
    // but the record at it is a FAILURE, which never short-circuits a live
    // retry — otherwise `config.retry` could not exist for an AI node. So the
    // mock's SECOND behavior runs.
    reenter(2);
    const ok = await mk(2).callAI(req);
    expect(ok.content).toBe('recovered');
    // Attempt 2 "REPLAY" — cached success (the program is exhausted; a real
    // dispatch would return '' — 'recovered' proves the invocation-log hit).
    reenter(2);
    const replayed = await mk(2).callAI(req);
    expect(replayed.content).toBe('recovered');
  });

  // GC-CHAT-3 (grade pass 2026-07-10) — failure envelopes carry their CLASS
  // FAMILY. Replay must re-throw the same family (provider vs generic) or the
  // node-failure event's code/recovery-hint payload diverges from live; an
  // envelope with NO kind (recorded before the field existed) replays as a
  // provider failure — old runs keep replaying as they did. The generic
  // RECORD half is exercised at the classification seam by seeding (dispatch
  // wraps its own throws into AiProviderError, so a live generic throw needs
  // a non-dispatch fault — the branch is 3 lines, pinned here via replay).
  it('a generic failure envelope replays as a plain Error (name restored), and a kind-less envelope stays provider-classed', async () => {
    const { createAiProvidersAdapter, __lastInvocationCacheKeyForTests, AiProviderError } = await import('../src/aiProviders/aiProvidersHost.js');
    const { beginNodeActivity } = await import('../src/host/effectIdentity.js');
    const { getInvocationLog } = await import('../src/executor/invocationLog.js');
    const { programMock, resetMockPrograms } = await import('../src/providers/dispatchMock.js');
    resetMockPrograms();
    const nodeId = 'gcchat3.family';
    programMock(nodeId, [{ errorCode: 'provider_unavailable' }]);
    const mk = () => createAiProvidersAdapter({
      runId: 'run-gcchat3-1', nodeId, tenantId: '_anon', attempt: 1, secrets: {},
    } as Parameters<typeof createAiProvidersAdapter>[0]);
    const req = { provider: 'mock', model: 'mock-1', messages: [{ role: 'user' as const, content: 'x' }] } as Parameters<ReturnType<typeof createAiProvidersAdapter>['callAI']>[0];

    // ADR 0549 P3 — see the sibling case: each `callAI` below stands for a fresh
    // node-body entry, so the ordinal (and therefore the identity) is rewound.
    const reenter = () => beginNodeActivity('run-gcchat3-1', nodeId, 1);

    // LIVE provider failure → records with kind:'provider' at the attempt key.
    reenter();
    await expect(mk().callAI(req)).rejects.toMatchObject({ name: 'AiProviderError' });
    const key = __lastInvocationCacheKeyForTests();
    expect(key).toBeTruthy();
    const recorded = await getInvocationLog().get(key!) as Record<string, unknown>;
    expect(recorded['__openwopInvocationOutcome']).toBe('failure');
    expect(recorded['kind']).toBe('provider');

    // Seed a GENERIC envelope at the same key → replay throws a plain Error
    // with the live name restored, NOT an AiProviderError.
    await getInvocationLog().put(key!, { __openwopInvocationOutcome: 'failure', kind: 'generic', name: 'TypeError', message: 'boom from a dispatcher' });
    reenter();
    const genericErr = await mk().callAI(req).then(() => null, (e: unknown) => e);
    expect(genericErr).toBeInstanceOf(Error);
    expect(genericErr).not.toBeInstanceOf(AiProviderError);
    expect((genericErr as Error).name).toBe('TypeError');
    expect((genericErr as Error).message).toBe('boom from a dispatcher');

    // Back-compat: a kind-LESS envelope (pre-change record) replays provider-classed.
    await getInvocationLog().put(key!, { __openwopInvocationOutcome: 'failure', code: 'rate_limited', message: 'old-style envelope' });
    reenter();
    const legacyErr = await mk().callAI(req).then(() => null, (e: unknown) => e);
    expect(legacyErr).toBeInstanceOf(AiProviderError);
    expect((legacyErr as { code?: string }).code).toBe('rate_limited');
  });
});

// ── ADR 0341 (GC-FORK-2) — side-effecting nodes never fire on a replay fork ──
describe('ADR 0341 — replay-fork side-effect suppression', () => {
  type Ev341 = { type: string; nodeId?: string; payload?: { outputs?: Record<string, unknown>; error?: { code?: string } } };
  // The events route content-negotiates: SSE by default, JSON with accept.
  const listEv = async (runId: string): Promise<Ev341[]> => {
    const res = await fetch(`${BASE}/v1/runs/${runId}/events`, { headers: { ...H, accept: 'application/json' } });
    return ((await res.json()) as { events: Ev341[] }).events;
  };
  const terminal = async (runId: string): Promise<string> => {
    for (let i = 0; i < 100; i++) {
      const r = await api<{ status: string }>(`/v1/runs/${runId}`);
      if (['completed', 'failed', 'cancelled'].includes(r.body.status)) return r.body.status;
      await new Promise((res) => setTimeout(res, 50));
    }
    return 'timeout';
  };
  const mkRun = async (workflowId: string): Promise<string> => {
    const r = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: {}, tenantId: '_anon' }) });
    expect(r.status).toBe(201);
    return r.body.runId;
  };
  const fork = async (runId: string): Promise<string> => {
    const r = await api<{ runId: string }>(`/v1/runs/${runId}:fork`, { method: 'POST', body: JSON.stringify({ fromSeq: 0, mode: 'replay' }) });
    expect(r.status).toBe(201);
    return r.body.runId;
  };

  it('a flagged node does NOT re-execute on replay — the source outcome is reproduced; a pure node DOES', async () => {
    let effectFires = 0;
    let pureFires = 0;
    getNodeRegistry().register({
      typeId: 'test.adr0341.effect', version: '1.0.0', sideEffecting: true,
      async execute() { effectFires += 1; return { status: 'success', outputs: { receipt: `sent-${effectFires}` } }; },
    });
    getNodeRegistry().register({
      typeId: 'test.adr0341.pure', version: '1.0.0',
      async execute() { pureFires += 1; return { status: 'success', outputs: { n: 1 } }; },
    });
    await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({
      workflowId: 'adr0341.suppress',
      nodes: [{ nodeId: 'fx', typeId: 'test.adr0341.effect' }, { nodeId: 'p', typeId: 'test.adr0341.pure' }],
      edges: [],
    }) });
    const src = await mkRun('adr0341.suppress');
    expect(await terminal(src)).toBe('completed');
    expect(effectFires).toBe(1);

    const forked = await fork(src);
    expect(await terminal(forked)).toBe('completed');
    expect(effectFires).toBe(1); // the side effect did NOT fire again
    expect(pureFires).toBe(2);   // the pure node re-executed live
    const done = (await listEv(forked)).find((e) => e.type === 'node.completed' && e.nodeId === 'fx');
    expect(JSON.stringify(done?.payload?.outputs ?? {})).toContain('sent-1'); // the SOURCE outcome, verbatim
  });

  it('a retried flagged node reproduces the full attempt sequence without firing (P3a fidelity)', async () => {
    let fires = 0;
    getNodeRegistry().register({
      typeId: 'test.adr0341.retry-effect', version: '1.0.0', sideEffecting: true,
      async execute() {
        fires += 1;
        if (fires === 1) return { status: 'failure', error: { code: 'internal_error', message: 'transient send failure' } };
        return { status: 'success', outputs: { receipt: 'sent-after-retry' } };
      },
    });
    await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({
      workflowId: 'adr0341.retry',
      nodes: [{ nodeId: 'fx', typeId: 'test.adr0341.retry-effect', config: { retry: { maxAttempts: 2 } } }],
      edges: [],
    }) });
    const src = await mkRun('adr0341.retry');
    expect(await terminal(src)).toBe('completed');
    expect(fires).toBe(2);

    const forked = await fork(src);
    expect(await terminal(forked)).toBe('completed');
    expect(fires).toBe(2); // NEITHER attempt fired live
    const evs = await listEv(forked);
    expect(evs.filter((e) => e.type === 'node.failed' && e.nodeId === 'fx').length).toBe(1);
    expect(evs.filter((e) => e.type === 'node.completed' && e.nodeId === 'fx').length).toBe(1);
  });

  it('a flagged node the source never reached fails CLOSED (replay_source_missing) — a replay never fires a NEW side effect', async () => {
    let gateCalls = 0;
    let effectFires = 0;
    getNodeRegistry().register({
      typeId: 'test.adr0341.flaky-gate', version: '1.0.0',
      // Source run: fails (call 1) so the downstream effect never runs.
      // Replay: succeeds (call 2) — the divergence that exposes the gap.
      async execute() {
        gateCalls += 1;
        if (gateCalls === 1) return { status: 'failure', error: { code: 'internal_error', message: 'first pass fails' } };
        return { status: 'success', outputs: { ok: true } };
      },
    });
    getNodeRegistry().register({
      typeId: 'test.adr0341.effect2', version: '1.0.0', sideEffecting: true,
      async execute() { effectFires += 1; return { status: 'success', outputs: { receipt: 'should-never-send' } }; },
    });
    await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({
      workflowId: 'adr0341.missing',
      nodes: [{ nodeId: 'gate', typeId: 'test.adr0341.flaky-gate' }, { nodeId: 'fx', typeId: 'test.adr0341.effect2' }],
      edges: [{ edgeId: 'e1', sourceNodeId: 'gate', targetNodeId: 'fx' }],
    }) });
    const src = await mkRun('adr0341.missing');
    expect(await terminal(src)).toBe('failed');
    expect(effectFires).toBe(0);

    const forked = await fork(src);
    expect(await terminal(forked)).toBe('failed');
    expect(effectFires).toBe(0); // fail-closed: the NEW side effect never fired
    const failedFx = (await listEv(forked)).find((e) => e.type === 'node.failed' && e.nodeId === 'fx');
    expect(failedFx?.payload?.error?.code).toBe('replay_source_missing');
  });
});
