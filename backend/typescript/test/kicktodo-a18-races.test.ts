/**
 * A-18 — the three check-then-write races the data grade left open after wave 4B,
 * interleaved DETERMINISTICALLY with `interleavedStorage` (the competitor runs to
 * completion between the first call's read and its write), so each case
 * reproduces the lost update every time:
 *
 *  - the `/links` relink check: two operators linking one product to different
 *    challenge versions both read "no link"; the later blind put replaced the
 *    earlier sale. Sabotage (witnessed): restore `links.put(link)` in
 *    `linkChallengeProduct` and the second call returns a link instead of throwing.
 *  - `upsertProfile`: two edits to different handles both claimed theirs; the
 *    loser's handle stayed claimed by a profile that no longer used it. Sabotage
 *    (witnessed): restore the blind `profiles.put(profile)` and `beta` stays held.
 *  - `eraseSubjectEntitlements`: a grant between the erasure's list and its delete
 *    was deleted with the row, a row granted mid-erasure escaped it, and a refund
 *    on a row being moved never reached its anonymized copy. Sabotage (witnessed):
 *    the pre-A-18 body reds the first two; dropping `revokeAnonymizedCopy` reds
 *    the third.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { createProduct, type Order } from '../src/features/commerce/commerceService.js';
import {
  eraseSubjectEntitlements, getEntitlement, getLinkByProduct, linkChallengeProduct, LinkConflictError, listEntitlementsFor, reprocessOrder,
} from '../src/features/kicktodo-commerce/entitlementService.js';
import { myProfile, upsertProfile } from '../src/features/kicktodo-community/communityService.js';
import { interleavedStorage, type InterleavedStorage } from './helpers/interleavedStorage.js';

const ORG = 'org-kt-a18';
let race: InterleavedStorage;

/** Raw view of the anonymized rows (the service exposes no read by erased key). */
const entitlementRows = new DurableCollection<{ tenantId: string; buyerSubject: string; challengeId: string; challengeVersion: number; orderId: string; state: string }>(
  'kicktodo-entitlements',
  (e) => `${e.tenantId}::${e.buyerSubject}::${e.challengeId}::v${e.challengeVersion}`,
);
const handleIndex = new DurableCollection<{ tenantId: string; handleLower: string; creatorSubject: string }>(
  'kicktodo-handle-index',
  (h) => `${h.tenantId}::${h.handleLower}`,
);

beforeAll(async () => {
  race = interleavedStorage(await openStorage('memory://'));
  initHostExtPersistence(race.storage);
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
});

async function published(T: string, title: string): Promise<string> {
  const draft = await createDraft({
    tenantId: T, title, summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  return draft.id;
}

async function sold(T: string, title: string): Promise<{ challengeId: string; productId: string }> {
  const challengeId = await published(T, title);
  const product = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:pub', type: 'digital', name: title, price: 10 });
  await linkChallengeProduct(T, product.productId, challengeId, 1, 'user:pub');
  return { challengeId, productId: product.productId };
}

const order = (T: string, orderId: string, productId: string, buyer: string, createdAt: string): Order => ({
  orderId, tenantId: T, orgId: ORG,
  items: [{ productId, name: 'Sold', unitPrice: 10, quantity: 1 }],
  subtotal: 10, discount: 0, total: 10, currency: 'usd',
  status: 'paid', fulfillmentStatus: 'pending',
  createdBy: buyer, createdAt, updatedAt: createdAt,
});

describe('A-18 /links — the relink check and the write are one CAS', () => {
  it('two operators linking one product to different versions: one wins, the other gets the 409', async () => {
    const T = 'tenant-a18-links';
    const first = await published(T, 'First');
    const second = await published(T, 'Second');
    const product = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:op', type: 'digital', name: 'P', price: 10 });

    let competitor: unknown = null;
    race.interleaveAfterRead((k) => k === `hostext:kicktodo-product-links:${T}::${product.productId}`, async () => {
      competitor = await linkChallengeProduct(T, product.productId, second, 1, 'user:op-b', { replace: false });
    });
    const mine = linkChallengeProduct(T, product.productId, first, 1, 'user:op-a', { replace: false });
    await expect(mine).rejects.toBeInstanceOf(LinkConflictError);
    expect(race.fired()).toBe(true);
    expect(competitor).toMatchObject({ challengeId: second });
    expect((await getLinkByProduct(T, product.productId))?.challengeId, 'the earlier sale is not silently replaced').toBe(second);
  });

  it('CONTROL: relinking the same version is idempotent, and replace still replaces', async () => {
    const T = 'tenant-a18-links-control';
    const a = await published(T, 'A');
    const b = await published(T, 'B');
    const product = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:op', type: 'digital', name: 'P', price: 10 });
    await linkChallengeProduct(T, product.productId, a, 1, 'user:op', { replace: false });
    await expect(linkChallengeProduct(T, product.productId, a, 1, 'user:op', { replace: false })).resolves.toMatchObject({ challengeId: a });
    await expect(linkChallengeProduct(T, product.productId, b, 1, 'user:op', { replace: false })).rejects.toBeInstanceOf(LinkConflictError);
    await expect(linkChallengeProduct(T, product.productId, b, 1, 'user:op', { replace: true })).resolves.toMatchObject({ challengeId: b });
  });
});

describe('A-18 upsertProfile — the profile write is a CAS; a lost claim is given back', () => {
  it('two concurrent edits to different handles leave exactly one handle held', async () => {
    const T = 'tenant-a18-profile';
    const CREATOR = 'user:a18-creator';
    await upsertProfile(T, CREATOR, { handle: 'start', displayName: 'Creator' });

    race.interleaveAfterRead((k) => k === `hostext:kicktodo-creator-profiles:${T}::${CREATOR}`, async () => {
      await upsertProfile(T, CREATOR, { handle: 'beta', displayName: 'Creator' });
    });
    const mine = await upsertProfile(T, CREATOR, { handle: 'alpha', displayName: 'Creator' });
    expect(race.fired()).toBe(true);

    expect(mine.handle).toBe('alpha');
    expect((await myProfile(T, CREATOR))?.handle).toBe('alpha');
    expect(await handleIndex.get(`${T}::alpha`)).toMatchObject({ creatorSubject: CREATOR });
    expect(await handleIndex.get(`${T}::beta`), 'the overwritten edit\'s handle is released, not stranded').toBeNull();
    expect(await handleIndex.get(`${T}::start`), 'the original handle is released').toBeNull();
    // …so someone else can take it.
    await expect(upsertProfile(T, 'user:someone-else', { handle: 'beta', displayName: 'Other' })).resolves.toMatchObject({ handle: 'beta' });
  });
});

describe('A-18 eraseSubjectEntitlements — claim, copy, re-check, delete', () => {
  it('a newer order granting between the list and the delete is carried into the tombstone, not deleted', async () => {
    const T = 'tenant-a18-erase-grant';
    const BUYER = 'user:a18-erase';
    const { challengeId, productId } = await sold(T, 'Erase');
    expect(await reprocessOrder(order(T, 'ord-old', productId, BUYER, '2026-03-01T00:00:00.000Z'), 'grant')).toBe(1);

    race.interleaveAfterRead((k) => k === `hostext:kicktodo-entitlements:${T}::`, () =>
      reprocessOrder(order(T, 'ord-new', productId, BUYER, '2026-03-02T00:00:00.000Z'), 'grant'));
    expect(await eraseSubjectEntitlements(T, BUYER)).toBe(1);
    expect(race.fired()).toBe(true);

    expect(await getEntitlement(T, BUYER, challengeId, 1), 'no live row under the erased subject').toBeNull();
    const tombs = (await entitlementRows.listByPrefix(`${T}::erased:`)).filter((e) => e.challengeId === challengeId);
    expect(tombs).toHaveLength(1);
    expect(tombs[0]!.orderId, 'the tombstone records the order that last paid').toBe('ord-new');
  });

  it('a row granted while the erasure runs is erased too', async () => {
    const T = 'tenant-a18-erase-late';
    const BUYER = 'user:a18-late';
    const one = await sold(T, 'One');
    const two = await sold(T, 'Two');
    expect(await reprocessOrder(order(T, 'ord-1', one.productId, BUYER, '2026-03-01T00:00:00.000Z'), 'grant')).toBe(1);

    race.interleaveAfterRead((k) => k === `hostext:kicktodo-entitlements:${T}::`, () =>
      reprocessOrder(order(T, 'ord-2', two.productId, BUYER, '2026-03-02T00:00:00.000Z'), 'grant'));
    expect(await eraseSubjectEntitlements(T, BUYER)).toBe(2);
    expect(race.fired()).toBe(true);
    expect(await listEntitlementsFor(T, BUYER)).toEqual([]);
  });

  it('a refund whose row an erasure moves out from under it still revokes the anonymized copy', async () => {
    const T = 'tenant-a18-erase-refund';
    const BUYER = 'user:a18-refund';
    const { challengeId, productId } = await sold(T, 'Refund');
    const paid = order(T, 'ord-r', productId, BUYER, '2026-03-01T00:00:00.000Z');
    expect(await reprocessOrder(paid, 'grant')).toBe(1);

    // The refund has listed the live row; the whole erasure runs before its re-read.
    const LIVE = `hostext:kicktodo-entitlements:${T}::${BUYER}::${challengeId}::v1`;
    race.interleaveAfterRead((k) => k === LIVE, () => eraseSubjectEntitlements(T, BUYER));
    expect(await reprocessOrder(paid, 'revoke')).toBe(1);
    expect(race.fired()).toBe(true);

    const tombs = (await entitlementRows.listByPrefix(`${T}::erased:`)).filter((e) => e.challengeId === challengeId);
    expect(tombs).toHaveLength(1);
    expect(tombs[0]!.state, 'a refunded order\'s tombstone is revoked').toBe('revoked');
  });

  it('CONTROL: an uncontended erasure anonymizes and is idempotent', async () => {
    const T = 'tenant-a18-erase-control';
    const BUYER = 'user:a18-control';
    const { productId } = await sold(T, 'Control');
    expect(await reprocessOrder(order(T, 'ord-c', productId, BUYER, '2026-03-01T00:00:00.000Z'), 'grant')).toBe(1);
    expect(await eraseSubjectEntitlements(T, BUYER)).toBe(1);
    expect(await eraseSubjectEntitlements(T, BUYER)).toBe(0);
    expect(await listEntitlementsFor(T, BUYER)).toEqual([]);
  });
});
