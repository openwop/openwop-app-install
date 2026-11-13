/**
 * ADR 1110 P5 — orders through the declared index (systemIndex over commerce's own store).
 *
 * Pins: every order write keeps the families in step (`at`, `st`, `live`); a cancel
 * leaves the live count; the paged list is newest first, pages without repeat or gap, and
 * filters by status on the full row; `getOrders` is org-guarded; the order cap counts the
 * live family; a backdated order moves in the newest-first order; the paged export walks
 * the orders once.
 *
 * Sabotage, each restored, each red: the `live` marker kept for a canceled order (the
 * cancel case); `orders.put` bypassing the hooks (the families case); the status filter
 * not re-checked on the full row (the stale-status case).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import {
  __backdateOrderForSeed, __forgetCatalogIndexReady, __forgetOrderIndexReady, cancelOrder, createOrder, createProduct, getOrders, listOrdersPage, orderCount,
} from '../src/features/commerce/commerceService.js';
import { indexedCount } from '../src/features/entities/systemIndex.js';
import { exportCommerceDataPage } from '../src/features/commerce/dataExport.js';
import { createOrg } from '../src/host/accessControlService.js';

const TYPE = 'commerce.order';
let storage: Storage;
let n = 0;
const tenant = (): string => `tenant-p5-${++n}`;

async function seedOrders(T: string, ORG: string, count: number): Promise<string[]> {
  const p = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'digital', name: 'Thing', price: 5, currency: 'USD' });
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) ids.push((await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: [{ productId: p.productId, quantity: 1 }] })).orderId);
  return ids;
}
const markerIds = async (T: string): Promise<string[]> => (await storage.kvList(`hostext:entity:sysidx:${T}:`)).map((r) => r.key);

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  __forgetCatalogIndexReady();
  __forgetOrderIndexReady();
});

describe('ADR 1110 P5 — the order index', () => {
  it('a create writes at, st and live markers; a cancel leaves the live count', async () => {
    const T = tenant();
    const [id] = await seedOrders(T, 'org-o', 1);
    const keys = (await markerIds(T)).filter((k) => k.includes(':commerce.order:'));
    expect(keys.some((k) => k.includes(':at:org-o:'))).toBe(true);
    expect(keys.some((k) => k.includes(':st:org-o:pending:'))).toBe(true);
    expect(await indexedCount(T, TYPE, 'org-o')).toBe(1);
    await cancelOrder(T, 'org-o', id as string);
    const after = (await markerIds(T)).filter((k) => k.includes(':commerce.order:'));
    expect(after.some((k) => k.includes(':live:'))).toBe(false);
    expect(after.some((k) => k.includes(':st:org-o:canceled:'))).toBe(true);
    expect(after.some((k) => k.includes(':st:org-o:pending:'))).toBe(false);
    expect(await indexedCount(T, TYPE, 'org-o', { exact: true })).toBe(0);
    expect(await orderCount(T, 'org-o')).toBe(1);
  });

  it('pages newest first without repeat or gap, and filters by status', async () => {
    const T = tenant();
    const ids = await seedOrders(T, 'org-o', 7);
    for (const [i, id] of ids.entries()) await __backdateOrderForSeed(T, id, new Date(Date.UTC(2026, 0, 1 + i)).toISOString());
    await cancelOrder(T, 'org-o', ids[2] as string);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listOrdersPage(T, 'org-o', { limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...page.orders.map((o) => o.orderId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...ids].reverse());
    expect((await listOrdersPage(T, 'org-o', { status: 'canceled' })).orders.map((o) => o.orderId)).toEqual([ids[2]]);
  });

  it('a stale status marker never lists an order under the wrong status (decided on the full row)', async () => {
    const T = tenant();
    const [id] = await seedOrders(T, 'org-o', 1);
    // The row moves on without its markers (a crash after the row write).
    const key = `hostext:commerce:order:${id}`;
    const raw = JSON.parse((await storage.kvGet(key)) ?? '{}') as Record<string, unknown>;
    await storage.kvSet(key, JSON.stringify({ ...raw, status: 'paid' }));
    expect((await listOrdersPage(T, 'org-o', { status: 'pending' })).orders).toEqual([]);
  });

  it('getOrders is org-guarded', async () => {
    const T = tenant();
    const [a] = await seedOrders(T, 'org-a', 1);
    const [b] = await seedOrders(T, 'org-b', 1);
    expect((await getOrders(T, 'org-a', [a as string, b as string])).map((o) => o.orderId)).toEqual([a]);
  });

  it('the paged export walks the orders once', async () => {
    const T = tenant();
    const org = await createOrg({ tenantId: T, createdBy: 'u', name: 'Shop', ownerSubject: 'u' });
    const ids = await seedOrders(T, org.orgId, 5);
    const got: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 30; guard += 1) {
      const page = await exportCommerceDataPage(T, { limit: 2, ...(cursor ? { cursor } : {}) });
      got.push(...((page.sections.orders ?? []) as { orderId: string }[]).map((o) => o.orderId));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(got.sort()).toEqual([...ids].sort());
  });
});
