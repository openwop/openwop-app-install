/**
 * ADR 0455 P1 — `productForChallenge`, the reverse lookup the KickTodo Detail
 * page needs to SURFACE a paid challenge's price (today it dead-ends at the
 * enroll wall). Pins: no link ⇒ null (free); a linked product ⇒ its price/org;
 * multiple tiers ⇒ the LOWEST ACTIVE price (OQ2).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { createProduct } from '../src/features/commerce/commerceService.js';
import { linkChallengeProduct, productForChallenge } from '../src/features/kicktodo-commerce/entitlementService.js';
import { ensureAffiliateForSubject, __resetSubjectAffiliateBridge } from '../src/features/kicktodo-commerce/subjectAffiliateBridge.js';
import { __resetAffiliates } from '../src/features/commerce/affiliate.js';

const T = 'tenant-pfc';
const ORG = 'org-pfc';

async function publishedChallenge(): Promise<string> {
  const draft = await createDraft({
    tenantId: T, title: 'Paid', summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  return draft.id;
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
});

describe('productForChallenge (ADR 0455 P1)', () => {
  it('returns null for a free (unlinked) challenge', async () => {
    const challengeId = await publishedChallenge();
    expect(await productForChallenge(T, challengeId, 1)).toBeNull();
  });

  it('returns the linked product price + org', async () => {
    const challengeId = await publishedChallenge();
    const product = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:pub', type: 'digital', name: 'Course', price: 19 });
    await linkChallengeProduct(T, product.productId, challengeId, 1, 'user:pub');

    const info = await productForChallenge(T, challengeId, 1);
    expect(info).not.toBeNull();
    expect(info?.productId).toBe(product.productId);
    expect(info?.orgId).toBe(ORG);
    expect(info?.price).toBe(19);
    expect(info?.active).toBe(true);
  });

  it('with multiple tiers, picks the lowest active price (OQ2)', async () => {
    const challengeId = await publishedChallenge();
    const premium = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:pub', type: 'digital', name: 'Premium', price: 49 });
    const basic = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:pub', type: 'digital', name: 'Basic', price: 9 });
    await linkChallengeProduct(T, premium.productId, challengeId, 1, 'user:pub');
    await linkChallengeProduct(T, basic.productId, challengeId, 1, 'user:pub');

    const info = await productForChallenge(T, challengeId, 1);
    expect(info?.price).toBe(9);
    expect(info?.productId).toBe(basic.productId);
  });
});

describe('referral-code resolution (ADR 0451 P2b — the route composition)', () => {
  it('mints the inviter a code in the challenge product org for a paid challenge; null for a free one', async () => {
    await __resetSubjectAffiliateBridge();
    await __resetAffiliates();
    // Free challenge ⇒ no product ⇒ productForChallenge null ⇒ the route returns { code: null }.
    const freeId = await publishedChallenge();
    expect(await productForChallenge(T, freeId, 1)).toBeNull();

    // Paid challenge ⇒ resolve the product org, then ensure the inviter's code THERE
    // so `affiliateCodeExists(tenant, org, code)` resolves it at checkout.
    const paidId = await publishedChallenge();
    const product = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:pub', type: 'digital', name: 'Paid', price: 20 });
    await linkChallengeProduct(T, product.productId, paidId, 1, 'user:pub');
    const info = await productForChallenge(T, paidId, 1);
    expect(info?.orgId).toBe(ORG);
    const link = await ensureAffiliateForSubject(T, info!.orgId, 'user:inviter');
    expect(link.code).toMatch(/^KT-[0-9A-F]{12}$/);
    // Idempotent — the same inviter always resolves to the same code.
    expect((await ensureAffiliateForSubject(T, info!.orgId, 'user:inviter')).code).toBe(link.code);
  });
});
