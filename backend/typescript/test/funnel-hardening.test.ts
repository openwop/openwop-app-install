/**
 * Funnel-program hardening (the grade-pass follow-ons):
 *  A FM-D1-RET — conversion rows purge on the confidential-pii retention
 *    window by ingest age; other classifications are untouched (fail-closed);
 *  B GC-OC-2 — an SCA-challenged one-click child's stock reservation is
 *    extended so the expiry sweep can't cancel it mid-confirm; never shortens
 *    an already-longer deadline; only pending orders qualify;
 *  D GC-CD-1 — a domain mutation bumps the shared version row and another
 *    "instance" (fresh cache) picks the change up within the 5s version
 *    window instead of the 60s TTL.
 *  (C GC-D3-1 — the links snapshot cache — is covered by the existing D3
 *   lead-score test remaining green plus the write-invalidation assertion here.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { purgeRetained } from '../src/host/retentionPurger.js';
import { relayConversion, listConversions, __resetPixels } from '../src/features/campaign-connectors/pixelService.js';
import { createProduct, createOrder, extendReservationForSca, getOrder, markAsPaid, __resetCommerce } from '../src/features/commerce/commerceService.js';
import { addDomain, verifyDomain, resolveCustomHost, invalidateHostCache, removeDomain, __resetCustomDomains } from '../src/host/customDomains.js';
import { linkSession, sessionsForContact, __resetIdentityLinks } from '../src/features/analytics/identityLinkService.js';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});
afterAll(async () => {
  delete process.env.OPENWOP_COMMERCE_SCA_RESERVATION_MS;
});

describe('A — FM-D1-RET conversion retention', () => {
  it('purges old conversion rows on the confidential-pii window only', async () => {
    await __resetPixels();
    const t = 'ret-t';
    await relayConversion(t, 'org', { eventId: 'old-1', eventName: 'purchase', email: 'a@x.test' });
    expect((await listConversions(t, 'org')).length).toBe(1);

    const future = new Date(Date.now() + 60_000).toISOString(); // cutoff after the row's `at`
    // wrong classification ⇒ untouched (fail-closed)
    await purgeRetained(t, 'internal', future);
    expect((await listConversions(t, 'org')).length).toBe(1);
    // the pii window purges it
    const results = await purgeRetained(t, 'confidential-pii', future);
    const deleted = results.reduce((sum, r) => sum + r.deleted, 0);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect((await listConversions(t, 'org')).length).toBe(0);
  });
});

describe('B — GC-OC-2 SCA reservation extension', () => {
  it('extends a pending order’s reservation, never shortens, and skips paid orders', async () => {
    await __resetCommerce();
    process.env.OPENWOP_COMMERCE_SCA_RESERVATION_MS = String(72 * 60 * 60 * 1000); // 72h — beyond any reservation TTL
    const t = 'sca-t'; const org = 'sca-org';
    const prod = await createProduct({ tenantId: t, orgId: org, createdBy: 'u', type: 'physical', name: 'Box', price: 10, currency: 'USD', inventory: 5 });
    const order = await createOrder({ tenantId: t, orgId: org, createdBy: 'u', lines: [{ productId: prod.productId, quantity: 1 }] });
    const before = order.reservationExpiresAt!;
    const extended = await extendReservationForSca(t, org, order.orderId);
    expect(extended).not.toBeNull();
    expect(extended! > before).toBe(true); // pushed past the default TTL

    // a second call with a SHORTER env window never shortens
    process.env.OPENWOP_COMMERCE_SCA_RESERVATION_MS = String(60_000);
    expect(await extendReservationForSca(t, org, order.orderId)).toBe((await getOrder(t, org, order.orderId))!.reservationExpiresAt);

    // paid orders don't qualify
    await markAsPaid(t, org, order.orderId, 'pi_x', { actor: 'test' });
    expect(await extendReservationForSca(t, org, order.orderId)).toBeNull();
  });
});

describe('C — GC-D3-1 links snapshot invalidation', () => {
  it('a new link is visible immediately after the write (snapshot invalidated)', async () => {
    await __resetIdentityLinks();
    const t = 'snap-t';
    await linkSession(t, 's-1', 'contact-1', 'form-submit');
    expect(await sessionsForContact(t, 'contact-1')).toEqual(['s-1']); // warms the snapshot
    await linkSession(t, 's-2', 'contact-1', 'form-submit');           // must invalidate
    expect((await sessionsForContact(t, 'contact-1')).sort()).toEqual(['s-1', 's-2']);
  });
});

describe('D — GC-CD-1 cross-instance host-cache coherence', () => {
  it('another instance sees a removed domain via the version row inside the 5s window', async () => {
    await __resetCustomDomains();
    const added = await addDomain({ tenantId: 'cd-t', orgId: 'cd-org', createdBy: 'u', hostname: 'live.coherence.test' });
    await verifyDomain('cd-t', 'cd-org', 'live.coherence.test', async () => [[added.verificationToken]]);
    expect(await resolveCustomHost('live.coherence.test')).toEqual({ tenantId: 'cd-t', orgId: 'cd-org' });

    // simulate instance B: fresh local cache, then instance A removes the domain
    invalidateHostCache();
    expect(await resolveCustomHost('live.coherence.test')).not.toBeNull(); // B has its own warm cache now
    await removeDomain('cd-t', 'cd-org', 'live.coherence.test');           // A mutates + bumps the version
    invalidateHostCache();                                                  // B's next window re-checks
    expect(await resolveCustomHost('live.coherence.test')).toBeNull();
  });
});
