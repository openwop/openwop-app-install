/**
 * ADR 1110 D1 — commerce.product's declared index: the families the kernel keeps
 * beside every product row (`entities/systemIndex.ts`), and the text normalisation
 * search shares with them. Pure: no store, no I/O.
 *
 *  n   `<org>:<nameKey>`             name order: the default list, paging, the whole-catalog
 *                                    iterator, and the per-org counter (the counted family)
 *  c   `<org>:<category>:<nameKey>`  ?category= and rule collections
 *  t   `<org>:<tag>:<nameKey>`       ?tag= and rule collections
 *  w   `<org>:<token>:<nameKey>`     search: a prefix scan of one token
 *  low `<org>`                       products at or under their low-stock threshold
 *
 * No projection carries `createdBy` (the DSAR eraser rewrites only the kernel row),
 * `inventory` or `updatedAt` (either would make every checkout an index write). A reader re-applies its
 * filters to the full row it hydrates, so a projection a crash left stale can only
 * hide a product until the repair, never show a wrong one.
 */
import type { EntityRecord } from '../entities/entitiesService.js';
import type { IndexMarker, SystemIndexDecl } from '../entities/systemIndex.js';
import type { Product } from './commerceService.js';

/** Searchable tokens per product, and characters kept per token. */
const MAX_TOKENS = 40;
const MAX_TOKEN_LEN = 40;
const NAME_KEY_LEN = 80;

/** Lower-case, accents folded (NFKD without combining marks). */
export function foldText(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** The name-order segment: folded, cut to 80 characters. */
export function nameKeyOf(name: string): string {
  return foldText(name).trim().slice(0, NAME_KEY_LEN);
}

/** Words of `s`: runs of letters and digits, folded. */
export function tokensOf(s: string): string[] {
  return foldText(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((t) => t.slice(0, MAX_TOKEN_LEN));
}

/** Every token a product is found by: its name, tags, categories and variant names (not
 *  its description — ADR 1110 D3), de-duplicated, at most 40. */
export function productTokens(p: Pick<Product, 'name' | 'tags' | 'categories' | 'variants'>): string[] {
  const out = new Set<string>();
  const add = (s: string): void => { for (const t of tokensOf(s)) if (out.size < MAX_TOKENS) out.add(t); };
  add(p.name);
  for (const t of p.tags ?? []) add(t);
  for (const c of p.categories ?? []) add(c);
  for (const v of p.variants ?? []) add(v.name);
  return [...out];
}

/** The list projection on the n, c and t markers. (Type aliases, not interfaces, so a
 *  projection is assignable to the marker's `Record<string, unknown>` without a cast.) */
export type ProductRowProjection = {
  productId: string; name: string; type: string; price: number; currency: string;
  active: boolean; unlisted?: true; categories: string[]; tags: string[];
};
/** The search projection on the w markers: what ranking and the AND check read. */
export type ProductSearchProjection = {
  productId: string; name: string; tags: string[]; categories: string[]; variantNames: string[];
  active: boolean; unlisted?: true;
};

const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null);

/** Read a marker's projection back, or null for a malformed one (skipped, like a corrupt row). */
export function readRowProjection(p: Record<string, unknown>): ProductRowProjection | null {
  const categories = strings(p.categories);
  const tags = strings(p.tags);
  if (typeof p.productId !== 'string' || typeof p.name !== 'string' || typeof p.type !== 'string'
    || typeof p.price !== 'number' || typeof p.currency !== 'string' || typeof p.active !== 'boolean' || !categories || !tags) return null;
  return {
    productId: p.productId, name: p.name, type: p.type, price: p.price, currency: p.currency, active: p.active,
    ...(p.unlisted === true ? { unlisted: true as const } : {}), categories, tags,
  };
}
export function readSearchProjection(p: Record<string, unknown>): ProductSearchProjection | null {
  const tags = strings(p.tags);
  const categories = strings(p.categories);
  const variantNames = strings(p.variantNames);
  if (typeof p.productId !== 'string' || typeof p.name !== 'string' || typeof p.active !== 'boolean' || !tags || !categories || !variantNames) return null;
  return {
    productId: p.productId, name: p.name, tags, categories, variantNames, active: p.active,
    ...(p.unlisted === true ? { unlisted: true as const } : {}),
  };
}

export function rowProjection(p: Product): ProductRowProjection {
  return {
    productId: p.productId, name: p.name, type: p.type, price: p.price, currency: p.currency,
    active: p.active, ...(p.unlisted === true ? { unlisted: true as const } : {}),
    categories: p.categories ?? [], tags: p.tags ?? [],
  };
}

export function searchProjection(p: Product): ProductSearchProjection {
  return {
    productId: p.productId, name: p.name, tags: p.tags ?? [], categories: p.categories ?? [],
    variantNames: (p.variants ?? []).map((v) => v.name), active: p.active,
    ...(p.unlisted === true ? { unlisted: true as const } : {}),
  };
}

/** At or under its own threshold, for a product that tracks stock. */
export function isLowStock(p: Pick<Product, 'inventory' | 'lowStockThreshold'>): boolean {
  return p.inventory !== undefined && p.lowStockThreshold !== undefined && p.inventory <= p.lowStockThreshold;
}

export function productMarkers(p: Product): IndexMarker[] {
  const nameKey = nameKeyOf(p.name);
  const row: Record<string, unknown> = rowProjection(p);
  const out: IndexMarker[] = [{ family: 'n', segments: [nameKey], p: row }];
  for (const c of new Set(p.categories ?? [])) out.push({ family: 'c', segments: [c, nameKey], p: row });
  for (const t of new Set(p.tags ?? [])) out.push({ family: 't', segments: [t, nameKey], p: row });
  const search: Record<string, unknown> = searchProjection(p);
  for (const tok of productTokens(p)) out.push({ family: 'w', segments: [tok, nameKey], p: search });
  if (isLowStock(p)) out.push({ family: 'low', segments: [], p: { productId: p.productId, name: p.name, lowStockThreshold: p.lowStockThreshold } });
  return out;
}

export const PRODUCT_INDEX: SystemIndexDecl = {
  orgOf: (rec: EntityRecord) => rec.orgId,
  markers: (rec: EntityRecord) => {
    const p = rec.ext?.product as Product | undefined;
    return p ? productMarkers(p) : [];
  },
  countedFamily: 'n',
};
