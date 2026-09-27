/**
 * ADR 0449 P2 — participant⇄CRM Contact bridge. Pins:
 *  - the link store contract (idempotent, first-write-wins, conflict-logged);
 *  - the paid-checkout observer links the buyer subject to the order's Contact
 *    ONLY for a KickTodo order that carries a contactId;
 *  - a non-KickTodo order, or a KickTodo order without a contactId, links nothing
 *    (the ADR 0426 / D3 privacy floor).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  linkSubjectToContact,
  resolveContactForSubject,
  __resetContactBridge,
} from '../src/features/kicktodo-core/contactBridgeService.js';
import { linkKicktodoBuyerContact } from '../src/features/kicktodo-commerce/contactLinkObserver.js';
import { linkChallengeProduct } from '../src/features/kicktodo-commerce/entitlementService.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { createProduct, type Order } from '../src/features/commerce/commerceService.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';

const T = 'tenant-bridge';
const ORG = 'org-bridge';
const BUYER = 'user:buyer';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
  await __resetContactBridge();
});

const orderOf = (over: Partial<Order> = {}): Order => ({
  orderId: 'ord-1', tenantId: T, orgId: ORG,
  items: [{ productId: 'prod-x', name: 'X', unitPrice: 10, quantity: 1 }],
  subtotal: 10, discount: 0, total: 10, currency: 'usd',
  status: 'paid', fulfillmentStatus: 'pending',
  createdBy: BUYER, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  ...over,
});

describe('link store (ADR 0449 P2)', () => {
  it('is idempotent first-write-wins; a conflicting re-link keeps the first binding', async () => {
    const aaa = await createContact({ tenantId: T, name: 'A', email: 'aaa@x.test' });
    const bbb = await createContact({ tenantId: T, name: 'B', email: 'bbb@x.test' });
    await linkSubjectToContact(T, BUYER, aaa.contactId, 'paid-checkout');
    expect(await resolveContactForSubject(T, BUYER)).toBe(aaa.contactId);
    // Re-link same contact ⇒ no-op; different contact ⇒ keeps the first (logged conflict).
    await linkSubjectToContact(T, BUYER, aaa.contactId, 'reminder-consent');
    await linkSubjectToContact(T, BUYER, bbb.contactId, 'reminder-consent');
    expect(await resolveContactForSubject(T, BUYER)).toBe(aaa.contactId);
    // Unlinked subject resolves to null.
    expect(await resolveContactForSubject(T, 'user:nobody')).toBeNull();
  });
});

describe('resolveContactForSubject soft-ref safety (ADR 0449 grade-data)', () => {
  it('follows a CRM merge to the survivor and drops a deleted contact (never a dead id)', async () => {
    const { createContact, deleteContact } = await import('../src/features/crm/contactsService.js');
    const { mergeContacts } = await import('../src/features/crm/crmMergeService.js');
    // Merge case: subject linked to the LOSER, then loser merges into survivor.
    const loser = await createContact({ tenantId: T, name: 'Loser', email: 'l@x.test' });
    const survivor = await createContact({ tenantId: T, name: 'Survivor', email: 's@x.test' });
    await linkSubjectToContact(T, 'user:merged', loser.contactId, 'paid-checkout');
    await mergeContacts(T, survivor.contactId, loser.contactId);
    expect(await resolveContactForSubject(T, 'user:merged')).toBe(survivor.contactId); // followed the tombstone

    // Delete case: subject linked to a contact that is then hard-deleted.
    const gone = await createContact({ tenantId: T, name: 'Gone', email: 'g@x.test' });
    await linkSubjectToContact(T, 'user:gone', gone.contactId, 'paid-checkout');
    await deleteContact(gone.contactId);
    expect(await resolveContactForSubject(T, 'user:gone')).toBeNull(); // dangling ⇒ unlinked (fail-closed)
  });

  it('KT-PORT-7b — follows a MULTI-HOP merge chain (A→B→C) to the live survivor', async () => {
    const { createContact } = await import('../src/features/crm/contactsService.js');
    const { mergeContacts } = await import('../src/features/crm/crmMergeService.js');
    const a = await createContact({ tenantId: T, name: 'A', email: 'a@chain.test' });
    const b = await createContact({ tenantId: T, name: 'B', email: 'b@chain.test' });
    const c = await createContact({ tenantId: T, name: 'C', email: 'c@chain.test' });
    await mergeContacts(T, b.contactId, a.contactId); // A → B
    await mergeContacts(T, c.contactId, b.contactId); // B → C   ⇒ chain A→B→C
    await linkSubjectToContact(T, 'user:chain', a.contactId, 'paid-checkout');
    // The old one-hop follow returned B (itself a tombstone) ⇒ null; the canonical
    // resolver chases to the live survivor C.
    expect(await resolveContactForSubject(T, 'user:chain')).toBe(c.contactId);
  });
});

describe('paid-checkout observer (ADR 0449 P2)', () => {
  async function paidChallengeProduct(): Promise<string> {
    const draft = await createDraft({
      tenantId: T, title: 'Paid', summary: 's', outcome: 'o', durationDays: 3,
      activities: [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: '', evidencePolicy: 'attestation' }],
    });
    await publishChallenge(T, draft.id, 1);
    const product = await createProduct({ tenantId: T, orgId: ORG, createdBy: BUYER, type: 'digital', name: 'Paid', price: 10 });
    await linkChallengeProduct(T, product.productId, draft.id, 1, 'user:author');
    return product.productId;
  }

  it('links the buyer subject to the order contact for a KickTodo order with a contactId', async () => {
    const productId = await paidChallengeProduct();
    const buyer = await createContact({ tenantId: T, name: 'Buyer', email: 'buyer@x.test' });
    await linkKicktodoBuyerContact(orderOf({ items: [{ productId, name: 'Paid', unitPrice: 10, quantity: 1 }], contactId: buyer.contactId }));
    expect(await resolveContactForSubject(T, BUYER)).toBe(buyer.contactId);
  });

  it('links NOTHING for a KickTodo order without a contactId (D3 floor)', async () => {
    const productId = await paidChallengeProduct();
    await linkKicktodoBuyerContact(orderOf({ items: [{ productId, name: 'Paid', unitPrice: 10, quantity: 1 }] })); // no contactId
    expect(await resolveContactForSubject(T, BUYER)).toBeNull();
  });

  it('links NOTHING for a non-KickTodo order even with a contactId (scope guard)', async () => {
    // prod-x is not linked to any challenge/seat — even with a REAL contact, no link.
    const c2 = await createContact({ tenantId: T, name: 'B2', email: 'b2@x.test' });
    await linkKicktodoBuyerContact(orderOf({ contactId: c2.contactId }));
    expect(await resolveContactForSubject(T, BUYER)).toBeNull();
  });
});
