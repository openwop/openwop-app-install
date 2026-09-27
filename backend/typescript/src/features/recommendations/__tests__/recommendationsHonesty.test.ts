/**
 * Recommendations ROUND 2 (UX_UPGRADE-recommendations, pass 2) — the seams where the
 * console, the storefront or the agent was told something untrue.
 *
 *  - REC2-B2  a segment-targeted placement is REPORTED, not silently reported as absent
 *  - REC2-B3  a full recompute REMOVES what no longer qualifies
 *  - REC2-M1  a segment that no longer resolves is named, not read as "not a member"
 *  - REC2-M2  a holdout with no session identity says it is not being enforced
 *  - REC2-M3  unpaid and refunded orders do not shape recommendations
 *  - REC2-M7  an agent-authored holdout is a DRAFT, per ADR 0273
 *  - REC2-M8  an unknown slot is refused, not coerced to `home`
 *  - REC2-M9  `upsertPlacement` upserts instead of minting duplicates
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { initHostExtPersistence } from '../../../host/hostExtPersistence.js';
import { openStorage } from '../../../storage/index.js';
import { createProduct, createOrder, markAsPaid, __resetCommerce, type Product } from '../../commerce/commerceService.js';
import {
  createPlacement, listPlacements, rebuildAffinity, resolveRecommendations, __resetRecommendations,
} from '../recommendationsService.js';
import { buildRecommendationsSurface } from '../surface.js';
import * as segments from '../../crm/segmentsService.js';
import { createContact } from '../../crm/contactsService.js';

// REC-FLAKE-1 (second pass) — `'default'` is the tenant literal a dozen other test
// files in this worker also write to, and `listForTenantIndexed` reads a SECONDARY
// index whose markers are documented as "delayed, not lost". A file-unique tenant
// removes both the shared-slice pollution and any chance that another file's rows or
// index sentinel decide what this one sees.
const T = 'tenant-reco-r2';
const ORG = 'org-reco-r2';

const mk = (name: string, price: number): Promise<Product> =>
  createProduct({ tenantId: T, orgId: ORG, createdBy: 'u', type: 'digital', name, price, currency: 'USD', categories: ['photo'] });

/** A SETTLED order — the only kind that should shape recommendations. */
async function paidOrder(ps: Product[]): Promise<void> {
  const o = await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: ps.map((p) => ({ productId: p.productId, quantity: 1 })) });
  await markAsPaid(T, ORG, o.orderId, `demo:pi_${o.orderId}`, {});
}
/** An UNPAID cart — created and never settled. */
async function pendingOrder(ps: Product[]): Promise<void> {
  await createOrder({ tenantId: T, orgId: ORG, createdBy: 'u', lines: ps.map((p) => ({ productId: p.productId, quantity: 1 })) });
}

const surface = (): ReturnType<typeof buildRecommendationsSurface> =>
  buildRecommendationsSurface({ tenantId: T } as Parameters<typeof buildRecommendationsSurface>[0]);

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
beforeEach(async () => { await __resetCommerce(); await __resetRecommendations(); vi.restoreAllMocks(); });

describe('REC2-M3 — only settled revenue shapes recommendations', () => {
  it('an unpaid cart does not become the store\'s trending product', async () => {
    const a = await mk('Camera', 100);
    const b = await mk('Lens', 50);
    await paidOrder([a]);            // one real sale of a
    for (let i = 0; i < 20; i++) await pendingOrder([b]); // 20 abandoned carts of b

    await rebuildAffinity(T, ORG);
    await createPlacement({ tenantId: T, orgId: ORG, createdBy: 'u', slot: 'home', source: 'trending' });
    const r = await resolveRecommendations({ tenantId: T, orgId: ORG, slot: 'home' });

    // Before: 20 unpaid carts made `b` the #1 trending product before a cent settled.
    expect(r.products[0]?.productId).toBe(a.productId);
  });
});

describe('REC2-B3 — a full recompute removes what no longer qualifies', () => {
  it('a product with no settled orders left loses its stale affinity row', async () => {
    const a = await mk('Camera', 100);
    const b = await mk('Lens', 50);
    await paidOrder([a, b]);
    const first = await rebuildAffinity(T, ORG);
    expect(first.written).toBeGreaterThan(0);

    // Every order goes away (canceled, or purged by retention). A put-only rebuild left
    // the rows in place, so the store kept promoting them as Trending forever — while
    // the toast said "0 products", which reads as "nothing to do".
    await __resetCommerce();
    await mk('Camera', 100); // catalog still exists; the ORDERS do not
    const second = await rebuildAffinity(T, ORG);
    expect(second.written).toBe(0);
    expect(second.removed).toBeGreaterThan(0);
  });
});

describe('REC2-B2 / M2 — the resolver says WHY nothing matched', () => {
  it('reports a segment-targeted placement instead of looking unconfigured', async () => {
    await createPlacement({ tenantId: T, orgId: ORG, createdBy: 'u', slot: 'pdp', source: 'trending', segmentId: 'seg-vip' });
    const r = await resolveRecommendations({ tenantId: T, orgId: ORG, slot: 'pdp' }); // anonymous
    expect(r.placementId).toBeUndefined();
    // …and the caller can tell this apart from "you never configured this slot", which
    // is what the console rendered before — telling the operator to add the placement
    // sitting active in the table one card above.
    expect(r.segmentTargetedSkipped).toBe(true);
  });

  it('a slot with NO placement at all reports nothing extra (the negative control)', async () => {
    const r = await resolveRecommendations({ tenantId: T, orgId: ORG, slot: 'pdp' });
    expect(r.segmentTargetedSkipped).toBeUndefined();
  });

  it('a holdout with no session identity is declared inert', async () => {
    const a = await mk('Camera', 100);
    await paidOrder([a]);
    await rebuildAffinity(T, ORG);
    await createPlacement({ tenantId: T, orgId: ORG, createdBy: 'u', slot: 'home', source: 'trending', holdoutPct: 20 });

    const r = await resolveRecommendations({ tenantId: T, orgId: ORG, slot: 'home' }); // no sessionKey
    expect(r.holdoutInert).toBe(true);   // the table says 20%; nothing is being held back
    expect(r.products.length).toBeGreaterThan(0);
  });

  it('…and is NOT declared inert once a session identity is supplied', async () => {
    const a = await mk('Camera', 100);
    await paidOrder([a]);
    await rebuildAffinity(T, ORG);
    await createPlacement({ tenantId: T, orgId: ORG, createdBy: 'u', slot: 'home', source: 'trending', holdoutPct: 20 });

    const r = await resolveRecommendations({ tenantId: T, orgId: ORG, slot: 'home', sessionKey: 'sess-1' });
    expect(r.holdoutInert).toBeUndefined();
  });
});

describe('review fold-ins — defects the independent pass found in the fix', () => {
  it('MJ-4/M1: an unresolvable segment is NAMED, on the matched path too', async () => {
    // My docblock claimed M1 was covered and nothing tested it: reverting the try/catch
    // to `.catch(() => [])` left all 13 green. And the reason reached only the EMPTY
    // return, while M1's own scenario is a shopper falling through to the GENERIC
    // placement — a matched result.
    const a = await mk('Camera', 100);
    await paidOrder([a]);
    await rebuildAffinity(T, ORG);
    // A DELETED segment throws `not_found` from the CRM (an empty list would be a real
    // "no members", which is a different answer) — that throw is what `.catch(() => [])`
    // used to swallow.
    //
    // REC-FLAKE-1 — this used to install `vi.spyOn(segments, 'resolveSegmentMembers')`
    // and went red twice in full-suite runs (2026-08-11, once at load ~50 and once at
    // load ~3, so not starvation) while passing 13/13 standalone: `unresolvedSegmentIds`
    // came back undefined, i.e. the spy had not rejected, i.e. it was not bound to the
    // instance the service calls. Ordering and the merge were ruled out — the surviving
    // difference between the two runs is worker-process state a spy depends on and this
    // assertion does not need. `seg-deleted` genuinely does not exist, so the REAL CRM
    // throws `not_found` here; the test now drives the mechanism it is about.
    const ORG_M1 = `${ORG}-m1`;                       // its own org: no leftover can pre-empt it
    // The GENERIC placement is authored FIRST, deliberately. That is the adverse order,
    // and it is what a merchandiser actually does — set up the fallback, then add
    // targeting. It is also the order under which this assertion can FAIL, which the
    // previous arrangement could not: with the targeted placement created first, the
    // case passed whether or not the resolver preferred targeting.
    await createPlacement({ tenantId: T, orgId: ORG_M1, createdBy: 'u', slot: 'home', source: 'trending' }); // the generic fallback
    await createPlacement({ tenantId: T, orgId: ORG_M1, createdBy: 'u', slot: 'home', source: 'trending', segmentId: 'seg-deleted' });

    // The ROOT CAUSE this flake was hiding (reproduced 2026-08-11): the resolver takes
    // the first matching placement, so a generic one authored earlier shadowed every
    // targeted one — no targeting applied, nothing said. Which came "first" was decided
    // by a millisecond `createdAt` tie-break over a tenant-index scan ordered by random
    // UUID, so the same two rows behaved differently on two machines. Ordering is now
    // total, and targeted placements are evaluated before the fallback.
    // NOT an order assertion: `createdAt` is a millisecond stamp, so two placements
    // authored back-to-back routinely TIE, and the tie-break is the random `placementId`.
    // Authored order is therefore not recoverable — my first version of this line
    // asserted it and went red on the machine where the two rows shared a millisecond.
    // That is precisely why the fix is to make the OUTCOME independent of the order
    // (targeted before fallback) rather than to pin the order itself.
    expect((await listPlacements(T, ORG_M1)).map((p) => p.segmentId ?? '(generic)').sort())
      .toEqual(['(generic)', 'seg-deleted']);

    const r = await resolveRecommendations({ tenantId: T, orgId: ORG_M1, slot: 'home', contactId: 'c-1' });
    expect(r.placementId).toBeTruthy();                       // it DID fall through
    expect(r.unresolvedSegmentIds).toContain('seg-deleted');   // …and says why
  });

  it('a GENERIC placement authored first does not shadow the targeted one', async () => {
    // The same defect from the merchandiser's side: set up a fallback, then add
    // targeting, and the targeting never fires — the fallback wins every time and the
    // console reports a perfectly healthy placement.
    const ORG_S = `${ORG}-shadow`;
    await segments.createSegment({ tenantId: T, name: 'VIP', filters: [], createdBy: 'u', segmentId: 'seg:vip' });
    await createContact({ tenantId: T, name: 'VIP Shopper' });
    const generic = await createPlacement({ tenantId: T, orgId: ORG_S, createdBy: 'u', slot: 'home', source: 'trending' });
    const targeted = await createPlacement({ tenantId: T, orgId: ORG_S, createdBy: 'u', slot: 'home', source: 'upsell', segmentId: 'seg:vip' });
    const members = await segments.resolveSegmentMembers(T, 'seg:vip');
    const r = await resolveRecommendations({ tenantId: T, orgId: ORG_S, slot: 'home', contactId: members[0]!.contactId });
    expect(r.placementId).toBe(targeted.placementId);
    expect(r.placementId).not.toBe(generic.placementId);
  });

  it('MJ-1: a contact who is not a member gets its OWN reason, not "unconfigured"', async () => {
    // The segment must RESOLVE (otherwise this is the M1 unresolved case) and simply not
    // contain the contact — the likely outcome of the new "preview as contact" field.
    // REC-FLAKE-1 — de-spied for the same reason as the case above: a real segment with a
    // real member proves the distinction the spy only asserted.
    await segments.createSegment({ tenantId: T, name: 'Real', filters: [], createdBy: 'u', segmentId: 'seg:real' });
    await createContact({ tenantId: T, name: 'Someone Else' });
    await createPlacement({ tenantId: T, orgId: ORG, createdBy: 'u', slot: 'pdp', source: 'trending', segmentId: 'seg:real' });
    const r = await resolveRecommendations({ tenantId: T, orgId: ORG, slot: 'pdp', contactId: 'not-a-member' });
    expect(r.segmentNotMatched).toBe(true);
    expect(r.segmentTargetedSkipped).toBeUndefined(); // a contact WAS supplied
  });

  it('BL-2: the workflow lane never adopts (or re-drafts) a human\'s placement', async () => {
    const human = await createPlacement({ tenantId: T, orgId: ORG, createdBy: 'merchandiser@example.com', slot: 'checkout', source: 'upsell' });
    await surface().upsertPlacement!({ orgId: ORG, slot: 'checkout', source: 'upsell', holdoutPct: 20 });

    const rows = await listPlacements(T, ORG);
    const theirs = rows.find((p) => p.placementId === human.placementId)!;
    expect(theirs.holdoutPct).toBeUndefined();  // untouched — no holdout raised on it
    expect(theirs.active).toBe(true);
    expect(rows).toHaveLength(2);               // the agent got its OWN row
  });

  it('BL-2/M7: an agent holdout lands INACTIVE from the workflow lane too', async () => {
    await surface().upsertPlacement!({ orgId: ORG, slot: 'cart', source: 'cross_sell', holdoutPct: 20 });
    const [row] = await listPlacements(T, ORG);
    expect(row!.active).toBe(false); // a human activates it (ADR 0273)
  });

  it('BL-1: create and update return the SAME shape (the node records it verbatim)', async () => {
    const created = await surface().upsertPlacement!({ orgId: ORG, slot: 'pdp', source: 'similar' }) as { placement: Record<string, unknown> };
    const updated = await surface().upsertPlacement!({ orgId: ORG, slot: 'pdp', source: 'similar' }) as { placement: Record<string, unknown> };
    expect(Object.keys(created.placement).sort()).toEqual(Object.keys(updated.placement).sort());
    expect(created.placement.placementId).toBe(updated.placement.placementId);
  });
});

describe('REC2-M8 / M9 — the workflow lane', () => {

  it('an unknown slot is REFUSED, not silently swapped for `home`', async () => {
    // Coercion meant a chain configured `slot: "PDP"` succeeded and inserted the HOME
    // slot's products into a post-purchase email — recorded, and replayed forever.
    await expect(surface().resolve!({ orgId: ORG, slot: 'PDP' })).rejects.toThrow(/Unknown recommendation slot/i);
  });

  it('upsertPlacement UPSERTS — a daily chain does not mint a duplicate every run', async () => {
    await surface().upsertPlacement!({ orgId: ORG, slot: 'pdp', source: 'similar' });
    await surface().upsertPlacement!({ orgId: ORG, slot: 'pdp', source: 'similar' });
    await surface().upsertPlacement!({ orgId: ORG, slot: 'pdp', source: 'similar' });

    // The resolver takes the FIRST by createdAt, so duplicates also meant editing the
    // newest row (the one an operator reaches for) changed nothing on the storefront.
    expect(await listPlacements(T, ORG)).toHaveLength(1);
  });
});
