/**
 * ADR 1001 D3.1 — the clarification continuation checkpoint store.
 *
 * Why it exists: a checkpoint holds the transcript tail of a paused agent turn,
 * tool output included, so it must (1) read back only for the run and node that
 * wrote it, newest round first; (2) refuse to grow past its cap rather than
 * write an unbounded row. Retiring with the run on both delete paths and both
 * adapters is `adr1001-checkpoint-run-cascade.test.ts`.
 *
 * Sabotage: removing the tenant check in `parse` reds case 1's cross-tenant
 * leg; removing the size cap reds case 2.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import {
  CLARIFICATION_CHECKPOINT_MAX_BYTES,
  latestClarificationCheckpoint,
  saveClarificationCheckpoint,
  type ClarificationCheckpoint,
} from '../src/host/clarificationCheckpoint.js';
import { bareRunId } from './support/bareRunId.js';

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  getNodeRegistry().register({ typeId: 'adr1001.noop', version: '1.0.0', async execute() { return { status: 'success', outputs: {} }; } });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}
let n = 0;
async function finishedRun(): Promise<{ runId: string; tenantId: string }> {
  const workflowId = `adr1001.ckpt.${Date.now()}-${n++}`;
  expect((await api('/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'n', typeId: 'adr1001.noop' }], edges: [] }) })).status).toBeLessThan(300);
  const { body } = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId }) });
  for (let i = 0; i < 300; i++) {
    const run = await hostExtStorage().getRun(bareRunId(body.runId));
    if (run && ['completed', 'failed'].includes(run.status)) return { runId: run.runId, tenantId: run.tenantId };
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('run did not finish');
}
function cp(runId: string, tenantId: string, round: number, extra: Partial<ClarificationCheckpoint> = {}): ClarificationCheckpoint {
  return {
    v: 1, tenantId, runId, nodeId: 'agent:1', round,
    transcriptTail: [{ role: 'assistant', content: `ask ${round}` }],
    questions: [{ id: 'q', question: 'Q?', answer: { kind: 'boolean' } }],
    questionsDigest: 'abcdabcdabcdabcd', ordinalCursor: round * 2, createdAt: '2026-10-28T10:00:00Z',
    ...extra,
  };
}

describe('ADR 1001 D3.1 — clarification checkpoints', () => {
  it('reads back the newest round, only for the run, node and tenant that wrote it', async () => {
    const { runId, tenantId } = await finishedRun();
    const s = hostExtStorage();
    for (const r of [1, 2, 10]) expect(await saveClarificationCheckpoint(s, cp(runId, tenantId, r))).toEqual({ ok: true });
    expect((await latestClarificationCheckpoint(s, { tenantId, runId, nodeId: 'agent:1' }))?.round).toBe(10);
    expect(await latestClarificationCheckpoint(s, { tenantId, runId, nodeId: 'agent:2' })).toBeNull();
    expect(await latestClarificationCheckpoint(s, { tenantId: 'other-tenant', runId, nodeId: 'agent:1' })).toBeNull();
  });

  it('refuses a checkpoint over the size cap instead of writing it', async () => {
    const { runId, tenantId } = await finishedRun();
    const big = cp(runId, tenantId, 1, { transcriptTail: [{ role: 'assistant', content: 'x'.repeat(CLARIFICATION_CHECKPOINT_MAX_BYTES) }] });
    expect(await saveClarificationCheckpoint(hostExtStorage(), big)).toEqual({ ok: false, reason: 'too_large' });
    expect(await latestClarificationCheckpoint(hostExtStorage(), { tenantId, runId, nodeId: 'agent:1' })).toBeNull();
  });
});
