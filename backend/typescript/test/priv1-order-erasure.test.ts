/**
 * PRIV-1 — commerce is now reachable by GDPR right-to-erasure (`eraseSubject`).
 * An order is a legally-retained financial record (tax law overrides erasure), so the
 * fix ANONYMIZES the shipping snapshot (strip name/street/city/postalCode; keep coarse
 * region/country + the totals + id) rather than deleting the order. The subject is
 * matched directly as a contactId (the CRM-contact-erasure case); a subject keyed by a CDP
 * sessionKey now ALSO reaches its orders via the ADR 0381 subject-key resolver (PRIV-2 — the
 * identity graph is expanded UPFRONT, before the analytics eraser consumes the link).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createProduct, createOrder, getOrder } from '../src/features/commerce/commerceService.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { linkSession } from '../src/features/analytics/identityLinkService.js';

const T = 'org:priv1';
const ORG = 'org:priv1';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

async function physicalProduct(): Promise<string> {
  const p = await createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'physical', name: 'Widget', price: 10, currency: 'USD', inventory: 100 });
  return p.productId;
}
const fullAddress = (name: string) => ({ name, line1: '1 Main St', line2: 'Apt 2', city: 'Springfield', region: 'IL', postalCode: '62704', country: 'US' });

describe('PRIV-1 — commerce subject erasure anonymizes order shipping', () => {
  it('erasure (direct contactId) strips the identity but keeps region/country + totals; other contact untouched; idempotent', async () => {
    const productId = await physicalProduct();
    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', contactId: 'contact-jane', shippingAddress: fullAddress('Jane Doe'), lines: [{ productId, quantity: 1 }] });
    const other = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', contactId: 'contact-bob', shippingAddress: fullAddress('Bob Smith'), lines: [{ productId, quantity: 1 }] });

    const res = await eraseSubject(T, 'contact-jane');
    expect(res.failed).toBe(0);

    const erased = await getOrder(T, ORG, order.orderId);
    expect(erased!.shippingAddress!.name).toBeUndefined();       // direct identifier stripped
    expect(erased!.shippingAddress!.line1).toBe('[redacted]');   // required field → redaction marker
    expect(erased!.shippingAddress!.city).toBeUndefined();
    expect(erased!.shippingAddress!.postalCode).toBeUndefined();
    expect(erased!.shippingAddress!.region).toBe('IL');          // coarse geo KEPT (tax/reporting)
    expect(erased!.shippingAddress!.country).toBe('US');
    expect(erased!.total).toBe(order.total);                     // the financial record survives
    expect(erased!.orderId).toBe(order.orderId);

    // a DIFFERENT subject's order is untouched
    expect((await getOrder(T, ORG, other.orderId))!.shippingAddress!.name).toBe('Bob Smith');

    // idempotent: re-erasing finds the fields already redacted (no error, no change)
    expect((await eraseSubject(T, 'contact-jane')).failed).toBe(0);
    expect((await getOrder(T, ORG, order.orderId))!.shippingAddress!.line1).toBe('[redacted]');
  });

  // PRIV-2 (ADR 0381) — the decisive test the direct-match couldn't pass: an erasure keyed by
  // a CDP sessionKey reaches the same person's contactId-keyed order, because eraseSubject
  // expands the identity graph UPFRONT (resolver runs before the analytics link-eraser deletes it).
  it('a sessionKey-keyed erasure reaches the linked contact\'s order (identity-graph expansion)', async () => {
    const productId = await physicalProduct();
    await linkSession(T, 'sess-xyz', 'contact-linked', 'form-submit'); // sessionKey → contactId
    const order = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', contactId: 'contact-linked', shippingAddress: fullAddress('Linked Lee'), lines: [{ productId, quantity: 1 }] });

    const res = await eraseSubject(T, 'sess-xyz'); // keyed by the SESSION, not the contactId
    expect(res.keysResolved).toBeGreaterThanOrEqual(2); // {sess-xyz, contact-linked}

    const erased = await getOrder(T, ORG, order.orderId);
    expect(erased!.shippingAddress!.name).toBeUndefined();      // resolved to contact-linked, then anonymized
    expect(erased!.shippingAddress!.line1).toBe('[redacted]');
    expect(erased!.total).toBe(order.total);                    // financial record still survives
  });

  // Grade-pass hardening — a CLIENT-supplied sessionKey that collides with the `crm:`-prefixed
  // contactId namespace must NOT expand the erasure to a DIFFERENT subject's order. An attacker
  // planting a link `{sessionKey: "crm:<victim>", contactId: <own>}` then erasing THEIR OWN
  // subject must not anonymize the victim's order.
  it('does NOT over-erase across an identity-namespace collision (planted crm:-prefixed sessionKey)', async () => {
    const productId = await physicalProduct();
    const victimOrder = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', contactId: 'crm:victim', shippingAddress: fullAddress('Victim Vera'), lines: [{ productId, quantity: 1 }] });
    // Attacker plants a link whose sessionKey IS the victim's contactId, pointing at their own contact.
    await linkSession(T, 'crm:victim', 'crm:attacker', 'form-submit');

    await eraseSubject(T, 'crm:attacker'); // erase the ATTACKER's own subject

    // The victim's order is untouched — the `crm:`-prefixed session key was dropped by the namespace guard.
    expect((await getOrder(T, ORG, victimOrder.orderId))!.shippingAddress!.name).toBe('Victim Vera');
  });
});
