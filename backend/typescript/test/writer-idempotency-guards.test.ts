/**
 * Phase 2 of the generator backlog — non-fold writer idempotency/uniqueness guards
 * (GEN-2e, GEN-2g). Each reuses an existing in-repo precedent:
 *  - GEN-2e: createCoupon now rejects a duplicate ACTIVE code (409), mirroring
 *    createAffiliate — a duplicate code otherwise silently shadowed `couponByCode`.
 *  - GEN-2g: collectEvent gains an OPT-IN `dedupeKey` (mirrors forms FRMB-IDEM):
 *    a deterministic id scoped to (tenant, eventType) so an at-least-once retry
 *    replays the stored row instead of appending a duplicate. The replay returns
 *    the STORED fields and does NOT re-validate.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createCoupon, deleteCoupon, listCoupons } from '../src/features/commerce/commerceService.js';
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
      .rejects.toMatchObject({ httpStatus: 409 });

    // a different code is fine
    const b = await createCoupon({ tenantId: T, orgId: T, code: 'SAVE20', type: 'percentage', value: 20 });
    expect(b.code).toBe('SAVE20');

    // uniqueness is tenant-scoped: another tenant may reuse the same code
    const other = await createCoupon({ tenantId: T2, orgId: T2, code: 'SAVE10', type: 'percentage', value: 5 });
    expect(other.code).toBe('SAVE10');

    // deleting frees the code (active-only invariant) → re-create is allowed, no dup left
    expect(await deleteCoupon(T, T, a.couponId)).toBe(true);
    const remade = await createCoupon({ tenantId: T, orgId: T, code: 'SAVE10', type: 'percentage', value: 15 });
    expect(remade.code).toBe('SAVE10');
    expect((await listCoupons(T, T)).filter((c) => c.code === 'SAVE10')).toHaveLength(1);
  });
});

describe('GEN-2g — collectEvent opt-in dedupe key', () => {
  it('replays the same row for a repeated dedupeKey; keyless always appends; tenant-scoped', async () => {
    const r1 = await collectEvent(T, 'purchase', { orderId: 'o1' }, 'k-1');
    const r2 = await collectEvent(T, 'purchase', { orderId: 'o1' }, 'k-1'); // at-least-once retry
    expect(r2.eventId).toBe(r1.eventId); // replay — same row
    expect(await listCollectedEvents(T)).toHaveLength(1);

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
