/**
 * Feature store derivations (ADR 0820 §7 UI) — PURE functions over the data the
 * store reads: the bundle catalog (`/marketplace/feature-bundles`), the billing
 * commerce projection (`/billing/bundles`) and the public plan catalog
 * (`/public/pricing`). Nothing here invents a figure:
 *
 *  - an amount is parsed from the operator's DISPLAY string, and anything that is
 *    not an unambiguous number ("$29", "$1,290", "29 €", "$65.83") yields `null`;
 *  - a saving, a "worth" line or an upsell is computed only when every input
 *    parses, and is hidden (`null`) when it is not positive;
 *  - grouping, "requires" notes and plan coverage come from catalog DATA, never
 *    from a UI-side map.
 */
import { formatNumber } from '../../i18n/format.js';
import type { BundleCommerce, FeatureBundleCatalog, FeatureBundleInfo, PublicPlanTier } from './marketplaceClient.js';

export type Cadence = 'month' | 'year';
export type BundleStatus = 'owned' | 'included' | 'free' | 'available';

/** A number token in a display string: either plain (`1290`, `65.83`) or US
 *  thousands-grouped (`1,290`, `1,290.00`). Anything else — European grouping,
 *  two numbers, no number — is ambiguous and parses to `null`. */
const NUM_RE = /\d[\d.,]*/g;
const PLAIN = /^\d+(\.\d+)?$/;
const GROUPED = /^\d{1,3}(,\d{3})+(\.\d+)?$/;

export function parseAmount(display: string | undefined): number | null {
  if (!display) return null;
  const tokens = display.match(NUM_RE);
  if (!tokens || tokens.length !== 1) return null;
  const tok = tokens[0]!.replace(/[.,]$/, '');
  if (!PLAIN.test(tok) && !GROUPED.test(tok)) return null;
  const n = Number(tok.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Render `amount` in the SHAPE of an operator display string (its currency
 *  prefix/suffix), e.g. ("$29", 58) → "$58". `null` when the template has no number. */
export function formatLike(template: string | undefined, amount: number): string | null {
  if (!template || parseAmount(template) === null) return null;
  const whole = Math.abs(amount - Math.round(amount)) < 0.005;
  const num = formatNumber(amount, whole ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return template.replace(/\d[\d.,]*\d|\d/, num);
}

/** The yearly saving versus twelve monthly payments, from two display strings.
 *  `null` unless both parse AND the yearly price is genuinely cheaper. */
export function annualSaving(monthly: string | undefined, annual: string | undefined): { amount: string; pct: number } | null {
  const mo = parseAmount(monthly);
  const yr = parseAmount(annual);
  if (mo === null || yr === null) return null;
  const diff = mo * 12 - yr;
  const pct = Math.round((diff / (mo * 12)) * 100);
  if (diff <= 0.005 || pct <= 0) return null;
  const amount = formatLike(monthly, diff);
  return amount ? { amount, pct } : null;
}

/** Whether the store may offer a Buy for this bundle: only when the server says a
 *  checkout would be accepted. A complimentary (free-plan-listed) bundle is
 *  `freeForNow` but NOT purchasable — its checkout would 409, so no button. An older
 *  backend without `purchasable` falls back to the status. */
export function canPurchase(c: BundleCommerce | undefined): boolean {
  if (!c?.forSale || c.owned) return false;
  if (c.purchasable !== undefined) return c.purchasable;
  return !c.includedInPlan;
}

/** The store status of one bundle. Owned is purchase truth; "included" is the
 *  plan; "free" is the server's `freeForNow` (the paywall does not bite yet). */
export function bundleStatus(c: BundleCommerce | undefined): BundleStatus {
  if (c?.owned) return 'owned';
  if (c?.includedInPlan) return 'included';
  if (c?.freeForNow) return 'free';
  return 'available';
}

export interface PriceView {
  /** The price for the chosen cadence, with its cadence suffix. */
  price?: string;
  cadence?: string;
  /** The other cadence's price (for "or $290/yr"), when published. */
  otherPrice?: string;
  otherCadence?: string;
  /** The real yearly saving, when computable. */
  saving: { amount: string; pct: number } | null;
  /** Whether a checkout at the chosen cadence exists. */
  sellsChosen: boolean;
}

/** One bundle's prices in the chosen cadence + the other cadence underneath. A
 *  yearly price is offered only when the bundle sells yearly AND the yearly
 *  amount is published (MKT-UX-6). */
export function bundlePrice(c: BundleCommerce | undefined, cadence: Cadence): PriceView {
  const d = c?.priceDisplay;
  const sellsMonth = !c?.cadences || c.cadences.includes('month');
  const sellsYear = !!c?.cadences?.includes('year') && !!d?.priceAnnual;
  const month = sellsMonth && d?.price ? { price: d.price, cadence: d.cadence ?? '' } : null;
  const year = sellsYear && d?.priceAnnual ? { price: d.priceAnnual, cadence: d.cadenceAnnual ?? '' } : null;
  const saving = annualSaving(d?.price, sellsYear ? d?.priceAnnual : undefined);
  const chosen = cadence === 'year' ? year : month;
  const other = cadence === 'year' ? month : year;
  return {
    ...(chosen ? { price: chosen.price, cadence: chosen.cadence } : {}),
    ...(other ? { otherPrice: other.price, otherCadence: other.cadence } : {}),
    saving,
    sellsChosen: chosen !== null,
  };
}

/** A plan tier's prices in the chosen cadence (from `/public/pricing` display). */
export function planPrice(p: PublicPlanTier, cadence: Cadence): PriceView {
  const d = p.display;
  const month = d?.price ? { price: d.price, cadence: d.cadence ?? '' } : null;
  const year = d?.priceAnnual ? { price: d.priceAnnual, cadence: d.cadenceAnnual ?? '' } : null;
  const chosen = cadence === 'year' ? year : month;
  const other = cadence === 'year' ? month : year;
  return {
    ...(chosen ? { price: chosen.price, cadence: chosen.cadence } : {}),
    ...(other ? { otherPrice: other.price, otherCadence: other.cadence } : {}),
    saving: annualSaving(d?.price, d?.priceAnnual),
    sellsChosen: chosen !== null,
  };
}

export interface BundleGroup { id: string; bundles: FeatureBundleInfo[] }

/** Bundles grouped by the catalog's DATA: the `groups` order first, then any
 *  group a bundle names that the list omits, then ungrouped bundles under `''`. */
export function groupBundles(catalog: Pick<FeatureBundleCatalog, 'groups'>, bundles: FeatureBundleInfo[]): BundleGroup[] {
  const order = [...(catalog.groups ?? [])];
  for (const b of bundles) if (b.group && !order.includes(b.group)) order.push(b.group);
  const out: BundleGroup[] = order.map((id) => ({ id, bundles: bundles.filter((b) => b.group === id) }));
  const rest = bundles.filter((b) => !b.group);
  if (rest.length) out.push({ id: '', bundles: rest });
  return out.filter((g) => g.bundles.length > 0);
}

/** The OTHER bundles this one needs, from the catalog's cross-bundle `dependsOn`
 *  edges: a feature of this bundle hard-depends on a feature that lives in a
 *  different bundle. Core dependencies are always present, so never listed. */
export function requiredBundles(bundle: FeatureBundleInfo, all: FeatureBundleInfo[]): FeatureBundleInfo[] {
  const own = new Set(bundle.features.map((f) => f.id));
  const home = new Map<string, FeatureBundleInfo>();
  for (const b of all) for (const f of b.features) home.set(f.id, b);
  const out: FeatureBundleInfo[] = [];
  for (const f of bundle.features) {
    for (const dep of f.dependsOn) {
      if (own.has(dep)) continue;
      const other = home.get(dep);
      if (other && other.id !== bundle.id && !out.includes(other)) out.push(other);
    }
  }
  return out;
}

/** Whether a plan's feature allowlist grants every feature of a bundle. */
export function planCovers(p: PublicPlanTier, bundle: FeatureBundleInfo): boolean {
  if (p.features === '*') return true;
  if (bundle.features.length === 0) return false;
  const has = new Set(p.features);
  if (has.has(`bundle:${bundle.id}`)) return true;
  return bundle.features.every((f) => has.has(f.id));
}

/** "Includes bundles worth $X/mo": the summed MONTHLY prices of the for-sale
 *  bundles a narrowed plan covers. `null` when the plan is unrestricted (`'*'` —
 *  a worth would be a claim about every bundle on an unconfigured paywall), when
 *  it covers none, or when ANY covered bundle's price does not parse (a partial
 *  sum would understate, and a guess would overstate). */
export function planWorth(
  p: PublicPlanTier, bundles: FeatureBundleInfo[], commerceById: Map<string, BundleCommerce>,
): { amount: number; template: string } | null {
  // The FREE plan's list of PRICED bundles is a complimentary notice period, not
  // something the plan sells — no "worth" line on Free.
  if (p.features === '*' || p.tier === 'free') return null;
  let sum = 0;
  let template: string | undefined;
  for (const b of bundles) {
    const c = commerceById.get(b.id);
    if (!c?.forSale || !planCovers(p, b)) continue;
    const n = parseAmount(c.priceDisplay?.price);
    if (n === null) return null;
    sum += n;
    template ??= c.priceDisplay?.price;
  }
  return sum > 0 && template ? { amount: sum, template } : null;
}

export type CompareCell = 'included' | 'free' | 'addon' | 'none';

/** One plans × bundles comparison cell. "Free for now" only in the CURRENT
 *  plan's column — it is this workspace's state, not a property of the plan. */
export function compareCell(p: PublicPlanTier, bundle: FeatureBundleInfo, c: BundleCommerce | undefined, currentTier: string | null): CompareCell {
  // A PRICED bundle on the FREE plan's list is complimentary (the notice period
  // before its paywall bites), never "included" in Free.
  if (planCovers(p, bundle)) return p.tier === 'free' && c?.forSale ? 'free' : 'included';
  if (c?.freeForNow && p.tier === currentTier) return 'free';
  return c?.forSale ? 'addon' : 'none';
}

/** The cheapest PAID plan (other than the current one) that covers this bundle
 *  AND whose covered bundles are worth more than the plan costs — i.e. a plan
 *  that is genuinely the better buy. `null` when no such plan is computable. */
export function cheaperPlanFor(
  bundle: FeatureBundleInfo, plans: PublicPlanTier[], bundles: FeatureBundleInfo[],
  commerceById: Map<string, BundleCommerce>, currentTier: string | null,
): { plan: PublicPlanTier; others: FeatureBundleInfo[] } | null {
  let best: { plan: PublicPlanTier; price: number; others: FeatureBundleInfo[] } | null = null;
  for (const p of plans) {
    if (p.tier === currentTier || p.tier === 'free' || !planCovers(p, bundle)) continue;
    const price = parseAmount(p.display?.price);
    const worth = planWorth(p, bundles, commerceById);
    if (price === null || !worth || worth.amount <= price) continue;
    if (best && best.price <= price) continue;
    const others = bundles.filter((b) => b.id !== bundle.id && commerceById.get(b.id)?.forSale && planCovers(p, b));
    best = { plan: p, price, others };
  }
  return best ? { plan: best.plan, others: best.others } : null;
}

const CADENCE_KEY = 'openwop.featureStore.cadence';
/** The viewer's remembered cadence (per-viewer convenience; storage may throw). */
export function readCadence(): Cadence {
  try { return window.localStorage.getItem(CADENCE_KEY) === 'year' ? 'year' : 'month'; } catch { return 'month'; }
}
export function writeCadence(c: Cadence): void {
  try { window.localStorage.setItem(CADENCE_KEY, c); } catch { /* private mode — the choice just isn't remembered */ }
}
