/**
 * Price lists + explainable resolution (ecommerce gap plan §5C C4).
 *
 * The account-native contract-pricing FLOOR: an org keeps N `PriceList`s —
 * plain (product → price) entries with an explicit assignment (contact ids
 * and/or CRM company ids) and a priority. Resolution is ONE deterministic
 * function used by every seller path (order create incl. cart/UCP/agent,
 * quote pricing, admin preview) and its answer always carries the WINNING
 * SOURCE — the research-doc "winning rule + precedence explanation" criterion:
 *
 *     contract entry (highest-priority matching active list, same currency)
 *       > variant price
 *       > product list price
 *
 * Deliberately NOT a rules engine: entries + assignment + priority only (no
 * DSL, no stackable promos — coupons stay coupons). No FX: an entry whose
 * list currency differs from the product's is skipped, never converted.
 * Contacts have no companyId (the known CRM gap), so assignment is explicit
 * per-contact and/or per-company; when CRM linkage lands, resolution widens
 * without an API change.
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString } from '../../host/boundedStrings.js';
import { recordCommerceAction } from './telemetry.js';
import { CURRENCIES, type Product } from './commerceService.js';

const nowIso = (): string => new Date().toISOString();
const MAX = { name: 200, entries: 500, assignments: 500, perOrg: 200 } as const;

export interface PriceListEntry { productId: string; variantId?: string; price: number }
export interface PriceList {
  priceListId: string; tenantId: string; orgId: string;
  name: string;
  currency: string;
  entries: PriceListEntry[];
  /** Explicit assignment — a buyer matches when their contactId OR companyId is listed. */
  assignment: { contactIds?: string[]; companyIds?: string[] };
  /** Higher wins when a buyer matches several lists. */
  priority: number;
  /** D3 — when true, buyers matching THIS list may buy ONLY products with an
   *  entry in one of their exclusive lists (account-native assortment). */
  exclusiveAssortment?: boolean;
  active: boolean;
  createdBy: string; createdAt: string; updatedAt: string;
}

const priceLists = new DurableCollection<PriceList>('commerce:price-list', (p) => p.priceListId, undefined, (p) => p.tenantId);

export async function listPriceLists(tenantId: string, orgId: string): Promise<PriceList[]> {
  return (await priceLists.listForTenantIndexed(tenantId))
    .filter((p) => p.orgId === orgId)
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
}

export async function getPriceList(tenantId: string, orgId: string, priceListId: string): Promise<PriceList | null> {
  const p = await priceLists.get(priceListId);
  return p && p.tenantId === tenantId && p.orgId === orgId ? p : null;
}

function cleanEntries(raw: unknown): PriceListEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PriceListEntry[] = [];
  for (const e of raw.slice(0, MAX.entries)) {
    const productId = typeof (e as { productId?: unknown })?.productId === 'string' ? String((e as { productId: string }).productId) : '';
    const price = (e as { price?: unknown })?.price;
    if (!productId || typeof price !== 'number' || !Number.isFinite(price) || price < 0) continue;
    const variantId = typeof (e as { variantId?: unknown })?.variantId === 'string' ? String((e as { variantId: string }).variantId) : undefined;
    out.push({ productId, ...(variantId ? { variantId } : {}), price });
  }
  return out;
}

function cleanIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = raw.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, MAX.assignments);
  return ids.length > 0 ? ids : undefined;
}

const priceListCurrencyOf = (raw: unknown): string => {
  const c = cleanString(raw, 8, 'USD').toUpperCase();
  if (!(CURRENCIES as readonly string[]).includes(c)) {
    throw new OpenwopError('validation_error', `Unsupported currency '${c}'. Supported: ${CURRENCIES.join(', ')}.`, 400, { field: 'currency', supported: CURRENCIES });
  }
  return c;
};

export async function createPriceList(input: {
  tenantId: string; orgId: string; createdBy: string;
  name: unknown; currency?: unknown; entries?: unknown;
  contactIds?: unknown; companyIds?: unknown; priority?: unknown; exclusiveAssortment?: unknown;
}): Promise<PriceList> {
  const existing = await listPriceLists(input.tenantId, input.orgId);
  if (existing.length >= MAX.perOrg) throw new OpenwopError('validation_error', `This org has the maximum ${MAX.perOrg} price lists.`, 409, { max: MAX.perOrg });
  const name = cleanString(input.name, MAX.name);
  if (!name) throw new OpenwopError('validation_error', 'A price-list `name` is required.', 400, { field: 'name' });
  const ts = nowIso();
  const p: PriceList = {
    priceListId: `prl:${randomUUID()}`, tenantId: input.tenantId, orgId: input.orgId,
    name,
    // R2 CM-P2-M4 — validate the currency instead of accepting any 8-char string. A
    // price list's currency is matched by EXACT string against the product's (below), so
    // an unvalidated one never wins a single resolution: the key account it was built for
    // is quietly billed list price forever, with no error anywhere.
    currency: priceListCurrencyOf(input.currency),
    entries: cleanEntries(input.entries),
    assignment: {
      ...(cleanIds(input.contactIds) ? { contactIds: cleanIds(input.contactIds) } : {}),
      ...(cleanIds(input.companyIds) ? { companyIds: cleanIds(input.companyIds) } : {}),
    },
    priority: typeof input.priority === 'number' && Number.isFinite(input.priority) ? Math.trunc(input.priority) : 0,
    ...(input.exclusiveAssortment === true ? { exclusiveAssortment: true } : {}),
    active: true,
    createdBy: input.createdBy, createdAt: ts, updatedAt: ts,
  };
  await priceLists.put(p);
  recordCommerceAction('price-list.created', p, input.createdBy, { priceListId: p.priceListId, name: p.name, entries: p.entries.length, priority: p.priority });
  return p;
}

export interface PriceListPatch { name?: unknown; currency?: unknown; entries?: unknown; contactIds?: unknown; companyIds?: unknown; priority?: unknown; exclusiveAssortment?: unknown; active?: unknown }
export async function updatePriceList(tenantId: string, orgId: string, priceListId: string, patch: PriceListPatch, opts: { actor?: string } = {}): Promise<PriceList | null> {
  const p = await getPriceList(tenantId, orgId, priceListId);
  if (!p) return null;
  const next: PriceList = { ...p, updatedAt: nowIso() };
  if (patch.name !== undefined) { const n = cleanString(patch.name, MAX.name); if (n) next.name = n; }
  // R2 CM-P2-M4 (review M-4) — the UPDATE path validated nothing, so `PATCH
  // {currency:'CHF'}` still silently made the list unresolvable, one route away from the
  // create-path guard.
  if (patch.currency !== undefined) next.currency = priceListCurrencyOf(patch.currency);
  if (patch.entries !== undefined) next.entries = cleanEntries(patch.entries);
  if (patch.contactIds !== undefined || patch.companyIds !== undefined) {
    next.assignment = {
      ...(patch.contactIds !== undefined ? (cleanIds(patch.contactIds) ? { contactIds: cleanIds(patch.contactIds) } : {}) : (p.assignment.contactIds ? { contactIds: p.assignment.contactIds } : {})),
      ...(patch.companyIds !== undefined ? (cleanIds(patch.companyIds) ? { companyIds: cleanIds(patch.companyIds) } : {}) : (p.assignment.companyIds ? { companyIds: p.assignment.companyIds } : {})),
    };
  }
  if (typeof patch.priority === 'number' && Number.isFinite(patch.priority)) next.priority = Math.trunc(patch.priority);
  if (typeof patch.exclusiveAssortment === 'boolean') { if (patch.exclusiveAssortment) next.exclusiveAssortment = true; else delete next.exclusiveAssortment; }
  if (typeof patch.active === 'boolean') next.active = patch.active;
  await priceLists.put(next);
  recordCommerceAction('price-list.updated', next, opts.actor ?? 'system', { priceListId, fields: Object.keys(patch) });
  return next;
}

export async function deletePriceList(tenantId: string, orgId: string, priceListId: string, opts: { actor?: string } = {}): Promise<boolean> {
  const p = await getPriceList(tenantId, orgId, priceListId);
  if (!p) return false;
  await priceLists.delete(priceListId);
  recordCommerceAction('price-list.deleted', p, opts.actor ?? 'system', { priceListId, name: p.name });
  return true;
}

// ── THE resolver ─────────────────────────────────────────────────────────────
export interface ResolvedPrice {
  price: number;
  currency: string;
  /** The winning source — 'price-list:<id>' | 'variant' | 'default'. */
  source: string;
  /** Present when a price list won (the human explanation). */
  priceListName?: string;
  priority?: number;
}

export interface BuyerContext { contactId?: string; companyId?: string }

function listMatchesBuyer(p: PriceList, buyer: BuyerContext): boolean {
  const byContact = Boolean(buyer.contactId && p.assignment.contactIds?.includes(buyer.contactId));
  const byCompany = Boolean(buyer.companyId && p.assignment.companyIds?.includes(buyer.companyId));
  return byContact || byCompany;
}

/**
 * Resolve the effective price for one product (optionally a variant) for a buyer.
 * Deterministic and explainable: highest-priority matching ACTIVE list with an
 * entry for the product (variant entry preferred over product entry) and the
 * SAME currency as the product wins; else the variant's own price; else the
 * product list price. Anonymous buyers (no context) always get default pricing.
 */
export async function resolvePrice(
  tenantId: string, orgId: string,
  product: Pick<Product, 'productId' | 'price' | 'currency' | 'variants'>,
  opts: { variantId?: string; buyer?: BuyerContext } = {},
): Promise<ResolvedPrice> {
  const buyer = opts.buyer ?? {};
  if (buyer.contactId || buyer.companyId) {
    const candidates = (await listPriceLists(tenantId, orgId)).filter(
      (p) => p.active && p.currency === product.currency && listMatchesBuyer(p, buyer),
    ); // already priority-sorted by listPriceLists
    for (const list of candidates) {
      const entry =
        (opts.variantId ? list.entries.find((e) => e.productId === product.productId && e.variantId === opts.variantId) : undefined) ??
        list.entries.find((e) => e.productId === product.productId && !e.variantId);
      if (entry) {
        return { price: entry.price, currency: product.currency, source: `price-list:${list.priceListId}`, priceListName: list.name, priority: list.priority };
      }
    }
  }
  if (opts.variantId) {
    const v = product.variants.find((x) => x.variantId === opts.variantId);
    if (v?.price !== undefined) return { price: v.price, currency: product.currency, source: 'variant' };
  }
  return { price: product.price, currency: product.currency, source: 'default' };
}

/** D3 — ONE sellability answer beside the price answer: when a buyer matches any
 *  ACTIVE exclusive-assortment list, only products carried by one of their
 *  exclusive lists are sellable; buyers with no exclusive list see everything.
 *  Anonymous buyers always see everything (the storefront default). */
export async function resolveSellable(
  tenantId: string, orgId: string, productId: string, buyer: BuyerContext,
): Promise<{ sellable: boolean; reason: 'no-assortment' | 'in-assortment' | 'not-in-assortment' }> {
  if (!buyer.contactId && !buyer.companyId) return { sellable: true, reason: 'no-assortment' };
  const exclusive = (await listPriceLists(tenantId, orgId)).filter((p) => p.active && p.exclusiveAssortment === true && listMatchesBuyer(p, buyer));
  if (exclusive.length === 0) return { sellable: true, reason: 'no-assortment' };
  const carried = exclusive.some((p) => p.entries.some((e) => e.productId === productId));
  return carried ? { sellable: true, reason: 'in-assortment' } : { sellable: false, reason: 'not-in-assortment' };
}

