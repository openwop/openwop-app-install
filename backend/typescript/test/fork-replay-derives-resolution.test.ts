/**
 * RFC 0223 (interrupt.md §Rejection, last bullet) — "On replay the failure MUST be
 * derived from the recorded `interrupt.resolved`, never re-decided." Host witness
 * of `0223.replay-derives-rejection` (openwop#1756).
 *
 * Route-level, real executor: a gate is decided in the source, then a `replay`
 * fork is taken AT the gate's recorded `interrupt.resolved`, so the prefix holds
 * its request and suspension and the fork must supply the resolution. A
 * re-deciding host re-raises the gate and waits; a deriving host takes the
 * source's decision.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import { bareRunId } from './support/bareRunId.js';

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  registerWorkflow({
    workflowId: 'wf.derive',
    nodes: [
      { nodeId: 'gate', typeId: 'core.approvalGate', config: { title: 'Derive?', actions: ['accept', 'reject'], rejectionPolicy: 'single-veto' } },
      { nodeId: 'after', typeId: 'core.noop', config: {} },
    ],
    edges: [{ edgeId: 'g-a', sourceNodeId: 'gate', targetNodeId: 'after' }],
  } as unknown as WorkflowDefinition);
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
  for (let i = 0; i < 300; i++) {
    status = (await api<{ status: string }>(`/runs/${runId}`)).body.status;
    if (pred(status)) return status;
    await new Promise((r) => setTimeout(r, 20));
  }
  return status;
}
const events = async (runId: string): Promise<Ev[]> =>
  (await api<{ events: Ev[] }>(`/runs/${runId}/events/poll?fromSeq=-1&limit=1000`)).body.events ?? [];
const gateToken = async (runId: string): Promise<string> =>
  ((await api<{ interrupts: Array<{ token: string }> }>(`/host/openwop-app/runs/${bareRunId(runId)}/interrupts`)).body.interrupts ?? [])[0]!.token;
const pick = (p: Json | undefined): Json => ({ decision: p?.['decision'], action: p?.['action'], reason: p?.['reason'] });

async function decidedThenForked(action: 'accept' | 'reject'): Promise<{ src: string; fromSeq: number; forkId: string; forkStatus: string }> {
  const r = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId: 'wf.derive' }) });
  const src = r.body.runId;
  expect(await waitFor(src, (s) => s.startsWith('waiting'))).toBe('waiting-approval');
  const res = await api(`/interrupts/${await gateToken(src)}`, { method: 'POST', body: JSON.stringify({ resumeValue: { action } }) });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  expect(await waitFor(src, (s) => TERMINAL.includes(s))).toBe(action === 'reject' ? 'failed' : 'completed');
  const at = (await events(src)).find((e) => e.type === 'interrupt.resolved' && e.nodeId === 'gate')!;
  const f = await api<{ runId: string }>(`/runs/${src}:fork`, { method: 'POST', body: JSON.stringify({ mode: 'replay', fromSeq: at.sequence }) });
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  const forkStatus = await waitFor(f.body.runId, (s) => TERMINAL.includes(s) || s.startsWith('waiting'));
  return { src, fromSeq: at.sequence, forkId: f.body.runId, forkStatus };
}

describe('RFC 0223 — a replay fork DERIVES the gate decision from the recorded interrupt.resolved', () => {
  it('a decided REJECT: no re-raise, the source\'s decision recorded, the fork fails as the source did, and a resolve answers 409', async () => {
    const { src, fromSeq, forkId, forkStatus } = await decidedThenForked('reject');
    const fork = await events(forkId);
    const tail = fork.filter((e) => e.sequence >= fromSeq && e.nodeId === 'gate');
    // replay.md §Suppression rule 2 (suite 2.44.5): NO new interrupt.requested.
    expect(tail.filter((e) => e.type === 'interrupt.requested' || e.type === 'node.suspended'), 'the fork re-raised the gate: a re-deciding host').toEqual([]);
    const srcResolved = (await events(src)).find((e) => e.type === 'interrupt.resolved' && e.nodeId === 'gate');
    const forkResolved = fork.find((e) => e.type === 'interrupt.resolved' && e.nodeId === 'gate');
    expect(pick(forkResolved?.payload)).toEqual(pick(srcResolved?.payload));
    expect(forkStatus).toBe('failed');
    const runFailed = fork.find((e) => e.type === 'run.failed');
    expect(runFailed?.payload).toMatchObject({ error: { code: 'approval_rejected' }, failedNodeId: 'gate' });
    expect(fork.find((e) => e.type === 'node.failed' && e.nodeId === 'gate')?.payload).toMatchObject({ error: { code: 'approval_rejected', retryable: false } });
    expect(fork.filter((e) => e.type === 'interrupt.resolved' && e.nodeId === 'gate'), 'recorded exactly once').toHaveLength(1);
    // The fork holds no open decision.
    // On the major-2 route the conformance leg drives (errors.md §One code per state).
    const again = await api<{ error?: string }>(`/runs/${forkId}/interrupts/gate`, { method: 'POST', headers: { 'OpenWOP-Version': '2.0' }, body: JSON.stringify({ resumeValue: { action: 'accept' } }) });
    expect({ status: again.status, code: again.body.error }).toEqual({ status: 409, code: 'interrupt_already_resolved' });
  });

  it('a decided ACCEPT is derived the same way: no re-raise, and the fork completes past the gate', async () => {
    const { fromSeq, forkId, forkStatus } = await decidedThenForked('accept');
    expect(forkStatus).toBe('completed');
    const fork = await events(forkId);
    expect(fork.filter((e) => e.sequence >= fromSeq && e.nodeId === 'gate' && (e.type === 'interrupt.requested' || e.type === 'node.suspended'))).toEqual([]);
    expect(fork.find((e) => e.type === 'interrupt.resolved' && e.nodeId === 'gate')?.payload).toMatchObject({ action: 'accept' });
    expect(fork.some((e) => e.type === 'node.completed' && e.nodeId === 'after')).toBe(true);
  });
});
