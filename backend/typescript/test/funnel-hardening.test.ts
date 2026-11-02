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
 *
 * TST-DEB-2 — red when: the purger ignores the classification; the SCA window
 * stops extending, is allowed to SHORTEN an already-longer deadline, or extends
 * a paid order; `linkSession` stops invalidating the snapshot; or a domain
 * mutation stops bumping the shared version row (instance B then serves the
 * removed host for the full 60 s TTL). D runs TWO module instances of
 * `host/customDomains.ts` over one storage with a faked `Date` — no manual
 * cache invalidation — so the 5 s version window is what it actually exercises.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { purgeRetained } from '../src/host/retentionPurger.js';
import { relayConversion, listConversions, __resetPixels } from '../src/features/campaign-connectors/pixelService.js';
import { createProduct, createOrder, extendReservationForSca, getOrder, markAsPaid, __resetCommerce } from '../src/features/commerce/commerceService.js';
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
    expect(deleted).toBe(1);
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

    // a second call with a SHORTER env window never shortens: both the return
    // value AND the stored row stay on the first (longer) deadline.
    process.env.OPENWOP_COMMERCE_SCA_RESERVATION_MS = String(60_000);
    expect(await extendReservationForSca(t, org, order.orderId)).toBe(extended);
    expect((await getOrder(t, org, order.orderId))!.reservationExpiresAt).toBe(extended);

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
    type Domains = typeof import('../src/host/customDomains.js');
    type Persistence = typeof import('../src/host/hostExtPersistence.js');
    const shared = await openStorage('memory://');
    // Two process-like instances: separate module graphs (separate host caches),
    // ONE storage — what two Cloud Run instances share.
    const instance = async (): Promise<Domains> => {
      vi.resetModules();
      const p: Persistence = await import('../src/host/hostExtPersistence.js');
      p.initHostExtPersistence(shared);
      return import('../src/host/customDomains.js');
    };
    const a = await instance();
    const b = await instance();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-03-02T10:00:00.000Z'));
      const added = await a.addDomain({ tenantId: 'cd-t', orgId: 'cd-org', createdBy: 'u', hostname: 'live.coherence.test' });
      await a.verifyDomain('cd-t', 'cd-org', 'live.coherence.test', async () => [[added.verificationToken]]);
      // B warms ITS cache.
      expect(await b.resolveCustomHost('live.coherence.test')).toEqual({ tenantId: 'cd-t', orgId: 'cd-org' });

      // A removes the domain (bumping the shared version row). Inside the 5 s
      // window B still serves its warm cache — the control that B's cache is
      // independent of A's (a shared cache would read null here).
      await a.removeDomain('cd-t', 'cd-org', 'live.coherence.test');
      expect(await b.resolveCustomHost('live.coherence.test')).toEqual({ tenantId: 'cd-t', orgId: 'cd-org' });

      // Past the 5 s version-check window, well inside the 60 s TTL: B re-reads.
      vi.setSystemTime(new Date('2026-03-02T10:00:05.001Z'));
      expect(await b.resolveCustomHost('live.coherence.test')).toBeNull();
    } finally {
      vi.useRealTimers();
      vi.resetModules();
    }
  }, 60_000);
});
