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
 * products tie lexically (since ADR 1110 P2 the lexical leg reads names and tags,
 * and each carries the one tag "jacket", so the name tiebreak gives Alpha, Bravo,
 * Charlie), while the embedder, which still reads descriptions, ranks Charlie
 * ("jacket jacket"), then Alpha, then Bravo (diluted by extra words). RRF (k = 60)
 * by hand: Alpha 1/60+1/61, Charlie 1/62+1/60, Bravo 1/61+1/62 → Alpha, Charlie,
 * Bravo — an order neither leg produces alone. Round 1 of /grade-tests 8f w1 probed
 * the old `> 0` + determinism assertions vacuous (lexical alone satisfied both).
 *
 * DOUBLE GUARD on the TENANT half of the isolation case: the namespace carries the
 * tenant (`productEmbeddingIndex.ts` `namespaceOf`) AND the in-memory vector
 * surface keeps one bucket per tenant (`inMemorySurfaces.ts` `createVector`).
 * Either alone keeps the case green; the witness is one edit to the query that
 * drops the caller's tenant from both (wave 120 `w120g2-psr-tenant-both`).
 *
 * Sabotages each case is red against (probed): the namespace losing its org, the
 * query reading another tenant's bucket and namespace, the blank-query guard
 * dropping `.trim()`, the fusion skipped, RRF dropping the semantic term, and the
 * semantic-only products (ADR 1110 P2) never joining the result.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import { createProduct, listProductsPage, __resetCommerce, type Product } from '../src/features/commerce/commerceService.js';
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
    // The SAME org id in ANOTHER tenant — the tenant half of the namespace.
    const X = 'tenant-prodvec-x';
    const xShell = await createProduct({ tenantId: X, orgId: 'orgA', createdBy: 'u', type: 'digital', name: 'Storm shell', description: 'a waterproof jacket shell', price: 50, currency: 'USD', categories: ['outerwear'], tags: ['gear'] });
    invalidateProductEmbeddings(T, 'orgA'); invalidateProductEmbeddings(T, 'orgB'); invalidateProductEmbeddings(X, 'orgA');
    await rebuildProductEmbeddings(T, 'orgA');
    await rebuildProductEmbeddings(T, 'orgB');
    await rebuildProductEmbeddings(X, 'orgA');
    const aIds = await queryProductEmbeddings(T, 'orgA', 'jacket', 10);
    // orgA recall contains orgA's product (positive control) and only orgA's.
    expect(aIds).toContain(aJacket.productId);
    const bIds = await queryProductEmbeddings(T, 'orgB', 'jacket', 10);
    expect(bIds).not.toContain(aJacket.productId); // orgB never sees orgA's product
    expect(bIds).toContain(rain.productId); // positive control: orgB's own recall works
    // and orgA never surfaces orgB's product id — not even for orgB's own words
    expect(aIds).not.toContain(rain.productId);
    expect(await queryProductEmbeddings(T, 'orgA', 'waterproof shell', 10)).not.toContain(rain.productId);
    // Cross-tenant: tenant X's orgA sees its own product and never tenant T's orgA.
    const xIds = await queryProductEmbeddings(X, 'orgA', 'jacket', 10);
    expect(xIds).toEqual([xShell.productId]);
    expect(aIds).not.toContain(xShell.productId);
  });

  it('searchProducts fuses lexical+semantic (lazy rebuild) and is deterministic', async () => {
    // ADR 1110 P2 — the lexical leg reads names and tags, not descriptions, so the shared
    // word is a tag; the semantic leg still reads the descriptions, and the two disagree.
    const plain = (name: string, description: string) =>
      createProduct({ tenantId: T, orgId: 'orgC', createdBy: 'u', type: 'digital', name, description, price: 50, currency: 'USD', categories: [], tags: ['jacket'] });
    const names = new Map<string, string>();
    for (const [n, d] of [['Alpha', 'jacket'], ['Bravo', 'jacket boats gardens sailing harbour'], ['Charlie', 'jacket jacket']] as const) names.set((await plain(n, d)).productId, n);
    const named = (ids: string[]) => ids.map((id) => names.get(id));
    // the two legs, each on its own, disagree:
    expect((await listProductsPage(T, 'orgC', { q: 'jacket' })).products.map((p) => p.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    await rebuildProductEmbeddings(T, 'orgC');
    expect(named(await queryProductEmbeddings(T, 'orgC', 'jacket', 10))).toEqual(['Charlie', 'Alpha', 'Bravo']);
    const r1 = await searchProducts({ tenantId: T, orgId: 'orgC', q: 'jacket' });
    const r2 = await searchProducts({ tenantId: T, orgId: 'orgC', q: 'jacket' });
    expect(r1.products.map((p) => p.name)).toEqual(['Alpha', 'Charlie', 'Bravo']); // RRF, by hand (header)
    expect(r1.products.map((p) => p.productId)).toEqual(r2.products.map((p) => p.productId)); // deterministic
  });

  it('ADR 1110 P2 — a product found only by its description comes back through semantic recall', async () => {
    const coat = await createProduct({ tenantId: T, orgId: 'orgE', createdBy: 'u', type: 'digital', name: 'Alpine', description: 'an insulated warm jacket for hiking', price: 50, currency: 'USD', categories: [], tags: [] });
    await createProduct({ tenantId: T, orgId: 'orgE', createdBy: 'u', type: 'digital', name: 'Sun hat', description: 'a light summer cap', price: 5, currency: 'USD', categories: [], tags: [] });
    // Premise: the lexical leg alone finds nothing (no name or tag says "jacket").
    expect((await listProductsPage(T, 'orgE', { q: 'jacket' })).products).toEqual([]);
    await rebuildProductEmbeddings(T, 'orgE');
    const r = await searchProducts({ tenantId: T, orgId: 'orgE', q: 'jacket' });
    // It joins the result, and ranks first: it is the only description that matches.
    expect(r.products[0]?.productId).toBe(coat.productId);
  });

  it('empty query returns no semantic ids (lexical/facet path unchanged)', async () => {
    await mk('orgD', 'Thing', 'stuff');
    await rebuildProductEmbeddings(T, 'orgD');
    expect(await queryProductEmbeddings(T, 'orgD', '')).toEqual([]);
    expect(await queryProductEmbeddings(T, 'orgD', '   ')).toEqual([]);
  });
});

