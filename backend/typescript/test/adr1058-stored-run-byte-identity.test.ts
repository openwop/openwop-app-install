/**
 * ADR 1058 D1 — a run with no loopback edge is byte-identical with the flag on.
 *
 * The stored-run proof: a gate run is STARTED with `OPENWOP_BOUNDED_LOOPBACK`
 * off (as every run stored before ADR 1058 was), suspended, and RESUMED with
 * the flag on. Its event log, normalised only for run-scoped values (run id,
 * timestamps, generated ids), must equal a run that never saw the flag. Keys
 * are compared in full, so a derivation that moved visit 0 (`…:gate:0`,
 * `…:gate:<resumeKey>`) goes red here, as does any payload key the loopback
 * code added to a run without a loopback edge.
 *
 * Both gate styles are covered: the native `core.approvalGate` and a
 * `ctx.suspend` gate whose resume key is its node id (`core.chat.approvalGate`'s
 * shape).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { validateWorkflowDefinition } from '../src/host/workflowDefinitionValidation.js';
import { bareRunId } from './support/bareRunId.js';

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  delete process.env.OPENWOP_BOUNDED_LOOPBACK;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  getNodeRegistry().register({
    typeId: 'test.adr1058.bi.suspendGate',
    version: '1.0.0',
    async execute(ctx) {
      const r = await ctx.suspend!({ reason: 'approval', resumeKey: ctx.nodeId, title: 'Review', actions: ['accept', 'reject'] }) as { action?: string };
      return { status: 'success', outputs: { decision: r?.action ?? 'unknown' } };
    },
  });
  for (const [id, typeId] of [['wf.adr1058.bi.native', 'core.approvalGate'], ['wf.adr1058.bi.reinvoke', 'test.adr1058.bi.suspendGate']] as const) {
    registerWorkflow(validateWorkflowDefinition({
      workflowId: id,
      nodes: [
        { nodeId: 'draft', typeId: 'core.noop', config: {} },
        { nodeId: 'gate', typeId, config: { title: 'Review', actions: ['accept', 'reject'] } },
        { nodeId: 'apply', typeId: 'core.noop', config: {} },
      ],
      edges: [
        { id: 'd-g', sourceNodeId: 'draft', targetNodeId: 'gate' },
        { id: 'g-a', sourceNodeId: 'gate', targetNodeId: 'apply' },
      ],
    }));
  }
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_BOUNDED_LOOPBACK;
  await new Promise<void>((res) => server.close(() => res()));
});

type Json = Record<string, unknown>;
type Ev = { type: string; nodeId?: string; payload?: unknown };
async function api<T = Json>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}
async function waitStatus(runId: string, ok: (s: string) => boolean): Promise<string> {
  let s = '';
  for (let i = 0; i < 300; i++) { s = (await api<{ status: string }>(`/runs/${runId}`)).body.status; if (ok(s)) return s; await new Promise((r) => setTimeout(r, 20)); }
  return s;
}
async function events(runId: string): Promise<Ev[]> {
  return (await api<{ events: Ev[] }>(`/runs/${runId}/events/poll?fromSeq=-1&limit=1000`)).body.events ?? [];
}
/** The log with run-scoped values replaced: run ids, timestamps, generated ids. */
function normalise(evs: Ev[], runId: string): unknown {
  const bare = bareRunId(runId);
  const scrub = (v: unknown, k?: string): unknown => {
    if (typeof v === 'string') {
      if (k && /(At|Id|token|durationMs)$/.test(k) && k !== 'nodeId' && k !== 'edgeId') return `<${k}>`;
      return v.split(runId).join('<run>').split(bare).join('<run>');
    }
    if (typeof v === 'number' && k === 'durationMs') return '<durationMs>';
    if (Array.isArray(v)) return v.map((x) => scrub(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Json).map(([kk, vv]) => [kk, scrub(vv, kk)]));
    return v;
  };
  return evs.map((e) => ({ type: e.type, nodeId: e.nodeId, payload: scrub(e.payload) }));
}
async function runThrough(workflowId: string, flagAtResume: boolean): Promise<{ runId: string; log: unknown; keys: string[] }> {
  delete process.env.OPENWOP_BOUNDED_LOOPBACK;
  const r = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId }) });
  expect(r.status).toBe(201);
  const runId = r.body.runId;
  expect(await waitStatus(runId, (s) => s.startsWith('waiting'))).toBe('waiting-approval');
  if (flagAtResume) process.env.OPENWOP_BOUNDED_LOOPBACK = 'true';
  const list = (await api<{ interrupts: Array<{ token: string }> }>(`/host/openwop-app/runs/${bareRunId(runId)}/interrupts`)).body.interrupts ?? [];
  const d = await api(`/interrupts/${list[0]!.token}`, { method: 'POST', body: JSON.stringify({ resumeValue: { action: 'accept' } }) });
  expect(d.status).toBeLessThan(300);
  expect(await waitStatus(runId, (s) => ['completed', 'failed', 'cancelled'].includes(s))).toBe('completed');
  const evs = await events(runId);
  delete process.env.OPENWOP_BOUNDED_LOOPBACK;
  const keys = evs.filter((e) => e.type === 'interrupt.requested').map((e) => String((e.payload as Json)['key']).split(runId).join('<run>').split(bareRunId(runId)).join('<run>'));
  return { runId, log: normalise(evs, runId), keys };
}

describe('ADR 1058 D1 — a stored run without a loopback replays byte-identically with the flag on', () => {
  it.each([
    ['native core.approvalGate', 'wf.adr1058.bi.native', '<run>:gate:0'],
    ['ctx.suspend gate keyed by node id', 'wf.adr1058.bi.reinvoke', '<run>:gate:gate'],
  ])('%s: started flag-off, resumed flag-on, equals a run that never saw the flag', async (_label, workflowId, key) => {
    const never = await runThrough(workflowId, false);
    const stored = await runThrough(workflowId, true);
    expect(never.keys).toEqual([key]);
    expect(stored.keys).toEqual([key]);
    expect(stored.log).toEqual(never.log);
    expect(JSON.stringify(stored.log)).not.toContain('loopback');
  });
});
