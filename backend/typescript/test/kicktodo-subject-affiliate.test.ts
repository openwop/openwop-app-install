/**
 * ADR 0451 P1 — the subject⇄affiliate-code bridge. Pins:
 *  - lazy mint: a referrer subject resolves to a stable affiliate (idempotent);
 *  - the code is deterministic (same subject ⇒ same code across calls);
 *  - the reverse index resolves code→subject (backs the self-referral guard);
 *  - distinct subjects get distinct codes/affiliates (no cross-attribution).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  ensureAffiliateForSubject,
  resolveSubjectForAffiliateCode,
  isSelfReferralAccrual,
  referralEarningsForSubject,
  __resetSubjectAffiliateBridge,
} from '../src/features/kicktodo-commerce/subjectAffiliateBridge.js';
import {
  __resetAffiliates,
  affiliateByCode,
  createAffiliate,
  accrueCommission,
  registerAffiliateAccrualGuard,
  __resetAccrualGuards,
} from '../src/features/commerce/affiliate.js';

const T = 'tenant-aff';
const ORG = 'org-aff';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetSubjectAffiliateBridge();
  await __resetAffiliates();
  __resetAccrualGuards();
});

describe('ensureAffiliateForSubject (ADR 0451 P1)', () => {
  it('lazily mints one stable affiliate per subject; re-calls are idempotent', async () => {
    const a = await ensureAffiliateForSubject(T, ORG, 'user:referrer');
    expect(a.code).toMatch(/^KT-[0-9A-F]{12}$/);
    expect(a.affiliateId).toMatch(/^aff:/);
    // Second call ⇒ SAME affiliate + code (no duplicate mint).
    const b = await ensureAffiliateForSubject(T, ORG, 'user:referrer');
    expect(b.affiliateId).toBe(a.affiliateId);
    expect(b.code).toBe(a.code);
    // The affiliate really exists in the commerce lane under that org.
    expect((await affiliateByCode(T, ORG, a.code))?.affiliateId).toBe(a.affiliateId);
  });

  it('the code is deterministic for a subject and distinct across subjects', async () => {
    const a1 = await ensureAffiliateForSubject(T, ORG, 'user:alice');
    await __resetSubjectAffiliateBridge();
    await __resetAffiliates();
    initHostExtPersistence(await openStorage('memory://'));
    const a2 = await ensureAffiliateForSubject(T, ORG, 'user:alice');
    expect(a2.code).toBe(a1.code); // deterministic across a fresh store

    const bob = await ensureAffiliateForSubject(T, ORG, 'user:bob');
    expect(bob.code).not.toBe(a1.code); // distinct subject ⇒ distinct code
    expect(bob.affiliateId).not.toBe(a1.affiliateId);
  });

  it('reverse index resolves code→subject; unknown code ⇒ null (fail-closed)', async () => {
    const a = await ensureAffiliateForSubject(T, ORG, 'user:carol');
    expect(await resolveSubjectForAffiliateCode(T, a.code)).toBe('user:carol');
    expect(await resolveSubjectForAffiliateCode(T, a.code.toLowerCase())).toBe('user:carol'); // case-insensitive
    expect(await resolveSubjectForAffiliateCode(T, 'KT-NOTACODE00')).toBeNull();
    expect(await resolveSubjectForAffiliateCode(T, 'ARBITRARY')).toBeNull();
  });
});

describe('self-referral guard (ADR 0451 P2)', () => {
  it('isSelfReferralAccrual is true only when the code maps back to the buyer', async () => {
    const a = await ensureAffiliateForSubject(T, ORG, 'user:dan');
    // Buyer IS the referrer → self-referral.
    expect(await isSelfReferralAccrual({ tenantId: T, createdBy: 'user:dan', affiliateCode: a.code })).toBe(true);
    // A different buyer using dan's code → legitimate referral.
    expect(await isSelfReferralAccrual({ tenantId: T, createdBy: 'user:eve', affiliateCode: a.code })).toBe(false);
    // A non-KickTodo code, or a missing buyer/code → never a self-referral.
    expect(await isSelfReferralAccrual({ tenantId: T, createdBy: 'user:dan', affiliateCode: 'PARTNER10' })).toBe(false);
    expect(await isSelfReferralAccrual({ tenantId: T, affiliateCode: a.code })).toBe(false);
  });

  it('catches a GUEST-checkout self-referral by contactId (ADR 0451 P2b, LEV-3 closure)', async () => {
    const { createContact } = await import('../src/features/crm/contactsService.js');
    const { linkSubjectToContact } = await import('../src/features/kicktodo-core/contactBridgeService.js');
    // The referrer has a linked Contact (the consent that made them a Contact).
    const contact = await createContact({ tenantId: T, name: 'Ivy', email: 'ivy@x.test' });
    await linkSubjectToContact(T, 'user:ivy', contact.contactId, 'paid-checkout');
    const a = await ensureAffiliateForSubject(T, ORG, 'user:ivy');

    // Guest checkout (createdBy = public: sentinel) whose contactId IS the referrer's
    // Contact ⇒ the SAME person buying through their own link ⇒ self-referral.
    expect(await isSelfReferralAccrual({ tenantId: T, createdBy: 'public:guest', contactId: contact.contactId, affiliateCode: a.code })).toBe(true);
    // A different buyer's contact ⇒ a legitimate referral.
    const other = await createContact({ tenantId: T, name: 'Jo', email: 'jo@x.test' });
    expect(await isSelfReferralAccrual({ tenantId: T, createdBy: 'public:guest', contactId: other.contactId, affiliateCode: a.code })).toBe(false);
  });

  it('accrueCommission consults the accrual-guard seam (veto ⇒ no accrual)', async () => {
    await createAffiliate({ tenantId: T, orgId: ORG, code: 'PARTNER20', name: 'Partner', commissionType: 'percentage', commissionRate: 20, currency: 'USD' });
    const order = { tenantId: T, orgId: ORG, createdAt: new Date(0).toISOString(), total: 100, currency: 'USD', affiliateCode: 'PARTNER20', createdBy: 'user:buyer' };
    // No guard registered ⇒ the 20% commission accrues.
    expect(await accrueCommission({ ...order, orderId: 'o-allow' })).toBe(20);
    // A vetoing guard ⇒ the seam skips the accrual (fail-open on throw is tested via the real guard's null path).
    registerAffiliateAccrualGuard(async () => false);
    expect(await accrueCommission({ ...order, orderId: 'o-veto' })).toBe(0);
  });

  it('the composed KickTodo guard blocks a self-referral but allows a real referral (via the seam)', async () => {
    registerAffiliateAccrualGuard(async (o) => !(await isSelfReferralAccrual(o)));
    const link = await ensureAffiliateForSubject(T, ORG, 'user:frank'); // frank's bridged code
    // A DIFFERENT buyer through frank's code is allowed by the guard (not a self-referral);
    // it accrues 0 only because ensureAffiliate's rate is 0 — so assert the GUARD verdict, not the amount.
    expect(await isSelfReferralAccrual({ tenantId: T, createdBy: 'user:frank', affiliateCode: link.code })).toBe(true); // blocked
    expect(await isSelfReferralAccrual({ tenantId: T, createdBy: 'user:heidi', affiliateCode: link.code })).toBe(false); // allowed
    // And the seam does not throw for the bridged code (guard resolves cleanly).
    await expect(accrueCommission({ tenantId: T, orgId: ORG, orderId: 'o-frank', createdAt: new Date(0).toISOString(), total: 100, currency: 'USD', affiliateCode: link.code, createdBy: 'user:frank' })).resolves.toBe(0);
  });
});

describe('referral earnings surface (ADR 0451 P3)', () => {
  it('zero + null code for a subject who never referred; their code + balance once they have', async () => {
    const none = await referralEarningsForSubject(T, 'user:never');
    expect(none.code).toBeNull();
    expect(none.balanceOwed).toBe(0);

    const link = await ensureAffiliateForSubject(T, ORG, 'user:kim');
    const earn = await referralEarningsForSubject(T, 'user:kim');
    expect(earn.code).toBe(link.code);
    expect(earn.balanceOwed).toBe(0); // rate 0 ⇒ nothing accrued yet; never fabricated
    expect(typeof earn.currency).toBe('string');
  });
});
