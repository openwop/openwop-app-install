/**
 * `core.conformance.hold` — the conformance-RESERVED PURE wait (openwop#1769).
 *
 * conformance/fixtures.md: it "completes after `inputs.delayMs` with its inputs
 * as outputs … MUST NOT [be classified] side-effecting … and MUST re-execute …
 * live in a replay." The replay fixtures used `core.delay`, which the registry
 * declares side-effecting, so a replay SERVED the wait instead of running it.
 *
 * Route-level, real executor: a source run (hold → side-effecting node), then a
 * `mode:"replay"` fork. The hold must RUN in the fork (its own node.started +
 * node.completed in the fork's tail) while the effect is served, not re-run.
 * The fixture's own case: a source cancelled INSIDE the hold, whose replay must
 * re-run the hold and fail the effect CLOSED (`replay_source_missing`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';
import { CONFORMANCE_HOLD_TYPE_ID } from '../src/bootstrap/conformanceHoldNode.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };
const effectRuns = new Map<string, number>();
/** Live executions of the HOLD per run. A served node emits the same
 *  node.started/node.completed pair, so the event log alone cannot tell
 *  "re-executed" from "served"; the execute body can. */
const holdRuns = new Map<string, number>();

/** The 2.44.4 fixture's shape: `wait` (hold, delayMs from a variable) → `effect`. */
const wf = (workflowId: string, delayMs: number): WorkflowDefinition => ({
  workflowId,
  nodes: [
    { nodeId: 'wait', typeId: CONFORMANCE_HOLD_TYPE_ID, config: {}, inputs: { delayMs: { type: 'variable', variableName: 'delayMs' } } },
    { nodeId: 'effect', typeId: 'test.hold.effect', config: {} },
  ],
  edges: [{ edgeId: 'wait-effect', sourceNodeId: 'wait', targetNodeId: 'effect' }],
  variables: [{ name: 'delayMs', type: 'number', required: true, defaultValue: delayMs }],
} as unknown as WorkflowDefinition);

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  getNodeRegistry().register({
    typeId: 'test.hold.effect',
    version: '1.0.0',
    sideEffecting: true,
    async execute(ctx) {
      effectRuns.set(ctx.runId, (effectRuns.get(ctx.runId) ?? 0) + 1);
      return { status: 'success', outputs: { sent: true } };
    },
  });
  // Count the REAL module's executions, keeping every other property (notably
  // its side-effect declaration) exactly as registered.
  const hold = getNodeRegistry().get(CONFORMANCE_HOLD_TYPE_ID)!;
  expect(hold, 'registered while conformance nodes are enabled').toBeTruthy();
  getNodeRegistry().register({
    ...hold,
    async execute(ctx) {
      holdRuns.set(ctx.runId, (holdRuns.get(ctx.runId) ?? 0) + 1);
      return hold.execute(ctx);
    },
  });
  registerWorkflow(wf('wf.hold.fast', 40));
  registerWorkflow(wf('wf.hold.slow', 5_000));
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
async function waitFor(runId: string, pred: (s: string) => boolean): Promise<string> {
  let status = '';
  for (let i = 0; i < 400; i++) {
    status = (await api<{ status: string }>(`/runs/${runId}`)).body.status;
    if (pred(status)) return status;
    await new Promise((r) => setTimeout(r, 25));
  }
  return status;
}
const events = async (runId: string): Promise<Ev[]> =>
  (await api<{ events: Ev[] }>(`/runs/${runId}/events/poll?fromSeq=-1&limit=1000`)).body.events ?? [];
async function start(workflowId: string): Promise<string> {
  const r = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId }) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.runId;
}
async function forkReplay(runId: string): Promise<string> {
  const f = await api<{ runId: string }>(`/runs/${runId}:fork`, { method: 'POST', body: JSON.stringify({ mode: 'replay', fromSeq: 0 }) });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  return f.body.runId;
}
const bare = (id: string): string => id.slice(id.lastIndexOf('/') + 1);

describe('core.conformance.hold — pure, and re-executed live in a replay', () => {
  it('is registered and is NOT side-effecting on any arm of the classifier', () => {
    const mod = getNodeRegistry().get(CONFORMANCE_HOLD_TYPE_ID);
    expect(mod?.typeId, 'registered while conformance nodes are enabled').toBe(CONFORMANCE_HOLD_TYPE_ID);
    expect(mod?.sideEffecting, 'declared pure outright').toBe(false);
    expect(isSideEffectingNode(CONFORMANCE_HOLD_TYPE_ID, mod)).toBe(false);
  });

  it('completes after delayMs with EXACTLY its resolved inputs as outputs', async () => {
    const src = await start('wf.hold.fast');
    expect(await waitFor(src, (s) => TERMINAL.includes(s))).toBe('completed');
    const done = (await events(src)).find((e) => e.type === 'node.completed' && e.nodeId === 'wait');
    // Suite 2.44.5 pins this: EXACTLY the resolved inputs, `delayMs` included,
    // under the same keys — nothing added, nothing renamed.
    expect(done?.payload?.['outputs']).toEqual({ delayMs: 40 });
  });

  it('a replay fork RE-RUNS the hold live and SERVES the side-effecting node', async () => {
    const src = await start('wf.hold.fast');
    expect(await waitFor(src, (s) => TERMINAL.includes(s))).toBe('completed');
    expect(effectRuns.get(bare(src))).toBe(1);
    const forkId = await forkReplay(src);
    expect(await waitFor(forkId, (s) => TERMINAL.includes(s))).toBe('completed');
    const tail = (await events(forkId)).filter((e) => e.nodeId === 'wait').map((e) => e.type);
    expect(tail).toEqual(['node.started', 'node.completed']);
    expect(holdRuns.get(bare(forkId)) ?? 0, 'the hold EXECUTED in the fork (a served node emits the same events)').toBe(1);
    expect(effectRuns.get(bare(forkId)) ?? 0, 'the effect was served, not re-performed').toBe(0);
    // replay.md §Suppression rule 2 (suite 2.44.5): a replay short-circuit raises
    // NO new interrupt.requested.
    expect((await events(forkId)).filter((e) => e.type === 'interrupt.requested')).toEqual([]);
  });

  it('the fixture\'s case: a source cancelled INSIDE the hold replays with the hold re-run and the effect failed CLOSED', async () => {
    const src = await start('wf.hold.slow');
    for (let i = 0; i < 200 && !(await events(src)).some((e) => e.type === 'node.started' && e.nodeId === 'wait'); i++) await new Promise((r) => setTimeout(r, 25));
    expect((await api(`/runs/${src}/cancel`, { method: 'POST', body: '{}' })).status).toBeLessThan(300);
    expect(await waitFor(src, (s) => TERMINAL.includes(s))).toBe('cancelled');
    expect(effectRuns.get(bare(src)) ?? 0, 'the effect never ran in the source').toBe(0);
    const forkId = await forkReplay(src);
    expect(await waitFor(forkId, (s) => TERMINAL.includes(s))).toBe('failed');
    const evs = await events(forkId);
    expect(evs.some((e) => e.type === 'node.completed' && e.nodeId === 'wait')).toBe(true);
    expect(holdRuns.get(bare(forkId)) ?? 0, 'the hold RAN in the fork (it is pure)').toBe(1);
    const effectFailed = evs.find((e) => e.type === 'node.failed' && e.nodeId === 'effect');
    expect((effectFailed?.payload?.['error'] as { code?: string } | undefined)?.code).toBe('replay_source_missing');
    expect(effectRuns.get(bare(forkId)) ?? 0, 'and the effect was NOT performed').toBe(0);
  }, 20_000);
});
