/**
 * ADR 0451 P1 — the subject⇄affiliate-code bridge. Pins:
 *  - lazy mint: a referrer subject resolves to a stable affiliate (idempotent);
 *  - the code is deterministic (same subject ⇒ same code across calls);
 *  - the reverse index resolves code→subject (backs the self-referral guard);
 *  - distinct subjects get distinct codes/affiliates (no cross-attribution) — even
 *    when a subject's deterministic code is already bound to someone else (the
 *    disambiguation loop, forced below with a seeded reverse-index row).
 *
 * TRIPLE GUARD (honest ceiling, grade-tests w40): "re-calls are idempotent" holds
 * through THREE independent paths in `ensureAffiliateForSubject` — the early
 * forward-link return, the reverse-index ADOPT path (the code is bound to this
 * subject ⇒ reuse its affiliate), and the forward-link CAS loser returning the
 * winner. Removing any ONE is invisible; the reverse-index write they all rely on
 * is witnessed by the reverse-index case.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { linkSubjectToContact } from '../src/features/kicktodo-core/contactBridgeService.js';
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

/** The REAL namespaces of the bridge's two sidecars, for seeding exact states. */
const codeIndex = () => new DurableCollection<{ tenantId: string; code: string; ownerSubject: string; affiliateId: string }>(
  'kicktodo-affiliate-code-subject', (c) => `${c.tenantId}::${c.code}`, undefined, (c) => c.tenantId);
const forwardLinks = () => new DurableCollection<{ tenantId: string; ownerSubject: string; orgId: string; affiliateId: string; code: string; createdAt: string }>(
  'kicktodo-subject-affiliate', (l) => `${l.tenantId}::${l.ownerSubject}`, undefined, (l) => l.tenantId);

/** An independent derivation of the documented base code (`KT-` + 12 upper-hex
 *  of sha256(`tenant::subject`)) — never computed by the module under test. */
const documentedBaseCode = (tenantId: string, subject: string): string =>
  `KT-${createHash('sha256').update(`${tenantId}::${subject}`).digest('hex').slice(0, 12).toUpperCase()}`;

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
    expect(a2.code).toBe(documentedBaseCode(T, 'user:alice'));

    // COLLISION: carol's deterministic code is already bound to mallory. Carol
    // must get a DISAMBIGUATED code, and mallory's binding must survive.
    const carolBase = documentedBaseCode(T, 'user:carol');
    await codeIndex().put({ tenantId: T, code: carolBase, ownerSubject: 'user:mallory', affiliateId: 'aff:mallory' });
    const carol = await ensureAffiliateForSubject(T, ORG, 'user:carol');
    expect(carol.code).toBe(`${carolBase}-2`);
    expect(await resolveSubjectForAffiliateCode(T, carolBase)).toBe('user:mallory');
    expect(await resolveSubjectForAffiliateCode(T, carol.code)).toBe('user:carol');
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
    // A bridged KickTodo code with a NON-ZERO rate (an operator raised it), so the
    // accrual AMOUNT tells a veto apart from a 0% commission.
    await createAffiliate({ tenantId: T, orgId: ORG, code: 'KT-FRANK-01', name: 'Frank', commissionType: 'percentage', commissionRate: 20, currency: 'USD' });
    await codeIndex().put({ tenantId: T, code: 'KT-FRANK-01', ownerSubject: 'user:frank', affiliateId: 'aff:frank' });
    const order = { tenantId: T, orgId: ORG, createdAt: new Date(0).toISOString(), total: 99.5, currency: 'USD', affiliateCode: 'KT-FRANK-01' };
    // Frank buying through his OWN code ⇒ vetoed, nothing accrues.
    expect(await accrueCommission({ ...order, orderId: 'o-frank', createdBy: 'user:frank' })).toBe(0);
    // Heidi through frank's code ⇒ a real referral, 20% of 99.50 accrues.
    expect(await accrueCommission({ ...order, orderId: 'o-heidi', createdBy: 'user:heidi' })).toBeCloseTo(19.9, 2);
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
    expect(earn.currency).toBe('USD');

    // Once a referral really accrues, the surface reports the LIVE balance.
    await createAffiliate({ tenantId: T, orgId: ORG, code: 'KT-LIV-01', name: 'Liv', commissionType: 'percentage', commissionRate: 20, currency: 'USD' });
    await forwardLinks().put({ tenantId: T, ownerSubject: 'user:liv', orgId: ORG, affiliateId: 'aff:liv', code: 'KT-LIV-01', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(await accrueCommission({ tenantId: T, orgId: ORG, orderId: 'o-liv', createdAt: new Date(0).toISOString(), total: 99.5, currency: 'USD', affiliateCode: 'KT-LIV-01', createdBy: 'user:buyer' })).toBeCloseTo(19.9, 2);
    const liv = await referralEarningsForSubject(T, 'user:liv');
    expect(liv.code).toBe('KT-LIV-01');
    expect(liv.balanceOwed).toBeCloseTo(19.9, 2);
  });
});
