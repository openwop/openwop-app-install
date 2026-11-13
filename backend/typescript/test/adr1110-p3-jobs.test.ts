/**
 * ADR 1110 P3 — the jobs that need every product read it a page at a time.
 *
 * Pins: the paged export hands out every product once, org by org, then the other
 * sections, and its cursor ends; the streamed feed document is byte-identical to the
 * one-shot render; a catalog over the in-request limit is not re-embedded inside the
 * search request but queued, and the background refresh rebuilds it (each queued org is
 * claimed by exactly one refresh).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import { __forgetCatalogIndexReady, createProduct } from '../src/features/commerce/commerceService.js';
import { exportCommerceDataPage } from '../src/features/commerce/dataExport.js';
import { createOrg } from '../src/host/accessControlService.js';
import { FEED_XML_TAIL, feedBatches, feedXmlHead, feedXmlItems, renderFeedXml, type ProductFeed } from '../src/features/campaign-connectors/catalogFeed.js';
import {
  __setSyncRebuildMaxForTest, ensureProductEmbeddingsFresh, invalidateProductEmbeddings, queryProductEmbeddings, refreshQueuedEmbeddings,
} from '../src/features/discovery/productEmbeddingIndex.js';

let n = 0;
const tenant = (): string => `tenant-p3-${++n}`;

beforeAll(() => { initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-p3-')) }); });
beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  __forgetCatalogIndexReady();
});
afterEach(() => __setSyncRebuildMaxForTest(null));

describe('ADR 1110 P3 — the paged export', () => {
  it('exports every product once, org by org, then the other sections, and the cursor ends', async () => {
    const T = tenant();
    const a = await createOrg({ tenantId: T, createdBy: 'u', name: 'A', ownerSubject: 'u' });
    const b = await createOrg({ tenantId: T, createdBy: 'u', name: 'B', ownerSubject: 'u' });
    for (const [org, names] of [[a.orgId, ['a1', 'a2', 'a3']], [b.orgId, ['b1']]] as const) {
      for (const name of names) await createProduct({ tenantId: T, orgId: org, createdBy: 'u', type: 'digital', name, price: 1, currency: 'USD', downloadAssetTokens: ['tok'] });
    }
    const products: Record<string, unknown>[] = [];
    const otherSections = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await exportCommerceDataPage(T, { limit: 2, ...(cursor ? { cursor } : {}) });
      for (const [name, rows] of Object.entries(page.sections)) {
        if (name === 'products') products.push(...(rows as Record<string, unknown>[]));
        else otherSections.add(name);
      }
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);
    expect(cursor).toBeUndefined();
    expect(products.map((p) => p.name).sort()).toEqual(['a1', 'a2', 'a3', 'b1']);
    expect(products.every((p) => p.downloadAssetCount === 1 && !('downloadAssetTokens' in p))).toBe(true);
    expect([...otherSections].sort()).toEqual(['coupons', 'orders', 'quotes']);
  });
});

describe('ADR 1110 P3 — the streamed feed', () => {
  it('is byte-identical to the one-shot render', async () => {
    const T = tenant();
    const O = 'org-feed';
    for (let i = 0; i < 7; i += 1) await createProduct({ tenantId: T, orgId: O, createdBy: 'u', type: 'digital', name: `Item ${i} & co`, price: 2, currency: 'USD', imageAssetTokens: [`img-${i}`] });
    const channel = { title: 'Shop & Co', brand: 'Shop & Co', link: 'https://shop.example/store/x' };
    const whole: ProductFeed = { items: [], excluded: [] };
    let streamed = feedXmlHead(channel);
    for await (const batch of feedBatches(T, O, 'https://shop.example', 3)) {
      whole.items.push(...batch.items);
      streamed += feedXmlItems(batch.items, channel.brand);
    }
    streamed += FEED_XML_TAIL;
    expect(whole.items).toHaveLength(7);
    expect(streamed).toBe(renderFeedXml(whole, channel));
  });
});

describe('ADR 1110 P3 — large catalogs re-embed off the request path', () => {
  it('a catalog over the limit is queued by the request and rebuilt by the refresh, once', async () => {
    const T = tenant();
    const O = 'org-embed';
    __setSyncRebuildMaxForTest(1);
    await createProduct({ tenantId: T, orgId: O, createdBy: 'u', type: 'digital', name: 'Jacket', description: 'warm jacket', price: 1, currency: 'USD' });
    await createProduct({ tenantId: T, orgId: O, createdBy: 'u', type: 'digital', name: 'Hat', description: 'summer hat', price: 1, currency: 'USD' });
    invalidateProductEmbeddings(T, O);
    await ensureProductEmbeddingsFresh(T, O);
    expect(await queryProductEmbeddings(T, O, 'jacket', 5)).toEqual([]); // not rebuilt inside the request
    expect(await refreshQueuedEmbeddings(5)).toBe(1);
    expect((await queryProductEmbeddings(T, O, 'jacket', 5)).length).toBeGreaterThan(0);
    expect(await refreshQueuedEmbeddings(5)).toBe(0); // the queued row was claimed
  });

  it('a catalog within the limit is still rebuilt inside the request', async () => {
    const T = tenant();
    const O = 'org-small';
    await createProduct({ tenantId: T, orgId: O, createdBy: 'u', type: 'digital', name: 'Jacket', description: 'warm jacket', price: 1, currency: 'USD' });
    invalidateProductEmbeddings(T, O);
    await ensureProductEmbeddingsFresh(T, O);
    expect((await queryProductEmbeddings(T, O, 'jacket', 5)).length).toBeGreaterThan(0);
  });
});
