/**
 * ADR 0977 — the RFC 0244 G2 counter tool (`conformance.eval:counter`) and the
 * one live door a fixture suite has to it. The host is booted the way production
 * runs: conformance nodes OFF, the ADR 0898 eval-fixture opt-in ON.
 *
 *   D1  `inc` and `read` are scoped to (tenant, owner, key). A never-incremented
 *       key reads 0, bad input is a typed error, and losing every CAS attempt is
 *       a typed error.
 *   D2  the interceptor's per-tool predicate lets exactly the named tool through
 *       on a live miss; every other tool fails closed.
 *   D3  a live miss is counted but does not fail the trial; a fail-closed miss
 *       does, and `conformance-eval-fixture-miss` is unchanged.
 *   D4  a counter return carries `outcome` (live value or served entry,
 *       verbatim); a fail-mode miss carries `error` and no `outcome`; other
 *       tools carry no `outcome`.
 *   E2E the suite's live → miss → live sequence: the three G2 legs, host side.
 *
 * Red when (each sabotage-witnessed): see the ADR 0977 P1 record.
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
import { fixtureInterceptor } from '../src/host/evals/agentEvalRun.js';
import { COUNTER_TOOL, counterOwnerHash, runCounter } from '../src/host/evals/evalCounter.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import type { EvalTaskDef } from '../src/host/evals/suiteStore.js';
import type { ExecuteAgentTool } from '../src/host/agentDispatch.js';

let server: Server;
let base = '';
const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };

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

/** Run one fixture suite; return its counter returns in script order and its summary task. */
async function runFixture(id: string): Promise<{ returns: Array<Record<string, unknown>>; task: Record<string, unknown> }> {
  const c = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: `${CONFORMANCE_SUITE_PREFIX}${id}`, agentId: SCRIPTED_AGENT_ID });
  expect(c.status, c.text.slice(0, 400)).toBe(201);
  const runId = String(c.json['runId']);
  expect(await waitTerminal(runId)).toBe('completed');
  const evs = ((((await send('GET', `/runs/${runId}/events/poll?limit=500`)).json as { events?: unknown[] }).events ?? []) as Ev[])
    .sort((a, b) => a.sequence - b.sequence);
  const returns = evs.filter((e) => e.type === 'agent.tool-returned' && e.payload['toolName'] === COUNTER_TOOL).map((e) => e.payload);
  const s = await send('GET', `/runs/${runId}/eval-summary`);
  const task = ((s.json['tasks'] as Array<Record<string, unknown>>) ?? [])[0]!;
  return { returns, task };
}
const countOf = (r: Record<string, unknown>): number => (r['outcome'] as { count: number }).count;

function task(fixtures: EvalTaskDef['fixtures']): EvalTaskDef {
  return { taskId: 't', input: {}, expected: { kind: 'golden', match: { strategy: 'contains', value: 'x' } }, ...(fixtures ? { fixtures } : {}) };
}
const ownerRun = (tenantId: string, principal: string) => ({
  tenantId,
  metadata: { owner: { principal, principalKind: 'user' as const, subject: { issuer: 'urn:test', subjectId: principal, lane: 'api-key', kind: 'workload' } } },
});

describe('ADR 0977 D1 — the counter store', () => {
  it('inc counts up, read does not move it, an unknown key reads 0', async () => {
    const run = ownerRun('t-d1', 'p-1');
    expect(await runCounter(run, { key: 'a', op: 'read' })).toEqual({ ok: true, value: { key: 'a', count: 0 } });
    expect(await runCounter(run, { key: 'a', op: 'inc' })).toEqual({ ok: true, value: { key: 'a', count: 1 } });
    expect(await runCounter(run, { key: 'a', op: 'inc' })).toEqual({ ok: true, value: { key: 'a', count: 2 } });
    expect(await runCounter(run, { key: 'a', op: 'read' })).toEqual({ ok: true, value: { key: 'a', count: 2 } });
  });

  it('is scoped by owner and by tenant', async () => {
    await runCounter(ownerRun('t-scope', 'p-1'), { key: 'k', op: 'inc' });
    expect(await runCounter(ownerRun('t-scope', 'p-2'), { key: 'k', op: 'read' })).toEqual({ ok: true, value: { key: 'k', count: 0 } });
    expect(await runCounter(ownerRun('t-other', 'p-1'), { key: 'k', op: 'read' })).toEqual({ ok: true, value: { key: 'k', count: 0 } });
    expect(counterOwnerHash(ownerRun('x', 'p-1'))).not.toBe(counterOwnerHash(ownerRun('x', 'p-2')));
    expect(counterOwnerHash({ tenantId: 'x', metadata: {} })).toBe(counterOwnerHash({ tenantId: 'y', metadata: {} }));
  });

  it('bad input is a typed error, never a write', async () => {
    const run = ownerRun('t-bad', 'p-1');
    for (const input of [{ key: 'a', op: 'dec' }, { key: '', op: 'inc' }, { key: 'a::b', op: 'inc' }, { op: 'inc' }, { key: 'x'.repeat(65), op: 'inc' }]) {
      expect(await runCounter(run, input), JSON.stringify(input)).toMatchObject({ ok: false, code: 'invalid_counter_input' });
    }
    expect(await runCounter({ ...run, tenantId: 'a::b' }, { key: 'a', op: 'inc' })).toMatchObject({ ok: false, code: 'invalid_counter_input' });
  });

  it('losing every compare-and-swap is counter_contention, not a silent no-op', async () => {
    const spy = vi.spyOn(DurableCollection.prototype, 'compareAndSwap').mockResolvedValue(false);
    try {
      expect(await runCounter(ownerRun('t-cas', 'p-1'), { key: 'a', op: 'inc' })).toMatchObject({ ok: false, code: 'counter_contention' });
      expect(spy).toHaveBeenCalledTimes(8);
    } finally { spy.mockRestore(); }
    expect(await runCounter(ownerRun('t-cas', 'p-1'), { key: 'a', op: 'read' })).toEqual({ ok: true, value: { key: 'a', count: 0 } });
  });
});

describe('ADR 0977 D2/D3 — the per-tool live predicate', () => {
  it('a live miss reaches the inner tool only for the admitted name; others fail closed', async () => {
    const calls: string[] = [];
    const inner: ExecuteAgentTool = async (call) => { calls.push(call.name); return { content: 'LIVE' }; };
    const ic = fixtureInterceptor(task({ toolResponses: [], onMiss: 'live' }), { allowLive: (t) => t === COUNTER_TOOL, agentId: 'a' });
    const w = ic.wrapDetailed(inner);
    expect(await w({ name: COUNTER_TOOL, input: { key: 'k', op: 'inc' } })).toMatchObject({ miss: 'live', result: { content: 'LIVE' } });
    expect(await w({ name: 'conformance.eval:lookup', input: {} })).toMatchObject({ miss: 'fail', result: { isError: true, errorCode: 'fixture_miss' } });
    expect(calls).toEqual([COUNTER_TOOL]);
    expect(ic.misses()).toBe(2);
    expect(ic.failClosedMisses()).toBe(1);
  });

  it('under onMiss "fail" even the admitted name never reaches the inner tool', async () => {
    const calls: string[] = [];
    const ic = fixtureInterceptor(task({ toolResponses: [], onMiss: 'fail' }), { allowLive: () => true, agentId: 'a' });
    await ic.wrap(async (call) => { calls.push(call.name); return { content: 'LIVE' }; })({ name: COUNTER_TOOL, input: {} });
    expect(calls).toEqual([]);
    expect(ic.failClosedMisses()).toBe(1);
  });
});

describe('ADR 0977 E2E — the G2 sequence live → miss → live, host side', () => {
  it('lists both counter fixtures (the opt-in)', () => {
    expect(listFixtureSuiteIds()).toEqual(expect.arrayContaining(['conformance-eval-counter-live', 'conformance-eval-counter-miss']));
  });

  it('live-miss-counted, first-unconsumed and miss-no-live-call all hold', async () => {
    const a = await runFixture('conformance-eval-counter-live');
    expect(a.returns, JSON.stringify(a.returns)).toHaveLength(4);
    // live-miss-counted: four live misses, counted, and they do not fail the trial (D3).
    expect(a.task['fixtureMissCount']).toBe(4);
    expect(a.task['passed'], JSON.stringify(a.task)).toBe(true);
    const [l1, l2, fA, sA] = a.returns.map(countOf) as [number, number, number, number];
    expect(l2).toBe(l1 + 1);
    expect(a.returns[0]!['outcome']).toEqual({ key: 'L', count: l1 });

    const b = await runFixture('conformance-eval-counter-miss');
    // first-unconsumed: served 1, served 2 (verbatim, D4), then a fail-closed miss.
    expect(b.returns.map((r) => r['outcome'] ?? null)).toEqual([{ served: 1 }, { served: 2 }, null, null]);
    expect(b.returns.slice(2).map((r) => (r['error'] as { code?: string } | undefined)?.code)).toEqual(['fixture_miss', 'fixture_miss']);
    expect(b.task['passed']).toBe(false);
    expect(b.task['fixtureMissCount']).toBe(2);

    const c = await runFixture('conformance-eval-counter-live');
    const [cl1, , cF, cS] = c.returns.map(countOf) as [number, number, number, number];
    // miss-no-live-call: the counter persisted across runs, and neither miss moved F or S.
    expect(cl1).toBe(l2 + 1);
    expect([cF, cS]).toEqual([fA, sA]);
  });

  it('D3 regression: conformance-eval-fixture-miss is unchanged (fail-closed miss fails the task)', async () => {
    const c = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: `${CONFORMANCE_SUITE_PREFIX}conformance-eval-fixture-miss`, agentId: SCRIPTED_AGENT_ID });
    expect(c.status, c.text.slice(0, 300)).toBe(201);
    const runId = String(c.json['runId']);
    expect(await waitTerminal(runId)).toBe('completed');
    const s = await send('GET', `/runs/${runId}/eval-summary`);
    const tasks = new Map(((s.json['tasks'] as Array<Record<string, unknown>>) ?? []).map((t) => [t['taskId'], t]));
    expect(tasks.get('missed'), s.text.slice(0, 400)).toMatchObject({ fixtureMissCount: 1, passed: false, score: 0 });
    expect(tasks.get('served')).toMatchObject({ passed: true });
    expect(tasks.get('served')!['fixtureMissCount'] ?? 0).toBe(0);
  });
});
