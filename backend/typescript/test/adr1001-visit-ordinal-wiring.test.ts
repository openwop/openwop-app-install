/**
 * ADR 1001 D3.3 / ADR 1002 — the executor hands `beginNodeActivity` the node's
 * VISIT, not its ADR 0772 execution ordinal.
 *
 * Why it exists: a retry opens a new execution, so passing the execution
 * ordinal would put attempt 2 in a different ordinal range from attempt 1 and
 * break RFC 0150 §B retry-stability (attempt 2's first effect must have attempt
 * 1's identity, or the retry-stable read misses and the effect fires twice).
 * A suspend/resume re-entry is the same execution and must land on the same
 * base too. A node records the ordinal cursor it was handed at each entry.
 *
 * Scope, stated: the revisit half (a completed node visited again lands on the
 * next base) is witnessed at the fold in `adr1001-ordinal-seed.test.ts`. No
 * workflow construct on this host re-enters a completed node today (bounded
 * loopback, ADR 0772 RRWF-10, is unbuilt), so it has no route to drive.
 *
 * WHERE THE VISIT IS LIVE: the executor builds `ExecutionOrdinals` on replay
 * forks only (`executor.ts`, "Replay only: nothing else reads the ordinal yet
 * (D5 will)"), so a live run passes visit 0 and a replay fork passes the folded
 * visit. Today they agree, because nothing re-enters a completed node. The
 * replay-fork case below is the one that exercises `visitOf` through the real
 * executor. Bounded loopback MUST fold ordinals on live runs too, or a source
 * would record every visit at base 0 while its fork keyed visit k at k·2^20.
 *
 * Sabotage: passing `ordinals.highest(nodeId)` (the execution count) instead
 * of `visitOf` reds the replay-fork retry case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { peekNodeActivityOrdinal } from '../src/host/effectIdentity.js';
import { bareRunId } from './support/bareRunId.js';

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' };
const seen = new Map<string, number[]>();
const fails = new Map<string, number>();

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  getNodeRegistry().register({
    typeId: 'adr1001.flaky', version: '1.0.0',
    async execute(ctx) {
      seen.set(ctx.runId, [...(seen.get(ctx.runId) ?? []), peekNodeActivityOrdinal(ctx.runId, ctx.nodeId)]);
      const f = fails.get(ctx.runId) ?? 0;
      if (f < 1) { fails.set(ctx.runId, f + 1); return { status: 'failure', error: { code: 'upstream_unavailable', message: 'transient' } }; }
      return { status: 'success', outputs: {} };
    },
  });
  getNodeRegistry().register({
    typeId: 'adr1001.pauses', version: '1.0.0',
    async execute(ctx) {
      seen.set(ctx.runId, [...(seen.get(ctx.runId) ?? []), peekNodeActivityOrdinal(ctx.runId, ctx.nodeId)]);
      await ctx.suspend!({ kind: 'clarification', key: 'q', question: 'Q?' });
      return { status: 'success', outputs: {} };
    },
  });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}
async function waitStatus(runId: string, pred: (s: string) => boolean): Promise<string> {
  let status = '';
  for (let i = 0; i < 400; i++) {
    status = (await api<{ status: string }>(`/runs/${runId}`)).body.status;
    if (pred(status)) return status;
    await new Promise((r) => setTimeout(r, 20));
  }
  return status;
}
let n = 0;
async function start(typeId: string, config?: Record<string, unknown>): Promise<string> {
  const workflowId = `adr1001.visit.${Date.now()}-${n++}`;
  expect((await api('/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'n', typeId, ...(config ? { config } : {}) }], edges: [] }) })).status).toBeLessThan(300);
  const { body } = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId }) });
  return body.runId;
}

describe('ADR 1001 D3.3 / ADR 1002 — the executor passes the visit', () => {
  it('a retry (a new execution) stays in visit 0: both attempts start at ordinal 0', async () => {
    const runId = await start('adr1001.flaky', { retry: { maxAttempts: 2 } });
    expect(await waitStatus(runId, (s) => ['completed', 'failed'].includes(s))).toBe('completed');
    expect(seen.get(bareRunId(runId))).toEqual([0, 0]);
  });

  it('a suspend/resume re-entry is the same execution and lands on the same base', async () => {
    const runId = await start('adr1001.pauses');
    await waitStatus(runId, (s) => s.startsWith('waiting'));
    const list = (await api<{ interrupts: Array<{ token: string }> }>(`/host/openwop-app/runs/${bareRunId(runId)}/interrupts`)).body.interrupts;
    if (!list[0]?.token) throw new Error('no open interrupt with a token');
    expect((await api(`/interrupts/${list[0].token}`, { method: 'POST', body: JSON.stringify({ resumeValue: { answer: 'x' } }) })).status).toBeLessThan(300);
    expect(await waitStatus(runId, (s) => ['completed', 'failed'].includes(s))).toBe('completed');
    expect(seen.get(bareRunId(runId))).toEqual([0, 0]);
  });

  it('a replay fork that re-executes a retried node computes the same visit-0 base as the live source', async () => {
    const source = await start('adr1001.flaky', { retry: { maxAttempts: 2 } });
    expect(await waitStatus(source, (s) => ['completed', 'failed'].includes(s))).toBe('completed');
    const events = (await api<{ events: Array<{ type: string; nodeId?: string; sequence: number }> }>(`/runs/${source}/events/poll?fromSeq=-1&limit=1000`)).body.events;
    const firstStart = events.find((e) => e.type === 'node.started' && e.nodeId === 'n');
    if (!firstStart) throw new Error('the source never started its node');
    const fork = await api<{ runId: string }>(`/runs/${source}:fork`, { method: 'POST', body: JSON.stringify({ mode: 'replay', fromSeq: firstStart.sequence }) });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    expect(await waitStatus(fork.body.runId, (s) => ['completed', 'failed'].includes(s))).toBe('completed');
    expect(seen.get(bareRunId(fork.body.runId))).toEqual([0, 0]);
  });
});
