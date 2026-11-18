/**
 * ADR 1142 (RFC 0260) — end to end through the real app: discovery advertises
 * `replay.llmCacheKeyRecipe`, the `conformance-llm-cache-key` fixture is listed,
 * and its run's provider-call record on `GET /runs/{runId}/effects` carries the
 * recipe-2 `cacheKey` the suite recomputes.
 *
 * The digests are RFC 0260 §B's known answers, so this file pins the same values
 * `v2-replay-llm-cache-key` judges (`0260.key-portable`), and `params-in-key` /
 * `key-stable` are the inequality and equality below. Sabotage: dropping the
 * `llmOpts` on the success put reds the recorded case; hashing `AiCallRequest`
 * instead of `sentSampling` leaves the vectors green here (the mock forwards
 * both), which is why the unit file pins the per-provider sets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

const KEY_16 = 'f1714d7aa2abf5994dd375f66aac14514b1c2439f203a6171dc6053c59f54402';
const KEY_32 = '07e50afae3ca35d1bc0f52cab7c4bb55b46f8b82333d0a870d2b8dec3b85380b';

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' };
const prior = process.env.OPENWOP_LLM_CACHE_KEY_RECIPE_2;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  // Read at node registration, so it is set before the app boots.
  process.env.OPENWOP_LLM_CACHE_KEY_RECIPE_2 = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  if (prior === undefined) delete process.env.OPENWOP_LLM_CACHE_KEY_RECIPE_2; else process.env.OPENWOP_LLM_CACHE_KEY_RECIPE_2 = prior;
});

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : {} };
}
async function waitTerminal(runId: string, ms = 30_000): Promise<string> {
  const end = Date.now() + ms;
  for (;;) {
    const status = isRecord((await api(`/runs/${runId}`)).body) ? ((await api(`/runs/${runId}`)).body as Json)['status'] : undefined;
    if (typeof status === 'string' && ['completed', 'failed', 'cancelled'].includes(status)) return status;
    if (Date.now() > end) throw new Error(`run ${runId} still ${String(status)} after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
/** The `llm-call` node's projected `cacheKey` on one run. */
async function cacheKeyOf(runId: string): Promise<unknown> {
  const effects = (await api(`/runs/${runId}/effects`)).body as Json;
  const rows = Array.isArray(effects['effects']) ? (effects['effects'] as Json[]) : [];
  return rows.find((r) => r['nodeId'] === 'llm-call' && r['cacheKey'] !== undefined)?.['cacheKey'];
}
/** One fixture run; its id, status and the `llm-call` node's projected `cacheKey`. */
async function keyed(params: Json): Promise<{ runId: string; status: string; cacheKey: unknown }> {
  const create = await api('/runs', { method: 'POST', body: JSON.stringify({ workflowId: 'conformance-llm-cache-key', inputs: { request: { prompt: 'Say ok.', params } } }) });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const runId = String((create.body as Json)['runId']);
  const status = await waitTerminal(runId);
  return { runId, status, cacheKey: await cacheKeyOf(runId) };
}

describe('ADR 1142 — RFC 0260 on the wire', () => {
  it('discovery advertises the recipe and the fixture', async () => {
    const d = (await api('/.well-known/openwop')).body as Json;
    expect(JSON.stringify(d)).toContain('"llmCacheKeyRecipe":"openwop-llm-key-2"');
    expect(JSON.stringify(d)).toContain('conformance-llm-cache-key');
  });

  it('the provider-call record carries the recipe-2 key the suite recomputes (key-recorded, key-portable)', async () => {
    const r = await keyed({ maxTokens: 16, temperature: 0 });
    expect(r.status).toBe('completed');
    expect(r.cacheKey).toEqual({ recipe: 'openwop-llm-key-2', digest: KEY_16 });
  });

  it('maxTokens is in the key, and identical runs share one (params-in-key, key-stable)', async () => {
    const [a, b] = [await keyed({ maxTokens: 32, temperature: 0 }), await keyed({ maxTokens: 32, temperature: 0 })];
    expect(a.cacheKey).toEqual({ recipe: 'openwop-llm-key-2', digest: KEY_32 });
    expect(b.cacheKey).toEqual(a.cacheKey);
  });

  it('a replay fork carries the source record\'s key verbatim (§C.3)', async () => {
    const src = await keyed({ maxTokens: 16, temperature: 0 });
    expect(src.cacheKey).toEqual({ recipe: 'openwop-llm-key-2', digest: KEY_16 });
    const fork = await api(`/runs/${src.runId}:fork`, { method: 'POST', body: JSON.stringify({ fromSeq: 0, mode: 'replay' }) });
    expect(fork.status, JSON.stringify(fork.body)).toBeLessThan(300);
    const forkId = String((fork.body as Json)['runId']);
    expect(await waitTerminal(forkId)).toBe('completed');
    expect(await cacheKeyOf(forkId)).toEqual(src.cacheKey);
  });

  it('a parameter this host cannot send fails the node instead of being dropped', async () => {
    const r = await keyed({ maxTokens: 16, seed: 7 });
    expect(r.status).toBe('failed');
    expect(r.cacheKey).toBeUndefined();
  });
});
