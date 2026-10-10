/**
 * host.knowledge — `vendor.myndhyve.knowledge-tools` retrieval against the demo
 * host. Proves the surface returns real, ranked, query-relevant chunks with
 * de-duplicated sources (lexical RAG over the seeded corpus), both end-to-end
 * through the mounted pack node and surface-direct (collection filter + shape).
 *
 * Why (ADR 0014 Phase 0 + LEAK-10): with no KB collections the tenant falls back to
 * the seeded corpus ONLY in demo mode, so this file sets `OPENWOP_DEMO_MODE`.
 * SABOTAGE-WITNESSED (/grade-tests wave 6): unsorted scoring, no collection filter, no
 * score threshold, no source de-dup, the demo gate forced off, or the KB backend
 * answering empty instead of `null` for a no-KB tenant each reds a case. (Before this
 * pass the filter, threshold and ranking legs used queries those breaks could not
 * change — they were green with each removed.)
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_DEMO_MODE = 'true'; // LEAK-10: the seeded demo corpus fallback is demo-gated
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { delete process.env.OPENWOP_DEMO_MODE; await new Promise<void>((res) => server.close(() => res())); });

async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json()) as T };
}

/** Matches chunks in BOTH demo collections and in several handbook chunks, so
 *  ranking, filtering and thresholds all have something to act on. */
const MULTI = 'rotate API keys security credentials onboarding training';

interface BundleEvent { type?: string; nodeId?: string; payload?: Record<string, unknown> }

describe('host.knowledge: retrieve node returns ranked chunks + sources', () => {
  it('a knowledge.retrieve run surfaces query-relevant chunks', async () => {
    await jsonFetch('/host/openwop-app/workflows', {
      method: 'POST',
      body: JSON.stringify({ workflowId: 'openwop-app.knowledge', nodes: [{ nodeId: 'op', typeId: 'knowledge.retrieve' }], edges: [] }),
    });
    const create = await jsonFetch<{ runId: string }>('/runs', {
      method: 'POST',
      body: JSON.stringify({ workflowId: 'openwop-app.knowledge', inputs: { query: MULTI } }),
    });
    expect(create.status).toBe(201);
    const { runId } = create.body;
    // No settle hook to await: poll the run to a terminal state (was a fixed 40×25ms =
    // 1s budget, a flake under a loaded gate).
    let status = 'pending';
    await vi.waitFor(async () => {
      status = (await jsonFetch<{ status: string }>(`/runs/${runId}`)).body.status;
      expect(['completed', 'failed', 'cancelled']).toContain(status);
    }, { timeout: 15_000, interval: 25 });
    expect(status).toBe('completed');
    const bundle = await jsonFetch<{ events?: BundleEvent[] }>(`/runs/${runId}/debug-bundle`);
    const out = ((bundle.body.events ?? []).find((e) => e.type === 'node.completed' && e.nodeId === 'op')?.payload?.outputs ?? {}) as Record<string, unknown>;
    const chunks = out.chunks as Array<Record<string, unknown>>;
    expect(out.hasResults).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
    // RANKED: several chunks match; the security/credentials chunk matches most terms and
    // must come first, and scores never increase down the list.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.assetId).toBe('doc-security');
    const scores = chunks.map((c) => c.relevanceScore as number);
    expect(scores[0]).toBeGreaterThan(0);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    const sources = out.sources as Array<Record<string, unknown>>;
    expect(sources.some((s) => s.assetId === 'doc-security')).toBe(true);
  });
});

describe('host.knowledge: surface-direct', () => {
  const kb = () => buildHostSurfaceBundle({ tenantId: 'kb-test' }).knowledge;

  it('filters by collectionIds and de-duplicates sources by asset', async () => {
    // The query matches the engineering runtime chunks AND the handbook security chunk.
    const query = 'workflow triggers event log runtime security credentials';
    const unfiltered = await kb().retrieve({ query, resultLimit: 5 }) as Record<string, unknown>;
    expect((unfiltered.chunks as Array<Record<string, unknown>>).some((c) => c.collectionId === 'handbook'), 'control: the handbook matches too').toBe(true);
    const res = await kb().retrieve({ query, collectionIds: ['engineering'], resultLimit: 5 }) as Record<string, unknown>;
    const chunks = res.chunks as Array<Record<string, unknown>>;
    expect(chunks.length).toBeGreaterThan(0);
    // Only the engineering collection is in scope.
    expect(chunks.every((c) => c.collectionId === 'engineering')).toBe(true);
    // doc-arch has two chunks (c4, c5), both returned — sources must collapse to one entry.
    expect(chunks.filter((c) => c.assetId === 'doc-arch')).toHaveLength(2);
    const sources = res.sources as Array<Record<string, unknown>>;
    expect(sources.filter((s) => s.assetId === 'doc-arch')).toHaveLength(1);
    // Required citation fields present.
    expect(sources.length).toBeGreaterThan(0);
    expect(typeof sources[0]!.sourceId).toBe('string');
    expect(typeof sources[0]!.title).toBe('string');
  });

  it('honors scoreThreshold and returns no results for an unrelated query', async () => {
    // The threshold drops lower-scored matches (relevance is normalised to the top hit = 1).
    const all = (await kb().retrieve({ query: MULTI }) as { chunks: Array<{ relevanceScore: number }> }).chunks;
    const top = (await kb().retrieve({ query: MULTI, scoreThreshold: 1 }) as { chunks: Array<{ relevanceScore: number }> }).chunks;
    expect(all.length).toBeGreaterThan(1);
    expect(top.length).toBeGreaterThan(0);
    expect(top.length).toBeLessThan(all.length);
    expect(top.every((c) => c.relevanceScore === 1)).toBe(true);
    // …and an unrelated query returns nothing.
    const res = await kb().retrieve({ query: 'zzzqqq nonexistent topic xylophone', scoreThreshold: 0.01 }) as Record<string, unknown>;
    expect(res.hasResults).toBe(false);
    expect((res.chunks as unknown[]).length).toBe(0);
  });
});
