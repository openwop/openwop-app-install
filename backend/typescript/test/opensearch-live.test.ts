/**
 * ADR 0867 (durable storage tier: the `opensearch` search engine) — the adapter
 * (`host/search/openSearchSearch.ts`) against a REAL OpenSearch (testcontainers),
 * for what the mock contract test (`opensearch-search.test.ts`) cannot show: real
 * `_bulk` indexing, BM25 relevance ranking, `refresh=wait_for` visibility, a real
 * 404 on a never-created index, and per-tenant physical indices on a real engine.
 *
 * Red when: the higher-frequency doc does not rank first; a deleted doc is still
 * returned; a never-created index throws instead of reading empty; one tenant's
 * query finds another tenant's doc (each case has an own-tenant positive control,
 * so an index or refresh failure cannot pass as isolation).
 *
 * NOT run by `npm run ci`: it sets OPENWOP_SKIP_TESTCONTAINERS=1, so every case skips,
 * and the hosted CI job that set OPENWOP_OPENSEARCH_LIVE=1 is disabled. Run it with
 * Docker up: `OPENWOP_OPENSEARCH_LIVE=1 node node_modules/vitest/vitest.mjs run
 * test/opensearch-live.test.ts` (the flag hard-requires the run, never a silent skip).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { SearchSurface } from '../src/host/inMemorySurfaces.js';
import { createOpenSearchSearch, type OpenSearchConfig } from '../src/host/search/openSearchSearch.js';

async function isDockerReachable(): Promise<boolean> {
  if (process.env.OPENWOP_SKIP_TESTCONTAINERS === '1') return false;
  try {
    const { execSync } = await import('node:child_process');
    execSync('docker info > /dev/null 2>&1', { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const forceLive = process.env.OPENWOP_OPENSEARCH_LIVE === '1';
const dockerAvailable = forceLive || await isDockerReachable();
if (!dockerAvailable) {
  // eslint-disable-next-line no-console
  console.warn('[opensearch-live] Docker not reachable — skipping. Set OPENWOP_OPENSEARCH_LIVE=1 to require it.');
}

let container: StartedTestContainer | null = null;
let config: OpenSearchConfig;

beforeAll(async () => {
  if (!dockerAvailable) return;
  container = await new GenericContainer('opensearchproject/opensearch:2')
    .withExposedPorts(9200)
    .withEnvironment({
      'discovery.type': 'single-node',
      DISABLE_SECURITY_PLUGIN: 'true',          // hit http://… without auth
      DISABLE_INSTALL_DEMO_CONFIG: 'true',
      OPENSEARCH_JAVA_OPTS: '-Xms512m -Xmx512m', // keep the JVM small on CI
    })
    .withWaitStrategy(Wait.forHttp('/_cluster/health', 9200).forStatusCode(200))
    .withStartupTimeout(180_000)
    .start();
  config = {
    endpoint: `http://${container.getHost()}:${container.getMappedPort(9200)}`,
    indexPrefix: 'owp-test-',
  };
}, 240_000); // image pull + JVM start can be slow

afterAll(async () => {
  if (container) { try { await container.stop(); } catch { /* ignore */ } }
}, 60_000);

const searchFor = (tenantId: string): SearchSurface => createOpenSearchSearch({ tenantId }, { config });

describe('OpenSearch live integration', () => {
  it.skipIf(!dockerAvailable)('index + BM25 query ranks by relevance; delete removes', async () => {
    const s = searchFor('t1');
    expect(await s.index({ index: 'docs', docs: [
      { id: '1', fields: { title: 'the quick brown fox' } },
      { id: '2', fields: { title: 'quick quick rabbit' } },
      { id: '3', fields: { title: 'slow turtle' } },
    ] })).toEqual({ indexed: 3 });
    const res = await s.query({ index: 'docs', q: 'quick' }) as { hits: Array<{ id: string; score: number; fields: unknown }> };
    expect(new Set(res.hits.map((h) => h.id))).toEqual(new Set(['1', '2'])); // both match 'quick'
    expect(res.hits[0].id).toBe('2');               // higher term frequency ranks first (BM25)
    expect(res.hits[0].score).toBeGreaterThan(0);
    expect(res.hits[0].fields).toEqual({ title: 'quick quick rabbit' });
    expect(await s.delete({ index: 'docs', ids: ['2'] })).toEqual({ deleted: 1 });
    const after = await s.query({ index: 'docs', q: 'quick' }) as { hits: Array<{ id: string }> };
    expect(after.hits.map((h) => h.id)).toEqual(['1']); // the deleted doc is gone
  });

  it.skipIf(!dockerAvailable)('query on a never-created index returns no hits (404 handled)', async () => {
    expect(await searchFor('t1').query({ index: 'missing-index', q: 'x' })).toEqual({ hits: [] });
  });

  it.skipIf(!dockerAvailable)('isolates tenants via distinct physical indices', async () => {
    await searchFor('tenant-a').index({ index: 'docs', docs: [{ id: '1', fields: { t: 'secret-a' } }] });
    // Positive control: the owner finds it, so an empty answer below is isolation,
    // not a failed index or refresh.
    const own = await searchFor('tenant-a').query({ index: 'docs', q: 'secret-a' }) as { hits: Array<{ id: string }> };
    expect(own.hits.map((h) => h.id)).toEqual(['1']);
    // tenant-b's physical index (`owp-test-v2.<b32(tenant-b)>.<b32(docs)>`) is separate and empty.
    expect(await searchFor('tenant-b').query({ index: 'docs', q: 'secret-a' })).toEqual({ hits: [] });
  });
});
