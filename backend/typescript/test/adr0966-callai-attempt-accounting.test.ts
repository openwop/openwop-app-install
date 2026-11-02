/**
 * ADR 0966 (RFC 0248) — `ctx.callAI` reports every provider request it made
 * (`attempts`) and honours a per-call `retry` policy.
 *
 * Driven through the real executor and the conformance node
 * `conformance.callai.echo-attempts`, which scripts its own mock replies and
 * outputs the call's `attempts` verbatim. Each case is one node, so the
 * `provider.usage` events (one per provider request) are counted by `nodeId`,
 * the same normative surface the corpus legs read.
 *
 * Sabotage: not counting in `dispatchPlain` reds the count cases; ignoring
 * `maxAttempts` reds the cap; ignoring `growMaxTokens` reds the no-growth case;
 * dropping the `parseRetryPolicy` call reds the malformed case; not recording
 * `attempts` with the cached result reds the replay case. (All re-witnessed by the
 * w73 probes ca66-*; the replay case now also pins the SOURCE run's attempts as a
 * literal, so "both sides lost attempts" can no longer compare undefined with
 * undefined.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { receivedMaxTokens } from '../src/providers/dispatchMock.js';
import { bareRunId } from './support/bareRunId.js';

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' };
const SCHEMA = { type: 'object', required: ['line'], properties: { line: { type: 'string' } } };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

type Json = Record<string, unknown>;
type Ev = { sequence: number; type: string; nodeId?: string; payload?: Json };
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
/** One field of a JSON object body (`undefined` when the body is not an object). */
const field = (v: unknown, key: string): unknown => (isRecord(v) ? v[key] : undefined);
async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : {};
  return { status: res.status, body };
}
function runIdOf(body: unknown): string {
  const id = field(body, 'runId');
  if (typeof id !== 'string') throw new Error(`no runId: ${JSON.stringify(body)}`);
  return id;
}
/** Poll a run until it is terminal. A timeout THROWS; it never returns a non-terminal status. */
async function waitTerminal(runId: string, ms = 30_000): Promise<string> {
  const end = Date.now() + ms;
  let status: unknown;
  for (;;) {
    status = field((await api(`/runs/${runId}`)).body, 'status');
    if (typeof status === 'string' && ['completed', 'failed', 'cancelled'].includes(status)) return status;
    if (Date.now() > end) throw new Error(`waitTerminal: run ${runId} still ${String(status)} after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
function toEv(v: unknown): Ev {
  if (!isRecord(v) || typeof v.sequence !== 'number' || typeof v.type !== 'string') throw new Error(`not an event: ${JSON.stringify(v)}`);
  return {
    sequence: v.sequence, type: v.type,
    ...(typeof v.nodeId === 'string' ? { nodeId: v.nodeId } : {}),
    ...(isRecord(v.payload) ? { payload: v.payload } : {}),
  };
}
async function events(runId: string): Promise<Ev[]> {
  const res = await api(`/runs/${runId}/events/poll?fromSeq=-1&limit=1000`);
  const list = field(res.body, 'events');
  if (!Array.isArray(list)) throw new Error(`no events list: ${JSON.stringify(res.body)}`);
  return list.map(toEv);
}

let n = 0;
/** One node, one case. Returns the run, its events, and the node's id. */
async function runCase(config: Json): Promise<{ runId: string; status: string; evs: Ev[]; nodeId: string }> {
  const s = `${Date.now()}-${n++}`;
  const nodeId = `case_${s.replace(/-/g, '_')}`;
  const workflowId = `adr0966.case.${s}`;
  const reg = await api('/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({
    workflowId, nodes: [{ nodeId, typeId: 'conformance.callai.echo-attempts', config }], edges: [],
  }) });
  expect(reg.status, JSON.stringify(reg.body)).toBeLessThan(300);
  const create = await api('/runs', { method: 'POST', body: JSON.stringify({ workflowId }) });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const runId = runIdOf(create.body);
  const status = await waitTerminal(runId);
  return { runId, status, evs: await events(runId), nodeId };
}
const attemptsOf = (evs: Ev[], nodeId: string): Json | undefined => {
  const attempts = field(evs.find((e) => e.type === 'node.completed' && e.nodeId === nodeId)?.payload?.['outputs'], 'attempts');
  return isRecord(attempts) ? attempts : undefined;
};
const usages = (evs: Ev[], nodeId: string): Ev[] => evs.filter((e) => e.type === 'provider.usage' && e.nodeId === nodeId);

describe('ADR 0966 — attempts on the ctx.callAI result (RFC 0248 §A)', () => {
  it('§A.1/A.2 — invalid then valid: count 2, output tokens summed, one provider.usage per request', async () => {
    const { status, evs, nodeId } = await runCase({ prompt: 'x', responseSchema: SCHEMA, script: [
      { kind: 'invalid-json', outputTokens: 30 }, { kind: 'valid', outputTokens: 40 },
    ] });
    expect(status).toBe('completed');
    expect(attemptsOf(evs, nodeId)).toMatchObject({ count: 2, outputTokens: 70, usageComplete: true });
    expect(usages(evs, nodeId)).toHaveLength(2);
  });

  it('§A.2 — an attempt without usage makes usageComplete false (outputTokens is then a floor)', async () => {
    const { evs, nodeId } = await runCase({ prompt: 'x', responseSchema: SCHEMA, script: [
      { kind: 'invalid-json', usage: false }, { kind: 'valid', outputTokens: 40 },
    ] });
    expect(attemptsOf(evs, nodeId)).toMatchObject({ count: 2, outputTokens: 40, usageComplete: false });
  });

  it('§A.3 — structuredOutput is the FINAL attempt\'s mode, and absent without a responseSchema', async () => {
    const native = await runCase({ prompt: 'x', responseSchema: SCHEMA, script: [
      { kind: 'invalid-json', structuredMode: 'prompt' }, { kind: 'valid', structuredMode: 'native' },
    ] });
    expect(attemptsOf(native.evs, native.nodeId)?.['structuredOutput']).toBe('native');
    const plain = await runCase({ prompt: 'x', script: [{ kind: 'valid', outputTokens: 5 }] });
    expect(attemptsOf(plain.evs, plain.nodeId)).toEqual({ count: 1, outputTokens: 5, usageComplete: true });
  });

  it('§A.5 — a replay fork reports the recorded attempts, byte-equal', async () => {
    const src = await runCase({ prompt: 'x', responseSchema: SCHEMA, script: [
      { kind: 'invalid-json', outputTokens: 30 }, { kind: 'valid', outputTokens: 40 },
    ] });
    // Pin the source literally, so a fork and a source that BOTH lost attempts cannot compare equal.
    expect(attemptsOf(src.evs, src.nodeId)).toEqual({ count: 2, outputTokens: 70, usageComplete: true, structuredOutput: 'prompt' });
    const f = await api(`/runs/${src.runId}:fork`, { method: 'POST', body: JSON.stringify({ mode: 'replay', fromSeq: 0 }) });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    const forkId = runIdOf(f.body);
    expect(await waitTerminal(forkId)).toBe('completed');
    expect(attemptsOf(await events(forkId), src.nodeId)).toEqual(attemptsOf(src.evs, src.nodeId));
  });
});

describe('ADR 0966 — the per-call retry policy (RFC 0248 §B)', () => {
  it('§B.1 — maxAttempts: 1 makes one request and gives up, with totalAttempts 1', async () => {
    const { status, evs, nodeId } = await runCase({ prompt: 'x', responseSchema: SCHEMA, retry: { maxAttempts: 1 }, script: [
      { kind: 'invalid-json' }, { kind: 'valid' }, { kind: 'valid' },
    ] });
    expect(status).toBe('failed');
    expect(usages(evs, nodeId)).toHaveLength(1);
    const exhausted = evs.find((e) => e.nodeId === nodeId && /retry[.-]exhausted/.test(e.type));
    expect(exhausted?.payload?.['totalAttempts']).toBe(1);
  });

  it('§B.1 — without a policy the host keeps its own budget (the cap is what bound the case above)', async () => {
    const { status, evs, nodeId } = await runCase({ prompt: 'x', responseSchema: SCHEMA, script: [
      { kind: 'invalid-json' }, { kind: 'valid', outputTokens: 7 },
    ] });
    expect(status).toBe('completed');
    expect(usages(evs, nodeId)).toHaveLength(2);
  });

  it('§B.2 — growMaxTokens: false keeps every attempt at the request\'s maxTokens; the default doubles it', async () => {
    // The suite's `growth` case: the valid reply needs 150 tokens, so under a
    // budget that never grows every attempt is cut off and the call fails.
    const kept = await runCase({ prompt: 'x', responseSchema: SCHEMA, maxTokens: 100, retry: { growMaxTokens: false }, script: [
      { kind: 'truncated', outputTokens: 100 }, { kind: 'valid', outputTokens: 150 },
    ] });
    expect(kept.status).toBe('failed');
    const sent = receivedMaxTokens(kept.nodeId, bareRunId(kept.runId));
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((m) => m === 100)).toBe(true);
    // The clamp makes it visible on the normative surface too: no attempt reports more than 100.
    expect(usages(kept.evs, kept.nodeId).every((e) => { const t = e.payload?.['outputTokens']; return typeof t === 'number' && t <= 100; })).toBe(true);
    expect(usages(kept.evs, kept.nodeId)).toHaveLength(sent.length);

    const grown = await runCase({ prompt: 'x', responseSchema: SCHEMA, maxTokens: 100, script: [
      { kind: 'truncated', outputTokens: 100 }, { kind: 'valid', outputTokens: 150 },
    ] });
    expect(grown.status).toBe('completed');
    expect(receivedMaxTokens(grown.nodeId, bareRunId(grown.runId))[1]).toBeGreaterThan(100);
  });

  it('fixture contract — past the end of the script the last entry repeats', async () => {
    // One invalid reply, then nothing scripted: every later request must be
    // invalid too, so the call exhausts its budget instead of completing on the
    // mock's default reply.
    const { status, evs, nodeId } = await runCase({ prompt: 'x', responseSchema: SCHEMA, retry: { maxAttempts: 3 }, script: [
      { kind: 'invalid-json', outputTokens: 10 },
    ] });
    expect(status).toBe('failed');
    // One call is one node execution; the executor then retries the failed node,
    // and each re-execution is a fresh call. Judge the first.
    const firstFail = evs.findIndex((e) => e.type === 'node.failed' && e.nodeId === nodeId);
    const first = evs.slice(0, firstFail);
    expect(usages(first, nodeId).map((e) => e.payload?.['outputTokens'])).toEqual([10, 10, 10]);
    expect(first.find((e) => e.nodeId === nodeId && /retry[.-]exhausted/.test(e.type))?.payload?.['totalAttempts']).toBe(3);
  });

  it('§B.5 — a malformed policy is refused with validation_error naming the field, before any request', async () => {
    for (const [retry, fieldName] of [[{ maxAttempts: 0 }, 'retry.maxAttempts'], [{ maxAttempts: 2.5 }, 'retry.maxAttempts'], [{ growMaxTokens: 'no' }, 'retry.growMaxTokens'], [{ maxRetries: 2 }, 'retry.maxRetries']] as const) {
      const { status, evs, nodeId } = await runCase({ prompt: 'x', responseSchema: SCHEMA, retry, script: [{ kind: 'valid' }] });
      expect(status).toBe('failed');
      const failed = evs.find((e) => e.type === 'node.failed' && e.nodeId === nodeId)?.payload?.['error'];
      expect(field(failed, 'code')).toBe('validation_error');
      expect(field(field(failed, 'details'), 'field')).toBe(fieldName);
      expect(usages(evs, nodeId)).toHaveLength(0);
    }
  });
});

describe('ADR 0966 — the vendored fixture and the advert (suite 2.46.19)', () => {
  it('advertises aiProviders.callAccounting and lists the fixture it gates', async () => {
    const r = await fetch(`${BASE}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } });
    const body: unknown = await r.json();
    expect(field(field(body, 'aiProviders'), 'callAccounting')).toEqual({ attempts: true, retryPolicy: true });
    expect(field(body, 'fixtures')).toContain('conformance-callai-attempt-accounting');
  });

  it('the fixture reads request and script from the RUN INPUTS, as the suite sends them', async () => {
    // The suite's `count` case. A node that read only `config` runs an empty
    // script with no schema here, and reports count 1.
    const create = await api('/runs', { method: 'POST', body: JSON.stringify({
      workflowId: 'conformance-callai-attempt-accounting',
      inputs: { request: { prompt: 'conformance', responseSchema: SCHEMA, maxTokens: 256 }, script: [
        { kind: 'invalid-json', outputTokens: 10 }, { kind: 'valid', outputTokens: 20 },
      ] },
    }) });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = runIdOf(create.body);
    expect(await waitTerminal(runId)).toBe('completed');
    const evs = await events(runId);
    expect(attemptsOf(evs, 'callai-echo')).toEqual({ count: 2, outputTokens: 30, usageComplete: true, structuredOutput: 'prompt' });
    expect(usages(evs, 'callai-echo')).toHaveLength(2);
  });
});

