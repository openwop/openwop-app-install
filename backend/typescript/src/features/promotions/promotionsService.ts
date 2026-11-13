/**
 * Promotions service (ADR 0274 / MERCH-B) — a rule-based incentives engine that
 * COMPOSES the commerce order path via the `promotionSeam` hook (commerce never
 * imports promotions — ruling 1). A promotion computes a discount DELTA against the
 * already-resolved (resolvePrice + coupon) price — never a second pricing path
 * (ruling 2). Fired promotions are snapshot onto the Order for replay/refund
 * attribution (ruling 7).
 *
 * Loss-leader budget is DERIVED from actual order usage (sum of this promotion's
 * `appliedPromotions.amount` across non-canceled orders) — no second counter, so an
 * abandoned/canceled cart never leaks budget (self-correcting; ADR 0211 doctrine).
 * `budget.maxQuantity` (a discounted-UNIT cap) is enforced the SAME derived way,
 * summing `appliedPromotions.quantity` — leak-free, no counter.
 *
 * Coupons are deliberately NOT subsumed here: they remain the commerce `code`
 * primitive (pricing.ts "coupons stay coupons"), applied by createOrder before this
 * hook. Promotions stack ON TOP of the coupon-net subtotal — so there is exactly one
 * application of each, no double-apply (ADR 0274 /architect finding #2, resolved by
 * non-overlap rather than migration).
 *
 * Rule types: cart_threshold, product_discount, loss_leader, tiered (buy-more-save-more
 * by quantity), bogo (buy N => cheapest M at the reward). budget.maxQuantity caps the
 * cumulative discounted-UNIT count for the per-unit reward types (bogo /
 * product_discount / loss_leader); it is N/A to the cart-level types (cart_threshold /
 * tiered, whose reward is not per-unit).
 *
 * @see docs/adr/0274-merch-b-promotions-loss-leaders.md
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString } from '../../host/boundedStrings.js';
import { subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import { getProducts, listOrders, quantizeMoney, CURRENCIES, ORDER_IDEM_STALE_MS, type Order, type Product } from '../commerce/commerceService.js';
import type { OrderDiscountContext, OrderDiscountResult, AppliedPromotion } from '../commerce/promotionSeam.js';
import { resolveSegmentMembers } from '../crm/segmentsService.js';
import { resolveToggle } from '../../host/featureToggles/service.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('promotions');

const nowIso = (): string => new Date().toISOString();
const round2 = (n: number): number => Math.round(n * 100) / 100;
const MAX = { name: 200, perOrg: 500 } as const;

export const PROMOTION_TYPES = ['cart_threshold', 'product_discount', 'loss_leader', 'tiered', 'bogo'] as const;
export type PromotionType = (typeof PROMOTION_TYPES)[number];
export const REWARD_KINDS = ['percentage', 'fixed'] as const;
export type RewardKind = (typeof REWARD_KINDS)[number];

export interface Promotion {
  promotionId: string; tenantId: string; orgId: string; name: string;
  type: PromotionType;
  reward: { kind: RewardKind; value: number };
  /** Product-scoped types: which products the reward applies to. */
  scope?: { productIds?: string[]; categories?: string[]; all?: boolean };
  /** cart_threshold: the minimum goods subtotal (major units) to trigger the reward. */
  minSpend?: number;
  /** tiered: the minimum total scoped QUANTITY to trigger the reward (buy-more-save-more). */
  minQuantity?: number;
  /** bogo: buy N scoped ⇒ the cheapest M units of each (buy+get) group get the reward
   *  (reward.kind:'percentage' value:100 = the classic "get one free"). */
  bogo?: { buy: number; get: number };
  /** loss_leader guard (major units) — the maximum cumulative discount this promotion may
   *  ever give (derived from order usage). Absent on non-budgeted promotions. */
  budget?: { maxDiscount?: number; maxQuantity?: number };
  /** R2 PRO2-P1 — the currency this promotion's AMOUNTS are in (`minSpend`, a `fixed`
   *  reward, `budget.maxDiscount`). Absent on a pure percentage, and on pre-R2 rows —
   *  those stay first-come, exactly as `couponDiscount` handles a currency-less coupon.
   *
   *  CORRECTED 2026-11-02 (ADR 1025 D4) — "stay first-come" was the hole, not a policy:
   *  a currency-less "10 off" took 10 off a ¥3,000 order (probed). A denominated
   *  promotion with no currency now applies to NO order (`needsCurrency`), and every
   *  lane refuses to create one. The two such rows in prod are the Solstice demo seed's;
   *  they stop applying until an operator sets a currency. No migration (a guessed
   *  currency is a relabel). */
  currency?: string;
  /** Live CRM-segment target (resolved at read; ADR 0211). */
  segmentId?: string;
  /** Scheduled sale window. */
  schedule?: { startAt?: string; endAt?: string };
  /** Deterministic resolution: priority DESC → createdAt ASC → id ASC. */
  priority: number;
  /** false ⇒ exclusive: once it fires, no lower-priority promotion also fires. */
  stackable: boolean;
  active: boolean;
  /** ADR 1025 (grade MCHUX-1) — an agent DRAFTED this and no person has activated it
   *  yet. Without it a proposal and a promotion someone paused read identically. Cleared
   *  the first time the promotion is activated. */
  proposed?: true;
  createdBy: string; createdAt: string; updatedAt: string;
}

/**
 * R2 PRO2-P24 — an erased operator's id leaves the promotion rows they authored; the
 * promotion itself stays, because it is the ORG's pricing record, not a person's data
 * (the same disposition commerce's order eraser takes). Named, so a failure in the
 * erasure sweep is attributable.
 */
export async function erasePromotionSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms, raw } = subjectKeyForms(subjectKey);
  const keys = new Set([...forms, raw].map((f) => f.toLowerCase()));
  for (const p of await promotions.listForTenantIndexed(tenantId)) {
    if (p.tenantId !== tenantId || !keys.has(p.createdBy.toLowerCase())) continue;
    await promotions.put({ ...p, createdBy: 'erased', updatedAt: nowIso() });
  }
}

/** R2 PRO2-P1 — validate rather than relabel (the commerce `currencyOf` lesson). */
function currencyOrThrow(raw: string): string {
  const c = raw.trim().toUpperCase();
  if (!(CURRENCIES as readonly string[]).includes(c)) {
    throw new OpenwopError('validation_error', `Unsupported currency '${c}'. Supported: ${CURRENCIES.join(', ')}.`, 400, { field: 'currency', supported: CURRENCIES });
  }
  return c;
}

const promotions = new DurableCollection<Promotion>('promotions:promo', (p) => p.promotionId, undefined, (p) => p.tenantId);

// ── CRUD ──────────────────────────────────────────────────────────────────────
export async function listPromotions(tenantId: string, orgId: string): Promise<Promotion[]> {
  return (await promotions.listForTenantIndexed(tenantId))
    .filter((p) => p.orgId === orgId)
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || a.promotionId.localeCompare(b.promotionId));
}
export async function getPromotion(tenantId: string, orgId: string, promotionId: string): Promise<Promotion | null> {
  const p = await promotions.get(promotionId);
  return p && p.tenantId === tenantId && p.orgId === orgId ? p : null;
}

function coerceType(v: unknown): PromotionType {
  if ((PROMOTION_TYPES as readonly string[]).includes(String(v))) return String(v) as PromotionType;
  throw new OpenwopError('validation_error', `type must be one of: ${PROMOTION_TYPES.join(', ')}`, 400, { field: 'type' });
}
function coerceReward(v: unknown): { kind: RewardKind; value: number } {
  const o = (v ?? {}) as { kind?: unknown; value?: unknown };
  // ADR 1025 (grade MCHCD-6) — an UNKNOWN kind is refused, not read as a percentage:
  // `{kind:'amount', value:10}` silently became 10% off. An absent kind keeps the
  // documented percentage default.
  if (o.kind !== undefined && !(REWARD_KINDS as readonly string[]).includes(String(o.kind))) {
    throw new OpenwopError('validation_error', `reward.kind must be one of: ${REWARD_KINDS.join(', ')}.`, 400, { field: 'reward.kind' });
  }
  const kind: RewardKind = o.kind === undefined ? 'percentage' : String(o.kind) as RewardKind;
  const value = Number(o.value);
  if (!Number.isFinite(value) || value < 0) throw new OpenwopError('validation_error', 'reward.value must be a non-negative number.', 400, { field: 'reward.value' });
  if (kind === 'percentage' && value > 100) throw new OpenwopError('validation_error', 'A percentage reward cannot exceed 100.', 400, { field: 'reward.value' });
  return { kind, value: round2(value) };
}
function coerceScope(v: unknown): Promotion['scope'] | undefined {
  const o = (v ?? {}) as { productIds?: unknown; categories?: unknown; all?: unknown };
  const productIds = Array.isArray(o.productIds) ? o.productIds.map(String).slice(0, 200) : undefined;
  const categories = Array.isArray(o.categories) ? o.categories.map((c) => String(c).toLowerCase()).slice(0, 50) : undefined;
  const all = o.all === true;
  if (!productIds?.length && !categories?.length && !all) return undefined;
  return { ...(productIds?.length ? { productIds } : {}), ...(categories?.length ? { categories } : {}), ...(all ? { all: true } : {}) };
}
function optNum(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? round2(n) : undefined;
}

export interface PromotionInput {
  tenantId: string; orgId: string; createdBy: string;
  name: unknown; type: unknown; reward: unknown; scope?: unknown; minSpend?: unknown; minQuantity?: unknown; bogo?: unknown;
  budget?: unknown; segmentId?: unknown; schedule?: unknown; priority?: unknown; stackable?: unknown; active?: unknown;
  /** R2 PRO2-P1 — the currency this promotion's amounts are in. */
  currency?: unknown;
  /** ADR 1025 — set by the agent lanes (chat draft, run surface), never by the console. */
  proposed?: boolean;
}
/** ADR 1025 D6 — a schedule bound must be a real instant, and the window must be
 *  non-empty. `Date.parse('last friday')` is NaN, and `NaN < now` is false, so an
 *  unparseable `endAt` used to make the promotion run forever. */
function cleanSchedule(raw: unknown): Promotion['schedule'] | undefined {
  const o = (raw ?? undefined) as { startAt?: unknown; endAt?: unknown } | undefined;
  if (!o) return undefined;
  const bound = (v: unknown, field: string): string | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) {
      throw new OpenwopError('validation_error', `schedule.${field} must be a date (ISO 8601).`, 400, { field: `schedule.${field}` });
    }
    return new Date(Date.parse(v)).toISOString();
  };
  const startAt = bound(o.startAt, 'startAt');
  const endAt = bound(o.endAt, 'endAt');
  if (startAt && endAt && Date.parse(endAt) <= Date.parse(startAt)) {
    throw new OpenwopError('validation_error', 'schedule.endAt must be after schedule.startAt.', 400, { field: 'schedule.endAt' });
  }
  return startAt || endAt ? { ...(startAt ? { startAt } : {}), ...(endAt ? { endAt } : {}) } : undefined;
}

/** ADR 1025 D4 — a promotion that carries an amount but no currency. It applies to no
 *  order; the console, the run surface and the chat list all say so. */
export const needsCurrency = (p: Promotion): boolean => isDenominated(p) && !p.currency;

const PER_UNIT_SCOPED: ReadonlySet<PromotionType> = new Set(['product_discount', 'loss_leader', 'bogo']);

/** ADR 1025 D4/D7 — the per-type rules a promotion must meet to be able to fire at all.
 *  Each refusal names the field, so the console and the model can fix it. */
function assertPromotionCanFire(p: Promotion): void {
  if (needsCurrency(p)) {
    throw new OpenwopError('validation_error', 'This promotion carries an amount (a fixed reward, a minimum spend or a loss budget), so it needs a `currency`.', 400, { field: 'currency', code: 'promotion_currency_missing', supported: CURRENCIES });
  }
  if (p.type === 'cart_threshold' && !(p.minSpend !== undefined && p.minSpend > 0)) {
    throw new OpenwopError('validation_error', 'A cart_threshold promotion needs `minSpend` greater than 0.', 400, { field: 'minSpend' });
  }
  if (p.reward.kind === 'fixed' && !(p.reward.value > 0)) {
    throw new OpenwopError('validation_error', 'A fixed reward must be greater than 0.', 400, { field: 'reward.value' });
  }
  if (PER_UNIT_SCOPED.has(p.type) && !p.scope) {
    throw new OpenwopError('validation_error', `A ${p.type} promotion needs a \`scope\` (productIds, categories, or all).`, 400, { field: 'scope' });
  }
}

export async function createPromotion(input: PromotionInput): Promise<Promotion> {
  if ((await listPromotions(input.tenantId, input.orgId)).length >= MAX.perOrg) {
    throw new OpenwopError('validation_error', 'Promotion limit reached for this workspace.', 400, {});
  }
  const type = coerceType(input.type);
  const promotionCurrency = typeof input.currency === 'string' && input.currency.trim()
    ? currencyOrThrow(input.currency)
    : undefined;
  const budgetRaw = (input.budget ?? undefined) as { maxDiscount?: unknown; maxQuantity?: unknown } | undefined;
  const budget = budgetRaw ? { ...(optNum(budgetRaw.maxDiscount) !== undefined ? { maxDiscount: optNum(budgetRaw.maxDiscount) } : {}), ...(optNum(budgetRaw.maxQuantity) !== undefined ? { maxQuantity: optNum(budgetRaw.maxQuantity) } : {}) } : undefined;
  // A loss_leader MUST carry a budget — that's what makes a below-cost SKU safe (ADR 0274).
  if (type === 'loss_leader' && !(budget && budget.maxDiscount !== undefined)) {
    throw new OpenwopError('validation_error', 'A loss_leader promotion requires budget.maxDiscount (the loss cap).', 400, { field: 'budget.maxDiscount' });
  }
  const minQuantity = optNum(input.minQuantity);
  if (type === 'tiered' && (minQuantity === undefined || minQuantity < 1)) {
    throw new OpenwopError('validation_error', 'A tiered promotion requires minQuantity (the buy-more-save-more threshold).', 400, { field: 'minQuantity' });
  }
  const bogoRaw = (input.bogo ?? undefined) as { buy?: unknown; get?: unknown } | undefined;
  const bogo = bogoRaw && Number(bogoRaw.buy) >= 1 && Number(bogoRaw.get) >= 1 ? { buy: Math.trunc(Number(bogoRaw.buy)), get: Math.trunc(Number(bogoRaw.get)) } : undefined;
  if (type === 'bogo' && !bogo) {
    throw new OpenwopError('validation_error', 'A bogo promotion requires bogo.buy ≥ 1 and bogo.get ≥ 1.', 400, { field: 'bogo' });
  }
  const schedule = cleanSchedule(input.schedule);
  const scope = coerceScope(input.scope);
  const segmentId = typeof input.segmentId === 'string' && input.segmentId.trim() ? input.segmentId.trim() : undefined;
  const name = cleanString(input.name, MAX.name, '');
  if (!name) throw new OpenwopError('validation_error', 'A promotion `name` is required.', 400, { field: 'name' });
  const now = nowIso();
  const p: Promotion = {
    promotionId: `promo:${randomUUID()}`, tenantId: input.tenantId, orgId: input.orgId, name,
    type, reward: coerceReward(input.reward),
    ...(scope ? { scope } : {}),
    ...(optNum(input.minSpend) !== undefined ? { minSpend: optNum(input.minSpend) } : {}),
    ...(minQuantity !== undefined ? { minQuantity } : {}),
    ...(bogo ? { bogo } : {}),
    ...(budget ? { budget } : {}),
    ...(segmentId ? { segmentId } : {}),
    ...(schedule ? { schedule } : {}),
    // R2 PRO2-P1 — captured at INTAKE. Nothing can reconstruct later what a stored
    // "spend 50, get 10 off" was denominated in.
    ...(promotionCurrency ? { currency: promotionCurrency } : {}),
    priority: Number.isFinite(Number(input.priority)) ? Math.trunc(Number(input.priority)) : 0,
    stackable: input.stackable !== false,
    active: input.active !== false,
    ...(input.proposed === true && input.active === false ? { proposed: true as const } : {}),
    createdBy: input.createdBy, createdAt: now, updatedAt: now,
  };
  assertPromotionCanFire(p);
  await promotions.put(p);
  log.info('promotion created', { tenantId: input.tenantId, orgId: input.orgId, promotionId: p.promotionId, type: p.type, hasBudget: !!p.budget });
  return p;
}

export async function updatePromotion(tenantId: string, orgId: string, promotionId: string, patch: Partial<PromotionInput>): Promise<Promotion | null> {
  const p = await getPromotion(tenantId, orgId, promotionId);
  if (!p) return null;
  const next: Promotion = { ...p, updatedAt: nowIso() };
  if (patch.name !== undefined) { const n = cleanString(patch.name, MAX.name, p.name); if (n) next.name = n; }
  if (patch.reward !== undefined) next.reward = coerceReward(patch.reward);
  if (patch.minSpend !== undefined) { const m = optNum(patch.minSpend); if (m === undefined) delete next.minSpend; else next.minSpend = m; }
  if (patch.priority !== undefined && Number.isFinite(Number(patch.priority))) next.priority = Math.trunc(Number(patch.priority));
  if (patch.stackable !== undefined) next.stackable = patch.stackable !== false;
  // ADR 1025 (grade MCHCD-2) — a strict boolean. `!== false` turned `"true"` (or any
  // truthy junk) ON while the D4/D7 check below keyed on `=== true`, so a junk value
  // re-activated a promotion that cannot fire without checking it.
  if (patch.active !== undefined) {
    if (typeof patch.active !== 'boolean') throw new OpenwopError('validation_error', '`active` must be true or false.', 400, { field: 'active' });
    next.active = patch.active;
  }
  if (patch.scope !== undefined) { const s = coerceScope(patch.scope); if (s) next.scope = s; else delete next.scope; }
  if (patch.segmentId !== undefined) { const s = typeof patch.segmentId === 'string' && patch.segmentId.trim() ? patch.segmentId.trim() : undefined; if (s) next.segmentId = s; else delete next.segmentId; }
  // R2 PRO2-P4 — the loss BUDGET and the schedule are patchable. They were write-once at
  // creation and unreachable from every surface, so the only way to change a cap was
  // delete + recreate — and because the burn is DERIVED from `appliedPromotions[]
  // .promotionId`, the new row starts at zero: every dollar already given away is
  // orphaned onto the deleted id and the cap silently restarts. A merchant trying to
  // TIGHTEN an over-running cap doubled their exposure instead.
  if (patch.budget !== undefined) {
    const raw = (patch.budget ?? undefined) as { maxDiscount?: unknown; maxQuantity?: unknown } | undefined;
    const b = raw ? {
      ...(optNum(raw.maxDiscount) !== undefined ? { maxDiscount: optNum(raw.maxDiscount) } : {}),
      ...(optNum(raw.maxQuantity) !== undefined ? { maxQuantity: Math.trunc(optNum(raw.maxQuantity)!) } : {}),
    } : undefined;
    if (b && Object.keys(b).length) next.budget = b; else delete next.budget;
    // The create path's invariant has to hold on a patch too, or a loss-leader can be
    // stripped of the guard that makes a below-cost SKU safe.
    if (next.type === 'loss_leader' && next.budget?.maxDiscount === undefined) {
      throw new OpenwopError('validation_error', 'A loss-leader promotion needs a `budget.maxDiscount` — it is the cap that makes a below-cost price safe.', 400, { field: 'budget.maxDiscount' });
    }
  }
  if (patch.schedule !== undefined) {
    const sc = cleanSchedule(patch.schedule);
    if (sc) next.schedule = sc; else delete next.schedule;
  }
  // ADR 1025 D4 — the route and the chat lane forwarded `currency` and this function
  // never read it (probed: PATCH {currency:'USD'} left it absent), so a mis-set or
  // missing currency was unfixable. Empty clears it; the D4 check below then refuses
  // the clear if the promotion still carries an amount.
  if (patch.currency !== undefined) {
    if (typeof patch.currency === 'string' && patch.currency.trim()) next.currency = currencyOrThrow(patch.currency);
    else delete next.currency;
  }
  // R2 PRO2-P22 — clearing the scope of a product-scoped promotion makes it fire on
  // NOTHING while still reading Active. `pruneProductRefs` already deactivates for the
  // identical end-state ("the merchant sees what broke"); the patch path did not.
  // Review M3 — `bogo` was missing (it is scope-gated exactly like the other two), and
  // keying on `patch.scope` guarded one door of two: re-enabling a promotion that
  // `pruneProductRefs` had already deactivated (`PATCH {active:true}`) brought it back
  // Active with an empty scope. Key on the RESULTING row instead.
  if (!next.scope && (next.type === 'product_discount' || next.type === 'loss_leader' || next.type === 'bogo')) {
    next.active = false;
  }
  // ADR 1025 D4/D7 — refuse a patch that would leave the row unable to fire, but only
  // when the patch touches money or turns the promotion on. PAUSING is always allowed,
  // so a legacy row (e.g. a currency-less one) is valid or paused, never wedged.
  const touchesMoney = patch.reward !== undefined || patch.minSpend !== undefined || patch.budget !== undefined || patch.currency !== undefined;
  if ((touchesMoney || patch.active === true || (!p.active && next.active)) && next.active) assertPromotionCanFire(next);
  if (next.active) delete next.proposed; // a person activated it: no longer a proposal
  else if (touchesMoney && needsCurrency(next)) assertPromotionCanFire(next);
  await promotions.put(next);
  return next;
}

/**
 * RI-4 (grade-data / ADR 0279 product-lifecycle seam) — drop this feature's soft
 * references to a DELETED product: remove it from `scope.productIds`. A promotion
 * whose product scope EMPTIES (no remaining ids, no categories, not `all`) is
 * DEACTIVATED, not deleted (disable-don't-destroy: the merchant sees what broke).
 * `bogo.buy/get` are quantities, not product refs — untouched. Idempotent;
 * bounded tenant-indexed read.
 */
export async function pruneProductRefs(tenantId: string, orgId: string, productId: string): Promise<number> {
  let touched = 0;
  for (const p of await listPromotions(tenantId, orgId)) {
    if (!p.scope?.productIds?.includes(productId)) continue;
    const rest = p.scope.productIds.filter((id) => id !== productId);
    const scopeEmptied = rest.length === 0 && !p.scope.categories?.length && p.scope.all !== true;
    await promotions.put({
      ...p,
      scope: { ...p.scope, productIds: rest },
      active: scopeEmptied ? false : p.active,
      updatedAt: nowIso(),
    });
    touched += 1;
  }
  return touched;
}

export async function deletePromotion(tenantId: string, orgId: string, promotionId: string): Promise<boolean> {
  const p = await getPromotion(tenantId, orgId, promotionId);
  if (!p) return false;
  await promotions.delete(promotionId);
  await ledgers.delete(promotionId).catch(() => undefined); // ADR 1025 D1 — its holds go with it
  log.info('promotion deleted', { tenantId, orgId, promotionId });
  return true;
}

// ── The engine (the hook body) ───────────────────────────────────────────────
function inWindow(p: Promotion, nowMs: number): boolean {
  if (!p.schedule) return true;
  // ADR 1025 D6 — a stored bound that does not parse (written before intake validated it)
  // FAILS CLOSED: `NaN > now` and `NaN < now` are both false, so it used to read as "open".
  if (p.schedule.startAt && !(Date.parse(p.schedule.startAt) <= nowMs)) return false;
  if (p.schedule.endAt && !(Date.parse(p.schedule.endAt) >= nowMs)) return false;
  return true;
}
function lineInScope(scope: Promotion['scope'], product: Product | undefined, productId: string): boolean {
  if (!scope) return false;
  if (scope.all) return true;
  if (scope.productIds?.includes(productId)) return true;
  if (scope.categories?.length && product) return product.categories.some((c) => scope.categories!.includes(c));
  return false;
}
/**
 * R2 PRO2-P9 — what a promotion has ALREADY spent. Only `canceled` used to be excluded,
 * so a **refunded** order burned 100% of its discount forever (the money came back; the
 * cap never did), a **partially refunded** one burned 100% regardless of proportion, and
 * a **pending** cart — created, checkout abandoned — burned budget until something
 * cancelled it, which for a digital-only cart is never. The docstring claimed
 * "an abandoned/canceled cart never leaks budget (self-correcting)"; that was true of
 * exactly one of those four states.
 *
 * R2 PRO2-P13 — and it is ONE pass. `budgetUsed`/`quantityUsed` each re-read the tenant's
 * entire order history, per promotion, per checkout: five budgeted promotions meant ten
 * full scans synchronously before the Stripe session was built, growing with lifetime
 * order count.
 */
export interface PromotionUsage { amount: number; quantity: number }

/** Does this promotion carry an AMOUNT (as opposed to a bare percentage)? A percentage
 *  with no threshold and no budget is currency-free by nature and stays so. */
export const isDenominated = (p: Promotion): boolean =>
  p.minSpend !== undefined || p.reward.kind === 'fixed' || p.budget?.maxDiscount !== undefined;

// ── Budget holds (ADR 1025 D1) ───────────────────────────────────────────────
/**
 * The loss budget used to be DERIVED only: `usageFromOrders` read the order history,
 * and the order that would count a checkout's spend was written seconds later (after
 * the inventory CAS and a network tax quote). Five concurrent 1-unit checkouts against
 * `maxDiscount: 10` burned 50 (probed, MCHWF-1). A HOLD is the in-flight half: the
 * order lane appends one to the promotion's ledger by compare-and-swap before the order
 * exists, and commerce commits it (stamps the orderId) after the order row lands, or
 * releases it on any failure.
 *
 * What counts against a budget is unchanged (`usageFromOrders` below, verbatim). Holds
 * only ADD checkouts that have no order row yet:
 *   usage = Σ live holds + usageFromOrders(orders NOT named by a live hold).
 * A committed hold keeps its orderId until it expires, so its order is counted once
 * through the hold, then through `appliedPromotions`. The ledger is read BEFORE the
 * orders, so an in-flight spend is never counted zero times while its hold lives; a
 * commit CAS that fails after the order exists counts it twice for at most the TTL.
 * Both errors under-spend; neither over-spends. A crashed checkout's hold expires by
 * itself: no second counter that can leak (ADR 0274's reason for deriving the budget).
 */
export const BUDGET_HOLD_TTL_MS = ORDER_IDEM_STALE_MS; // one constant: a hold outlives any createOrder
/** Grade MCHA-1 — a flash sale on one loss leader is exactly where checkouts contend on
 *  one ledger row; 5 attempts with no backoff failed late checkouts closed while budget
 *  remained. Retries re-read only the ledger (not the order history) after a jittered
 *  backoff. */
const HOLD_CAS_ATTEMPTS = 25;
const backoff = (attempt: number): Promise<void> => new Promise((r) => setTimeout(r, Math.floor(Math.random() * (4 + attempt * 4))));
interface BudgetHold { holdId: string; amount: number; quantity: number; expiresAt: string; orderId?: string }
/** `version` rises on every write, so a row can never return to byte-identical content
 *  (grade MCHA-4: hold → commit → expiry prune could otherwise re-match a stale read). */
interface BudgetLedger { promotionId: string; tenantId: string; orgId: string; version?: number; holds: BudgetHold[] }
const ledgers = new DurableCollection<BudgetLedger>('promotions:budget-hold', (l) => l.promotionId, undefined, (l) => l.tenantId);

const isBudgeted = (p: Promotion): boolean => p.budget?.maxDiscount !== undefined || p.budget?.maxQuantity !== undefined;
const liveHolds = (row: BudgetLedger | null, nowMs: number): BudgetHold[] =>
  (row?.holds ?? []).filter((h) => Date.parse(h.expiresAt) > nowMs);
/** A hold reference carried through commerce: `<promotionId>|<holdId>`. */
const holdRef = (promotionId: string, holdId: string): string => `${promotionId}|${holdId}`;
const parseRef = (ref: string): { promotionId: string; holdId: string } | null => {
  const i = ref.lastIndexOf('|');
  return i > 0 ? { promotionId: ref.slice(0, i), holdId: ref.slice(i + 1) } : null;
};

/** Rewrite one ledger by CAS (bounded retries). `edit` returns the new holds. */
async function casLedger(tenantId: string, promotionId: string, edit: (holds: BudgetHold[]) => BudgetHold[]): Promise<void> {
  for (let attempt = 0; attempt < HOLD_CAS_ATTEMPTS; attempt++) {
    const row = await ledgers.get(promotionId);
    if (!row || row.tenantId !== tenantId) return;
    if (await ledgers.compareAndSwap(row, { ...row, version: (row.version ?? 0) + 1, holds: edit(liveHolds(row, Date.now())) })) return;
    await backoff(attempt);
  }
  log.warn('promotion budget hold update lost every race — the hold will expire on its own', { tenantId, promotionId });
}

/** Commerce, after the order row is written: name the order on each hold. */
export async function commitBudgetHolds(tenantId: string, refs: readonly string[], orderId: string): Promise<void> {
  for (const ref of refs) {
    const r = parseRef(ref);
    if (!r) continue;
    await casLedger(tenantId, r.promotionId, (holds) => {
      // Grade MCHA-3 — the TTL is a bound createOrder is expected to meet, not one it is
      // forced to. If the hold already expired, the order now counts through its own
      // `appliedPromotions`; say so, because for that gap the spend was counted zero times.
      if (!holds.some((h) => h.holdId === r.holdId)) log.warn('promotion budget hold expired before its order was written', { tenantId, promotionId: r.promotionId, orderId, code: 'promotion_hold_expired' });
      return holds.map((h) => (h.holdId === r.holdId ? { ...h, orderId } : h));
    });
  }
}
/** Commerce, when the order was NOT written: give the budget back. */
export async function releaseBudgetHolds(tenantId: string, refs: readonly string[]): Promise<void> {
  for (const ref of refs) {
    const r = parseRef(ref);
    if (r) await casLedger(tenantId, r.promotionId, (holds) => holds.filter((h) => h.holdId !== r.holdId));
  }
}

/** `skip(promotionId, orderId)` — a spend already counted through a live hold (ADR 1025
 *  D1). Per PAIR, not per order: an order can carry a held promotion and an unheld one. */
function usageFromOrders(orders: Order[], skip?: (promotionId: string, orderId: string) => boolean): Map<string, PromotionUsage> {
  const out = new Map<string, PromotionUsage>();
  for (const o of orders) {
    if (o.status === 'canceled' || o.status === 'refunded') continue;
    // A PENDING cart is money in flight: it must keep holding its budget, or two
    // concurrent checkouts both see the full cap.
    //
    // Review M2 — an earlier version of this dropped pending carts older than a
    // RECOMPUTED `createdAt + env TTL`, on the premise that a digital-only cart is never
    // swept. That premise is false: `createOrder` stamps `reservationExpiresAt` on EVERY
    // pending order and the sweep cancels by DEADLINE, not by stock. Recomputing the
    // deadline also diverges from the stored one whenever it is extended (3-D Secure) or
    // the sweep's per-tick batch lags — and in that gap the budget was released while the
    // order was still payable, so a concurrent checkout could take the cap and the stale
    // order could then pay. Read the order's OWN deadline; a swept cart is `canceled`
    // and already excluded above.
    if (o.status === 'pending' && o.reservationExpiresAt && Date.parse(o.reservationExpiresAt) < Date.now()) continue;
    // A partial refund returns part of the discount too — burn only the share that stuck.
    // Review B1 — `orderChargeTotal` resolves through `toStripeMinorUnits`, which throws
    // on a row with no `currency`; calling it for EVERY order reddened the suite and, in
    // production, threw into `createOrder`'s catch — i.e. added a new trigger for the
    // silent-full-price path this pass explicitly deferred. Compute it only where the
    // proration needs it, and only when the row can answer.
    //
    // Review I2/I3 — and prorate on the GOODS the promotion actually discounted, not on
    // `orderChargeTotal` (which folds in tax and shipping, so a shipping-only refund
    // released discount budget). Units are released only on a FULL refund: a money ratio
    // cannot say how many units came back.
    const kept = o.status === 'partially_refunded' && o.currency && o.total > 0
      ? Math.max(0, Math.min(1, (o.total - (o.refundedAmount ?? 0)) / o.total))
      : 1;
    for (const ap of o.appliedPromotions ?? []) {
      if (skip?.(ap.promotionId, o.orderId)) continue;
      const cur = out.get(ap.promotionId) ?? { amount: 0, quantity: 0 };
      cur.amount += ap.amount * kept;
      cur.quantity += ap.quantity ?? 0; // whole units — a partial refund does not return a fraction of one
      out.set(ap.promotionId, cur);
    }
  }
  return out;
}

/** The per-promotion spend for an org, in ONE order-history read (see PRO2-P13).
 *  Exported so the console can finally show the BURN, not just the cap (PRO2-P5). */
export async function promotionUsage(tenantId: string, orgId: string): Promise<Map<string, PromotionUsage>> {
  return usageFromOrders(await listOrders(tenantId, orgId));
}

/** Cap a per-unit discount list to the promotion's REMAINING `maxQuantity` budget
 *  (derived, leak-free). `unitDiscounts` is ordered most-favourable-first (bogo:
 *  cheapest reward units; product_discount: item order), so slicing keeps the
 *  right units. Returns the summed amount + the units actually discounted. */
function capUnitsToQuantityBudget(
  ctx: OrderDiscountContext, promo: Promotion, unitDiscounts: number[], usage: Map<string, PromotionUsage>,
): { amount: number; qty: number } {
  let units = unitDiscounts;
  if (promo.budget?.maxQuantity !== undefined && units.length > 0) {
    const remaining = promo.budget.maxQuantity - (usage.get(promo.promotionId)?.quantity ?? 0);
    if (remaining <= 0) return { amount: 0, qty: 0 }; // unit budget exhausted
    if (units.length > remaining) units = units.slice(0, remaining);
  }
  return { amount: quantizeMoney(units.reduce((s, u) => s + u, 0), ctx.currency), qty: units.length };
}

const warnedNoCurrency = new Set<string>();

/** The `promotionSeam` hook body. Deterministic (priority DESC → createdAt ASC → id ASC);
 *  a non-stackable promotion that fires is exclusive of all lower-priority ones. */
export async function applyPromotions(ctx: OrderDiscountContext): Promise<OrderDiscountResult> {
  // Respect the per-tenant toggle: promotions OFF ⇒ no-op ⇒ commerce byte-identical.
  // ADR 0819 §1 opt-out — money/compliance truth: this must apply whatever the tenant's plan.
  const assignment = await resolveToggle('promotions', { tenantId: ctx.tenantId });
  if (!assignment?.enabled) return { discount: 0, appliedPromotions: [] };
  // ADR 1025 D1 — the ORDER lane reserves; previews (the chat tool, the run surface) call
  // the engine without `reserve` and never touch the ledger.
  return applyPromotionsUngated(ctx, { reserve: true });
}

/** The pure engine (toggle-gate already passed) — deterministic + directly testable.
 *  `reserve` (the order lane only) takes a budget hold for every budgeted promotion that
 *  fires; the result's `holdIds` must then be committed or released by the caller. */
export async function applyPromotionsUngated(ctx: OrderDiscountContext, opts: { reserve?: boolean } = {}): Promise<OrderDiscountResult> {
  const nowMs = Date.parse(nowIso());
  const active = (await listPromotions(ctx.tenantId, ctx.orgId))
    .filter((p) => p.active && inWindow(p, nowMs))
    // R2 PRO2-P1 — a promotion whose money is denominated (a spend threshold, a fixed
    // reward, or a loss budget) only means anything in its own currency. Commerce refuses
    // a cross-currency COUPON with a typed error ten lines from this hook; promotions
    // read `ctx.currency` nowhere at all and applied the wrong money silently — a ¥3,000
    // order cleared a "spend 50" threshold meant as dollars and took ¥10 off.
    // ADR 1025 D4 — and a denominated promotion with NO currency applies to nothing
    // (it used to apply in every currency: the `!p.currency` escape).
    .filter((p) => {
      if (!isDenominated(p)) return true;
      if (!p.currency) {
        // Once per promotion per process (grade MCHCD-7): this runs on every checkout and
        // every preview, and the row is also flagged on every list read.
        if (!warnedNoCurrency.has(p.promotionId)) {
          warnedNoCurrency.add(p.promotionId);
          log.warn('promotion skipped — it carries an amount but no currency', { code: 'promotion_currency_missing', tenantId: ctx.tenantId, orgId: ctx.orgId, promotionId: p.promotionId });
        }
        return false;
      }
      return p.currency === ctx.currency;
    });
  if (active.length === 0) return { discount: 0, appliedPromotions: [] };
  const budgeted = active.filter(isBudgeted);
  if (budgeted.length === 0) return evaluatePromotions(ctx, active, new Map<string, PromotionUsage>());
  // Ledger FIRST, then the order history once; a retry re-reads only the ledger. An order
  // written after the history read has a live hold (committed or not), so it is counted
  // through that hold.
  let rows = await readLedgers(ctx, budgeted);
  const orders = await listOrders(ctx.tenantId, ctx.orgId);
  if (!opts.reserve) {
    // A preview: the burn as the order lane would see it (holds included), no new hold.
    return evaluatePromotions(ctx, active, usageWithHolds(rows, orders, Date.now()));
  }
  for (let attempt = 0; attempt < HOLD_CAS_ATTEMPTS; attempt++) {
    if (attempt > 0) { await backoff(attempt); rows = await readLedgers(ctx, budgeted); }
    const nowMs = Date.now();
    const usage = usageWithHolds(rows, orders, nowMs);
    const result = await evaluatePromotions(ctx, active, usage);
    const taken: string[] = [];
    let lost = false;
    try {
      for (const ap of result.appliedPromotions) {
        const promo = budgeted.find((p) => p.promotionId === ap.promotionId);
        if (!promo) continue;
        const expected = rows.get(promo.promotionId) ?? null;
        const hold: BudgetHold = { holdId: randomUUID(), amount: ap.amount, quantity: ap.quantity ?? 0, expiresAt: new Date(nowMs + BUDGET_HOLD_TTL_MS).toISOString() };
        const next: BudgetLedger = { promotionId: promo.promotionId, tenantId: ctx.tenantId, orgId: ctx.orgId, version: (expected?.version ?? 0) + 1, holds: [...liveHolds(expected, nowMs), hold] };
        if (!(await ledgers.compareAndSwap(expected, next))) { lost = true; break; }
        taken.push(holdRef(promo.promotionId, hold.holdId));
      }
    } catch (err) {
      // Commerce swallows a hook error, so ids never returned would strand until the TTL.
      await releaseBudgetHolds(ctx.tenantId, taken).catch(() => undefined);
      throw err;
    }
    if (!lost) return { ...result, ...(taken.length ? { holdIds: taken } : {}) };
    // Another checkout moved a ledger between our read and our write: give back what this
    // attempt took and re-evaluate against the fresh ledger (its spend may change what fires).
    await releaseBudgetHolds(ctx.tenantId, taken);
  }
  // Fail CLOSED for the whole evaluation, never for one promotion: dropping only the
  // contended one would let a lower-priority promotion that an exclusive winner excludes
  // fire instead, and would change the approval gateKey between proposal and resume.
  log.warn('promotion budget contention — this order gets no promotion', { tenantId: ctx.tenantId, orgId: ctx.orgId, code: 'promotion_budget_contended' });
  return { discount: 0, appliedPromotions: [] };
}

async function readLedgers(ctx: OrderDiscountContext, budgeted: Promotion[]): Promise<Map<string, BudgetLedger | null>> {
  const rows = new Map<string, BudgetLedger | null>();
  for (const p of budgeted) {
    const row = await ledgers.get(p.promotionId);
    rows.set(p.promotionId, row && row.tenantId === ctx.tenantId ? row : null);
  }
  return rows;
}

/** usage = Σ live holds + every order spend not already counted through one. */
function usageWithHolds(rows: Map<string, BudgetLedger | null>, orders: Order[], nowMs: number): Map<string, PromotionUsage> {
  const held = new Set<string>();
  for (const [promotionId, row] of rows) for (const h of liveHolds(row, nowMs)) if (h.orderId) held.add(`${promotionId}|${h.orderId}`);
  const usage = usageFromOrders(orders, (promotionId, orderId) => held.has(`${promotionId}|${orderId}`));
  for (const [promotionId, row] of rows) {
    for (const h of liveHolds(row, nowMs)) {
      const cur = usage.get(promotionId) ?? { amount: 0, quantity: 0 };
      cur.amount += h.amount;
      cur.quantity += h.quantity;
      usage.set(promotionId, cur);
    }
  }
  return usage;
}

/** One deterministic pass over the active promotions against a given usage. */
async function evaluatePromotions(ctx: OrderDiscountContext, active: Promotion[], usage: Map<string, PromotionUsage>): Promise<OrderDiscountResult> {
  // The order's own products, once, for category matching (ADR 1110 P2: point reads of
  // the line ids, never the catalog — every lookup below is keyed by a line's product).
  const products = new Map<string, Product>((await getProducts(ctx.tenantId, ctx.orgId, ctx.items.map((i) => i.productId))).map((p) => [p.productId, p]));
  const applied: AppliedPromotion[] = [];
  let total = 0;
  let subtotalRemaining = ctx.subtotalAfterCoupon;

  for (const promo of active) {
    if (subtotalRemaining <= 0) break;
    // Segment targeting: a targeted promo needs a matching contact; skip otherwise.
    if (promo.segmentId) {
      if (!ctx.contactId) continue;
      const members = await resolveSegmentMembers(ctx.tenantId, promo.segmentId).catch(() => []);
      if (!members.some((m) => m.contactId === ctx.contactId)) continue;
    }

    let amount = 0;
    let discountedQty = 0; // discounted UNITS granted (per-unit reward types only; drives maxQuantity)
    if (promo.type === 'cart_threshold') {
      if (promo.minSpend !== undefined && ctx.subtotalAfterCoupon >= promo.minSpend) {
        amount = promo.reward.kind === 'percentage' ? ctx.subtotalAfterCoupon * (promo.reward.value / 100) : promo.reward.value;
      }
    } else if (promo.type === 'product_discount' || promo.type === 'loss_leader') {
      // Per-unit decomposition — EXACTLY equal to the prior per-line sum when
      // uncapped (Σ unitPrice·pct = lineTotal·pct; Σ min(unitPrice,v) =
      // min(lineTotal, v·qty)) — so budget.maxQuantity can bound the unit count.
      const unitDiscounts: number[] = [];
      for (const item of ctx.items) {
        if (!lineInScope(promo.scope, products.get(item.productId), item.productId)) continue;
        const perUnit = promo.reward.kind === 'percentage' ? item.unitPrice * (promo.reward.value / 100) : Math.min(item.unitPrice, promo.reward.value);
        for (let k = 0; k < item.quantity; k++) unitDiscounts.push(perUnit);
      }
      const capped = capUnitsToQuantityBudget(ctx, promo, unitDiscounts, usage);
      amount = capped.amount; discountedQty = capped.qty;
    } else if (promo.type === 'tiered') {
      // Buy-more-save-more: the reward hits the scoped subtotal once total scoped quantity
      // crosses the tier threshold (no scope ⇒ the whole cart).
      const scoped = ctx.items.filter((i) => !promo.scope || lineInScope(promo.scope, products.get(i.productId), i.productId));
      const qty = scoped.reduce((s, i) => s + i.quantity, 0);
      if (promo.minQuantity !== undefined && qty >= promo.minQuantity) {
        const scopedTotal = scoped.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
        amount = promo.reward.kind === 'percentage' ? scopedTotal * (promo.reward.value / 100) : promo.reward.value;
      }
    } else if (promo.type === 'bogo' && promo.bogo) {
      // Buy N of scoped ⇒ the cheapest `get` units of each (buy+get) group take the reward
      // (percentage:100 = "get one free"). Expand scoped units, discount the cheapest.
      const units: number[] = [];
      for (const i of ctx.items) if (lineInScope(promo.scope, products.get(i.productId), i.productId)) for (let k = 0; k < i.quantity; k++) units.push(i.unitPrice);
      units.sort((a, b) => a - b);
      const group = promo.bogo.buy + promo.bogo.get;
      const discountedUnits = group > 0 ? Math.floor(units.length / group) * promo.bogo.get : 0;
      // The reward hits the CHEAPEST discountedUnits (units sorted asc) — build
      // that per-unit list so maxQuantity can cap it (keeps the cheapest).
      const unitDiscounts: number[] = [];
      for (let u = 0; u < discountedUnits; u++) {
        unitDiscounts.push(promo.reward.kind === 'percentage' ? units[u]! * (promo.reward.value / 100) : Math.min(units[u]!, promo.reward.value));
      }
      const capped = capUnitsToQuantityBudget(ctx, promo, unitDiscounts, usage);
      amount = capped.amount; discountedQty = capped.qty;
    }

    amount = quantizeMoney(Math.min(amount, subtotalRemaining), ctx.currency); // review M1
    // Loss-leader budget cap (derived, leak-free): never exceed the remaining loss budget.
    if (amount > 0 && promo.budget?.maxDiscount !== undefined) {
      const remainingBudget = quantizeMoney(promo.budget.maxDiscount - (usage.get(promo.promotionId)?.amount ?? 0), ctx.currency);
      amount = quantizeMoney(Math.min(amount, Math.max(0, remainingBudget)), ctx.currency);
    }
    if (!(amount > 0)) continue; // R2 PRO2-P21 — `NaN <= 0` is FALSE, so a NaN amount used to be PUSHED

    applied.push({ promotionId: promo.promotionId, type: promo.type, name: promo.name, amount, ...(discountedQty > 0 ? { quantity: discountedQty } : {}) });
    total = round2(total + amount);
    subtotalRemaining = round2(subtotalRemaining - amount);
    if (!promo.stackable) break; // exclusive
  }
  return { discount: total, appliedPromotions: applied };
}

/** ADR 1025 (grade MCHCD-4) — the PREVIEW lane (chat tool + run surface). The currency is
 *  normalised and validated (a lowercase `usd` used to match nothing and return a zero
 *  discount as a success), and the active promotions that apply to NO cart because they
 *  have no currency are named in `notApplying`. Other reasons a promotion does not fire on
 *  THIS cart (another currency, its schedule, a segment, an unmet threshold) are not
 *  reported here. Never takes budget holds. */
export async function previewPromotions(input: { tenantId: string; orgId: string; currency?: unknown; items: { productId: string; unitPrice: number; quantity: number }[] }): Promise<OrderDiscountResult & { notApplying: { promotionId: string; reason: 'needs_currency' }[] }> {
  // Absent ⇒ USD (the documented default); present but not a string is refused rather
  // than silently previewed as USD (grade MCHCD-N2).
  if (input.currency !== undefined && input.currency !== null && typeof input.currency !== 'string') {
    throw new OpenwopError('validation_error', '`currency` must be a currency code.', 400, { field: 'currency', supported: CURRENCIES });
  }
  const currency = typeof input.currency === 'string' && input.currency.trim() ? currencyOrThrow(input.currency) : 'USD';
  const subtotal = input.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const r = await applyPromotionsUngated({ tenantId: input.tenantId, orgId: input.orgId, currency, subtotalAfterCoupon: subtotal, items: input.items });
  const notApplying = (await listPromotions(input.tenantId, input.orgId))
    .filter((p) => p.active && needsCurrency(p))
    .map((p) => ({ promotionId: p.promotionId, reason: 'needs_currency' as const }));
  return { ...r, notApplying };
}

export async function __resetPromotions(): Promise<void> {
  await promotions.__clear();
  await ledgers.__clear();
}
