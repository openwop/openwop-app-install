/**
 * ADR 0984 — RFC 0252: an eval task takes its fixtures from a recorded run.
 * The host is booted the way production runs (conformance nodes OFF, the
 * ADR 0898 eval-fixture opt-in ON), with the three scenario fixtures registered
 * as the suite ships them and the RFC 0252 wire switch forced on.
 *
 *   source-replayed  the replay's counter outcomes equal the source's, no miss,
 *                    `eval.started.fixtureRuns` echoes the map, and the live
 *                    counter did not move (a probe source sees +1, not +2);
 *   drift            the missed `inc P` fails closed: miss 1, failed, and the
 *                    probe's `read P` is unchanged;
 *   source-refused / -uniform
 *                    an unknown id, another tenant's bound id and a malformed id
 *                    get the same 400, with no id in it (a run that never
 *                    invoked the agent is the derivation unit case);
 *   fields-refused   a key naming no task, a target task that carries its own
 *                    fixtures, `fixtureRuns` without `mode: "eval"`, an empty map;
 *   wire             the derived entries never reach a run read, and the facet
 *                    and the body key follow the vendored schemas;
 *   derivation       (unit) no invocation, not terminal, a success without
 *                    `outcome`, a call without its return, an error without
 *                    `fixtureErrors`: each unusable; delegates are excluded;
 *                    an error becomes `isError` when `fixtureErrors` is on.
 *
 * Sabotage (2026-10-26, each red, then restored): derived fixtures not applied
 * reds source-replayed (the probe sees +2); a read error escaping the uniform
 * refusal reds §C; dropping the own-fixtures check, or the non-eval refusal,
 * reds §B; accepting a success without `outcome` reds "not held"; dropping the
 * invocation check reds "never invoked".
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'false';
  process.env.OPENWOP_CONFORMANCE_EVAL_FIXTURES = 'true';
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/index.js';
import { CONFORMANCE_SUITE_PREFIX, SCRIPTED_AGENT_ID, listFixtureSuiteIds } from '../src/host/evals/fixtureSuites.js';
import { COUNTER_TOOL } from '../src/host/evals/evalCounter.js';
import { evalSuiteCapability, resetRfc0252WireCache } from '../src/host/evals/evalCapability.js';
import { deriveFromRun } from '../src/host/evals/recordedFixtures.js';
import { getEventLog } from '../src/executor/eventLog.js';
import type { RunRecord } from '../src/types.js';

let server: Server;
let base = '';
const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };

// The three fixtures as the suite ships them (vendored at 2.46.32, loaded at boot).
const SOURCE = 'conformance-eval-recorded-source';
const REPLAY = 'conformance-eval-recorded-replay';
const DRIFT = 'conformance-eval-recorded-drift';

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
const create = (id: string, extra: Record<string, unknown> = {}) =>
  send('POST', '/runs', { mode: 'eval', evalSuiteRef: `${CONFORMANCE_SUITE_PREFIX}${id}`, agentId: SCRIPTED_AGENT_ID, ...extra });

async function runFixture(id: string, extra: Record<string, unknown> = {}) {
  const c = await create(id, extra);
  expect(c.status, c.text.slice(0, 400)).toBe(201);
  const runId = String(c.json['runId']);
  expect(await waitTerminal(runId)).toBe('completed');
  const evs = ((((await send('GET', `/runs/${runId}/events/poll?limit=500`)).json as { events?: unknown[] }).events ?? []) as Ev[])
    .sort((a, b) => a.sequence - b.sequence);
  const counter = evs.filter((e) => e.type === 'agent.tool-returned' && e.payload['toolName'] === COUNTER_TOOL).map((e) => e.payload['outcome']);
  const started = evs.find((e) => e.type === 'eval.started')?.payload ?? {};
  const s = await send('GET', `/runs/${runId}/eval-summary`);
  const task = ((s.json['tasks'] as Array<Record<string, unknown>>) ?? [])[0]!;
  return { runId, counter, started, task };
}
const count = (o: unknown): number => (o as { count: number }).count;
/** The error code, from either envelope shape (`error: "<code>"` or `error: {code}`). */
const codeOf = (r: Reply): unknown => (typeof r.json['error'] === 'string' ? r.json['error'] : (r.json['error'] as { code?: unknown } | undefined)?.code);

describe('RFC 0252 — the scenario legs, host side, in the suite order', () => {
  it('source-replayed and drift-fails-closed, witnessed by a probe source', async () => {
    const source1 = await runFixture(SOURCE);
    expect(source1.counter).toHaveLength(3);

    const replay = await runFixture(REPLAY, { fixtureRuns: { record: source1.runId } });
    // The accepted map, verbatim, on the wire (not under `vendor.openwop-app`).
    // Both sides are the tenant-bound wire id POST /runs handed back: the host
    // never rewrites map values (ADR 0723 binds keys), so it accepts only bound ids.
    expect(source1.runId).toMatch(/^[^/]+\/[A-Za-z0-9._~-]{16,128}$/);
    expect(replay.started['fixtureRuns']).toEqual({ record: source1.runId });
    expect((replay.started['vendor'] as Record<string, Record<string, unknown>> | undefined)?.['openwop-app']?.['fixtureRuns']).toBeUndefined();
    expect(replay.counter).toEqual(source1.counter);
    expect(replay.task['fixtureMissCount'] ?? 0).toBe(0);
    expect(replay.task['passed']).toBe(true);

    const drift = await runFixture(DRIFT, { fixtureRuns: { record: source1.runId } });
    expect(drift.task).toMatchObject({ fixtureMissCount: 1, passed: false });

    const source2 = await runFixture(SOURCE);
    // inc R: +1 since source1. +2 would mean the replay reached the live counter.
    expect(count(source2.counter[1])).toBe(count(source1.counter[1]) + 1);
    // read P: unchanged. The drift's missed `inc P` never ran live.
    expect(count(source2.counter[0])).toBe(count(source1.counter[0]));
  });

  it('the derived entries never reach a run read', async () => {
    const source = await runFixture(SOURCE);
    const replay = await runFixture(REPLAY, { fixtureRuns: { record: source.runId } });
    const read = await send('GET', `/runs/${replay.runId}`);
    expect(read.status).toBe(200);
    expect(read.text).not.toMatch(/recordedFixtures|toolResponses/);
  });
});

describe('RFC 0252 §C — one refusal for every unusable source, without the id', () => {
  it('a bare id of a usable source is refused like an unknown one, so no unbound id is echoed (ADR 0723)', async () => {
    const source = await runFixture(SOURCE);
    const bare = source.runId.split('/').pop()!;
    const [r, unknown] = [await create(REPLAY, { fixtureRuns: { record: bare } }), await create(REPLAY, { fixtureRuns: { record: `${source.runId.split('/')[0]}/${randomUUID().replace(/-/g, '')}` } })];
    for (const x of [r, unknown]) expect(x.status, x.text.slice(0, 300)).toBe(400);
    expect(codeOf(r)).toBe(codeOf(unknown));
    expect(r.json['message']).toEqual(unknown.json['message']);
    expect(r.text).not.toContain(bare);
  });

  it('an unknown id, another tenant\'s bound id and a malformed id answer alike (no invocation: the unit case below)', async () => {
    const unknown = `default/${randomUUID()}`;
    const foreign = `tenant-b/${randomUUID()}`;
    const replies = [
      await create(REPLAY, { fixtureRuns: { record: unknown } }),
      await create(REPLAY, { fixtureRuns: { record: foreign } }),
      await create(REPLAY, { fixtureRuns: { record: 'not-a-run' } }),
    ];
    for (const [r, id] of [[replies[0]!, unknown], [replies[1]!, foreign], [replies[2]!, 'not-a-run']] as const) {
      expect(r.status, r.text).toBe(400);
      expect(codeOf(r)).toBe('validation_error');
      expect(r.text).not.toContain(id.split('/').pop()!);
    }
    const bodies = replies.map((r) => JSON.stringify({ ...r.json, requestId: undefined }));
    expect(new Set(bodies).size).toBe(1);
  });
});

describe('RFC 0252 §B — request refusals', () => {
  it('a key naming no task, a task with its own fixtures, no mode, and an empty map are each 400 validation_error', async () => {
    const source = await runFixture(SOURCE);
    const cases = [
      await create(REPLAY, { fixtureRuns: { nope: source.runId } }),
      await create(SOURCE, { fixtureRuns: { record: source.runId } }),
      await create(REPLAY, { fixtureRuns: {} }),
      await send('POST', '/runs', { workflowId: 'anything', fixtureRuns: { record: source.runId } }),
    ];
    for (const r of cases) {
      expect(r.status, r.text).toBe(400);
      expect(codeOf(r)).toBe('validation_error');
    }
  });

  it('the facet member and the body key follow the vendored schemas', async () => {
    // The ONE builder discovery reads (ADR 0889 D7), from the real vendored schemas.
    expect(evalSuiteCapability()).toMatchObject({ recordedFixtures: true, fixtureMatching: true });
    expect(listFixtureSuiteIds()).toEqual(expect.arrayContaining([SOURCE, REPLAY, DRIFT]));
    resetRfc0252WireCache(false);
    try {
      expect(evalSuiteCapability().recordedFixtures).toBeUndefined();
      const r = await create(REPLAY, { fixtureRuns: { record: 'x' } });
      expect(r.status).toBe(400);
      expect(r.text).toMatch(/fixtureRuns/);
    } finally {
      resetRfc0252WireCache();
    }
  });
});

describe('RFC 0252 §C/§D — derivation (unit)', () => {
  const runOf = (status: string): RunRecord => ({ runId: `src-${randomUUID()}`, tenantId: 't', status } as RunRecord);
  const put = (runId: string, type: string, payload: Record<string, unknown>) => getEventLog().append({ runId, type, payload });
  const A = SCRIPTED_AGENT_ID;
  async function recorded(status = 'completed') {
    const run = runOf(status);
    await put(run.runId, 'agent.invocation.started', { invocationId: 'i', agentId: A });
    await put(run.runId, 'agent.toolCalled', { agentId: A, toolName: 'x', callId: 'c1', inputs: { a: 1 } });
    await put(run.runId, 'agent.toolReturned', { agentId: A, toolName: 'x', callId: 'c1', status: 'ok', outcome: { v: 1 } });
    await put(run.runId, 'agent.toolCalled', { agentId: 'delegate', toolName: 'y', callId: 'd1', inputs: {} });
    return run;
  }

  it('derives exact entries in sequence order, excluding delegates', async () => {
    const run = await recorded();
    expect(await deriveFromRun(run, A, { allowErrors: false })).toEqual([{ tool: 'x', args: { a: 1 }, argsMatch: 'exact', response: { v: 1 } }]);
  });

  it('a run that is not terminal, or never invoked the agent, is unusable', async () => {
    expect(await deriveFromRun(await recorded('running'), A, { allowErrors: false })).toBeNull();
    expect(await deriveFromRun(await recorded(), 'some.other.agent', { allowErrors: false })).toBeNull();
  });

  it('a success without its outcome, or a call without its return, is not held', async () => {
    const noOutcome = await recorded();
    await put(noOutcome.runId, 'agent.toolCalled', { agentId: A, toolName: 'x', callId: 'c2', inputs: {} });
    await put(noOutcome.runId, 'agent.toolReturned', { agentId: A, toolName: 'x', callId: 'c2', status: 'ok' });
    expect(await deriveFromRun(noOutcome, A, { allowErrors: true })).toBeNull();
    const noReturn = await recorded();
    await put(noReturn.runId, 'agent.toolCalled', { agentId: A, toolName: 'x', callId: 'c3', inputs: {} });
    expect(await deriveFromRun(noReturn, A, { allowErrors: true })).toBeNull();
  });

  it('a failed or forbidden call is an isError entry only with fixtureErrors', async () => {
    const run = await recorded();
    await put(run.runId, 'agent.toolCalled', { agentId: A, toolName: 'x', callId: 'c4', inputs: { b: 2 } });
    await put(run.runId, 'agent.toolReturned', { agentId: A, toolName: 'x', callId: 'c4', status: 'error', error: { code: 'boom', message: 'tool error' } });
    await put(run.runId, 'agent.toolCalled', { agentId: A, toolName: 'z', callId: 'c5', inputs: {} });
    await put(run.runId, 'agent.toolReturned', { agentId: A, toolName: 'z', callId: 'c5', status: 'forbidden' });
    expect(await deriveFromRun(run, A, { allowErrors: false })).toBeNull();
    expect((await deriveFromRun(run, A, { allowErrors: true }))?.slice(1)).toEqual([
      { tool: 'x', args: { b: 2 }, argsMatch: 'exact', response: { code: 'boom', message: 'tool error' }, isError: true },
      { tool: 'z', args: {}, argsMatch: 'exact', response: { code: 'forbidden' }, isError: true },
    ]);
  });
});
