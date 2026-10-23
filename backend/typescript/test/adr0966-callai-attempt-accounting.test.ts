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
 * `attempts` with the cached result reds the replay case.
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
async function api<T = Json>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}
async function waitTerminal(runId: string): Promise<string> {
  let status = '';
  for (let i = 0; i < 300; i++) {
    status = (await api<{ status: string }>(`/runs/${runId}`)).body.status;
    if (['completed', 'failed', 'cancelled'].includes(status)) return status;
    await new Promise((r) => setTimeout(r, 20));
  }
  return status;
}
async function events(runId: string): Promise<Ev[]> {
  return (await api<{ events: Ev[] }>(`/runs/${runId}/events/poll?fromSeq=-1&limit=1000`)).body.events ?? [];
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
  const create = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId }) });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const runId = create.body.runId;
  const status = await waitTerminal(runId);
  return { runId, status, evs: await events(runId), nodeId };
}
const attemptsOf = (evs: Ev[], nodeId: string): Json | undefined =>
  (evs.find((e) => e.type === 'node.completed' && e.nodeId === nodeId)?.payload?.['outputs'] as { attempts?: Json } | undefined)?.attempts;
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
    const f = await api<{ runId: string }>(`/runs/${src.runId}:fork`, { method: 'POST', body: JSON.stringify({ mode: 'replay', fromSeq: 0 }) });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    expect(await waitTerminal(f.body.runId)).toBe('completed');
    expect(attemptsOf(await events(f.body.runId), src.nodeId)).toEqual(attemptsOf(src.evs, src.nodeId));
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
    expect(usages(kept.evs, kept.nodeId).every((e) => (e.payload?.['outputTokens'] as number) <= 100)).toBe(true);
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
    for (const [retry, field] of [[{ maxAttempts: 0 }, 'retry.maxAttempts'], [{ maxAttempts: 2.5 }, 'retry.maxAttempts'], [{ growMaxTokens: 'no' }, 'retry.growMaxTokens'], [{ maxRetries: 2 }, 'retry.maxRetries']] as const) {
      const { status, evs, nodeId } = await runCase({ prompt: 'x', responseSchema: SCHEMA, retry, script: [{ kind: 'valid' }] });
      expect(status).toBe('failed');
      const failed = evs.find((e) => e.type === 'node.failed' && e.nodeId === nodeId)?.payload?.['error'] as { code?: string; details?: { field?: string } } | undefined;
      expect(failed?.code).toBe('validation_error');
      expect(failed?.details?.field).toBe(field);
      expect(usages(evs, nodeId)).toHaveLength(0);
    }
  });
});

describe('ADR 0966 — the vendored fixture and the advert (suite 2.46.19)', () => {
  it('advertises aiProviders.callAccounting and lists the fixture it gates', async () => {
    const r = await fetch(`${BASE}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } });
    const body = (await r.json()) as { aiProviders?: { callAccounting?: unknown }; fixtures?: string[] };
    expect(body.aiProviders?.callAccounting).toEqual({ attempts: true, retryPolicy: true });
    expect(body.fixtures).toContain('conformance-callai-attempt-accounting');
  });

  it('the fixture reads request and script from the RUN INPUTS, as the suite sends them', async () => {
    // The suite's `count` case. A node that read only `config` runs an empty
    // script with no schema here, and reports count 1.
    const create = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({
      workflowId: 'conformance-callai-attempt-accounting',
      inputs: { request: { prompt: 'conformance', responseSchema: SCHEMA, maxTokens: 256 }, script: [
        { kind: 'invalid-json', outputTokens: 10 }, { kind: 'valid', outputTokens: 20 },
      ] },
    }) });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    expect(await waitTerminal(create.body.runId)).toBe('completed');
    const evs = await events(create.body.runId);
    expect(attemptsOf(evs, 'callai-echo')).toEqual({ count: 2, outputTokens: 30, usageComplete: true, structuredOutput: 'prompt' });
    expect(usages(evs, 'callai-echo')).toHaveLength(2);
  });
});

void bareRunId;
