/** ADR0904: provider dispatch must own a durable daily reservation. Real SQLite
 * connections pin last-slot contention and uncertain commit acknowledgements. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage, type Storage } from '../src/storage/index.js';
import { checkEmbedBudget, reserveEmbedBudget } from '../src/features/kb/embedBudget.js';
import { createCollection, ingestDocument, chunkText, type KnowledgeDocument } from '../src/features/kb/kbService.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { runWithEffectContext } from '../src/host/runEffectContext.js';
import { callTokens, prefixesFor } from '../src/features/kb/contextualEnrichment.js';

let a: Storage; let b: Storage;
const savedCap = process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY;
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-reservation-'));
  initInMemorySurfaces({ dataDir: dir });
  const file = join(dir, 'primary.db');
  a = await openStorage(`sqlite://${file}`); b = await openStorage(`sqlite://${file}`);
  initHostExtPersistence(a); process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY = '10';
});
afterEach(async () => {
  initHostExtPersistence(a);
  await b.close(); await a.close();
  if (savedCap === undefined) delete process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY;
  else process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY = savedCap;
});
const bind = (target: Storage, prop: string | symbol): unknown => {
  const value: unknown = Reflect.get(target, prop);
  return typeof value === 'function' ? value.bind(target) : value;
};

it('two SQLite writers competing for the last slot authorize exactly one dispatch', async () => {
  let next = 0;
  initHostExtPersistence(new Proxy(a, { get(target, prop) {
    if (prop === 'kvCompareAndSwap') return (...args: Parameters<Storage['kvCompareAndSwap']>) =>
      (next++ % 2 === 0 ? a : b).kvCompareAndSwap(...args);
    return bind(target, prop);
  } }));
  const results = await Promise.all([reserveEmbedBudget('last-slot', 10), reserveEmbedBudget('last-slot', 10)]);
  expect(results.filter(r => !r.exceeded)).toHaveLength(1);
  initHostExtPersistence(b);
  expect((await checkEmbedBudget('last-slot', 0)).used).toBe(10);
});

it('a lost reservation acknowledgement charges the committed slot and refuses dispatch after restart', async () => {
  initHostExtPersistence(new Proxy(a, { get(target, prop) {
    if (prop === 'kvCompareAndSwap') return async (...args: Parameters<Storage['kvCompareAndSwap']>) => {
      const result = await a.kvCompareAndSwap(...args);
      if (args[0].includes('kb:embedusage:') && result.swapped) throw new Error('lost acknowledgement');
      return result;
    };
    return bind(target, prop);
  } }));
  expect(await reserveEmbedBudget('lost-ack', 10)).toMatchObject({ exceeded: true, unavailable: true });
  initHostExtPersistence(b);
  expect((await checkEmbedBudget('lost-ack', 0)).used).toBe(10);
  expect((await reserveEmbedBudget('lost-ack', 1)).exceeded).toBe(true);
});

it('an unreadable reservation counter cannot authorize a paid call', async () => {
  initHostExtPersistence(new Proxy(a, { get(target, prop) {
    if (prop === 'kvGet') return async () => { throw new Error('storage unavailable'); };
    return bind(target, prop);
  } }));
  expect(await reserveEmbedBudget('unreadable', 1)).toMatchObject({ exceeded: true, unavailable: true });
});

it('a malformed provider response keeps its reservation and a competing chunk cannot overspend', async () => {
  delete process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY;
  const col = await createCollection('malformed', 'o', 'u', { name: 'manuals' });
  await ingestDocument('malformed', 'o', 'u', col.collectionId, { title: 'Manual', text: 'bounded manual '.repeat(230) }, { documentId: 'document' });
  const documents = new DurableCollection<KnowledgeDocument>('kb:document', d => `${d.tenantId}:${d.orgId}:${d.documentId}`);
  const doc = await documents.get('malformed:o:document'); expect(doc).not.toBeNull();
  const chunks = chunkText(doc!.text);
  const tokens = Math.max(...chunks.map(c => callTokens(doc!.text, c)));
  process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY = String(tokens);
  let calls = 0;
  const result = await prefixesFor('malformed', col.collectionId, doc!, chunks, {
    provider: 'mock', model: 'model', dispatch: async () => { calls++; return ' '; },
  });
  expect(calls).toBe(1);
  expect(result.complete).toBe(false);
  const used = (await checkEmbedBudget('malformed', 0)).used;
  expect(chunks.map(c => callTokens(doc!.text, c))).toContain(used);
  expect(used).toBeLessThanOrEqual(tokens);
});

it('a provider retry needs another reservation and cannot reuse the first attempt slot', async () => {
  const { createVertexEmbed } = await import('../src/host/vertexEmbedder.js');
  process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY = '1';
  let calls = 0;
  const provider = createVertexEmbed('gemini-embedding-001', 3, {
    beforeAttempt: async text => { if ((await reserveEmbedBudget('retry', Math.ceil(text.length / 4))).exceeded) throw new Error('budget unavailable'); },
    env: { OPENWOP_VERTEX_PROJECT: 'fixture' },
    metadata: { metadataText: async () => 'fixture', accessToken: async () => 'fixture-token', invalidate: () => {} },
    sleep: async () => {},
    fetchImpl: async () => { calls++; return { ok: false, status: 503, headers: { get: () => null }, text: async () => '' }; },
  });
  await expect(provider.embed(['x'], 'document')).rejects.toThrow('budget unavailable');
  expect(calls).toBe(1); expect(provider.stats.calls).toBe(1);
  expect((await checkEmbedBudget('retry', 0)).used).toBe(1);
});

it('a shared host embedder used outside the KB service still charges the same counter', async () => {
  const { registerKbEmbeddingBudget } = await import('../src/features/kb/embedBudget.js');
  const { resolveHostEmbedder, __setHostEmbedderForTest } = await import('../src/host/headlessAi.js');
  process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY = '1';
  const oldHost = process.env.OPENWOP_KB_HOST_EMBEDDER;
  const oldTenants = process.env.OPENWOP_KB_HOST_EMBEDDER_TENANTS;
  process.env.OPENWOP_KB_HOST_EMBEDDER = 'vertex:gemini-embedding-001';
  process.env.OPENWOP_KB_HOST_EMBEDDER_TENANTS = 'org:outside-kb';
  let calls = 0; registerKbEmbeddingBudget();
  __setHostEmbedderForTest(async () => ({ provider: 'vertex', model: 'gemini-embedding-001', funding: 'host', embed: async texts => { calls++; return texts.map(() => [1, 0, 0]); } }));
  try {
    const provider = await resolveHostEmbedder('org:outside-kb', 3);
    expect(provider).not.toBeNull();
    expect(await provider!.embed(['x'])).toEqual([[1, 0, 0]]);
    await expect(provider!.embed(['y'])).rejects.toThrow('host_embedding_budget_unavailable');
    expect(calls).toBe(1); expect((await checkEmbedBudget('org:outside-kb', 0)).used).toBe(1);
  } finally {
    __setHostEmbedderForTest(null);
    if (oldHost === undefined) delete process.env.OPENWOP_KB_HOST_EMBEDDER; else process.env.OPENWOP_KB_HOST_EMBEDDER = oldHost;
    if (oldTenants === undefined) delete process.env.OPENWOP_KB_HOST_EMBEDDER_TENANTS; else process.env.OPENWOP_KB_HOST_EMBEDDER_TENANTS = oldTenants;
  }
});


it('an unclassified replay cannot reserve a headless attempt even when the cap is uncapped', async () => {
  delete process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY;
  const result = await runWithEffectContext({ runId: 'replay-fixture', nodeId: 'unclassified-read', tenantId: 'replay', replaying: true }, () => reserveEmbedBudget('replay', 1));
  expect(result).toMatchObject({ exceeded: true, unavailable: true });
  expect(await b.kvList('hostext:kb:embedusage:replay:')).toEqual([]);
});
