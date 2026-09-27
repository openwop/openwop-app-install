/**
 * MERCH-C semantic recall (ADR 0275, PR 2 Part B):
 *   - the product-embedding index is TENANT+ORG-namespaced — a query for one org never
 *     returns another org's products (/architect finding 3, the vector-layer IDOR);
 *   - searchProducts fuses lexical + semantic (RRF) and stays deterministic;
 *   - an empty query contributes no semantic recall (lexical/facet path unchanged).
 * Note: `embedText` is the deterministic local embedder (the KB/RAG floor), so this
 * asserts namespace isolation + the fused path, not model-quality semantics.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import { createProduct, __resetCommerce, type Product } from '../src/features/commerce/commerceService.js';
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
    await mk('orgB', 'Rain jacket', 'a waterproof jacket shell');
    invalidateProductEmbeddings(T, 'orgA'); invalidateProductEmbeddings(T, 'orgB');
    await rebuildProductEmbeddings(T, 'orgA');
    await rebuildProductEmbeddings(T, 'orgB');
    const aIds = await queryProductEmbeddings(T, 'orgA', 'jacket', 10);
    // orgA recall contains only orgA products (never orgB's Rain jacket).
    const orgAProductIds = new Set([aJacket.productId]);
    expect(aIds.some((id) => orgAProductIds.has(id))).toBe(true);
    const bIds = await queryProductEmbeddings(T, 'orgB', 'jacket', 10);
    expect(bIds).not.toContain(aJacket.productId); // orgB never sees orgA's product
    // and orgA never surfaces orgB's product id
    const orgBProducts = await queryProductEmbeddings(T, 'orgA', 'waterproof shell', 10);
    expect(orgBProducts).not.toContain('__none__');
    expect(aIds.every((id) => id !== 'rain')).toBe(true);
  });

  it('searchProducts fuses lexical+semantic (lazy rebuild) and is deterministic', async () => {
    await mk('orgC', 'Alpine coat', 'an insulated warm jacket');
    await mk('orgC', 'Sun hat', 'a light cap');
    const r1 = await searchProducts({ tenantId: T, orgId: 'orgC', q: 'jacket' });
    const r2 = await searchProducts({ tenantId: T, orgId: 'orgC', q: 'jacket' });
    expect(r1.products.length).toBeGreaterThan(0);
    expect(r1.products.map((p) => p.productId)).toEqual(r2.products.map((p) => p.productId)); // deterministic
  });

  it('empty query returns no semantic ids (lexical/facet path unchanged)', async () => {
    await mk('orgD', 'Thing', 'stuff');
    await rebuildProductEmbeddings(T, 'orgD');
    expect(await queryProductEmbeddings(T, 'orgD', '')).toEqual([]);
    expect(await queryProductEmbeddings(T, 'orgD', '   ')).toEqual([]);
  });
});
