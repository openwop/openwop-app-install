/**
 * ADR 0904 P5 (Track 2, D1) — the operator host embedder, built INERT: unset env = no
 * behaviour change, the boot refuses it without a daily spend cap (architect A3), and an
 * unreachable embedder degrades honestly. (Query-aware embeddings are P1a's test.)
 *
 * Pinned, each sabotage-witnessed (revert → red → restore):
 *  - resolution order: per-collection spec → explicit `provider` (BYOK) → operator arm
 *    when the collection made no choice → local hash; `anon:` and non-allowlisted tenants
 *    never get the operator arm;
 *  - the query embed is metered: over the daily cap the search is lexical-only, labelled;
 *  - an unreachable operator embedder degrades to lexical-only, never another model;
 *  - boot refuses the operator arm with no cap, or with a value it cannot serve;
 *  - the Vertex adapter: one request per text over a bounded pool, RETRIEVAL_* task
 *    types, Retry-After on 429, a fresh token after a 401, width checked, unit vectors;
 *  - INERT: with OPENWOP_KB_HOST_EMBEDDER unset nothing changes (local hash, `none`).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollection, ingestDocument, searchDetailed, setRetrievalConfig, collectionQuality, KB_MAINTENANCE_CALLER, CHUNKER_VERSION } from '../src/features/kb/kbService.js';
import { assertHostEmbedderBootConfig, registerKbEmbeddingBudget } from '../src/features/kb/embedBudget.js';
import { __setHeadlessEmbedderForTest, __setHostEmbedderForTest, hostEmbedderEligible, type HeadlessEmbedder } from '../src/host/headlessAi.js';
import { createVertexEmbed, __resetVertexProjectForTests } from '../src/host/vertexEmbedder.js';
import { embedText, DEFAULT_EMBEDDING_DIMS } from '../src/aiProviders/localEmbedding.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import type { GcpMetadataClient } from '../src/host/gcpAdc.js';

const ORG = 'org-1';
let n = 0;
const tenant = () => `org:kb0904p1-${Date.now()}-${n++}`;

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kb0904p1-')) });
  initHostExtPersistence(await openStorage('memory://'));
  registerKbEmbeddingBudget();
});
afterEach(() => {
  __setHeadlessEmbedderForTest(null);
  __setHostEmbedderForTest(null);
  delete process.env.OPENWOP_KB_HOST_EMBEDDER;
  delete process.env.OPENWOP_KB_HOST_EMBEDDER_TENANTS;
  delete process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY;
});

interface Call { texts: readonly string[]; inputType: 'query' | 'document' }
function fake(label: Partial<HeadlessEmbedder> & { model: string; provider: string }, calls: Call[] = []): HeadlessEmbedder {
  return {
    ...label,
    embed: async (texts, inputType = 'document') => {
      calls.push({ texts, inputType });
      return texts.map((t) => embedText(`${label.model}:${t}`, DEFAULT_EMBEDDING_DIMS));
    },
  };
}

async function collectionWith(tenantId: string, cfg: Record<string, unknown> = {}): Promise<string> {
  const c = await createCollection(tenantId, ORG, 'u', { name: 'c' });
  if (Object.keys(cfg).length > 0) await setRetrievalConfig(tenantId, ORG, c.collectionId, 'u', cfg);
  await ingestDocument(tenantId, ORG, 'u', c.collectionId, { title: 'Leave', text: 'Parental leave is sixteen weeks at full pay for every employee.' });
  await ingestDocument(tenantId, ORG, 'u', c.collectionId, { title: 'Expenses', text: 'Meals are reimbursed up to fifty dollars per day when travelling.' });
  return c.collectionId;
}

describe('ADR 0904 D1 — the operator host embedder arm', () => {
  it('is inert while OPENWOP_KB_HOST_EMBEDDER is unset: a default collection stays on the local hash', async () => {
    let called = false;
    __setHostEmbedderForTest(async () => { called = true; return null; });
    const t = tenant();
    const col = await collectionWith(t);
    expect((await searchDetailed(t, ORG, col, 'parental leave', 3, 'dense')).embedding.mode).toBe('local');
    const q = (await collectionQuality(t, ORG, KB_MAINTENANCE_CALLER)).find((c) => c.collectionId === col)!;
    expect(q.embedder).toMatchObject({ mode: 'local', funding: 'none' });
    expect(called, 'the operator arm is never consulted').toBe(false);
  });

  it('a collection that made no choice gets the operator embedder; explicit choices keep theirs', async () => {
    process.env.OPENWOP_KB_HOST_EMBEDDER = 'vertex:gemini-embedding-001';
    const hostCalls: Call[] = [];
    const byokCalls: Call[] = [];
    __setHostEmbedderForTest(async () => fake({ model: 'gemini-embedding-001', provider: 'vertex', funding: 'host', embedVersion: 'q1' }, hostCalls));
    __setHeadlessEmbedderForTest(async () => fake({ model: 'text-embedding-3-small', provider: 'openai', funding: 'byok' }, byokCalls));
    const t = tenant();
    const dflt = await collectionWith(t);
    const local = await collectionWith(t, { embedder: 'local' });
    const byok = await collectionWith(t, { embedder: 'provider' });

    const d = await searchDetailed(t, ORG, dflt, 'parental leave weeks', 3, 'dense');
    expect(d.embedding).toMatchObject({ mode: 'provider', provider: 'vertex', funding: 'host', model: 'gemini-embedding-001' });
    expect((await searchDetailed(t, ORG, local, 'parental leave weeks', 3, 'dense')).embedding.mode).toBe('local');
    expect((await searchDetailed(t, ORG, byok, 'parental leave weeks', 3, 'dense')).embedding).toMatchObject({ provider: 'openai', funding: 'byok' });

    const q = new Map((await collectionQuality(t, ORG, KB_MAINTENANCE_CALLER)).map((c) => [c.collectionId, c]));
    expect(q.get(dflt)!.embedder).toMatchObject({ funding: 'host', provider: 'vertex', available: true });
    expect(q.get(dflt)!.expectedSignature).toBe(`host:gemini-embedding-001:${DEFAULT_EMBEDDING_DIMS}:off:v${CHUNKER_VERSION}:q1`);
    expect(q.get(dflt)!.indexState).toBe('current');
    expect(q.get(local)!.embedder.funding).toBe('none');
    // OpenAI's signature is byte-identical to the pre-0904 shape: no rebuild for it.
    expect(q.get(byok)!.expectedSignature).toBe(`provider:text-embedding-3-small:${DEFAULT_EMBEDDING_DIMS}:off:v${CHUNKER_VERSION}`);

    // `default` clears an explicit choice back onto the deployment default.
    await setRetrievalConfig(t, ORG, local, 'u', { embedder: 'default' });
    expect((await searchDetailed(t, ORG, local, 'parental leave weeks', 3, 'dense')).embedding.funding).toBe('host');
  });

  it('anon tenants and tenants outside the allowlist never get the operator arm', async () => {
    process.env.OPENWOP_KB_HOST_EMBEDDER = 'vertex:gemini-embedding-001';
    __setHostEmbedderForTest(async () => fake({ model: 'gemini-embedding-001', provider: 'vertex', funding: 'host' }));
    expect(hostEmbedderEligible('anon:abc')).toBe(false);
    expect(hostEmbedderEligible('org:acme')).toBe(true);
    const anon = `anon:kb0904-${n++}`;
    const col = await collectionWith(anon);
    expect((await searchDetailed(anon, ORG, col, 'parental leave', 3, 'dense')).embedding.mode).toBe('local');
    process.env.OPENWOP_KB_HOST_EMBEDDER_TENANTS = 'org:someone-else';
    const t = tenant();
    const col2 = await collectionWith(t);
    expect((await searchDetailed(t, ORG, col2, 'parental leave', 3, 'dense')).embedding.mode).toBe('local');
  });

  it('an unreachable operator embedder degrades to lexical-only, labelled — never another model', async () => {
    process.env.OPENWOP_KB_HOST_EMBEDDER = 'vertex:gemini-embedding-001';
    __setHostEmbedderForTest(async () => ({ model: 'gemini-embedding-001', provider: 'vertex', funding: 'host', embedVersion: 'q1', embed: async () => { throw new Error('metadata unreachable'); } }));
    const t = tenant();
    const col = await collectionWith(t);
    const r = await searchDetailed(t, ORG, col, 'parental leave weeks', 3, 'dense');
    expect(r.embedding.mode).toBe('lexical-only');
    expect(r.hits[0]?.title).toBe('Leave');
  });

  it('meters the query embed: over the daily cap the search is lexical-only', async () => {
    const calls: Call[] = [];
    __setHeadlessEmbedderForTest(async () => fake({ model: 'text-embedding-3-small', provider: 'openai', funding: 'byok' }, calls));
    const t = tenant();
    const col = await collectionWith(t, { embedder: 'provider' });
    expect((await searchDetailed(t, ORG, col, 'parental leave', 3, 'dense')).embedding.mode).toBe('provider'); // hydrated, uncapped
    process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY = '1';
    const before = calls.filter((c) => c.inputType === 'query').length;
    const r = await searchDetailed(t, ORG, col, 'parental leave weeks at full pay', 3, 'dense');
    expect(r.embedding.mode).toBe('lexical-only');
    expect(calls.filter((c) => c.inputType === 'query').length).toBe(before);
  });
});

describe('ADR 0904 D1 (A3) — boot spend guard', () => {
  it('refuses the operator arm with no daily cap, and an unsupported value', () => {
    expect(() => assertHostEmbedderBootConfig({})).not.toThrow();
    expect(() => assertHostEmbedderBootConfig({ OPENWOP_KB_HOST_EMBEDDER: 'vertex:gemini-embedding-001' })).toThrow(/OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY/);
    expect(() => assertHostEmbedderBootConfig({ OPENWOP_KB_HOST_EMBEDDER: 'vertex:gemini-embedding-001', OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY: '0' })).toThrow(/OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY/);
    expect(() => assertHostEmbedderBootConfig({ OPENWOP_KB_HOST_EMBEDDER: 'vertex:gemini-embedding-001', OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY: '2000000' })).not.toThrow();
    expect(() => assertHostEmbedderBootConfig({ OPENWOP_KB_HOST_EMBEDDER: 'openai:text-embedding-3-small', OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY: '2000000' })).toThrow(/not supported/);
    expect(() => assertHostEmbedderBootConfig({ OPENWOP_KB_HOST_EMBEDDER: 'vertex:gemini-embedding-001:extra', OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY: '2000000' })).toThrow(/not supported/);
  });
});

describe('ADR 0904 D1 — Vertex adapter', () => {
  function metadata(tokens: string[]): GcpMetadataClient & { invalidations: number } {
    let i = 0;
    const md = {
      invalidations: 0,
      accessToken: async () => tokens[Math.min(i, tokens.length - 1)]!,
      metadataText: async () => 'proj-x',
      invalidate: () => { md.invalidations += 1; i += 1; },
    };
    return md;
  }

  it('one request per text over a bounded pool, task types, unit vectors', async () => {
    __resetVertexProjectForTests();
    let inFlight = 0;
    let peak = 0;
    const seen: Array<{ url: string; body: { instances: Array<{ content: string; task_type: string }>; parameters: { outputDimensionality: number } }; auth: string }> = [];
    const { embed, stats } = createVertexEmbed('gemini-embedding-001', 3, {
      beforeAttempt: async () => {}, // transport shape tests; durable admission has its own SQLite witnesses
      env: { OPENWOP_VERTEX_EMBED_CONCURRENCY: '2', OPENWOP_VERTEX_LOCATION: 'europe-west4' },
      metadata: metadata(['tok-1']),
      fetchImpl: async (url, init) => {
        inFlight += 1; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        seen.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization! });
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ predictions: [{ embeddings: { values: [3, 4, 0] } }] }) };
      },
    });
    const out = await embed(['a', 'b', 'c', 'd', 'e'], 'query');
    expect(stats.calls).toBe(5);
    expect(peak).toBe(2);
    expect(out[0]).toEqual([0.6, 0.8, 0]);
    // ADR 0812 KEEP — Google's own REST API version (`googleapis.com/v1`), not the OpenWOP v1 wire.
    expect(seen[0]!.url).toBe('https://europe-west4-aiplatform.googleapis.com/v1/projects/proj-x/locations/europe-west4/publishers/google/models/gemini-embedding-001:predict'); // ADR 0812 KEEP
    expect(seen.every((s) => s.body.instances.length === 1 && s.body.instances[0]!.task_type === 'RETRIEVAL_QUERY' && s.body.parameters.outputDimensionality === 3)).toBe(true);
    expect(seen[0]!.auth).toBe('Bearer tok-1');
    expect(new Set(seen.map((s) => s.body.instances[0]!.content))).toEqual(new Set(['a', 'b', 'c', 'd', 'e']));
  });

  it('rejects nonnumeric vector entries and normalizes large finite entries without overflow', async () => {
    const provider = (values: unknown[]) => createVertexEmbed('gemini-embedding-001', 3, {
      beforeAttempt: async () => {},
      env: { OPENWOP_VERTEX_PROJECT: 'fixture' }, metadata: metadata(['fixture-token']),
      fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ predictions: [{ embeddings: { values } }] }) }),
    });
    await expect(provider(['invalid', 0, 0]).embed(['x'], 'document')).rejects.toThrow('finite numbers');
    await expect(provider([null, 0, 0]).embed(['x'], 'document')).rejects.toThrow('finite numbers');
    const [vector] = await provider([1e308, 1e308, 0]).embed(['x'], 'document');
    expect(vector!.every(Number.isFinite)).toBe(true);
    expect(vector![0]).toBeCloseTo(Math.SQRT1_2); expect(vector![1]).toBeCloseTo(Math.SQRT1_2);
  });

  it('honours Retry-After on 429, refreshes the token once on 401, and checks the width', async () => {
    __resetVertexProjectForTests();
    const sleeps: number[] = [];
    const responses = [
      { ok: false, status: 429, retry: '2', body: '' },
      { ok: false, status: 401, retry: null, body: 'expired' },
      { ok: true, status: 200, retry: null, body: JSON.stringify({ predictions: [{ embeddings: { values: [1, 0, 0] } }] }) },
    ];
    const auths: string[] = [];
    const md = metadata(['old', 'new']);
    const { embed } = createVertexEmbed('gemini-embedding-001', 3, {
      beforeAttempt: async () => {}, // transport shape tests; durable admission has its own SQLite witnesses
      env: { OPENWOP_VERTEX_PROJECT: 'p' },
      metadata: md,
      sleep: async (ms) => { sleeps.push(ms); },
      fetchImpl: async (_u, init) => {
        auths.push(init.headers.authorization!);
        const r = responses.shift()!;
        return { ok: r.ok, status: r.status, headers: { get: (h: string) => (h === 'retry-after' ? r.retry : null) }, text: async () => r.body };
      },
    });
    expect(await embed(['x'], 'document')).toEqual([[1, 0, 0]]);
    expect(sleeps).toEqual([2000]);
    expect(md.invalidations).toBe(1);
    expect(auths).toEqual(['Bearer old', 'Bearer old', 'Bearer new']);

    const wrongWidth = createVertexEmbed('gemini-embedding-001', 3, {
      beforeAttempt: async () => {}, // transport shape tests; durable admission has its own SQLite witnesses
      env: { OPENWOP_VERTEX_PROJECT: 'p' }, metadata: metadata(['t']),
      fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ predictions: [{ embeddings: { values: [1, 0] } }] }) }),
    });
    await expect(wrongWidth.embed(['x'], 'document')).rejects.toThrow(/expected a 3-d vector/);
  });
});
