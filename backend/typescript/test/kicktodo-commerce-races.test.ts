/**
 * KickTodo wave 4B (slice B) — read-then-put races in the commerce adapters,
 * interleaved DETERMINISTICALLY: `interleavedStorage` runs the competing call to
 * completion between the first call's read and its write (see the helper), so each
 * case reproduces the lost update every time rather than by microtask luck.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { createProduct, type Order } from '../src/features/commerce/commerceService.js';
import { getEntitlement, linkChallengeProduct, reprocessOrder } from '../src/features/kicktodo-commerce/entitlementService.js';
import { requestSellerOnboarding, sellerRequestStatus } from '../src/features/kicktodo-commerce/sellerRequestService.js';
import { listApprovals, resolveApproval } from '../src/host/approvalService.js';
import { getSharePolicy, setSharePolicy } from '../src/features/kicktodo-commerce/shareLedgerService.js';
import { ensureAffiliateForSubject, resolveSubjectForAffiliateCode } from '../src/features/kicktodo-commerce/subjectAffiliateBridge.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { createHash } from 'node:crypto';
import { getSeatLink, linkCohortProduct, SeatLinkConflictError } from '../src/features/kicktodo-commerce/seatService.js';
import { interleavedStorage, type InterleavedStorage } from './helpers/interleavedStorage.js';

const ORG = 'org-kt-races';
let race: InterleavedStorage;

beforeAll(async () => {
  race = interleavedStorage(await openStorage('memory://'));
  initHostExtPersistence(race.storage);
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
});

async function soldChallenge(T: string): Promise<{ challengeId: string; productId: string }> {
  const draft = await createDraft({
    tenantId: T, title: 'Sold', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  const product = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:pub', type: 'digital', name: 'Sold', price: 10 });
  await linkChallengeProduct(T, product.productId, draft.id, 1, 'user:pub');
  return { challengeId: draft.id, productId: product.productId };
}

const order = (T: string, orderId: string, productId: string, buyer: string, createdAt: string): Order => ({
  orderId, tenantId: T, orgId: ORG,
  items: [{ productId, name: 'Sold', unitPrice: 10, quantity: 1 }],
  subtotal: 10, discount: 0, total: 10, currency: 'usd',
  status: 'paid', fulfillmentStatus: 'pending',
  createdBy: buyer, createdAt, updatedAt: createdAt,
});

describe('entitlement grant/revoke are CAS (KTCOM-5 / KTM-2)', () => {
  // Sabotage (witnessed): swap `grantLine`'s `compareAndSwap(existing, next)` back to a
  // blind `entitlements.put(next)` and the pointer lands on the OLDER order, so the
  // older refund revokes access (both expectations below go red).
  it('an older order granting from a stale read cannot take the pointer from a newer one', async () => {
    const T = 'tenant-kt-race-grant';
    const BUYER = 'user:two-orders';
    const { challengeId, productId } = await soldChallenge(T);
    const older = order(T, 'ord-older', productId, BUYER, '2026-03-01T00:00:00.000Z');
    const newer = order(T, 'ord-newer', productId, BUYER, '2026-03-02T00:00:00.000Z');

    // The older order reads "no entitlement"; the newer one grants before it writes.
    race.interleaveAfterRead((k) => k === `hostext:kicktodo-entitlements:${T}::${BUYER}::${challengeId}::v1`, () => reprocessOrder(newer, 'grant'));
    await reprocessOrder(older, 'grant');
    expect(race.fired()).toBe(true);

    expect((await getEntitlement(T, BUYER, challengeId, 1))?.orderId, 'ARCH-H1: the newest paying order holds the pointer').toBe('ord-newer');
    // …so refunding the OLDER order cannot take away what the newer one paid for.
    await reprocessOrder(older, 'revoke');
    expect((await getEntitlement(T, BUYER, challengeId, 1))?.state).toBe('active');
  });

  // Sabotage (witnessed): restore the revoke's blind `put({ ...listedRow, revoked })`
  // and the newer order's fresh grant is overwritten with `revoked`.
  it('a refund racing a newer order\'s grant does not overwrite that grant', async () => {
    const T = 'tenant-kt-race-revoke';
    const BUYER = 'user:refund-then-rebuy';
    const { challengeId, productId } = await soldChallenge(T);
    const first = order(T, 'ord-first', productId, BUYER, '2026-03-01T00:00:00.000Z');
    const second = order(T, 'ord-second', productId, BUYER, '2026-03-05T00:00:00.000Z');
    expect(await reprocessOrder(first, 'grant')).toBe(1);

    // The refund lists the row pointing at `first`; the re-purchase lands before it writes.
    race.interleaveAfterRead((k) => k === `hostext:kicktodo-entitlements:${T}::`, () => reprocessOrder(second, 'grant'));
    expect(await reprocessOrder(first, 'revoke')).toBe(0);
    expect(race.fired()).toBe(true);

    const e = await getEntitlement(T, BUYER, challengeId, 1);
    expect(e?.orderId).toBe('ord-second');
    expect(e?.state, 'the refund of the first order must not revoke the second purchase').toBe('active');
  });

  it('CONTROL: an uncontended refund still revokes', async () => {
    const T = 'tenant-kt-race-control';
    const { challengeId, productId } = await soldChallenge(T);
    const only = order(T, 'ord-only', productId, 'user:solo', '2026-03-01T00:00:00.000Z');
    expect(await reprocessOrder(only, 'grant')).toBe(1);
    expect(await reprocessOrder(only, 'revoke')).toBe(1);
    expect((await getEntitlement(T, 'user:solo', challengeId, 1))?.state).toBe('revoked');
  });
});

describe('share-policy version bump is CAS (KTCOM-5 / KTM-1)', () => {
  // Sabotage (witnessed): restore the blind `policies.put(next)` and both writes claim
  // version 1, so one version number names two rates.
  it('two concurrent policy changes get DISTINCT versions; the stored row is the later one', async () => {
    const T = 'tenant-kt-race-policy';
    let competitor: { version: number; shareBps: number } | null = null;
    race.interleaveAfterRead((k) => k === `hostext:kicktodo-share-policy:${T}`, async () => {
      competitor = await setSharePolicy(T, 3000, 'user:op-b');
    });
    const mine = await setSharePolicy(T, 2000, 'user:op-a');
    expect(race.fired()).toBe(true);

    expect(competitor!.version).toBe(1);
    expect(mine.version, 'a stale read must not reuse the competitor\'s version').toBe(2);
    const stored = await getSharePolicy(T);
    expect(stored).toMatchObject({ version: 2, shareBps: 2000, updatedBy: 'user:op-a' });
  });
});

describe('seller request mints ONE approval (KTCOM-5 / KTM-3)', () => {
  const pendingSellerCards = async (T: string) =>
    (await listApprovals(T, 'pending')).filter((a) => a.kind === 'connect-seller');

  // Sabotage (witnessed): drop the derived `approvalId` (back to a random id) and
  // restore the blind `requests.put(row)`, and the inbox holds TWO cards.
  it('two concurrent requests from one author leave one pending approval, and both return it', async () => {
    const T = 'tenant-kt-race-seller';
    const AUTHOR = 'user:pub'; // `soldChallenge` links as this subject
    await soldChallenge(T);
    let competitor: { approvalId: string } | null = null;
    race.interleaveAfterRead((k) => k === `hostext:kicktodo-seller-requests:${T}::${AUTHOR}`, async () => {
      competitor = await requestSellerOnboarding(T, AUTHOR);
    });
    const mine = await requestSellerOnboarding(T, AUTHOR);
    expect(race.fired()).toBe(true);

    const cards = await pendingSellerCards(T);
    expect(cards, 'one author, one open request ⇒ one inbox card').toHaveLength(1);
    expect(mine.approvalId).toBe(cards[0]!.approvalId);
    expect(competitor!.approvalId).toBe(cards[0]!.approvalId);
  });

  it('a REJECTED request can still be re-requested, as a fresh approval', async () => {
    const T = 'tenant-kt-race-seller-rerequest';
    const AUTHOR = 'user:pub';
    await soldChallenge(T);
    const first = await requestSellerOnboarding(T, AUTHOR);
    await resolveApproval(first.approvalId, { status: 'rejected', note: 'not yet' });
    expect((await sellerRequestStatus(T, AUTHOR)).request).toBe('rejected');

    const second = await requestSellerOnboarding(T, AUTHOR);
    expect(second.approvalId).not.toBe(first.approvalId);
    expect((await pendingSellerCards(T)).map((a) => a.approvalId)).toEqual([second.approvalId]);
    // …and it is idempotent again while pending.
    expect((await requestSellerOnboarding(T, AUTHOR)).approvalId).toBe(second.approvalId);
  });
});

describe('affiliate code ownership is claimed, not overwritten (KTCOM-5)', () => {
  /** The bridge's real reverse-index namespace, to land a competing claim. */
  const codeIndex = new DurableCollection<{ tenantId: string; code: string; ownerSubject: string; affiliateId: string }>(
    'kicktodo-affiliate-code-subject', (c) => `${c.tenantId}::${c.code}`, undefined, (c) => c.tenantId);
  /** Independent derivation of the documented base code (`KT-` + 12 upper-hex). */
  const baseCode = (t: string, subject: string): string =>
    `KT-${createHash('sha256').update(`${t}::${subject}`).digest('hex').slice(0, 12).toUpperCase()}`;

  // Sabotage (witnessed): restore the old shape (check the index, create, then a blind
  // `codeIndex.put` at the end) and alice's mint overwrites mallory's binding, so
  // mallory's code resolves to alice.
  it('a different subject claiming the code between our check and our write keeps it', async () => {
    const T = 'tenant-kt-race-affiliate';
    const code = baseCode(T, 'user:alice');
    // Mallory claims alice's candidate code (a collision) after alice has looked.
    race.interleaveAfterRead((k) => k === `hostext:kicktodo-affiliate-code-subject:${T}::${code}`, async () => {
      expect(await codeIndex.compareAndSwap(null, { tenantId: T, code, ownerSubject: 'user:mallory', affiliateId: 'aff:mallory' })).toBe(true);
    });
    const alice = await ensureAffiliateForSubject(T, ORG, 'user:alice');
    expect(race.fired()).toBe(true);

    expect(await resolveSubjectForAffiliateCode(T, code), 'mallory keeps the code she claimed').toBe('user:mallory');
    expect(alice.code).toBe(`${code}-2`);
    expect(await resolveSubjectForAffiliateCode(T, alice.code)).toBe('user:alice');
    // …and alice's claim carries her affiliate id once the mint completes.
    expect((await codeIndex.get(`${T}::${alice.code}`))?.affiliateId).toBe(alice.affiliateId);
  });
});

describe('a seat-product link never silently re-points (KTO-5)', () => {
  /** Seed cohort detail rows directly — `linkCohortProduct` only needs them to exist. */
  const cohorts = new DurableCollection<{ tenantId: string; circleId: string; challengeId: string; challengeVersion: number; startDateLocal: string; capacity: number; seatsTaken: number }>(
    'kicktodo-cohorts', (c) => `${c.tenantId}::${c.circleId}`);
  const seedCohort = (T: string, circleId: string) =>
    cohorts.put({ tenantId: T, circleId, challengeId: 'chal:x', challengeVersion: 1, startDateLocal: '2026-11-01', capacity: 5, seatsTaken: 1 });

  // Sabotage (witnessed): restore the blind `links.put(link)` and the first caller's
  // stale write re-points the product to cohort A under the competitor's feet.
  it('a link to cohort A racing a link to cohort B is refused, and B\'s link stands', async () => {
    const T = 'tenant-kt-race-seat';
    await seedCohort(T, 'circle-a');
    await seedCohort(T, 'circle-b');
    race.interleaveAfterRead((k) => k === `hostext:kicktodo-cohorts:${T}::circle-a`, () =>
      linkCohortProduct(T, 'user:coach-b', { productId: 'prod-seat', circleId: 'circle-b' }));
    await expect(linkCohortProduct(T, 'user:coach-a', { productId: 'prod-seat', circleId: 'circle-a' }))
      .rejects.toBeInstanceOf(SeatLinkConflictError);
    expect(race.fired()).toBe(true);
    expect((await getSeatLink(T, 'prod-seat'))?.circleId).toBe('circle-b');
  });

  it('re-linking the SAME cohort is idempotent; a different cohort is refused sequentially too', async () => {
    const T = 'tenant-kt-seat-relink';
    await seedCohort(T, 'circle-a');
    await seedCohort(T, 'circle-b');
    const first = await linkCohortProduct(T, 'user:coach', { productId: 'prod-seat', circleId: 'circle-a' });
    expect(await linkCohortProduct(T, 'user:coach', { productId: 'prod-seat', circleId: 'circle-a' })).toEqual(first);
    await expect(linkCohortProduct(T, 'user:coach', { productId: 'prod-seat', circleId: 'circle-b' }))
      .rejects.toMatchObject({ existing: { circleId: 'circle-a' } });
    expect((await getSeatLink(T, 'prod-seat'))?.circleId).toBe('circle-a');
  });
});
