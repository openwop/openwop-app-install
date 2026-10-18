/**
 * ADR 0420 (admin link surface) — the operator's view of what is for sale, and the
 * two rules the surface adds:
 *  - `listChallengeLinks` lists the tenant's product→challenge links (and nothing
 *    of another tenant's);
 *  - `unlinkChallengeProduct` stops selling without touching a granted entitlement
 *    (a buyer keeps what they paid for);
 *  - `relinkConflict` refuses a SILENT relink to a different challenge version unless
 *    the caller says `replace`, and is idempotent for the same version.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { createProduct, type Order } from '../src/features/commerce/commerceService.js';
import {
  linkChallengeProduct, listChallengeLinks, unlinkChallengeProduct, getLinkByProduct, relinkConflict, isChallengePaid, LinkError,
  reprocessOrder, getEntitlement, type ChallengeProductLink,
} from '../src/features/kicktodo-commerce/entitlementService.js';

const T = 'tenant-links';
const OTHER = 'tenant-links-other';
let challengeId = '';
/** A REAL commerce product per tenant: since KTCOM-3 a link only paywalls while its
 *  product exists, so a fabricated product id would read as "not for sale". */
const productOf: Record<string, string> = {};

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  __clearEnrollGuards();
  for (const tenant of [T, OTHER]) {
    const draft = await createDraft({
      tenantId: tenant, title: 'Sellable', summary: 's', outcome: 'o', durationDays: 3,
      activities: [{ stableActivityId: 'a', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
    });
    await publishChallenge(tenant, draft.id, 1);
    if (tenant === T) challengeId = draft.id;
    const product = await createProduct({ tenantId: tenant, orgId: 'org-links', createdBy: 'user:op', type: 'digital', name: 'Sellable', price: 12.5 });
    productOf[tenant] = product.productId;
    await linkChallengeProduct(tenant, product.productId, draft.id, 1, 'user:op');
  }
});

describe('challenge links — the operator surface (ADR 0420)', () => {
  it('lists only the tenant’s links, and unlink stops the sale without an error on a second call', async () => {
    const mine = await listChallengeLinks(T);
    expect(mine.map((l) => l.productId)).toEqual([productOf[T]!]);
    expect(await isChallengePaid(T, challengeId, 1)).toBe(true);

    // A buyer who already PAID through this product keeps what they bought.
    const order: Order = {
      orderId: 'ord-links-paid', tenantId: T, orgId: 'org-links',
      items: [{ productId: productOf[T]!, name: 'Sellable', unitPrice: 12.5, quantity: 1 }],
      subtotal: 12.5, discount: 0, total: 12.5, currency: 'usd',
      status: 'paid', fulfillmentStatus: 'pending',
      createdBy: 'user:paid-buyer', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z',
    };
    expect(await reprocessOrder(order, 'grant')).toBe(1);

    expect(await unlinkChallengeProduct(T, productOf[T]!)).toBe(true);
    expect(await getLinkByProduct(T, productOf[T]!)).toBeNull();
    expect(await isChallengePaid(T, challengeId, 1)).toBe(false); // free again on the next enrol
    expect(await unlinkChallengeProduct(T, productOf[T]!)).toBe(false); // honest: nothing to remove
    // …and the granted entitlement is untouched by the unlink.
    expect((await getEntitlement(T, 'user:paid-buyer', challengeId, 1))?.state).toBe('active');
    // The other tenant's link is untouched.
    expect((await listChallengeLinks(OTHER)).map((l) => l.productId)).toEqual([productOf[OTHER]!]);
  });

  it('relinkConflict: same version idempotent; different version refused unless replace; no link ⇒ proceed', async () => {
    // A literal link (relinkConflict is pure) — writing one into tenant T would
    // change what the listing case above sees, so this case writes nothing.
    const link: ChallengeProductLink = {
      tenantId: T, productId: 'prod:relink', challengeId, challengeVersion: 1, createdBy: 'user:op', createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(relinkConflict(null, { challengeId: 'x', challengeVersion: 9 })).toBeNull();
    expect(relinkConflict(link, { challengeId, challengeVersion: 1 })).toBeNull();
    expect(relinkConflict(link, { challengeId: 'chal:other', challengeVersion: 2 })).toMatch(/already sells/);
    // Same challenge, a DIFFERENT version is a relink too — never silent.
    expect(relinkConflict(link, { challengeId, challengeVersion: 2 })).toBe(
      `Product already sells ${challengeId} v1; unlink it or pass replace: true.`,
    );
    expect(relinkConflict(link, { challengeId: 'chal:other', challengeVersion: 2, replace: true })).toBeNull();
  });

  it('a link still refuses an unpublished version (unchanged rule)', async () => {
    // A real DRAFT (exists, never published) reaches the published-status guard.
    const draft = await createDraft({
      tenantId: T, title: 'Not yet', summary: 's', outcome: 'o', durationDays: 3,
      activities: [{ stableActivityId: 'a', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
    });
    await expect(linkChallengeProduct(T, 'prod:draft', draft.id, 1, 'user:op')).rejects.toThrow('Only a PUBLISHED challenge version can be sold.');
    // A missing version is refused by the earlier not-found guard.
    await expect(linkChallengeProduct(T, 'prod:never', 'chal:missing', 1, 'user:op')).rejects.toBeInstanceOf(LinkError);
    await expect(linkChallengeProduct(T, 'prod:never', 'chal:missing', 1, 'user:op')).rejects.toThrow('Challenge version not found.');
    expect(await getLinkByProduct(T, 'prod:draft')).toBeNull();
  });
});
