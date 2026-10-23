/**
 * MERCH-C semantic recall (ADR 0275, PR 2 Part B):
 *   - the product-embedding index is TENANT+ORG-namespaced — a query for one org never
 *     returns another org's products (/architect finding 3, the vector-layer IDOR);
 *   - searchProducts fuses lexical + semantic (RRF) and stays deterministic;
 *   - an empty query contributes no semantic recall (lexical/facet path unchanged).
 * Note: `embedText` is the deterministic local embedder (the KB/RAG floor: a hashed,
 * sublinear-TF bag of words), so this asserts namespace isolation + the fused path,
 * not model-quality semantics.
 *
 * The fusion fixture is built so the lexical and semantic orders DISAGREE: three
 * products tie lexically (each matches "jacket" only in its description, so the
 * name tiebreak gives Alpha, Bravo, Charlie), while the embedder ranks Charlie
 * ("jacket jacket"), then Alpha, then Bravo (diluted by extra words). RRF (k = 60)
 * by hand: Alpha 1/60+1/61, Charlie 1/62+1/60, Bravo 1/61+1/62 → Alpha, Charlie,
 * Bravo — an order neither leg produces alone. Round 1 of /grade-tests 8f w1 probed
 * the old `> 0` + determinism assertions vacuous (lexical alone satisfied both).
 *
 * Sabotages each case is red against (probed): the namespace losing its org, the
 * blank-query guard dropping `.trim()`, the fusion skipped.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import { createProduct, listProducts, __resetCommerce, type Product } from '../src/features/commerce/commerceService.js';
import { searchProducts, __resetDiscovery } from '../src/features/discovery/discoveryService.js';
import { rebuildProductEmbeddings, queryProductEmbeddings, invalidateProductEmbeddings } from '../src/features/discovery/productEmbeddingIndex.js';

const T = 'default';
const mk = (org: string, name: string, desc: string): Promise<Product> =>
  createProduct({ tenantId: T, orgId: org, createdBy: 'u', type: 'digital', name, description: desc, price: 50, currency: 'USD', categories: ['outerwear'], tags: ['gear'] });

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-prodvec-')) });
  initHostExtPersistence(await openStorage('memory://'));
});
beforeEach(async () => { await __resetCommerce(); await __resetDiscovery(); });

describe('MERCH-C semantic recall', () => {
  it('is tenant+org namespace-isolated (no cross-org recall — the vector-layer IDOR)', async () => {
    const aJacket = await mk('orgA', 'Alpine coat', 'an insulated warm jacket for hiking');
    await mk('orgA', 'Sun hat', 'a light summer cap');
    const rain = await mk('orgB', 'Rain jacket', 'a waterproof jacket shell');
    invalidateProductEmbeddings(T, 'orgA'); invalidateProductEmbeddings(T, 'orgB');
    await rebuildProductEmbeddings(T, 'orgA');
    await rebuildProductEmbeddings(T, 'orgB');
    const aIds = await queryProductEmbeddings(T, 'orgA', 'jacket', 10);
    // orgA recall contains only orgA products (never orgB's Rain jacket).
    const orgAProductIds = new Set([aJacket.productId]);
    expect(aIds.some((id) => orgAProductIds.has(id))).toBe(true);
    const bIds = await queryProductEmbeddings(T, 'orgB', 'jacket', 10);
    expect(bIds).not.toContain(aJacket.productId); // orgB never sees orgA's product
    expect(bIds).toContain(rain.productId); // positive control: orgB's own recall works
    // and orgA never surfaces orgB's product id — not even for orgB's own words
    expect(aIds).not.toContain(rain.productId);
    expect(await queryProductEmbeddings(T, 'orgA', 'waterproof shell', 10)).not.toContain(rain.productId);
  });

  it('searchProducts fuses lexical+semantic (lazy rebuild) and is deterministic', async () => {
    const plain = (name: string, description: string) =>
      createProduct({ tenantId: T, orgId: 'orgC', createdBy: 'u', type: 'digital', name, description, price: 50, currency: 'USD', categories: [], tags: [] });
    const names = new Map<string, string>();
    for (const [n, d] of [['Alpha', 'jacket'], ['Bravo', 'jacket boats gardens sailing harbour'], ['Charlie', 'jacket jacket']] as const) names.set((await plain(n, d)).productId, n);
    const named = (ids: string[]) => ids.map((id) => names.get(id));
    // the two legs, each on its own, disagree:
    expect((await listProducts(T, 'orgC', 'jacket')).map((p) => p.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    await rebuildProductEmbeddings(T, 'orgC');
    expect(named(await queryProductEmbeddings(T, 'orgC', 'jacket', 10))).toEqual(['Charlie', 'Alpha', 'Bravo']);
    const r1 = await searchProducts({ tenantId: T, orgId: 'orgC', q: 'jacket' });
    const r2 = await searchProducts({ tenantId: T, orgId: 'orgC', q: 'jacket' });
    expect(r1.products.map((p) => p.name)).toEqual(['Alpha', 'Charlie', 'Bravo']); // RRF, by hand (header)
    expect(r1.products.map((p) => p.productId)).toEqual(r2.products.map((p) => p.productId)); // deterministic
  });

  it('empty query returns no semantic ids (lexical/facet path unchanged)', async () => {
    await mk('orgD', 'Thing', 'stuff');
    await rebuildProductEmbeddings(T, 'orgD');
    expect(await queryProductEmbeddings(T, 'orgD', '')).toEqual([]);
    expect(await queryProductEmbeddings(T, 'orgD', '   ')).toEqual([]);
  });
});

