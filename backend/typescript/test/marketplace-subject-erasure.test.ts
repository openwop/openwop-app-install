/**
 * MPL-7 — the marketplace erasers RUN, and reach the rows.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE RATCHET. `subject-erasure-feature-stores.test.ts`
 * proves a namespace is CLASSIFIED and that its feature REGISTERS an eraser. It
 * cannot prove the eraser reaches anything — and that gap is not hypothetical:
 * while sabotage-proving this change, REMOVING `listingTombstones`' `tenantOf`
 * (so `listForTenantIndexed` enumerates nothing and the eraser silently
 * anonymizes zero rows) left the ratchet **fully green**. Registration is
 * mechanism; reach is wiring, and the repo's mechanism-vs-wiring lesson says to
 * test them separately. This file is the wiring half.
 *
 * WHAT WAS WRONG (re-derive; do not trust the number in this sentence):
 *
 *   grep -rn 'registerSubjectEraser\|registerRetentionPurger' \
 *     src/features/marketplace src/features/commerce-connect | wc -l
 *
 * MEASURED on this branch's parent: **0**, across 13 namespaces. Sharpest
 * instance: `commerce-connect:listing-tombstone` had no `tenantOf` AND no field
 * literally named `tenantId`, so `purgeTenantRows`'s `jsonTenantId` fallback
 * skipped it too — no eraser, no purger, no tenant teardown, while carrying a raw
 * `req.userId` in `by`.
 *
 * Each case asserts BOTH halves of the decision: what the erasure removes, and
 * what it deliberately KEEPS. Every "keeps" here is a case where deletion would
 * be a grant or a rewrite, so a future author who "simplifies" the eraser to a
 * delete turns one of these red.
 *
 * Wave 10: the review + pack-disable fixtures are written through the PRODUCT
 * writers (`upsertReview`, `disablePack`), never a test-declared collection — a
 * writer-side regression (key spelling, index) is otherwise invisible. The
 * test-side collections below are READERS only.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { __resetCommerceConnect, listingTombstones, paidListings } from '../src/features/commerce-connect/stores.js';
import { ERASED_VALUE } from '../src/features/marketplace/erasure.js';
import { upsertReview, __resetMarketplaceReviews } from '../src/features/marketplace/reviewService.js';
import { disablePack, __clearPackEnablement } from '../src/features/marketplace/packEnablementService.js';

const TENANT = 'ws:mkt-erasure';
const SUBJECT = 'usr_departing_member';
const OTHER = 'usr_someone_else';

interface ReviewRow {
  reviewId: string; tenantId: string; orgId: string; packName: string;
  rating: number; body?: string; authorId: string; createdAt: string; updatedAt: string;
}
interface PackDisableRow { id: string; tenantId: string; packName: string; disabledAt: string; disabledBy: string }

// READERS over the SAME namespaces as the owning services (writes go through the services).
const reviews = new DurableCollection<ReviewRow>('marketplace:review', (r) => r.reviewId, undefined, (r) => r.tenantId);
const packDisables = new DurableCollection<PackDisableRow>('marketplace:pack-disable', (r) => r.id, undefined, (r) => r.tenantId);

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  // Booting the app is what REGISTERS the erasers (feature boot → host seam).
  // Calling the module functions directly would test the mechanism and skip the
  // wiring, which is precisely the distinction this file exists to hold.
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

beforeEach(async () => {
  await __resetCommerceConnect();
  await __resetMarketplaceReviews();
  await __clearPackEnablement();
});

const now = '2026-01-01T00:00:00Z';

describe('MPL-7 — marketplace:review: the words go, the rating stays', () => {
  it('anonymizes the author and drops the body, and leaves the rating and the row', async () => {
    const { reviewId } = await upsertReview({ tenantId: TENANT, orgId: 'org-a', packName: 'vendor.a.nodes', rating: 5, body: 'I loved it, — Jane', authorId: SUBJECT });

    await eraseSubject(TENANT, SUBJECT);

    const r = await reviews.get(reviewId);
    expect(r, 'the ROW must survive — deleting it silently moves the pack average, which is other people\'s information').toBeTruthy();
    expect(r!.authorId).toBe(ERASED_VALUE);
    expect(r!.body, 'the person\'s own words go').toBeUndefined();
    expect(r!.rating, 'the rating is the pack\'s reputation, not the person\'s data').toBe(5);
  });

  it('leaves ANOTHER member\'s review completely untouched (over-erasure is unrecoverable)', async () => {
    const { reviewId } = await upsertReview({ tenantId: TENANT, orgId: 'org-a', packName: 'vendor.a.nodes', rating: 3, body: 'fine', authorId: OTHER });
    await eraseSubject(TENANT, SUBJECT);
    const r = await reviews.get(reviewId);
    expect(r!.authorId).toBe(OTHER);
    expect(r!.body).toBe('fine');
  });

  it('is IDEMPOTENT — the contract requires it (the eraser runs once per linked identity key)', async () => {
    const { reviewId } = await upsertReview({ tenantId: TENANT, orgId: 'org-a', packName: 'vendor.a.nodes', rating: 4, body: 'x', authorId: SUBJECT });
    await eraseSubject(TENANT, SUBJECT);
    await eraseSubject(TENANT, SUBJECT);
    const r = await reviews.get(reviewId);
    expect(r!.authorId).toBe(ERASED_VALUE);
    expect(r!.rating).toBe(4);
  });
});

describe('MPL-7 — marketplace:pack-disable: deleting the row would be a GRANT', () => {
  it('anonymizes disabledBy and KEEPS the deny row (deleting it re-enables the pack)', async () => {
    await disablePack(TENANT, 'vendor.b.nodes', SUBJECT);
    await eraseSubject(TENANT, SUBJECT);
    const [d] = (await packDisables.listForTenantIndexed(TENANT)).filter((r) => r.packName === 'vendor.b.nodes');
    expect(d, 'a sparse DENY row: deleting it silently RE-ENABLES a pack the workspace deliberately hid').toBeTruthy();
    expect(d!.disabledBy).toBe(ERASED_VALUE);
    expect(d!.packName).toBe('vendor.b.nodes');
  });
});

describe('MPL-7 — commerce-connect:listing-tombstone: the row that nothing could reach', () => {
  it('anonymizes `by` and KEEPS the 90-day cooldown row', async () => {
    await listingTombstones.put({ packName: 'vendor.c.nodes', sellerTenantId: TENANT, by: SUBJECT, at: now, reason: 'Payout URL pointed at an unverified domain' });

    await eraseSubject(TENANT, SUBJECT);

    const t = await listingTombstones.get('vendor.c.nodes');
    expect(t, 'the row IS the ADR 0574 cooldown — deleting it lets a dissolved squatter re-claim the name immediately').toBeTruthy();
    expect(t!.by).toBe(ERASED_VALUE);
    expect(t!.reason, 'the OPERATOR\'s business record of why, not a statement about the erased subject').toBe('Payout URL pointed at an unverified domain');
  });

  it('reaches the row THROUGH the tenant index — the wiring the ratchet cannot see', async () => {
    // The assertion that reddens when `tenantOf` is removed from the declaration.
    // With no extractor `listForTenantIndexed` enumerates nothing, the eraser
    // anonymizes zero rows, and the ADR 0464 ratchet stays fully green — measured.
    await listingTombstones.put({ packName: 'vendor.d.nodes', sellerTenantId: TENANT, by: SUBJECT, at: now, reason: 'r' });
    expect(
      (await listingTombstones.listForTenantIndexed(TENANT)).map((t) => t.packName),
      'the tombstone store must be TENANT-INDEXED or no eraser can enumerate it',
    ).toContain('vendor.d.nodes');
  });
});

describe('MPL-7 — commerce-connect:paid-listing: dropping stateMeta would RELEASE an operator hold', () => {
  it('anonymizes stateMeta.by and keeps the suspension intact', async () => {
    await paidListings.put({
      packName: 'vendor.e.nodes', sellerTenantId: TENANT, lane: 'native-paid',
      priceMajorUnits: 10, currency: 'usd', approvalState: 'approved',
      state: 'suspended', stateMeta: { by: SUBJECT, at: now, reason: 'Dispute under review' },
      createdAt: now, updatedAt: now,
    });

    await eraseSubject(TENANT, SUBJECT);

    const l = await paidListings.get('vendor.e.nodes');
    expect(l!.stateMeta?.by).toBe(ERASED_VALUE);
    // `listingState()` reads absent-⇒-active, so dropping `state`/`stateMeta`
    // would silently make a held listing purchasable again.
    expect(l!.state, 'the HOLD must survive the erasure').toBe('suspended');
    expect(l!.stateMeta?.reason).toBe('Dispute under review');
  });
});

describe('MPL-7 — the nine money-truth stores are NOT erased, and that is the decision', () => {
  it('an order survives a DSAR against its buyer (a receipt is a statutory record)', async () => {
    const { orders } = await import('../src/features/commerce-connect/stores.js');
    await orders.put({
      orderId: 'cco_keep', buyerTenantId: TENANT, sellerTenantId: 'ws:seller', packName: 'vendor.f.nodes',
      amountMajorUnits: 40, currency: 'usd', applicationFeeMajorUnits: 5,
      status: 'paid', mode: 'demo', createdAt: now, updatedAt: now,
    });
    await eraseSubject(TENANT, SUBJECT);
    const o = await orders.get('cco_keep');
    expect(o, 'an order is a financial record reclaimed by TENANT teardown, not by a DSAR').toBeTruthy();
    expect(o!.status).toBe('paid');
    expect(o!.amountMajorUnits).toBe(40);
  });
});
