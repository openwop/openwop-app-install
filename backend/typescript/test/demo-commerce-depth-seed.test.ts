/**
 * `demo-commerce-depth` round-trip (app-seeding-strategy.md §4 Phase 4, ADR 0031).
 *
 * Verifies catalog depth on top of commerce-showcase: 24 products (with images,
 * variants, facet fields, low-stock), 2 bundles, 5 subscriptions, 3 price lists,
 * 4 coupons, 2 affiliates, 45 backdated co-purchase orders, 8 quotes (one
 * converted) — seeded idempotently and cleared with no byproduct orphans.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { openStorage } from '../src/storage/index.js';
import { seedDemoPeople } from '../src/host/demoPeopleSeed.js';
import { seedDemoMedia } from '../src/host/demoMediaSeed.js';
import { seedDemoCrm } from '../src/host/demoCrmSeed.js';
import { seedDemoCommerceDepth, clearDemoCommerceDepth, countDemoCommerceDepth } from '../src/host/demoCommerceDepthSeed.js';
import { listProducts, listOrders, listCoupons } from '../src/features/commerce/commerceService.js';
import { listProductSubscriptions } from '../src/features/commerce/subscriptions.js';
import { listQuotes } from '../src/features/commerce/quotes.js';
import { listPriceLists } from '../src/features/commerce/pricing.js';
import { SOLSTICE_CATALOG, SOLSTICE_QUOTES } from '../src/host/seed-data/solsticeDemo.js';

const ACTOR = 'demo:commerce-depth';
const refundStore = new DurableCollection<{ refundLedgerId: string; tenantId: string }>('commerce:refund', (r) => r.refundLedgerId, undefined, (r) => r.tenantId);

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'owp-demo-comm-')) });
  registerToggleDefault({ id: 'crm', status: 'on', bucketUnit: 'tenant', salt: 'crm' });
  registerToggleDefault({ id: 'commerce', status: 'on', bucketUnit: 'tenant', salt: 'commerce' });
});

describe('demo-commerce-depth seeder', () => {
  it('seeds catalog depth, idempotent; images + bundles + subs + orders + quotes; clears clean', async () => {
    const tenantId = 'demo-comm-t1';
    await seedDemoPeople(tenantId);
    await seedDemoMedia(tenantId);
    await seedDemoCrm(tenantId);
    const orgId = (await (await import('../src/host/accessControlService.js')).listOrgs(tenantId))[0]!.orgId;

    const first = await seedDemoCommerceDepth(tenantId);
    expect(first.created).toBeGreaterThan(50);

    const products = (await listProducts(tenantId, orgId)).filter((p) => p.createdBy === ACTOR);
    expect(products).toHaveLength(SOLSTICE_CATALOG.length); // 24
    // Images wired from Phase 2, variants + facet fields present.
    expect(products.filter((p) => (p.imageAssetTokens?.length ?? 0) > 0).length).toBeGreaterThan(20);
    expect(products.some((p) => p.kind === 'bundle' && (p.components?.length ?? 0) >= 2)).toBe(true);
    expect(products.some((p) => p.customFields?.roast === 'dark')).toBe(true);
    expect(products.some((p) => (p.lowStockThreshold ?? 0) > 0 && (p.inventory ?? 99) < p.lowStockThreshold!)).toBe(true);

    // Orders (45) + subs (5) + price lists (3) + coupons (4) + quotes (8, one converted).
    const orders = (await listOrders(tenantId, orgId)).filter((o) => o.createdBy === ACTOR);
    expect(orders.length).toBeGreaterThanOrEqual(45);
    expect(orders.some((o) => o.status === 'fulfilled')).toBe(true);
    expect((await listProductSubscriptions(tenantId, orgId)).filter((s) => s.createdBy === ACTOR)).toHaveLength(5);
    expect((await listPriceLists(tenantId, orgId)).filter((l) => l.createdBy === ACTOR)).toHaveLength(3);
    expect((await listCoupons(tenantId, orgId)).filter((c) => ['SOLSTICE-WELCOME20', 'SOLSTICE-WHOLESALE15', 'SOLSTICE-HOLIDAY25', 'SOLSTICE-FREESHIP'].includes(c.code))).toHaveLength(4);
    const quotes = (await listQuotes(tenantId, orgId)).filter((q) => q.createdBy === ACTOR);
    expect(quotes).toHaveLength(SOLSTICE_QUOTES.length);
    expect(quotes.some((q) => q.status === 'converted')).toBe(true);

    // Idempotent re-seed.
    const before = await countDemoCommerceDepth(tenantId);
    const second = await seedDemoCommerceDepth(tenantId);
    expect(second.created).toBe(0);
    expect(await countDemoCommerceDepth(tenantId)).toBe(before);

    // Partial/full refunds produced ledger rows (review #1357 HIGH — verify they clear).
    expect((await refundStore.listForTenantIndexed(tenantId)).length).toBeGreaterThan(0);

    // Clear removes everything (no refund-ledger / stock-movement orphans).
    await clearDemoCommerceDepth(tenantId);
    expect(await countDemoCommerceDepth(tenantId)).toBe(0);
    expect((await listOrders(tenantId, orgId)).filter((o) => o.createdBy === ACTOR)).toHaveLength(0);
    expect((await listProductSubscriptions(tenantId, orgId)).filter((s) => s.createdBy === ACTOR)).toHaveLength(0);
    expect((await listQuotes(tenantId, orgId)).filter((q) => q.createdBy === ACTOR)).toHaveLength(0);
    expect((await refundStore.listForTenantIndexed(tenantId)).length).toBe(0);

    // Round-trips.
    const third = await seedDemoCommerceDepth(tenantId);
    expect(third.created).toBeGreaterThan(50);
  });
});
