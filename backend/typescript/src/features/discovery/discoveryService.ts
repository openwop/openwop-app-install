/**
 * Discovery service (ADR 0275 / MERCH-C) — faceted product search, collections
 * (manual + dynamic), and pin/boost/bury merchandising rules, COMPOSING commerce
 * `listProducts` (never a second product store) + the priority-matrix-free lexical
 * rank it already computes + the shared bucketing primitive (holdout). No parallel
 * catalog/ranker/bucketer (ADR 0271 rulings 1/3/4).
 *
 * - Collections: a `Collection` stores only a curated `productIds[]` (manual) OR a
 *   facet-predicate `rule` (dynamic); dynamic membership resolves LIVE from
 *   `listProducts` (ADR 0211 — never materialized).
 * - Merch-rules: pin(id,pos) / boost(pred,factor) / bury(pred) / hide(pred) applied
 *   OVER the ranked candidate set (a post-ranking transform), with preview + holdout.
 *
 * Semantic recall via `host.db.vector` + `embedText` (tenant+org namespace, derived
 * index) is the next increment (ADR 0275 §Phase-2) — this module is lexical + facets +
 * curation, which is deterministic and directly testable.
 *
 * @see docs/adr/0275-merch-c-discovery-search-collections-merch-rules.md
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString } from '../../host/boundedStrings.js';
import { bucketOf } from '../../host/variantAssignment.js';
import { ensureProductEmbeddingsFresh, queryProductEmbeddings } from './productEmbeddingIndex.js';

/** Reciprocal-Rank Fusion of the lexical order + a semantic id ranking (ADR 0275 Part B).
 *  RRF combines RANKS (not scores) so the two rankers never double-count; the stable
 *  `productId` tiebreak keeps the fused order deterministic (so the merch-rule/holdout
 *  layer downstream stays deterministic). Products only in the lexical set are kept. */
function rrfFuse(lexical: Product[], semanticIds: string[]): Product[] {
  const K = 60;
  const semRank = new Map(semanticIds.map((id, i) => [id, i] as const));
  return lexical
    .map((p, i) => ({ p, score: 1 / (K + i) + (semRank.has(p.productId) ? 1 / (K + semRank.get(p.productId)!) : 0) }))
    .sort((a, b) => b.score - a.score || a.p.productId.localeCompare(b.p.productId))
    .map((s) => s.p);
}
import { listProducts, type Product } from '../commerce/commerceService.js';
import { listProductFieldDefs } from '../commerce/productFields.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('discovery');

const nowIso = (): string => new Date().toISOString();
const MAX = { name: 200, perOrg: 1000, ids: 500, rules: 200 } as const;
const HOLDOUT_SALT = 'merch-rule-holdout-v1';

// ── Collections ─────────────────────────────────────────────────────────────
export interface FacetPredicate {
  categories?: string[]; tags?: string[];
  minPrice?: number; maxPrice?: number;
  /** R2 PD2-1 — the currency a price bound is DENOMINATED IN. `Product.price` is major
   *  units with a per-row currency and the catalog is genuinely multi-currency
   *  (USD/EUR/GBP/CAD/AUD/JPY), but this predicate carried no currency at all — so
   *  `maxPrice: 50` matched every ¥50 item (≈$0.33) and missed the ¥5,000 one (≈$33),
   *  in BOTH dynamic collections and hide/boost rules. A hide rule with no unit
   *  removes real inventory from the storefront and says nothing.
   *
   *  A price bound WITHOUT a currency (a pre-R2 row) is UNINTERPRETABLE, and there is
   *  no defensible currency to guess. "Matches nothing" is NOT uniformly fail-closed
   *  (review B2): for a `hide` rule it means hide nothing, so inventory a merchant
   *  suppressed would quietly return to the public storefront. So the RULE is treated
   *  as degraded rather than silently re-interpreted — see `degradedRuleIds`. */
  currency?: string;
}
export interface Collection {
  collectionId: string; tenantId: string; orgId: string;
  name: string; slug: string;
  type: 'manual' | 'dynamic';
  /** manual */ productIds?: string[];
  /** dynamic — resolved live, never materialized (ADR 0211) */ rule?: FacetPredicate;
  /** one-level taxonomy parent (strict at write, silent-ungroup at read) */ parentId?: string;
  active: boolean;
  createdBy: string; createdAt: string; updatedAt: string;
}
const collections = new DurableCollection<Collection>('discovery:collection', (c) => c.collectionId, undefined, (c) => c.tenantId);

const slugify = (s: string): string => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'collection';

export async function listCollections(tenantId: string, orgId: string): Promise<Collection[]> {
  return (await collections.listForTenantIndexed(tenantId)).filter((c) => c.orgId === orgId).sort((a, b) => a.name.localeCompare(b.name));
}
export async function getCollection(tenantId: string, orgId: string, collectionId: string): Promise<Collection | null> {
  const c = await collections.get(collectionId);
  return c && c.tenantId === tenantId && c.orgId === orgId ? c : null;
}

function cleanPredicate(v: unknown): FacetPredicate | undefined {
  const o = (v ?? {}) as Record<string, unknown>;
  const categories = Array.isArray(o.categories) ? o.categories.map((c) => String(c).toLowerCase()).slice(0, 50) : undefined;
  const tags = Array.isArray(o.tags) ? o.tags.map((c) => String(c).toLowerCase()).slice(0, 50) : undefined;
  const minPrice = Number.isFinite(Number(o.minPrice)) ? Number(o.minPrice) : undefined;
  const maxPrice = Number.isFinite(Number(o.maxPrice)) ? Number(o.maxPrice) : undefined;
  const currency = typeof o.currency === 'string' && o.currency.trim() ? o.currency.trim().toUpperCase().slice(0, 8) : undefined;
  // R2 PD2-1 — a price bound must state its currency, at INTAKE. Accepting one without
  // it and resolving later would leave stored predicates nobody can interpret.
  if ((minPrice !== undefined || maxPrice !== undefined) && !currency) {
    throw new OpenwopError('validation_error', 'A price bound needs a `currency` — the catalog is multi-currency, so `minPrice`/`maxPrice` mean nothing on their own.', 400, { field: 'currency' });
  }
  const pred: FacetPredicate = { ...(categories?.length ? { categories } : {}), ...(tags?.length ? { tags } : {}), ...(minPrice !== undefined ? { minPrice } : {}), ...(maxPrice !== undefined ? { maxPrice } : {}), ...(currency && (minPrice !== undefined || maxPrice !== undefined) ? { currency } : {}) };
  return Object.keys(pred).length ? pred : undefined;
}

export async function createCollection(input: { tenantId: string; orgId: string; createdBy: string; name: unknown; type: unknown; productIds?: unknown; rule?: unknown; parentId?: unknown }): Promise<Collection> {
  if ((await listCollections(input.tenantId, input.orgId)).length >= MAX.perOrg) throw new OpenwopError('validation_error', 'Collection limit reached.', 400, {});
  const name = cleanString(input.name, MAX.name, '');
  if (!name) throw new OpenwopError('validation_error', 'A collection `name` is required.', 400, { field: 'name' });
  const type: 'manual' | 'dynamic' = input.type === 'dynamic' ? 'dynamic' : 'manual';
  const rule = type === 'dynamic' ? cleanPredicate(input.rule) : undefined;
  if (type === 'dynamic' && !rule) throw new OpenwopError('validation_error', 'A dynamic collection needs a rule (categories/tags/price).', 400, { field: 'rule' });
  const productIds = type === 'manual' && Array.isArray(input.productIds) ? input.productIds.map(String).slice(0, MAX.ids) : undefined;
  const parentId = typeof input.parentId === 'string' && input.parentId.trim() ? input.parentId.trim() : undefined;
  const now = nowIso();
  const c: Collection = {
    collectionId: `col:${randomUUID()}`, tenantId: input.tenantId, orgId: input.orgId,
    name, slug: slugify(name), type,
    ...(productIds ? { productIds } : type === 'manual' ? { productIds: [] } : {}),
    ...(rule ? { rule } : {}),
    ...(parentId ? { parentId } : {}),
    active: true, createdBy: input.createdBy, createdAt: now, updatedAt: now,
  };
  await collections.put(c);
  log.info('collection created', { tenantId: input.tenantId, orgId: input.orgId, collectionId: c.collectionId, type: c.type });
  return c;
}

export async function updateCollection(tenantId: string, orgId: string, collectionId: string, patch: { name?: unknown; productIds?: unknown; rule?: unknown; active?: unknown; parentId?: unknown }): Promise<Collection | null> {
  const c = await getCollection(tenantId, orgId, collectionId);
  if (!c) return null;
  const next: Collection = { ...c, updatedAt: nowIso() };
  if (patch.name !== undefined) { const n = cleanString(patch.name, MAX.name, c.name); if (n) { next.name = n; next.slug = slugify(n); } }
  if (patch.active !== undefined) next.active = patch.active !== false;
  if (patch.productIds !== undefined && c.type === 'manual') next.productIds = Array.isArray(patch.productIds) ? patch.productIds.map(String).slice(0, MAX.ids) : [];
  if (patch.rule !== undefined && c.type === 'dynamic') { const r = cleanPredicate(patch.rule); if (r) next.rule = r; }
  if (patch.parentId !== undefined) { const pid = typeof patch.parentId === 'string' && patch.parentId.trim() ? patch.parentId.trim() : undefined; if (pid) next.parentId = pid; else delete next.parentId; }
  await collections.put(next);
  return next;
}
export async function deleteCollection(tenantId: string, orgId: string, collectionId: string): Promise<boolean> {
  const c = await getCollection(tenantId, orgId, collectionId);
  if (!c) return false;
  await collections.delete(collectionId);
  return true;
}

/**
 * RI-4 (grade-data / ADR 0279 product-lifecycle seam) — drop this feature's soft
 * references to a DELETED product: remove it from manual collections' `productIds`
 * and strip `pin` actions that reference it from merch rules. A rule whose actions
 * empty is DEACTIVATED, not deleted (disable-don't-destroy: the merchandiser sees
 * what broke instead of losing an authored config). Predicate-based actions
 * (boost/bury/hide) don't reference product ids and are untouched; dynamic
 * collections resolve live and self-heal. Idempotent; bounded tenant-indexed reads.
 */
export async function pruneProductRefs(tenantId: string, orgId: string, productId: string): Promise<{ collections: number; rules: number }> {
  let touchedCollections = 0;
  let touchedRules = 0;
  for (const c of await listCollections(tenantId, orgId)) {
    if (c.type !== 'manual' || !c.productIds?.includes(productId)) continue;
    await collections.put({ ...c, productIds: c.productIds.filter((id) => id !== productId), updatedAt: nowIso() });
    touchedCollections += 1;
  }
  for (const r of await listMerchRules(tenantId, orgId)) {
    const kept = r.actions.filter((a) => !(a.kind === 'pin' && a.productId === productId));
    if (kept.length === r.actions.length) continue;
    await merchRules.put({ ...r, actions: kept, active: kept.length > 0 ? r.active : false, updatedAt: nowIso() });
    touchedRules += 1;
  }
  return { collections: touchedCollections, rules: touchedRules };
}

function matchesPredicate(p: Product, pred: FacetPredicate): boolean {
  if (pred.categories?.length && !p.categories.some((c) => pred.categories!.includes(c))) return false;
  if (pred.tags?.length && !p.tags.some((tg) => pred.tags!.includes(tg))) return false;
  // R2 PD2-1 — a price bound only applies to products in the bound's own currency, and
  // a bound whose currency was never captured (a pre-R2 row) matches NOTHING rather
  // than silently comparing ¥ against $.
  if (pred.minPrice !== undefined || pred.maxPrice !== undefined) {
    if (!pred.currency || (p.currency ?? '').toUpperCase() !== pred.currency.toUpperCase()) return false;
    if (pred.minPrice !== undefined && p.price < pred.minPrice) return false;
    if (pred.maxPrice !== undefined && p.price > pred.maxPrice) return false;
  }
  return true;
}

/** Resolve a collection to its LIVE product set (dynamic = resolve-at-read; never cached). */
export async function resolveCollection(tenantId: string, orgId: string, collectionId: string, activeOnly = true): Promise<Product[]> {
  const c = await getCollection(tenantId, orgId, collectionId);
  if (!c) return [];
  const all = (await listProducts(tenantId, orgId)).filter((p) => !activeOnly || p.active !== false);
  if (c.type === 'manual') {
    const ids = new Set(c.productIds ?? []);
    return all.filter((p) => ids.has(p.productId));
  }
  return c.rule ? all.filter((p) => matchesPredicate(p, c.rule!)) : [];
}

// ── Merchandising rules ─────────────────────────────────────────────────────
export type MerchAction =
  | { kind: 'pin'; productId: string; position: number }
  | { kind: 'boost'; predicate: FacetPredicate; factor: number }
  | { kind: 'bury'; predicate: FacetPredicate }
  | { kind: 'hide'; predicate: FacetPredicate };

export interface MerchRule {
  ruleId: string; tenantId: string; orgId: string; name: string;
  /** scope: which search/collection the rule applies to. `query:<term>` | `collection:<id>` | `all` */
  scope: string;
  actions: MerchAction[];
  holdoutPct?: number;
  active: boolean;
  createdBy: string; createdAt: string; updatedAt: string;
}
const merchRules = new DurableCollection<MerchRule>('discovery:merch-rule', (r) => r.ruleId, undefined, (r) => r.tenantId);

export async function listMerchRules(tenantId: string, orgId: string): Promise<MerchRule[]> {
  return (await merchRules.listForTenantIndexed(tenantId)).filter((r) => r.orgId === orgId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
function cleanActions(v: unknown): MerchAction[] {
  if (!Array.isArray(v)) return [];
  const out: MerchAction[] = [];
  for (const raw of v.slice(0, MAX.rules)) {
    const a = raw as Record<string, unknown>;
    if (a.kind === 'pin' && typeof a.productId === 'string' && Number.isFinite(Number(a.position))) out.push({ kind: 'pin', productId: a.productId, position: Math.max(0, Math.trunc(Number(a.position))) });
    // R2 (review I1) — `factor: 0` was accepted and stored as a "boost" that buries;
    // `-5` round-tripped to the operator while applying as 0.01. Reject non-positive
    // outright (it is not a boost), and store the CLAMPED value so what the operator
    // and the agent read back is what actually applies.
    else if (a.kind === 'boost' && Number.isFinite(Number(a.factor))) {
      if (Number(a.factor) <= 0) throw new OpenwopError('validation_error', 'A boost `factor` must be greater than 0 (use `bury` to demote).', 400, { field: 'factor' });
      const pred = cleanPredicate(a.predicate);
      if (pred) out.push({ kind: 'boost', predicate: pred, factor: clampBoostFactor(Number(a.factor)) });
    }
    else if ((a.kind === 'bury' || a.kind === 'hide')) { const pred = cleanPredicate(a.predicate); if (pred) out.push({ kind: a.kind, predicate: pred }); }
  }
  return out;
}
export async function createMerchRule(input: { tenantId: string; orgId: string; createdBy: string; name: unknown; scope: unknown; actions: unknown; holdoutPct?: unknown }): Promise<MerchRule> {
  const name = cleanString(input.name, MAX.name, '');
  if (!name) throw new OpenwopError('validation_error', 'A rule `name` is required.', 400, { field: 'name' });
  const scope = cleanString(input.scope, MAX.name, 'all') || 'all';
  const actions = cleanActions(input.actions);
  if (actions.length === 0) throw new OpenwopError('validation_error', 'A rule needs at least one action (pin/boost/bury/hide).', 400, { field: 'actions' });
  const hp = Number(input.holdoutPct);
  const holdoutPct = Number.isFinite(hp) && hp > 0 && hp <= 100 ? Math.round(hp) : undefined;
  const now = nowIso();
  const r: MerchRule = {
    ruleId: `mrl:${randomUUID()}`, tenantId: input.tenantId, orgId: input.orgId, name, scope, actions,
    ...(holdoutPct !== undefined ? { holdoutPct } : {}),
    active: true, createdBy: input.createdBy, createdAt: now, updatedAt: now,
  };
  await merchRules.put(r);
  log.info('merch rule created', { tenantId: input.tenantId, orgId: input.orgId, ruleId: r.ruleId, scope: r.scope, actions: r.actions.length });
  return r;
}
export async function deleteMerchRule(tenantId: string, orgId: string, ruleId: string): Promise<boolean> {
  const r = await merchRules.get(ruleId);
  if (!r || r.tenantId !== tenantId || r.orgId !== orgId) return false;
  await merchRules.delete(ruleId);
  return true;
}

/** Apply the active merch-rules for a scope to a ranked product list (a post-ranking
 *  transform — never a second ranker). Deterministic; a holdout control cohort (by
 *  sessionKey) sees the UNMODIFIED order so lift is measurable (ADR 0236). */
/** R2 (review B2) — a price bound with no currency cannot be evaluated. Reporting the
 *  rule is the only honest option: silently skipping it un-hides inventory, and
 *  silently guessing a currency hides the wrong inventory. */
// R2 (review I1) — a stored `factor` of 0 or −5 round-tripped to the operator and to
// the agent's `list-rules` while being clamped to 0.01 at apply time: a "boost" that
// buries, reported as created. Clamp at INTAKE so what is stored is what applies.
export const clampBoostFactor = (n: number): number => Math.max(0.01, Math.min(100, n));

const isUninterpretable = (a: MerchAction): boolean =>
  'predicate' in a && (a.predicate.minPrice !== undefined || a.predicate.maxPrice !== undefined) && !a.predicate.currency;

export function applyMerchRules(ranked: Product[], rules: MerchRule[], scope: string, sessionKey?: string): { products: Product[]; appliedRuleIds: string[]; degradedRuleIds: string[] } {
  const applicable = rules.filter((r) => r.active && (r.scope === 'all' || r.scope === scope));
  const appliedRuleIds: string[] = [];
  const degradedRuleIds: string[] = [];
  let list = [...ranked];
  for (const rule of applicable) {
    // Holdout: a control-cohort caller sees the unmodified ranking (no rule).
    if (rule.holdoutPct && sessionKey && bucketOf(sessionKey, rule.ruleId, HOLDOUT_SALT) < rule.holdoutPct * 100) continue;
    if (rule.actions.some(isUninterpretable)) {
      // Skipped AND reported — a rule that stopped working must not do so in silence.
      degradedRuleIds.push(rule.ruleId);
      log.warn('merch rule skipped — a price bound with no currency cannot be evaluated', { ruleId: rule.ruleId, name: rule.name });
      continue;
    }
    let touched = false;
    for (const a of rule.actions) {
      if (a.kind === 'hide') { const before = list.length; list = list.filter((p) => !matchesPredicate(p, a.predicate)); if (list.length !== before) touched = true; }
      // R2 PD2-6 — `factor` is finally READ. Boost/bury partitioned the list, so every
      // match jumped to the absolute front (or back): `factor: 1.05` and `factor: 10`
      // were indistinguishable, two boosts could not blend (the last one by createdAt
      // won outright), and "gently favour high-margin" replaced the top of the results
      // with the boost predicate. The number was required, validated, exposed in the
      // agent tool schema and documented in the curator prompt — and ignored.
      //
      // Applied in RANK space (this transform receives an ordered list, not scores):
      // rank' = rank / factor. A stable sort with an index + productId tiebreak keeps
      // the determinism the holdout cohort relies on.
      else if (a.kind === 'bury' || a.kind === 'boost') {
        // `bury` carries no factor in its type — it IS a full demotion, expressed as a
        // rank push past every other row. The index tiebreak below is load-bearing:
        // `MAX_SAFE_INTEGER + i` collapses to the same float for i >= 1, so the
        // arithmetic alone does NOT preserve the buried rows' relative order (review I3).
        // Clamped at intake now; the read-side clamp stays as a belt for legacy rows.
        const factor = a.kind === 'boost' ? clampBoostFactor(a.factor) : 1;
        const hit = list.filter((p) => matchesPredicate(p, a.predicate));
        if (hit.length) {
          const hits = new Set(hit.map((p) => p.productId));
          const scored = list.map((p, i) => ({
            p,
            // 1-based so the first rank is not a fixed point of the multiplication.
            rank: hits.has(p.productId) ? (a.kind === 'boost' ? (i + 1) / factor : Number.MAX_SAFE_INTEGER + i) : i + 1,
            i,
          }));
          scored.sort((x, y) => x.rank - y.rank || x.i - y.i || x.p.productId.localeCompare(y.p.productId));
          const next = scored.map((r) => r.p);
          if (next.some((p, i) => p.productId !== list[i]?.productId)) touched = true;
          list = next;
        }
      }
      else if (a.kind === 'pin') { const idx = list.findIndex((p) => p.productId === a.productId); if (idx >= 0) { const [item] = list.splice(idx, 1); list.splice(Math.min(a.position, list.length), 0, item!); touched = true; } }
    }
    if (touched) appliedRuleIds.push(rule.ruleId);
  }
  return { products: list, appliedRuleIds, degradedRuleIds };
}

// ── Faceted search ───────────────────────────────────────────────────────────
export interface Facet {
  key: string; label: string;
  values: { value: string; count: number }[];
  /** R2 PD2-9 — the number of DISTINCT values this facet has, before the cap. */
  totalValues: number;
}
export interface SearchResult {
  products: Product[];
  facets: Facet[];
  appliedRuleIds: string[];
  /** R2 (review B2) — rules that could NOT be evaluated (a pre-R2 price bound with no
   *  currency). They are skipped, and saying so is the point: a hide rule that stops
   *  hiding is inventory silently returning to the storefront. */
  degradedRuleIds: string[];
  /** R2 PD2-3 — how many products MATCHED, before the page cap. The response used to
   *  carry only the capped array, so the console's "Showing the first 12 of {{total}}"
   *  read `products.length` — which IS the cap. A 5,000-product catalog reported "48
   *  matches", and round 1 made that worse by promoting the cap to the status of a
   *  total. A cap that reads as completeness is the defect. */
  total: number;
  /** True when the cap actually dropped something (so the console can stay quiet when
   *  nothing was hidden). */
  truncated: boolean;
  /** R2 PD2-3 — products REMOVED by hide rules, so a preview that is shorter than the
   *  match count can say why instead of leaving "where did it go?" unanswerable on the
   *  one screen that exists to answer it. */
  hiddenByRules: number;
}

/** Faceted search over the ACTIVE catalog: lexical rank (commerce `listProducts`) →
 *  optional collection scope + facet filters → merch-rules. Facet COUNTS are computed
 *  over the active, pre-merch-rule set (categories/tags + typed productFields). */
export async function searchProducts(input: {
  tenantId: string; orgId: string; q?: string;
  collectionId?: string; filters?: Record<string, string>; sessionKey?: string; limit?: number;
}): Promise<SearchResult> {
  const { tenantId, orgId } = input;
  // Collection scope resolves the base set (active-only); else the full active catalog.
  let base = input.collectionId
    ? await resolveCollection(tenantId, orgId, input.collectionId, true)
    : (await listProducts(tenantId, orgId, input.q, {})).filter((p) => p.active !== false);
  if (input.collectionId && input.q) {
    // apply the lexical query within the collection via listProducts ranking order
    const ranked = (await listProducts(tenantId, orgId, input.q, {})).filter((p) => p.active !== false);
    const inColl = new Set(base.map((p) => p.productId));
    base = ranked.filter((p) => inColl.has(p.productId));
  }

  // MERCH-C (ADR 0275, PR 2 Part B) — SEMANTIC recall fused with the lexical order via RRF.
  // Only in-scope products are re-ranked (semantic ids outside `base` are ignored), so the
  // fusion never widens the active/collection scope; the merch-rule + holdout layer below
  // then re-orders this ONE deterministic list.
  if (input.q && input.q.trim()) {
    // R2 PD2-5 — the "best-effort" claim covered only the QUERY half: this rebuild was
  // unguarded, so a vector-store failure rejected the whole search — a 500 on the
  // operator console AND the unauthenticated public storefront, for a dependency
  // keyword search does not need. It also re-attempted a full catalog re-embed on
  // EVERY request, because the freshness stamp is only set on success.
  try {
    await ensureProductEmbeddingsFresh(tenantId, orgId);
  } catch (err) {
    log.warn('product embedding refresh failed — searching lexical-only', { tenantId, orgId, error: err instanceof Error ? err.message : String(err) });
  }
    const semanticIds = await queryProductEmbeddings(tenantId, orgId, input.q, 96);
    if (semanticIds.length > 0) base = rrfFuse(base, semanticIds);
  }

  const fieldDefs = await listProductFieldDefs(tenantId, orgId);
  // Facet counts over the base (pre-filter) set — active only, never leaking drafts.
  const facets = buildFacets(base, fieldDefs);

  // Apply facet filters (category/tag/typed field equality).
  let filtered = base;
  const filters = input.filters ?? {};
  for (const [key, value] of Object.entries(filters)) {
    const v = value.toLowerCase();
    if (key === 'category') filtered = filtered.filter((p) => p.categories.map((c) => c.toLowerCase()).includes(v));
    else if (key === 'tag') filtered = filtered.filter((p) => p.tags.map((t) => t.toLowerCase()).includes(v));
    else filtered = filtered.filter((p) => String(p.customFields?.[key] ?? '').toLowerCase() === v);
  }

  const rules = await listMerchRules(tenantId, orgId);
  const scope = input.collectionId ? `collection:${input.collectionId}` : input.q ? `query:${input.q.trim().toLowerCase()}` : 'all';
  const { products, appliedRuleIds, degradedRuleIds } = applyMerchRules(filtered, rules, scope, input.sessionKey);
  const limit = Math.min(Math.max(1, input.limit ?? 48), 96);
  const total = products.length;
  return {
    products: products.slice(0, limit),
    facets,
    appliedRuleIds,
    degradedRuleIds,
    total,
    truncated: total > limit,
    hiddenByRules: Math.max(0, filtered.length - total),
  };
}

function buildFacets(products: Product[], fieldDefs: { key: string; label: string }[]): Facet[] {
  const facets: Facet[] = [];
  const count = (get: (p: Product) => string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const p of products) for (const v of get(p)) if (v) m.set(v, (m.get(v) ?? 0) + 1);
    return m;
  };
  // R2 PD2-9 — the facet cap carries its own truth: the console's "Top 3 values per
  // facet" note fired on `values.length > 3`, where that length was ALREADY capped at
  // 30 — so a facet with 200 distinct values was truncated twice and its real
  // cardinality was invisible at both layers.
  const FACET_VALUE_CAP = 30;
  const toValues = (m: Map<string, number>): { value: string; count: number }[] => [...m.entries()].map(([value, c]) => ({ value, count: c })).sort((a, b) => b.count - a.count).slice(0, FACET_VALUE_CAP);
  const cats = count((p) => p.categories);
  if (cats.size) facets.push({ key: 'category', label: 'Category', values: toValues(cats), totalValues: cats.size });
  const tags = count((p) => p.tags);
  if (tags.size) facets.push({ key: 'tag', label: 'Tag', values: toValues(tags), totalValues: tags.size });
  for (const def of fieldDefs) {
    const m = count((p) => { const v = p.customFields?.[def.key]; return v === undefined ? [] : [String(v)]; });
    if (m.size) facets.push({ key: def.key, label: def.label, values: toValues(m), totalValues: m.size });
  }
  return facets;
}

export async function __resetDiscovery(): Promise<void> {
  await collections.__clear();
  await merchRules.__clear();
}
