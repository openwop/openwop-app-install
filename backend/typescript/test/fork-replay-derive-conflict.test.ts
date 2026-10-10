/**
 * A replay fork whose gate row was decided by SOMEONE ELSE (the derivation
 * reports `conflict`, forkReplayResolutions.ts §DERIVED_MARKER) FAILS CLOSED:
 * a replay never re-decides, so neither the recorded decision nor the other
 * one is applied — the gate node fails `replay_gate_conflict`, no
 * `interrupt.resolved` is recorded, and the run does not continue past it.
 *
 * The derivation is wrapped to report the conflict; its own refusal is
 * witnessed in `fork-replay-derive-race.test.ts`.
 */
import { vi } from 'vitest';
import { bareRunId } from './support/bareRunId.js';

vi.mock('../src/executor/forkReplayResolutions.js', async (orig) => {
  const real = await orig<typeof import('../src/executor/forkReplayResolutions.js')>();
  return {
    ...real,
    deriveRecordedResolutions: async (...a: Parameters<typeof real.deriveRecordedResolutions>) =>
      (await real.deriveRecordedResolutions(...a)).map((d) => ({ ...d, conflict: true })),
  };
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

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

describe('replay fork — a gate decided outside the replay fails CLOSED', () => {
  it('neither decision is applied: node.failed replay_gate_conflict, no interrupt.resolved, no continuation', async () => {
    const { fromSeq, forkId, forkStatus } = await decidedThenForked('accept');
    expect(forkStatus).toBe('failed');
    const fork = await events(forkId);
    expect(fork.filter((e) => e.sequence >= fromSeq && e.type === 'interrupt.resolved' && e.nodeId === 'gate'), 'the recorded decision was applied over a conflict').toEqual([]);
    expect(fork.find((e) => e.type === 'node.failed' && e.nodeId === 'gate')?.payload).toMatchObject({ error: { code: 'openwop-app.replay_gate_conflict', retryable: false } }) // major-2 poll namespaces a host code;
    expect(fork.some((e) => e.type === 'node.completed' && e.nodeId === 'after'), 'the run continued past the conflicted gate').toBe(false);
  });
});
