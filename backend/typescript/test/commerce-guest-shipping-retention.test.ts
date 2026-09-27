/**
 * R3 I1 (retention half) — GUEST shipping snapshots have no subject key, so
 * `eraseSubject` can structurally never reach them. Retention is the backstop:
 * past the window, a contactId-LESS order's shipping anonymizes regardless of
 * linkage (coarse region/country kept, direct identifiers stripped,
 * idempotent). Contact-linked orders are deliberately UNTOUCHED — their PII is
 * DSAR-reachable and follows the contact's lifecycle, not a clock.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createProduct, createOrder, getOrder, purgeStaleGuestShipping,
  GUEST_SHIPPING_RETENTION_DAYS, __resetCommerce,
} from '../src/features/commerce/commerceService.js';

const T = 'tenant-gsr';
const ORG = 'org-gsr';
const BY = 'user-gsr';
const DAY = 24 * 60 * 60 * 1000;

let storage: Awaited<ReturnType<typeof openStorage>>;
beforeAll(async () => { storage = await openStorage('memory://'); initHostExtPersistence(storage); });
beforeEach(async () => { await __resetCommerce(); });

const ship = { name: 'Ada Lovelace', line1: '1 Analytical Way', city: 'London', region: 'LDN', postalCode: 'N1', country: 'GB' };

async function orderWith(opts: { contactId?: string }): Promise<string> {
  const p = await createProduct({ tenantId: T, orgId: ORG, createdBy: BY, type: 'physical', name: 'Widget', price: 10, currency: 'USD', inventory: 100 });
  const o = await createOrder({ tenantId: T, orgId: ORG, createdBy: BY, ...(opts.contactId ? { contactId: opts.contactId } : {}), lines: [{ productId: p.productId, quantity: 1 }], shippingAddress: ship });
  return o.orderId;
}

describe('R3 I1 — guest shipping snapshots age out; linked ones do not', () => {
  it('past the window: the GUEST snapshot anonymizes (name/street/city/postal stripped, region/country kept); the LINKED one survives; a second pass is a no-op', async () => {
    const guest = await orderWith({});
    const linked = await orderWith({ contactId: 'ct-1' });
    const future = Date.now() + (GUEST_SHIPPING_RETENTION_DAYS + 1) * DAY;

    const purged = await purgeStaleGuestShipping(future);
    expect(purged).toBe(1);

    const g = await getOrder(T, ORG, guest);
    expect(g?.shippingAddress?.line1).toBe('[redacted]');
    expect(g?.shippingAddress?.name).toBeUndefined();
    expect(g?.shippingAddress?.city).toBeUndefined();
    expect(g?.shippingAddress?.postalCode).toBeUndefined();
    expect(g?.shippingAddress?.region).toBe('LDN');   // coarse geography kept
    expect(g?.shippingAddress?.country).toBe('GB');

    const l = await getOrder(T, ORG, linked);
    expect(l?.shippingAddress?.line1).toBe('1 Analytical Way'); // DSAR-reachable → clock-exempt

    expect(await purgeStaleGuestShipping(future)).toBe(0); // idempotent
  });

  it('inside the window: nothing anonymizes', async () => {
    await orderWith({});
    expect(await purgeStaleGuestShipping(Date.now() + DAY)).toBe(0);
  });
});
