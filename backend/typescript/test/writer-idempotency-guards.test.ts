/**
 * Phase 2 of the generator backlog — non-fold writer idempotency/uniqueness guards
 * (GEN-2e, GEN-2g). Each reuses an existing in-repo precedent:
 *  - GEN-2e: createCoupon now rejects a duplicate ACTIVE code (409), mirroring
 *    createAffiliate — a duplicate code otherwise silently shadowed `couponByCode`.
 *  - GEN-2g: collectEvent gains an OPT-IN `dedupeKey` (mirrors forms FRMB-IDEM):
 *    a deterministic id scoped to (tenant, eventType) so an at-least-once retry
 *    replays the stored row instead of appending a duplicate. The replay returns
 *    the STORED fields and does NOT re-validate.
 *
 * The dedupe id is DERIVED from (tenant, eventType, key), so a replay that
 * re-wrote the row would keep the same id and the same row count: case 1 proves
 * the short-circuit by retrying with a DIFFERENT payload and reading the STORED
 * payload back (8fw5g6-wig-dedupe-overwrite-c1-r2). No exported writer deactivates
 * a coupon, so the active-only half writes an `active: false` row straight through
 * the coupon collection's own namespace (8fw5g6-wig-coupon-active-only-r2).
 * Sabotages witnessed (/grade-tests 8f W5, 8fw5g6-wig-*): the duplicate check, the
 * tenant scope of the resolver, the active filter, the replay short-circuit, and
 * tenant / eventType dropped from the dedupe id.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createCoupon, deleteCoupon, listCoupons, type Coupon } from '../src/features/commerce/commerceService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { collectEvent, listCollectedEvents } from '../src/features/cdp/collectService.js';
import { registerEventSchema } from '../src/features/cdp/eventSchemaService.js';
import type { Storage } from '../src/storage/storage.js';

const T = 'org:t1';
const T2 = 'org:t2';

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

describe('GEN-2e — createCoupon code uniqueness', () => {
  it('rejects a duplicate ACTIVE code (409), is tenant-scoped, and allows re-create after delete', async () => {
    const a = await createCoupon({ tenantId: T, orgId: T, code: 'save10', type: 'percentage', value: 10 });
    expect(a.code).toBe('SAVE10'); // normalized upper-case

    // duplicate (case-insensitive) → 409, matching the createAffiliate sibling
    await expect(createCoupon({ tenantId: T, orgId: T, code: 'SAVE10', type: 'percentage', value: 20 }))
      .rejects.toMatchObject({ httpStatus: 409, message: 'That coupon code already exists.' });
    expect((await listCoupons(T, T)).filter((c) => c.code === 'SAVE10'), 'the refused duplicate wrote no row').toHaveLength(1);

    // a different code is fine
    const b = await createCoupon({ tenantId: T, orgId: T, code: 'SAVE20', type: 'percentage', value: 20 });
    expect(b.code).toBe('SAVE20');

    // uniqueness is tenant-scoped: another tenant may reuse the same code
    const other = await createCoupon({ tenantId: T2, orgId: T2, code: 'SAVE10', type: 'percentage', value: 5 });
    expect(other.code).toBe('SAVE10');

    // deleting frees the code → re-create is allowed, no dup left
    expect(await deleteCoupon(T, T, a.couponId)).toBe(true);
    const remade = await createCoupon({ tenantId: T, orgId: T, code: 'SAVE10', type: 'percentage', value: 15 });
    expect(remade.code).toBe('SAVE10');
    expect((await listCoupons(T, T)).filter((c) => c.code === 'SAVE10')).toHaveLength(1);

    // active-only: an INACTIVE coupon does not hold its code. No exported writer
    // deactivates one, so the row is written raw through the coupon collection's
    // namespace (the same kv rows `listCoupons` reads).
    const raw = new DurableCollection<Coupon>('commerce:coupon', (c) => c.couponId, undefined, (c) => c.tenantId);
    const retired: Coupon = { couponId: 'cpn:retired-1', tenantId: T, orgId: T, code: 'OLD25', type: 'percentage', value: 25, active: false, createdAt: '2026-01-01T00:00:00.000Z' };
    await raw.put(retired);
    expect((await listCoupons(T, T)).some((c) => c.couponId === 'cpn:retired-1'), 'the raw row is visible to the service').toBe(true);
    const reissued = await createCoupon({ tenantId: T, orgId: T, code: 'old25', type: 'percentage', value: 30 });
    expect(reissued.code).toBe('OLD25');
    expect(reissued.active).toBe(true);
  });
});

describe('GEN-2g — collectEvent opt-in dedupe key', () => {
  it('replays the same row for a repeated dedupeKey (the stored payload unchanged); keyless always appends; tenant-scoped', async () => {
    const r1 = await collectEvent(T, 'purchase', { orderId: 'o1' }, 'k-1');
    // At-least-once retry carrying a DIFFERENT body: a replay returns the stored row;
    // a re-put would land on the same derived id and silently replace the payload.
    const r2 = await collectEvent(T, 'purchase', { orderId: 'o1-RETRY' }, 'k-1');
    expect(r2.eventId).toBe(r1.eventId); // replay — same row
    const rows = await listCollectedEvents(T);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload, 'the replay rewrote the stored payload').toEqual({ orderId: 'o1' });

    // keyless stays always-append
    await collectEvent(T, 'purchase', { orderId: 'o2' });
    await collectEvent(T, 'purchase', { orderId: 'o2' });
    expect(await listCollectedEvents(T)).toHaveLength(3);

    // a different tenant with the SAME key gets a distinct id (no cross-tenant collision)
    const other = await collectEvent(T2, 'purchase', { orderId: 'o1' }, 'k-1');
    expect(other.eventId).not.toBe(r1.eventId);

    // the SAME key under a DIFFERENT eventType is also distinct (scope includes eventType)
    const diffType = await collectEvent(T, 'refund', { orderId: 'o1' }, 'k-1');
    expect(diffType.eventId).not.toBe(r1.eventId);
  });

  it('a replay returns the STORED fields and does NOT re-validate (schema tightened after accept)', async () => {
    // v1: permissive (no required field)
    await registerEventSchema(T, 'signup', { type: 'object', properties: { email: { type: 'string' } } });
    const first = await collectEvent(T, 'signup', { email: 'a@b.test' }, 'sk-1');
    expect(first.hasSchema).toBe(true);
    expect(first.piiFields).toContain('email');

    // tighten: v2 now REQUIRES a field the stored payload lacks
    await registerEventSchema(T, 'signup', { type: 'object', required: ['country'], properties: { email: { type: 'string' }, country: { type: 'string' } } });

    // a FRESH ingest of the old payload now fails the tightened schema…
    await expect(collectEvent(T, 'signup', { email: 'a@b.test' })).rejects.toMatchObject({ httpStatus: 422 });

    // …but the SAME dedupeKey REPLAYS the already-accepted event — no re-validation, no 422.
    const replay = await collectEvent(T, 'signup', { email: 'a@b.test' }, 'sk-1');
    expect(replay.eventId).toBe(first.eventId);
    expect(replay.piiFields).toEqual(first.piiFields);
    expect(replay.schemaVersion).toBe(first.schemaVersion);
    expect(await listCollectedEvents(T)).toHaveLength(1); // still one row
  });
});
