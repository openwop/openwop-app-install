/**
 * ADR 0456 P2 — the lifecycle emissions are actually WIRED. Pins that, for a
 * subject with a linked CRM Contact (consent), the real paths emit the CDP event:
 *  - enroll() ⇒ kicktodo.participant.enrolled
 *  - submitCheckIn completing the last activity ⇒ kicktodo.participant.completed
 *  - reprocessOrder grant ⇒ kicktodo.challenge.purchased
 * …and that a subject WITHOUT a Contact emits nothing (Gate 0) through the same paths.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import { enroll, __clearEnrollGuards } from '../src/features/kicktodo-core/enrollmentService.js';
import { todayFor, submitCheckIn, __clearCheckInObservers } from '../src/features/kicktodo-core/todayService.js';
import { linkSubjectToContact, __resetContactBridge } from '../src/features/kicktodo-core/contactBridgeService.js';
import { linkChallengeProduct, reprocessOrder } from '../src/features/kicktodo-commerce/entitlementService.js';
import { createProduct, type Order } from '../src/features/commerce/commerceService.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { listCollectedEvents } from '../src/features/cdp/collectService.js';

const T = 'tenant-lw';
const ORG = 'org-lw';
const SUBJECT = 'user:participant-lw';

const types = async (): Promise<string[]> => (await listCollectedEvents(T)).map((e) => e.eventType);

async function oneActivityChallenge(): Promise<string> {
  const draft = await createDraft({
    tenantId: T, title: 'C', summary: 's', outcome: 'o', durationDays: 1,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'A', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  return draft.id;
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  __clearEnrollGuards();
  __clearCheckInObservers();
  await __resetContactBridge();
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
});

const orderOf = (productId: string): Order => ({
  orderId: 'ord-lw', tenantId: T, orgId: ORG,
  items: [{ productId, name: 'C', unitPrice: 10, quantity: 1 }],
  subtotal: 10, discount: 0, total: 10, currency: 'usd',
  status: 'paid', fulfillmentStatus: 'pending',
  createdBy: SUBJECT, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

describe('lifecycle emissions are wired (ADR 0456 P2)', () => {
  it('enroll + complete emit for a consented subject; nothing for an unlinked one', async () => {
    const challengeId = await oneActivityChallenge();

    // Unlinked subject → enroll emits nothing (Gate 0).
    await enroll({ tenantId: T, ownerSubject: 'user:anon-lw', challengeId, challengeVersion: 1, timezone: 'UTC' });
    expect(await types()).not.toContain('kicktodo.participant.enrolled');

    // Linked subject → enroll emits 'enrolled'.
    const contact = await createContact({ tenantId: T, name: 'Pat', email: 'pat@x.test' });
    await linkSubjectToContact(T, SUBJECT, contact.contactId, 'paid-checkout');
    await enroll({ tenantId: T, ownerSubject: SUBJECT, challengeId, challengeVersion: 1, timezone: 'UTC' });
    expect(await types()).toContain('kicktodo.participant.enrolled');

    // Completing the only activity emits 'completed'.
    const view = await todayFor(T, SUBJECT);
    const cardId = view.enrollments.flatMap((e) => e.actions).map((a) => a.card?.id).find(Boolean);
    expect(cardId).toBeTruthy();
    await submitCheckIn(T, SUBJECT, cardId!, {});
    expect(await types()).toContain('kicktodo.participant.completed');
  });

  it('a paid KickTodo order emits purchased for a consented buyer', async () => {
    const challengeId = await oneActivityChallenge();
    const product = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'user:pub', type: 'digital', name: 'C', price: 10 });
    await linkChallengeProduct(T, product.productId, challengeId, 1, 'user:pub');
    const contact = await createContact({ tenantId: T, name: 'Buyer', email: 'buyer@x.test' });
    await linkSubjectToContact(T, SUBJECT, contact.contactId, 'paid-checkout');

    await reprocessOrder(orderOf(product.productId), 'grant');
    expect(await types()).toContain('kicktodo.challenge.purchased');
  });
});
