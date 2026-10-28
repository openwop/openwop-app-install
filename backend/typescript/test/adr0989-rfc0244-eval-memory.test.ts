/**
 * ADR 0989 — RFC 0244 G3, the reserved `conformance.eval:memory` tool, under the
 * prod posture (nodes off, the eval-fixture opt-in on).
 *
 * - D2: the per-trial port keeps ids, upserts by id, and `get` reads by id.
 * - D3: the tool's ops, and bad input as a typed error.
 * - D1/D4/D5: `conformance-eval-memory-isolation` is listed. Over HTTP its
 *   2 trials each see the seed, see no `trial-note` before their own write, and
 *   read their write back. Every memory call carries `outcome`, and none is a
 *   fixture miss.
 *
 * Red when (sabotage-witnessed): one memory store is shared across trials; the
 * port drops ids; `outcome` is missing; the fixture stays unlisted; the tool
 * goes through the fixture interceptor.
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'false';
  process.env.OPENWOP_CONFORMANCE_EVAL_FIXTURES = 'true';
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { CONFORMANCE_SUITE_PREFIX, SCRIPTED_AGENT_ID, listFixtureSuiteIds } from '../src/host/evals/fixtureSuites.js';
import { ephemeralMemory } from '../src/host/evals/agentEvalRun.js';
import { MEMORY_TOOL, runMemoryTool } from '../src/host/evals/evalMemoryTool.js';

const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };
const FIXTURE = 'conformance-eval-memory-isolation';

let server: Server;
let base = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => {
  delete process.env.OPENWOP_ENABLE_CONFORMANCE_NODES;
  delete process.env.OPENWOP_CONFORMANCE_EVAL_FIXTURES;
  await new Promise<void>((r) => server.close(() => r()));
});

interface Reply { status: number; json: Record<string, unknown>; text: string }
async function send(method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${base}${path}`, { method, headers: V2, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* asserted below */ }
  return { status: res.status, json, text };
}
async function waitTerminal(runId: string): Promise<string> {
  for (let i = 0; i < 400; i += 1) {
    const status = String(((await send('GET', `/runs/${runId}`)).json as { status?: string }).status ?? '');
    if (['completed', 'failed', 'cancelled'].includes(status)) return status;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${runId} never settled`);
}
type Ev = { type: string; sequence: number; payload: Record<string, unknown> };

describe('ADR 0989 D2 — the per-trial port keeps ids', () => {
  it('a seeded id and a written id are readable by id; a write with an id upserts', async () => {
    const m = ephemeralMemory([{ id: 'seeded', content: 'seed' }]);
    expect(m.get('seeded')).toEqual({ id: 'seeded', content: 'seed' });
    expect(m.get('note')).toBeUndefined();
    await m.write('s', { id: 'note', content: 'one' });
    await m.write('s', { id: 'note', content: 'two' });
    expect(m.get('note')).toEqual({ id: 'note', content: 'two' });
    expect((await m.read('s')).filter((r) => r.id === 'note')).toHaveLength(1);
    expect((await m.read('s')).map((r) => r.id)).toEqual(['seeded', 'note']);
  });
});

describe('ADR 0989 D3 — the tool', () => {
  it('write returns {id}; read returns {id, content} or content null; bad input is typed', async () => {
    const m = ephemeralMemory([{ id: 'seeded', content: 'seed' }]);
    expect(await runMemoryTool(m, { op: 'read', id: 'seeded' })).toEqual({ ok: true, value: { id: 'seeded', content: 'seed' } });
    expect(await runMemoryTool(m, { op: 'read', id: 'trial-note' })).toEqual({ ok: true, value: { id: 'trial-note', content: null } });
    expect(await runMemoryTool(m, { op: 'write', id: 'trial-note', content: 'written' })).toEqual({ ok: true, value: { id: 'trial-note' } });
    expect(await runMemoryTool(m, { op: 'read', id: 'trial-note' })).toEqual({ ok: true, value: { id: 'trial-note', content: 'written' } });
    for (const bad of [{ op: 'read' }, { op: 'write', id: 'x' }, { op: 'delete', id: 'x' }, { op: 'read', id: 'has space' }]) {
      expect(await runMemoryTool(m, bad), JSON.stringify(bad)).toMatchObject({ ok: false, code: 'invalid_memory_input' });
    }
  });
});

describe('ADR 0989 D1/D4/D5 — the isolation fixture over HTTP', () => {
  it('is listed; each trial sees the seed and only its own note; every memory call carries outcome', async () => {
    expect(listFixtureSuiteIds()).toContain(FIXTURE);
    const c = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: `${CONFORMANCE_SUITE_PREFIX}${FIXTURE}`, agentId: SCRIPTED_AGENT_ID });
    expect(c.status, c.text.slice(0, 400)).toBe(201);
    const runId = String(c.json['runId']);
    expect(await waitTerminal(runId)).toBe('completed');
    const evs = ((((await send('GET', `/runs/${runId}/events/poll?limit=500`)).json as { events?: unknown[] }).events ?? []) as Ev[])
      .sort((a, b) => a.sequence - b.sequence);
    const calls = evs.filter((e) => e.type === 'agent.tool-called' && e.payload['toolName'] === MEMORY_TOOL);
    const rets = evs.filter((e) => e.type === 'agent.tool-returned' && e.payload['toolName'] === MEMORY_TOOL);
    expect(rets.length).toBe(calls.length);
    expect(rets.length).toBeGreaterThanOrEqual(8);
    for (const r of rets) expect(r.payload['outcome'], JSON.stringify(r.payload)).toBeDefined();
    const byCall = new Map(rets.map((r) => [r.payload['callId'], r.payload['outcome'] as Record<string, unknown>]));
    const reads = calls.filter((e) => (e.payload['inputs'] as Record<string, unknown>)['op'] === 'read')
      .map((e) => ({ id: (e.payload['inputs'] as Record<string, unknown>)['id'], out: byCall.get(e.payload['callId'])! }));
    const seedReads = reads.filter((r) => r.id === 'seeded');
    const noteReads = reads.filter((r) => r.id === 'trial-note');
    expect(seedReads.length).toBe(2);
    for (const r of seedReads) expect(r.out['content']).toBe('seed');
    // n of the 2n note reads are empty: each trial's first read, before its own write.
    expect(noteReads.length).toBe(4);
    expect(noteReads.filter((r) => r.out['content'] === null)).toHaveLength(2);
    expect(noteReads.filter((r) => r.out['content'] === 'written')).toHaveLength(2);
    const s = await send('GET', `/runs/${runId}/eval-summary`);
    const t = ((s.json['tasks'] as Array<Record<string, unknown>>) ?? [])[0]!;
    expect(t['fixtureMissCount'] ?? 0).toBe(0);
    expect(s.json['passed']).toBe(true);
  });
});
