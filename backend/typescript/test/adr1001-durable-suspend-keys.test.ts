/**
 * ADR 1001 D3.2 — opt-in `durable: true` ctx.suspend keys.
 *
 * Why it exists: a re-invoke resume re-runs the node from the top with ONLY the
 * latest resolution seeded. A node that suspends twice — the agent runner's
 * ADR 0775 approval gate, then a clarification — was re-entered with B's answer,
 * threw again on A, and re-asked A forever. A durable key is served from the
 * node's own resolved row; a non-durable key keeps today's behaviour, because a
 * node that deliberately re-asks on one key must keep being asked. The served
 * value passes the same resume scrub a seeded one does.
 *
 * Sabotage: dropping the `durable` branch in `makeSuspendFn` reds case 1 (A is
 * asked twice); serving every key regardless of the flag reds case 2; serving
 * `row.resolvedValue` unscrubbed reds case 3.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import type { NodeModule } from '../src/executor/types.js';
import { bareRunId } from './support/bareRunId.js';

const HEX = '0123456789abcdef0123456789abcdef0123'; // rewritten by the free-text resume scrub

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' };

function twoAsks(typeId: string, durable: boolean): NodeModule {
  return {
    typeId,
    version: '1.0.0',
    async execute(ctx) {
      const a = await ctx.suspend!({ kind: 'clarification', key: 'ask-a', question: 'A?', ...(durable ? { durable: true } : {}) });
      const b = await ctx.suspend!({ kind: 'clarification', key: 'ask-b', question: 'B?', ...(durable ? { durable: true } : {}) });
      return { status: 'success', outputs: { a, b } };
    },
  };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  getNodeRegistry().register(twoAsks('adr1001.durable', true));
  getNodeRegistry().register(twoAsks('adr1001.plain', false));
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

type Json = Record<string, unknown>;
async function api<T = Json>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}
async function waitStatus(runId: string, pred: (s: string) => boolean): Promise<string> {
  let status = '';
  for (let i = 0; i < 300; i++) {
    status = (await api<{ status: string }>(`/runs/${runId}`)).body.status;
    if (pred(status)) return status;
    await new Promise((r) => setTimeout(r, 20));
  }
  return status;
}
async function openAsk(runId: string): Promise<{ token: string; question: unknown }> {
  for (let i = 0; i < 300; i++) {
    const list = (await api<{ interrupts: Array<{ token: string; data?: { question?: unknown } }> }>(`/host/openwop-app/runs/${bareRunId(runId)}/interrupts`)).body.interrupts ?? [];
    if (list[0]) return { token: list[0].token, question: list[0].data?.question };
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('no open interrupt');
}
async function answer(token: string, value: unknown): Promise<void> {
  const r = await api(`/interrupts/${token}`, { method: 'POST', body: JSON.stringify({ resumeValue: value }) });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
}
let n = 0;
async function start(typeId: string): Promise<string> {
  const workflowId = `adr1001.${typeId}.${Date.now()}-${n++}`;
  const reg = await api('/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'n', typeId }], edges: [] }) });
  expect(reg.status, JSON.stringify(reg.body)).toBeLessThan(300);
  const create = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId }) });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  return create.body.runId;
}
async function outputs(runId: string): Promise<Json | undefined> {
  const evs = (await api<{ events: Array<{ type: string; nodeId?: string; payload?: { outputs?: Json } }> }>(`/runs/${runId}/events/poll?fromSeq=-1&limit=1000`)).body.events ?? [];
  return evs.filter((e) => e.type === 'node.completed' && e.nodeId === 'n').at(-1)?.payload?.outputs;
}

describe('ADR 1001 D3.2 — durable ctx.suspend keys', () => {
  it('a node that suspends twice on durable keys gets past the first on re-entry', async () => {
    const runId = await start('adr1001.durable');
    const first = await openAsk(runId);
    expect(first.question).toBe('A?');
    await answer(first.token, { answer: 'alpha' });
    await waitStatus(runId, (s) => s.startsWith('waiting'));
    const second = await openAsk(runId);
    expect(second.question).toBe('B?'); // not A again
    await answer(second.token, { answer: 'beta' });
    expect(await waitStatus(runId, (s) => ['completed', 'failed'].includes(s))).toBe('completed');
    expect(await outputs(runId)).toEqual({ a: { answer: 'alpha' }, b: { answer: 'beta' } });
  });

  it('a non-durable key keeps today\'s behaviour: the first ask is asked again', async () => {
    const runId = await start('adr1001.plain');
    await answer((await openAsk(runId)).token, { answer: 'alpha' });
    await waitStatus(runId, (s) => s.startsWith('waiting'));
    const second = await openAsk(runId);
    expect(second.question).toBe('B?');
    await answer(second.token, { answer: 'beta' });
    await waitStatus(runId, (s) => s.startsWith('waiting'));
    expect((await openAsk(runId)).question).toBe('A?');
  });

  it('a served answer passes the same resume scrub as a seeded one', async () => {
    const runId = await start('adr1001.durable');
    await answer((await openAsk(runId)).token, { answer: `id ${HEX}` });
    await waitStatus(runId, (s) => s.startsWith('waiting'));
    await answer((await openAsk(runId)).token, { answer: 'beta' });
    expect(await waitStatus(runId, (s) => ['completed', 'failed'].includes(s))).toBe('completed');
    expect(JSON.stringify((await outputs(runId))?.['a'])).not.toContain(HEX);
  });
});
