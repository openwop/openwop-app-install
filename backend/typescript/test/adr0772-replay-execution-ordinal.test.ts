/**
 * ADR 0772 D2 + D6 — a replay fork serves each execution of a side-effecting
 * node the source's outcome for THAT execution, on every entry into the fork.
 *
 * Route-level: the source runs through `POST /v1/runs`, the fork through
 * `POST /v1/runs/{id}:fork`, and the gate through `POST /v1/interrupts/{token}`,
 * all against the real executor. The witness of "no side effect fired" is a
 * counter inside the node's own `execute` — the only place a real effect would
 * happen — so a replay-served outcome and a live execution cannot be confused.
 *
 *  - `RRWF-19` (D6): a replay fork that inherits an OPEN gate (ADR 0751) and is
 *    then resolved used to re-enter the executor with no replay source, so the
 *    side-effecting node after the gate executed LIVE.
 *  - `RRWF-4`: a fork cut inside a retried node's second execution restored the
 *    node as `failed` (the fold ignored `node.started`) and never re-ran it.
 *  - `RRWF-3` (D2): the served outcome is keyed on the execution ordinal, not the
 *    per-body attempt — a fork cut after the first failed execution is served
 *    the SECOND execution's outcome for its first live execution.
 *
 * Red when (wave 60 probes, tracker TST-BRB-6): a resumed replay fork loses its
 * run-level replay source (RRWF-19 positive and fail-closed halves); the fail-closed
 * `replay_source_missing` arm is dropped; a terminal stops closing an execution; the
 * served outcome is keyed on the per-body attempt instead of the execution ordinal
 * (the `second-completed` fork); `snapshotFromEventPrefix` stops reopening a node
 * started in the prefix (the IN FLIGHT fold, and the `second-completed` fork); the
 * H1 replay re-open (`sourceOrdinals.highest(id) > consumed`) is dropped (the
 * `second-start` fork, whose prefix ends at `failed(1)`).
 *
 * Not a witness, recorded: `ExecutionOrdinals.start`'s early `return open` is
 * behaviourally redundant (an open ordinal always equals closed + 1, which the
 * fallthrough recomputes), so w60g2-rpo-open-continues was an equivalent mutant.
 *
 * Ceiling, recorded: the `slow` node's real 800 ms and the 20 ms status polls are the
 * real executor's timing; the pause must land while `slow` runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { ExecutionOrdinals, indexSourceOutcomes } from '../src/executor/sideEffects.js';
import { snapshotFromEventPrefix } from '../src/executor/executor.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import { bareRunId } from './support/bareRunId.js';

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

/** Real executions per run — the effect a replay must never repeat. */
const effectRuns = new Map<string, number>();
const flakyRuns = new Map<string, number>();

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  const registry = getNodeRegistry();
  registry.register({
    typeId: 'test.adr0772.effect',
    version: '1.0.0',
    sideEffecting: true,
    async execute(ctx) {
      const id = bareRunId(ctx.runId);
      effectRuns.set(id, (effectRuns.get(id) ?? 0) + 1);
      return { status: 'success', outputs: { sent: true } };
    },
  });
  // Fails its FIRST execution in a run, succeeds after — a real retry in the source.
  registry.register({
    typeId: 'test.adr0772.flaky',
    version: '1.0.0',
    sideEffecting: true,
    async execute(ctx) {
      const id = bareRunId(ctx.runId);
      const n = (flakyRuns.get(id) ?? 0) + 1;
      flakyRuns.set(id, n);
      return n === 1
        ? { status: 'failure', error: { code: 'upstream_unavailable', message: 'first try fails' } }
        : { status: 'success', outputs: { delivered: n } };
    },
  });
  const gateThenEffect: WorkflowDefinition = {
    workflowId: 'wf.adr0772.gate-effect',
    nodes: [
      { nodeId: 'gate', typeId: 'core.approvalGate', config: { title: 'ADR 0772', actions: ['accept', 'reject'] } },
      { nodeId: 'effect', typeId: 'test.adr0772.effect', config: {} },
    ],
    edges: [{ edgeId: 'g-e', sourceNodeId: 'gate', targetNodeId: 'effect' }],
  };
  const retried: WorkflowDefinition = {
    workflowId: 'wf.adr0772.retried',
    nodes: [
      { nodeId: 'start', typeId: 'core.noop', config: {} },
      { nodeId: 'flaky', typeId: 'test.adr0772.flaky', config: { retry: { maxAttempts: 2 } } },
    ],
    edges: [{ edgeId: 's-f', sourceNodeId: 'start', targetNodeId: 'flaky' }],
  };
  // A PURE slow step, so a replay fork can be paused while it runs — before `effect`.
  registry.register({
    typeId: 'test.adr0772.slow',
    version: '1.0.0',
    async execute() {
      await new Promise((r) => setTimeout(r, 800));
      return { status: 'success', outputs: { waited: true } };
    },
  });
  const slowThenEffect: WorkflowDefinition = {
    workflowId: 'wf.adr0772.slow-effect',
    nodes: [
      { nodeId: 'start', typeId: 'core.noop', config: {} },
      { nodeId: 'slow', typeId: 'test.adr0772.slow', config: {} },
      { nodeId: 'effect', typeId: 'test.adr0772.effect', config: {} },
    ],
    edges: [{ edgeId: 's-w', sourceNodeId: 'start', targetNodeId: 'slow' }, { edgeId: 'w-e', sourceNodeId: 'slow', targetNodeId: 'effect' }],
  };
  registerWorkflow(gateThenEffect);
  registerWorkflow(retried);
  registerWorkflow(slowThenEffect);
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

type Json = Record<string, unknown>;
type Ev = { sequence: number; type: string; nodeId?: string; payload?: Json };
async function api<T = Json>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}
const TERMINAL = ['completed', 'failed', 'cancelled'];
async function waitStatus(runId: string, pred: (s: string) => boolean): Promise<string> {
  let status = '';
  for (let i = 0; i < 300; i++) {
    status = (await api<{ status: string }>(`/runs/${runId}`)).body.status;
    if (pred(status)) return status;
    await new Promise((r) => setTimeout(r, 20));
  }
  return status;
}
async function events(runId: string): Promise<Ev[]> {
  return (await api<{ events: Ev[] }>(`/runs/${runId}/events/poll?fromSeq=-1&limit=1000`)).body.events ?? [];
}
async function openGate(runId: string): Promise<string> {
  const list = (await api<{ interrupts: Array<{ token: string }> }>(`/host/openwop-app/runs/${bareRunId(runId)}/interrupts`)).body.interrupts ?? [];
  expect(list.length, `run ${runId} must have an open gate`).toBeGreaterThan(0);
  return list[0]!.token;
}
async function accept(token: string): Promise<void> {
  const r = await api(`/interrupts/${token}`, { method: 'POST', body: JSON.stringify({ resumeValue: { action: 'accept' } }) });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
}
async function startRun(workflowId: string): Promise<string> {
  const r = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId }) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.runId;
}
async function forkReplay(runId: string, fromSeq: number): Promise<string> {
  const f = await api<{ runId: string }>(`/runs/${runId}:fork`, { method: 'POST', body: JSON.stringify({ mode: 'replay', fromSeq }) });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  return f.body.runId;
}

describe('ADR 0772 D6 (RRWF-19) — a RESUMED replay fork still suppresses side effects', () => {
  // NOT an ADR 0772 D6 witness: the fork's FIRST body derives the decided gate
  // (RFC 0223, forkReplayResolutions.ts) and never re-enters through the resolve
  // route, so deleting D6 would leave this green. The positive D6 half is the
  // `:pause`/`:resume` leg below.
  it('RFC 0223 derivation witness: a replay fork inheriting a gate the SOURCE decided derives it in its first body, and serves the node after it', async () => {
    const src = await startRun('wf.adr0772.gate-effect');
    expect(await waitStatus(src, (s) => s.startsWith('waiting'))).toBe('waiting-approval');
    const suspendedAt = (await events(src)).find((e) => e.type === 'node.suspended' && e.nodeId === 'gate')!.sequence;
    await accept(await openGate(src));
    expect(await waitStatus(src, (s) => TERMINAL.includes(s))).toBe('completed');
    expect(effectRuns.get(bareRunId(src))).toBe(1);

    // Fork AFTER the suspension: the fork inherits the gate as state (ADR 0751).
    // RFC 0223 (openwop#1756) — the source RECORDED the decision, so the replay
    // derives it rather than waiting on a new one (this used to need the fork's
    // gate accepted by hand, i.e. a re-decided replay).
    const forkId = await forkReplay(src, suspendedAt + 1);
    expect(await waitStatus(forkId, (s) => s.startsWith('waiting') || TERMINAL.includes(s))).toBe('completed');

    // The effect never executed in the fork: it was served the source's outcome.
    expect(effectRuns.get(bareRunId(forkId)) ?? 0, 'a replay fork must never fire a side effect, resumed or not').toBe(0);
    const forkEffect = (await events(forkId)).filter((e) => e.nodeId === 'effect' && e.type === 'node.completed');
    expect(forkEffect).toHaveLength(1);
    expect(forkEffect[0]!.payload?.['outputs']).toEqual({ sent: true });
  });

  it('RRWF-19 (positive half): a replay fork RESUMED through `:resume` still serves the side-effecting node from the source', async () => {
    // Source runs to completion: `effect` records {sent:true} once.
    const src = await startRun('wf.adr0772.slow-effect');
    expect(await waitStatus(src, (s) => TERMINAL.includes(s))).toBe('completed');
    expect(effectRuns.get(bareRunId(src))).toBe(1);
    // Fork as a replay from `slow`'s start, so the fork re-runs `slow` and is
    // paused (drain-current-node) before `effect` — the resume path, not the
    // fork's first body, is what reaches `effect`.
    const slowAt = (await events(src)).find((e) => e.type === 'node.started' && e.nodeId === 'slow')!.sequence;
    const forkId = await forkReplay(src, slowAt);
    for (let i = 0; i < 100 && !(await events(forkId)).some((e) => e.type === 'node.started' && e.nodeId === 'slow' && e.sequence >= slowAt); i++) await new Promise((r) => setTimeout(r, 20));
    const pause = await api(`/runs/${forkId}:pause`, { method: 'POST', body: JSON.stringify({ drainPolicy: 'drain-current-node' }) });
    expect(pause.status, JSON.stringify(pause.body)).toBeLessThan(300);
    expect(await waitStatus(forkId, (s) => s === 'paused' || TERMINAL.includes(s)), 'paused BEFORE effect').toBe('paused');
    expect((await events(forkId)).some((e) => e.nodeId === 'effect' && e.sequence >= slowAt), 'effect must not have been reached before the resume').toBe(false);
    const resume = await api(`/runs/${forkId}:resume`, { method: 'POST', body: '{}' });
    expect(resume.status, JSON.stringify(resume.body)).toBeLessThan(300);
    expect(await waitStatus(forkId, (s) => TERMINAL.includes(s))).toBe('completed');
    const effectDone = (await events(forkId)).filter((e) => e.nodeId === 'effect' && e.type === 'node.completed');
    expect(effectDone).toHaveLength(1);
    expect(effectDone[0]!.payload?.['outputs'], 'served the source\'s recorded outcome').toEqual({ sent: true });
    expect(effectRuns.get(bareRunId(forkId)) ?? 0, 'a RESUMED replay fork must never fire a side effect').toBe(0);
  });

  it('RRWF-19 (fail-closed half): a gate the source NEVER decided is re-created live; once resolved, the effect after it is still NOT fired (no source outcome ⇒ fail closed)', async () => {
    const src = await startRun('wf.adr0772.gate-effect');
    expect(await waitStatus(src, (s) => s.startsWith('waiting'))).toBe('waiting-approval');
    const suspendedAt = (await events(src)).find((e) => e.type === 'node.suspended' && e.nodeId === 'gate')!.sequence;
    const forkId = await forkReplay(src, suspendedAt + 1);
    expect(await waitStatus(forkId, (s) => s.startsWith('waiting') || TERMINAL.includes(s))).toBe('waiting-approval');
    await accept(await openGate(forkId));
    expect(await waitStatus(forkId, (s) => TERMINAL.includes(s))).toBe('failed');
    expect(effectRuns.get(bareRunId(forkId)) ?? 0, 'a replay fork must never fire a side effect, resumed or not').toBe(0);
    const failed = (await events(forkId)).find((e) => e.nodeId === 'effect' && e.type === 'node.failed');
    expect((failed?.payload?.['error'] as { code?: string } | undefined)?.code).toBe('replay_source_missing');
  });
});

describe('ADR 0772 D2 / RRWF-4 — a fork cut inside a retried node', () => {
  it('source: the node fails once, retries, completes', async () => {
    const src = await startRun('wf.adr0772.retried');
    expect(await waitStatus(src, (s) => TERMINAL.includes(s))).toBe('completed');
    const flaky = (await events(src)).filter((e) => e.nodeId === 'flaky').map((e) => e.type);
    expect(flaky).toEqual(['node.started', 'node.failed', 'node.started', 'node.completed']);
    expect(flakyRuns.get(bareRunId(src))).toBe(2);
  });

  for (const cut of ['second-start', 'second-completed'] as const) {
    it(`a replay fork at the ${cut} re-runs the node and is served execution 2's outcome, firing nothing`, async () => {
      const src = await startRun('wf.adr0772.retried');
      expect(await waitStatus(src, (s) => TERMINAL.includes(s))).toBe('completed');
      const flaky = (await events(src)).filter((e) => e.nodeId === 'flaky');
      // second-start: the prefix ends `failed(1)` — the natural "fork from here"
      // on attempt 2 (grade-code H1: the fold restored the node `failed`). Held by
      // the H1 replay re-open in executeRunBody, not by the ordinal key: the fork's
      // first live attempt and its execution ordinal are both 2 here.
      // second-completed: the prefix also holds started(2) — the node was IN
      // FLIGHT in its second execution (the in-flight fold + the ordinal key).
      const fromSeq = cut === 'second-start' ? flaky[2]!.sequence : flaky[3]!.sequence;
      const forkId = await forkReplay(src, fromSeq);
      expect(await waitStatus(forkId, (s) => TERMINAL.includes(s))).toBe('completed');
      expect(flakyRuns.get(bareRunId(forkId)) ?? 0, 'the replay must not execute the node live').toBe(0);
      const tail = (await events(forkId)).filter((e) => e.sequence >= fromSeq && e.nodeId === 'flaky').map((e) => e.type);
      // The execution the fork runs is execution 2, served `completed` — never
      // execution 1's failure replayed a second time.
      expect(tail).toEqual(['node.started', 'node.completed']);
    });
  }

  it('a full replay (fromSeq 0) reproduces the source retry, execution by execution', async () => {
    const src = await startRun('wf.adr0772.retried');
    expect(await waitStatus(src, (s) => TERMINAL.includes(s))).toBe('completed');
    const forkId = await forkReplay(src, 0);
    expect(await waitStatus(forkId, (s) => TERMINAL.includes(s))).toBe('completed');
    expect(flakyRuns.get(bareRunId(forkId)) ?? 0).toBe(0);
    const flaky = (await events(forkId)).filter((e) => e.nodeId === 'flaky').map((e) => e.type);
    expect(flaky).toEqual(['node.started', 'node.failed', 'node.started', 'node.completed']);
  });
});

describe('ADR 0772 (grade-code H1) — a BRANCH fork inside a retry applies the retry policy', () => {
  it('a branch fork at the retry start re-runs the node live instead of failing the fork', async () => {
    const src = await startRun('wf.adr0772.retried');
    expect(await waitStatus(src, (s) => TERMINAL.includes(s))).toBe('completed');
    const flaky = (await events(src)).filter((e) => e.nodeId === 'flaky');
    const f = await api<{ runId: string }>(`/runs/${src}:fork`, { method: 'POST', body: JSON.stringify({ mode: 'branch', fromSeq: flaky[2]!.sequence }) });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    // A branch re-fires: the node runs live in the fork (its first live execution
    // there fails, per the test node) and the prefix's consumed attempt counts
    // against `maxAttempts: 2`, so it is NOT retried again: the fork fails with
    // the node's own error, never as a node restored dead from the prefix.
    expect(await waitStatus(f.body.runId, (s) => TERMINAL.includes(s))).toBe('failed');
    expect(flakyRuns.get(bareRunId(f.body.runId)), 'the node must re-run live in a branch').toBe(1);
  });
});

describe('ADR 0772 D2 — the open-execution fold', () => {
  const ev = (type: string, nodeId: string, payload: Json = {}) => ({ type, nodeId, payload });

  it('a start after a suspend, a cut or a fork boundary continues the execution; a terminal closes it', () => {
    const ord = ExecutionOrdinals.fold([
      ev('node.started', 'a'), ev('node.suspended', 'a'), ev('node.started', 'a'), // reinvoke: same execution
      ev('node.failed', 'a'),
      ev('node.started', 'a'), ev('node.started', 'a'), // pause cut, then resumed: same execution
      ev('node.completed', 'a'),
      ev('node.failed', 'b'), // pre-start refusal: an orphan, ignored
    ]);
    expect(ord.highest('a')).toBe(2);
    expect(ord.highest('b')).toBe(0);
    expect(ord.start('a')).toBe(3);
  });

  it('retry → suspend → retry → complete folds to one outcome per execution (the RRWF-3 example)', () => {
    const idx = indexSourceOutcomes([
      ev('node.started', 'x'), ev('node.failed', 'x', { error: { code: 'e1', message: 'one' } }),
      ev('node.started', 'x'), ev('node.suspended', 'x'), ev('node.started', 'x'),
      ev('node.failed', 'x', { error: { code: 'e2', message: 'two' } }),
      ev('node.started', 'x'), ev('node.completed', 'x', { outputs: { ok: 1 } }),
    ]);
    expect([...idx.get('x')!.entries()].map(([n, o]) => [n, o.kind])).toEqual([[1, 'failed'], [2, 'failed'], [3, 'completed']]);
  });

  it('snapshotFromEventPrefix restores a node retried in the prefix as IN FLIGHT, not failed (RRWF-4)', () => {
    const snap = snapshotFromEventPrefix([
      ev('node.started', 'start'), ev('node.completed', 'start', { outputs: {} }),
      ev('node.started', 'flaky'), ev('node.failed', 'flaky', { error: { code: 'e', message: 'm' } }),
      ev('node.started', 'flaky'),
    ]);
    const states = new Map(snap.nodeState);
    expect(states.get('start')).toBe('completed');
    expect(states.has('flaky'), 'an in-flight node is left unset so the fork re-executes it').toBe(false);
    expect(new Map(snap.nodeErrors).has('flaky')).toBe(false);
  });
});
