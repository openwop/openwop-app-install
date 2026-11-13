/**
 * ADR 1058 / RFC 0258 (`Draft`) — the declared, bounded refine loopback, end to
 * end through the real executor: `POST /v1/runs`, the gate resolved through
 * `POST /v1/interrupts/{token}`, a replay fork through `POST /v1/runs/{id}:fork`.
 *
 * What each leg witnesses:
 *  - a refine on a native gate (`core.approvalGate`) marks the gate's
 *    `node.completed` with `loopback {edgeId, targetNodeId, round, rearmed}`
 *    (`LOOPBACK_MARKER_WRITE_KEY`; the first cut wrote the vendor-hatch key),
 *    re-runs the region (the producer runs again), raises a NEW
 *    `interrupt.requested` under a different key, and never starts the node
 *    after the gate (RFC 0258 §C.1–C.3);
 *  - the producer receives every earlier round on its `historyInput` port, its
 *    own outputs and the reviewer's feedback, rebuilt from the log (§C.4);
 *  - a refine on a `ctx.suspend` gate whose resume key is its own node id (the
 *    shape of `core.chat.approvalGate`) is asked again under `#v1` instead of
 *    being served its own first answer (ADR 1058 D1, the B1 defect);
 *  - after `maxIterations` rounds `withdraw` drops `refine` from the offered
 *    actions, a refine resume is refused `400`, and accept still completes the
 *    run with the downstream node run once (§D);
 *  - under `fail` the refine past the cap emits `workflow.loopback-limit` and
 *    `cap.breached {kind:'loopback-iterations'}` and fails the run
 *    `loop_limit_exceeded` (§D);
 *  - a replay fork cut right after round 1's marked completion resumes with the
 *    region re-armed (the gate asked again), not with the gate completed and the
 *    downstream node released (§C.6, the fold in `snapshotFromEventPrefix`);
 *  - a gate WITHOUT a loopback edge keeps today's key `…:gate:0` and no marker,
 *    flag on or off (stored runs replay byte-identically).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { validateWorkflowDefinition } from '../src/host/workflowDefinitionValidation.js';
import { bareRunId } from './support/bareRunId.js';
import { LOOPBACK_MARKER_WRITE_KEY } from '../src/executor/loopbackWire.js';

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

const draftRuns = new Map<string, number>();
const applyRuns = new Map<string, number>();
const bump = (m: Map<string, number>, runId: string): number => { const n = (m.get(bareRunId(runId)) ?? 0) + 1; m.set(bareRunId(runId), n); return n; };

function def(workflowId: string, gateTypeId: string, loopback: Record<string, unknown> | null): unknown {
  return {
    workflowId,
    nodes: [
      { nodeId: 'draft', typeId: 'test.adr1058.draft', config: {} },
      { nodeId: 'gate', typeId: gateTypeId, config: { title: 'Review the draft', actions: ['accept', 'reject', 'refine'] } },
      { nodeId: 'apply', typeId: 'test.adr1058.apply', config: {} },
    ],
    edges: [
      { id: 'd-g', sourceNodeId: 'draft', targetNodeId: 'gate' },
      ...(loopback ? [{ id: 'again', sourceNodeId: 'gate', targetNodeId: 'draft', loopback }] : []),
      { id: 'g-a', sourceNodeId: 'gate', targetNodeId: 'apply' },
    ],
  };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_BOUNDED_LOOPBACK = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  const registry = getNodeRegistry();
  registry.register({
    typeId: 'test.adr1058.draft',
    version: '1.0.0',
    async execute(ctx) {
      const rounds = (ctx.inputs as Record<string, unknown> | undefined)?.['rounds'];
      return { status: 'success', outputs: { draft: `draft-${bump(draftRuns, ctx.runId)}`, ...(rounds !== undefined ? { rounds } : {}) } };
    },
  });
  registry.register({
    typeId: 'test.adr1058.apply',
    version: '1.0.0',
    async execute(ctx) { bump(applyRuns, ctx.runId); return { status: 'success', outputs: { applied: true } }; },
  });
  // The shape of `core.chat.approvalGate`: a ctx.suspend whose resume key is its node id.
  registry.register({
    typeId: 'test.adr1058.suspendGate',
    version: '1.0.0',
    async execute(ctx) {
      const r = await ctx.suspend!({ reason: 'approval', resumeKey: ctx.nodeId, title: 'Review', actions: ['accept', 'reject', 'refine'] }) as { action?: string };
      return { status: 'success', outputs: { decision: r?.action ?? 'unknown', seenLoopback: ctx.loopback ?? null } };
    },
  });
  for (const raw of [
    def('wf.adr1058.native', 'core.approvalGate', { on: 'refine', maxIterations: 2, historyInput: 'rounds' }),
    def('wf.adr1058.native-fail', 'core.approvalGate', { on: 'refine', maxIterations: 1, onExhausted: 'fail' }),
    def('wf.adr1058.reinvoke', 'test.adr1058.suspendGate', { on: 'refine', maxIterations: 2 }),
    def('wf.adr1058.no-loop', 'core.approvalGate', null),
  ]) registerWorkflow(validateWorkflowDefinition(raw));
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_BOUNDED_LOOPBACK;
  await new Promise<void>((res) => server.close(() => res()));
});

type Json = Record<string, unknown>;
type Ev = { sequence: number; type: string; nodeId?: string; payload?: Json };
async function api<T = Json>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}
const TERMINAL = ['completed', 'failed', 'cancelled'];
async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < 300 && !ok(v); i++) { await new Promise((r) => setTimeout(r, 20)); v = await read(); }
  return v;
}
const status = async (runId: string): Promise<string> => (await api<{ status: string }>(`/runs/${runId}`)).body.status;
async function events(runId: string): Promise<Ev[]> {
  return (await api<{ events: Ev[] }>(`/runs/${runId}/events/poll?fromSeq=-1&limit=1000`)).body.events ?? [];
}
const requests = (evs: Ev[]): Ev[] => evs.filter((e) => e.type === 'interrupt.requested' && e.nodeId === 'gate');
/** Wait until the gate has raised `n` requests and the run waits on it. */
async function waitRequests(runId: string, n: number): Promise<Ev[]> {
  await waitFor(async () => requests(await events(runId)).length, (c) => c >= n);
  await waitFor(() => status(runId), (s) => s === 'waiting-approval' || TERMINAL.includes(s));
  return events(runId);
}
async function openToken(runId: string): Promise<string> {
  const list = (await api<{ interrupts: Array<{ token: string }> }>(`/host/openwop-app/runs/${bareRunId(runId)}/interrupts`)).body.interrupts ?? [];
  expect(list.length, `run ${runId} must have an open gate`).toBeGreaterThan(0);
  return list[0]!.token;
}
async function decide(runId: string, resumeValue: Json): Promise<{ status: number; body: Json }> {
  return api(`/interrupts/${await openToken(runId)}`, { method: 'POST', body: JSON.stringify({ resumeValue }) });
}
const REFINE = { action: 'refine', refineFeedback: { scope: 'whole', text: 'Another option, please.' } };
async function startRun(workflowId: string): Promise<string> {
  const r = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId }) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.runId;
}
const keyOf = (e: Ev | undefined): string => String(e?.payload?.['key']);
const actionsOf = (e: Ev | undefined): unknown => (e?.payload?.['data'] as Json | undefined)?.['actions'];

describe('ADR 1058 — a refine re-enters the producer, bounded', () => {
  it('native gate: refine marks the completion, re-runs the region under a new key, and never reaches the node after the gate', async () => {
    const runId = await startRun('wf.adr1058.native');
    await waitRequests(runId, 1);
    const r = await decide(runId, REFINE);
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const evs = await waitRequests(runId, 2);
    expect(await status(runId)).toBe('waiting-approval');

    const marked = evs.filter((e) => e.type === 'node.completed' && e.nodeId === 'gate');
    expect(marked).toHaveLength(1);
    expect(marked[0]!.payload?.[LOOPBACK_MARKER_WRITE_KEY]).toEqual({ edgeId: 'again', targetNodeId: 'draft', round: 1, rearmed: ['draft', 'gate'] });
    expect(evs.filter((e) => e.type === 'node.started' && e.nodeId === 'draft')).toHaveLength(2);
    const [first, second] = requests(evs);
    expect(keyOf(first).endsWith(':gate:0'), keyOf(first)).toBe(true);
    expect(keyOf(second).endsWith(':gate:1'), keyOf(second)).toBe(true);
    expect(evs.some((e) => e.nodeId === 'apply'), 'nothing leaves the region on a refine').toBe(false);
    expect(applyRuns.get(bareRunId(runId)) ?? 0).toBe(0);
    // §C.4 — the producer sees the round it replaces, from the log, with no run-scoped bytes.
    const drafts = evs.filter((e) => e.type === 'node.completed' && e.nodeId === 'draft').map((e) => e.payload?.['outputs'] as Json);
    expect(drafts[0]).toEqual({ draft: 'draft-1', rounds: [] });
    expect(drafts[1]).toEqual({ draft: 'draft-2', rounds: [{ round: 1, outputs: { draft: 'draft-1', rounds: [] }, refineFeedback: REFINE.refineFeedback }] });
  });

  it('ctx.suspend gate keyed by its node id: visit 1 is asked again under #v1, not served its own first answer', async () => {
    const runId = await startRun('wf.adr1058.reinvoke');
    await waitRequests(runId, 1);
    expect((await decide(runId, REFINE)).status).toBeLessThan(300);
    const evs = await waitRequests(runId, 2);
    expect(await status(runId)).toBe('waiting-approval');
    const [first, second] = requests(evs);
    expect(keyOf(first).endsWith(':gate:gate'), keyOf(first)).toBe(true);
    expect(keyOf(second).endsWith(':gate:gate#v1'), keyOf(second)).toBe(true);
    expect(evs.filter((e) => e.type === 'interrupt.resolved' && e.nodeId === 'gate'), 'only the caller decided').toHaveLength(1);
    // Accept the second visit: the gate completes unmarked and releases `apply` once.
    expect((await decide(runId, { action: 'accept' })).status).toBeLessThan(300);
    expect(await waitFor(() => status(runId), (s) => TERMINAL.includes(s))).toBe('completed');
    expect(applyRuns.get(bareRunId(runId))).toBe(1);
    expect(draftRuns.get(bareRunId(runId))).toBe(2);
    // ADR 1058 PR-B — the gate sees the host's round count on ctx.loopback.
    const gateDone = (await events(runId)).filter((e) => e.type === 'node.completed' && e.nodeId === 'gate').map((e) => (e.payload?.['outputs'] as Json)['seenLoopback']);
    expect(gateDone).toEqual([{ round: 0, maxIterations: 2, exhausted: false }, { round: 1, maxIterations: 2, exhausted: false }]);
  });

  it('withdraw (default): after maxIterations rounds refine is no longer offered, a refine is refused 400, accept completes', async () => {
    const runId = await startRun('wf.adr1058.native');
    await waitRequests(runId, 1);
    expect((await decide(runId, REFINE)).status).toBeLessThan(300);
    await waitRequests(runId, 2);
    expect((await decide(runId, REFINE)).status).toBeLessThan(300);
    const evs = await waitRequests(runId, 3);
    const third = requests(evs)[2];
    expect(actionsOf(requests(evs)[1])).toContain('refine');
    expect(actionsOf(third)).not.toContain('refine');
    expect(actionsOf(third)).toEqual(expect.arrayContaining(['accept', 'reject']));

    const refused = await decide(runId, REFINE);
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(await status(runId)).toBe('waiting-approval');

    expect((await decide(runId, { action: 'accept' })).status).toBeLessThan(300);
    expect(await waitFor(() => status(runId), (s) => TERMINAL.includes(s))).toBe('completed');
    expect(draftRuns.get(bareRunId(runId))).toBe(3);
    expect(applyRuns.get(bareRunId(runId))).toBe(1);
  });

  it('fail: a refine past the cap emits the two cap events and fails the run loop_limit_exceeded', async () => {
    const runId = await startRun('wf.adr1058.native-fail');
    await waitRequests(runId, 1);
    expect((await decide(runId, REFINE)).status).toBeLessThan(300);
    const evs2 = await waitRequests(runId, 2);
    expect(actionsOf(requests(evs2)[1]), 'fail keeps refine offered').toContain('refine');
    expect((await decide(runId, REFINE)).status).toBeLessThan(300);
    expect(await waitFor(() => status(runId), (s) => TERMINAL.includes(s))).toBe('failed');
    const evs = await events(runId);
    expect(evs.find((e) => e.type === 'workflow.loopback-limit')?.payload).toMatchObject({ nodeId: 'gate', iterations: 1, limit: 1 });
    expect(evs.find((e) => e.type === 'cap.breached')?.payload).toMatchObject({ kind: 'loopback-iterations', limit: 1, observed: 2 });
    expect(evs.find((e) => e.type === 'node.failed' && e.nodeId === 'gate')?.payload?.['error']).toMatchObject({ code: 'loop_limit_exceeded', retryable: false });
    expect(applyRuns.get(bareRunId(runId)) ?? 0).toBe(0);
  });

  it('a replay fork cut after round 1\'s marked completion resumes with the region re-armed', async () => {
    const src = await startRun('wf.adr1058.native');
    await waitRequests(src, 1);
    expect((await decide(src, REFINE)).status).toBeLessThan(300);
    const evs = await waitRequests(src, 2);
    const markedAt = evs.find((e) => e.type === 'node.completed' && e.nodeId === 'gate')!.sequence;
    const f = await api<{ runId: string }>(`/runs/${src}:fork`, { method: 'POST', body: JSON.stringify({ mode: 'replay', fromSeq: markedAt + 1 }) });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    const fork = f.body.runId;
    expect(await waitFor(() => status(fork), (s) => s.startsWith('waiting') || TERMINAL.includes(s))).toBe('waiting-approval');
    const forkEvs = await events(fork);
    expect(forkEvs.some((e) => e.nodeId === 'apply'), 'the fork must not release the gate\'s forward edge').toBe(false);
    expect(keyOf(requests(forkEvs).at(-1)).endsWith(':gate:1')).toBe(true);
  });

  it('a gate without a loopback edge keeps today\'s key and carries no marker (flag on)', async () => {
    const runId = await startRun('wf.adr1058.no-loop');
    const evs = await waitRequests(runId, 1);
    expect(keyOf(requests(evs)[0]).endsWith(':gate:0')).toBe(true);
    expect((await decide(runId, { action: 'accept' })).status).toBeLessThan(300);
    expect(await waitFor(() => status(runId), (s) => TERMINAL.includes(s))).toBe('completed');
    const done = (await events(runId)).find((e) => e.type === 'node.completed' && e.nodeId === 'gate');
    expect(Object.keys(done?.payload ?? {}).sort()).toEqual(['nodeId', 'outputs']);
  });
});
