/**
 * ADR 1025 D4/D6/D7 — promotion intake and evaluation (row 74, MCHWF-4/6/7).
 *
 *  - D4  currency: PATCH reads it (it was forwarded and ignored); a denominated promotion
 *        is refused without one; a legacy currency-less denominated row applies to NO order
 *        and is flagged `needsCurrency`; pausing such a row is always allowed.
 *  - D6  schedule bounds must parse and form a window; a stored unparseable bound fails closed.
 *  - D7  per-type rules: cart_threshold needs minSpend > 0; per-unit types need a scope; a
 *        fixed reward must be > 0.
 *
 * Each probe in the row-74 grade (`workflows-assessment/2026-11-02-…row74.md`) is a case
 * here, run against the same service the route, the chat tool and the run surface call.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../../../host/hostExtPersistence.js';
import { openStorage } from '../../../storage/index.js';
import {
  createPromotion, updatePromotion, getPromotion, applyPromotionsUngated, previewPromotions, needsCurrency, __resetPromotions, type Promotion,
} from '../promotionsService.js';
import { buildPromotionsSurface } from '../surface.js';

const T = 'default';
const ORG = 'org-adr1025';
/** The same store the service writes, to plant a row the intake would now refuse (a
 *  pre-ADR-1025 row, like the two in prod). */
const raw = new DurableCollection<Promotion>('promotions:promo', (p) => p.promotionId, undefined, (p) => p.tenantId);
const legacy = async (over: Partial<Promotion>): Promise<Promotion> => {
  const now = new Date().toISOString();
  const p: Promotion = {
    promotionId: `promo:legacy-${Math.random().toString(36).slice(2)}`, tenantId: T, orgId: ORG, name: 'Legacy',
    type: 'cart_threshold', reward: { kind: 'fixed', value: 10 }, minSpend: 50,
    priority: 0, stackable: true, active: true, createdBy: 'demo:merch', createdAt: now, updatedAt: now, ...over,
  };
  await raw.put(p);
  return p;
};
const cart = (currency: string, amount: number) => ({ tenantId: T, orgId: ORG, currency, subtotalAfterCoupon: amount, items: [{ productId: 'p1', unitPrice: amount, quantity: 1 }] });

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
beforeEach(async () => { await __resetPromotions(); });

describe('ADR 1025 D4 — currency on every lane', () => {
  it('refuses a denominated promotion with no currency (fixed reward, minSpend, loss budget)', async () => {
    const base = { tenantId: T, orgId: ORG, createdBy: 'u' };
    await expect(createPromotion({ ...base, name: 'A', type: 'cart_threshold', reward: { kind: 'percentage', value: 10 }, minSpend: 50 }))
      .rejects.toMatchObject({ details: { field: 'currency', code: 'promotion_currency_missing' } });
    await expect(createPromotion({ ...base, name: 'B', type: 'product_discount', reward: { kind: 'fixed', value: 5 }, scope: { all: true } }))
      .rejects.toMatchObject({ details: { field: 'currency' } });
    await expect(createPromotion({ ...base, name: 'C', type: 'loss_leader', reward: { kind: 'percentage', value: 40 }, scope: { all: true }, budget: { maxDiscount: 100 } }))
      .rejects.toMatchObject({ details: { field: 'currency' } });
    // A pure percentage stays currency-free (positive control).
    await expect(createPromotion({ ...base, name: 'D', type: 'product_discount', reward: { kind: 'percentage', value: 10 }, scope: { all: true } })).resolves.toBeTruthy();
  });

  it('a legacy currency-less denominated row applies to NO order, in any currency, and is flagged', async () => {
    const p = await legacy({});
    expect(needsCurrency(p)).toBe(true);
    // The probe: this took 10 off a ¥3,000 order. And it no longer fires in USD either.
    expect((await applyPromotionsUngated(cart('JPY', 3000))).discount).toBe(0);
    expect((await applyPromotionsUngated(cart('USD', 60))).discount).toBe(0);
  });

  it('PATCH sets the currency (it was forwarded and ignored), and the row then fires in that currency only', async () => {
    const p = await legacy({});
    const fixed = await updatePromotion(T, ORG, p.promotionId, { currency: 'usd' });
    expect(fixed?.currency).toBe('USD');
    expect((await getPromotion(T, ORG, p.promotionId))?.currency).toBe('USD');
    expect((await applyPromotionsUngated(cart('USD', 60))).discount).toBe(10);
    expect((await applyPromotionsUngated(cart('JPY', 3000))).discount).toBe(0);
  });

  it('pausing a legacy row is always allowed; re-activating it without a currency is refused', async () => {
    const p = await legacy({});
    await expect(updatePromotion(T, ORG, p.promotionId, { active: false })).resolves.toMatchObject({ active: false });
    await expect(updatePromotion(T, ORG, p.promotionId, { active: true })).rejects.toMatchObject({ details: { field: 'currency' } });
    // …and clearing the currency off a denominated promotion is refused too.
    const ok = await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'E', type: 'cart_threshold', reward: { kind: 'fixed', value: 5 }, minSpend: 20, currency: 'EUR' });
    await expect(updatePromotion(T, ORG, ok.promotionId, { currency: '' })).rejects.toMatchObject({ details: { field: 'currency' } });
  });
});

describe('ADR 1025 D4 — the run surface and the preview lane say why a promotion is not applying', () => {
  it('listActive flags needsCurrency; preview names it in notApplying', async () => {
    const p = await legacy({});
    const surface = buildPromotionsSurface({ tenantId: T });
    const listed = (await surface.listActive!({ orgId: ORG })).promotions as { promotionId: string; needsCurrency?: true }[];
    expect(listed.find((x) => x.promotionId === p.promotionId)?.needsCurrency).toBe(true);
    const preview = await surface.applyPreview!({ orgId: ORG, currency: 'USD', items: [{ productId: 'p1', unitPrice: 60, quantity: 1 }] });
    expect(preview.discount).toBe(0);
    expect(preview.notApplying).toEqual([{ promotionId: p.promotionId, reason: 'needs_currency' }]);
  });

  it('preview normalises the currency (a lowercase code used to match nothing, silently)', async () => {
    await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'F', type: 'cart_threshold', reward: { kind: 'fixed', value: 10 }, minSpend: 50, currency: 'USD' });
    expect((await previewPromotions({ tenantId: T, orgId: ORG, currency: 'usd', items: [{ productId: 'p1', unitPrice: 60, quantity: 1 }] })).discount).toBe(10);
    await expect(previewPromotions({ tenantId: T, orgId: ORG, currency: 'dollars', items: [] })).rejects.toMatchObject({ details: { field: 'currency' } });
  });
});

describe('ADR 1025 — review hardening (grade MCHCD-2/6, MCHUX-1)', () => {
  it('`active` must be a real boolean: a junk value can no longer switch on an unfireable row unchecked', async () => {
    const p = await legacy({ active: false });
    await expect(updatePromotion(T, ORG, p.promotionId, { active: 'true' })).rejects.toMatchObject({ details: { field: 'active' } });
    expect((await getPromotion(T, ORG, p.promotionId))?.active).toBe(false);
  });
  it('an unknown reward kind is refused (it used to become a percentage)', async () => {
    await expect(createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'K', type: 'product_discount', reward: { kind: 'amount', value: 10 }, scope: { all: true } }))
      .rejects.toMatchObject({ details: { field: 'reward.kind' } });
  });
  it('an agent draft is marked proposed until a person activates it', async () => {
    const draft = await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'agent', name: 'Draft', type: 'product_discount', reward: { kind: 'percentage', value: 5 }, scope: { all: true }, active: false, proposed: true });
    expect(draft.proposed).toBe(true);
    const live = await updatePromotion(T, ORG, draft.promotionId, { active: true });
    expect(live?.proposed).toBeUndefined();
    // A person's own paused promotion is never "proposed".
    const own = await createPromotion({ tenantId: T, orgId: ORG, createdBy: 'u', name: 'Mine', type: 'product_discount', reward: { kind: 'percentage', value: 5 }, scope: { all: true }, active: false });
    expect(own.proposed).toBeUndefined();
  });
});

describe('ADR 1025 D6 — schedules', () => {
  it('refuses an unparseable bound and an empty window at intake', async () => {
    const base = { tenantId: T, orgId: ORG, createdBy: 'u', name: 'S', type: 'product_discount', reward: { kind: 'percentage', value: 10 }, scope: { all: true } };
    await expect(createPromotion({ ...base, schedule: { endAt: 'last friday' } })).rejects.toMatchObject({ details: { field: 'schedule.endAt' } });
    await expect(createPromotion({ ...base, schedule: { startAt: '2026-12-02T00:00:00Z', endAt: '2026-12-01T00:00:00Z' } })).rejects.toMatchObject({ details: { field: 'schedule.endAt' } });
    const ok = await createPromotion({ ...base, schedule: { startAt: '2026-01-01T00:00:00Z', endAt: '2099-01-01T00:00:00Z' } });
    expect(ok.schedule?.endAt).toBe('2099-01-01T00:00:00.000Z');
  });

  it('a STORED unparseable bound fails closed (it used to read as an open window)', async () => {
    await legacy({ type: 'product_discount', reward: { kind: 'percentage', value: 10 }, minSpend: undefined, scope: { all: true }, schedule: { endAt: 'last friday' } });
    expect((await applyPromotionsUngated(cart('USD', 100))).discount).toBe(0);
    // Control: the same row with a real future bound fires.
    await __resetPromotions();
    await legacy({ type: 'product_discount', reward: { kind: 'percentage', value: 10 }, minSpend: undefined, scope: { all: true }, schedule: { endAt: '2099-01-01T00:00:00Z' } });
    expect((await applyPromotionsUngated(cart('USD', 100))).discount).toBe(10);
  });
});

describe('ADR 1025 D7 — a promotion that could never fire is refused', () => {
  const base = { tenantId: T, orgId: ORG, createdBy: 'u', currency: 'USD' };
  it('cart_threshold without minSpend', async () => {
    await expect(createPromotion({ ...base, name: 'C', type: 'cart_threshold', reward: { kind: 'percentage', value: 10 } })).rejects.toMatchObject({ details: { field: 'minSpend' } });
  });
  it('a per-unit type with no scope', async () => {
    for (const type of ['product_discount', 'loss_leader', 'bogo']) {
      await expect(createPromotion({ ...base, name: 'P', type, reward: { kind: 'percentage', value: 10 }, budget: { maxDiscount: 10 }, bogo: { buy: 1, get: 1 } }), type)
        .rejects.toMatchObject({ details: { field: 'scope' } });
    }
  });
  it('a fixed reward of 0', async () => {
    await expect(createPromotion({ ...base, name: 'Z', type: 'cart_threshold', reward: { kind: 'fixed', value: 0 }, minSpend: 10 })).rejects.toMatchObject({ details: { field: 'reward.value' } });
  });
});
