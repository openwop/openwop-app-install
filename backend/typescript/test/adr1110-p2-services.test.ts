/**
 * ADR 1110 P2 — the service readers that used to load the whole catalog.
 *
 * Pins: the summary's low-stock list is read from the `low` index slice and keeps the
 * exact rule (physical, inventory strictly under the threshold); a discovery search that
 * read its bounded candidate set and found more says so (`candidatesTruncated`), so a
 * count past the bound is a floor, not the catalog's size.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { __forgetCatalogIndexReady, commerceSummary, createProduct } from '../src/features/commerce/commerceService.js';
import { DISCOVERY_CANDIDATE_LIMIT, searchProducts } from '../src/features/discovery/discoveryService.js';

const ORG = 'org-p2';
let n = 0;
const tenant = (): string => `tenant-p2-${++n}`;

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  __forgetCatalogIndexReady();
});

describe('ADR 1110 P2 — summary low stock', () => {
  it('lists physical products strictly under their threshold, from the index slice', async () => {
    const T = tenant();
    const mk = (name: string, extra: Record<string, unknown>) => createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'physical', name, price: 1, currency: 'USD', ...extra });
    await mk('Low', { inventory: 2, lowStockThreshold: 5 });
    await mk('AtThreshold', { inventory: 5, lowStockThreshold: 5 }); // indexed as low (<=), not listed (<)
    await mk('Plenty', { inventory: 50, lowStockThreshold: 5 });
    await createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'digital', name: 'Ebook', price: 1, currency: 'USD', inventory: 0, lowStockThreshold: 5 });
    const summary = await commerceSummary(T, ORG);
    expect(summary.lowStock.map((p) => p.name)).toEqual(['Low']);
  });
});

describe('ADR 1110 P2 — discovery says when its candidate bound cut a search short', () => {
  it('a search past the bound reports candidatesTruncated; a small one does not', async () => {
    const T = tenant();
    for (let i = 0; i < DISCOVERY_CANDIDATE_LIMIT + 5; i += 1) {
      await createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'digital', name: `Lamp ${String(i).padStart(4, '0')}`, price: 1, currency: 'USD' });
    }
    await createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'digital', name: 'Kettle', price: 1, currency: 'USD' });
    const wide = await searchProducts({ tenantId: T, orgId: ORG });
    expect(wide.candidatesTruncated).toBe(true);
    expect(wide.total).toBe(DISCOVERY_CANDIDATE_LIMIT);
    const narrow = await searchProducts({ tenantId: T, orgId: ORG, q: 'kettle' });
    expect(narrow.candidatesTruncated).toBe(false);
    expect(narrow.products.map((p) => p.name)).toEqual(['Kettle']);
  }, 120_000);
});
