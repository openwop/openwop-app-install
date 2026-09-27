/**
 * Recommendations service (ADR 0273 / MERCH-A) — product recommendations +
 * upsell/cross-sell + frequently-bought-together, COMPOSING the commerce catalog
 * (`commerceService`), the priority-matrix weighted-scoring engine
 * (`rankByPriority` — margin-aware, explainable; no new ML), CRM segments (live
 * resolution, ADR 0211), and the shared bucketing primitive (`variantAssignment`
 * — holdout). No parallel catalog/scoring/bucketing stack (ADR 0271 rulings 1/4/5).
 *
 * Two stores, both DERIVED/config — never a second product or order store:
 *  - `RecoAffinity` — a labelled derived co-occurrence + trending cache mined from
 *    `Order` lines (ADR 0211 "derived cache, never authoritative"), rebuilt by the
 *    schedule-daemon tick (`affinityRebuild.ts`).
 *  - `RecoPlacement` — the merchandiser's slot→source binding (+ segment + holdout).
 *
 * @see docs/adr/0273-merch-a-recommendations-upsell-crosssell.md
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { optionalCleanString } from '../../host/boundedStrings.js';
import { bucketOf } from '../../host/variantAssignment.js';
import { rankByPriority } from '../priority-matrix/scoring.js';
import type { CriteriaSet } from '../priority-matrix/types.js';
import { listProducts, getProduct, listOrders, type Product } from '../commerce/commerceService.js';
import { resolveSegmentMembers } from '../crm/segmentsService.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('recommendations');

const nowIso = (): string => new Date().toISOString();
const MAX = { name: 200, perOrg: 2000, related: 24, limit: 24 } as const;
const HOLDOUT_SALT = 'reco-holdout-v1';

// ── Placement model ───────────────────────────────────────────────────────────
export const RECO_SLOTS = ['pdp', 'cart', 'checkout', 'post_purchase', 'category', 'home', 'oos_404'] as const;
export type RecoSlot = (typeof RECO_SLOTS)[number];
export const RECO_SOURCES = ['bought_together', 'cross_sell', 'upsell', 'similar', 'trending'] as const;
export type RecoSource = (typeof RECO_SOURCES)[number];

export interface RecoPlacement {
  placementId: string; tenantId: string; orgId: string;
  slot: RecoSlot; source: RecoSource;
  /** Live CRM-segment target (ADR 0211 — resolved at read, never materialized). */
  segmentId?: string;
  /** 0..100 — the control cohort held back from recs so lift is measurable. */
  holdoutPct?: number;
  active: boolean;
  createdBy: string; createdAt: string; updatedAt: string;
}

/** One product's derived co-occurrence + trending row (the labelled cache). */
export interface RecoAffinity {
  key: string; tenantId: string; orgId: string; productId: string;
  related: { relatedId: string; coScore: number }[];
  /** Units sold across mined orders — the `trending` signal. */
  trendingScore: number;
  computedAt: string;
}

const placements = new DurableCollection<RecoPlacement>('reco:placement', (p) => p.placementId, undefined, (p) => p.tenantId);
const affinity = new DurableCollection<RecoAffinity>('reco:affinity', (a) => a.key, undefined, (a) => a.tenantId);

const affKey = (tenantId: string, orgId: string, productId: string): string => `${tenantId}::${orgId}::${productId}`;

// ── Placement CRUD ──────────────────────────────────────────────────────────
export async function listPlacements(tenantId: string, orgId: string): Promise<RecoPlacement[]> {
  return (await placements.listForTenantIndexed(tenantId))
    .filter((p) => p.orgId === orgId)
    // REC-FLAKE-1 (root cause) — `createdAt` is a MILLISECOND stamp and two placements
    // authored in one sitting routinely share it. `Array.sort` is stable, but the input
    // is a tenant-INDEX scan ordered by marker key (`<tenant>:<uuid>`), so on a tie the
    // surviving order is the placements' random UUIDs. Ordering must be TOTAL or
    // "the first matching placement" is a coin flip.
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.placementId.localeCompare(b.placementId));
}

function coerceSlot(v: unknown): RecoSlot {
  if ((RECO_SLOTS as readonly string[]).includes(String(v))) return v as RecoSlot;
  throw new OpenwopError('validation_error', `Invalid slot. One of: ${RECO_SLOTS.join(', ')}`, 400, { field: 'slot' });
}
function coerceSource(v: unknown): RecoSource {
  if ((RECO_SOURCES as readonly string[]).includes(String(v))) return v as RecoSource;
  throw new OpenwopError('validation_error', `Invalid source. One of: ${RECO_SOURCES.join(', ')}`, 400, { field: 'source' });
}
function coerceHoldout(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new OpenwopError('validation_error', 'holdoutPct must be 0..100.', 400, { field: 'holdoutPct' });
  return Math.round(n);
}

export async function createPlacement(input: {
  tenantId: string; orgId: string; createdBy: string;
  slot: unknown; source: unknown; segmentId?: unknown; holdoutPct?: unknown; active?: unknown;
}): Promise<RecoPlacement> {
  if ((await listPlacements(input.tenantId, input.orgId)).length >= MAX.perOrg) {
    throw new OpenwopError('validation_error', 'Placement limit reached for this workspace.', 400, {});
  }
  const holdoutPct = coerceHoldout(input.holdoutPct);
  const segmentId = optionalCleanString(input.segmentId, MAX.name);
  const now = nowIso();
  const p: RecoPlacement = {
    placementId: `rpl:${randomUUID()}`, tenantId: input.tenantId, orgId: input.orgId,
    slot: coerceSlot(input.slot), source: coerceSource(input.source),
    ...(segmentId ? { segmentId } : {}),
    ...(holdoutPct !== undefined ? { holdoutPct } : {}),
    active: input.active !== false,
    createdBy: input.createdBy, createdAt: now, updatedAt: now,
  };
  await placements.put(p);
  log.info('placement created', { tenantId: input.tenantId, orgId: input.orgId, placementId: p.placementId, slot: p.slot, source: p.source });
  return p;
}

export interface PlacementPatch { source?: unknown; segmentId?: unknown; holdoutPct?: unknown; active?: unknown }
export async function updatePlacement(tenantId: string, orgId: string, placementId: string, patch: PlacementPatch): Promise<RecoPlacement | null> {
  const p = await placements.get(placementId);
  if (!p || p.tenantId !== tenantId || p.orgId !== orgId) return null;
  const next: RecoPlacement = { ...p, updatedAt: nowIso() };
  if (patch.source !== undefined) next.source = coerceSource(patch.source);
  if (patch.active !== undefined) next.active = patch.active !== false;
  if (patch.holdoutPct !== undefined) {
    const h = coerceHoldout(patch.holdoutPct);
    if (h === undefined) delete next.holdoutPct; else next.holdoutPct = h;
  }
  if (patch.segmentId !== undefined) {
    const s = optionalCleanString(patch.segmentId, MAX.name);
    if (s) next.segmentId = s; else delete next.segmentId;
  }
  await placements.put(next);
  return next;
}

export async function deletePlacement(tenantId: string, orgId: string, placementId: string): Promise<boolean> {
  const p = await placements.get(placementId);
  if (!p || p.tenantId !== tenantId || p.orgId !== orgId) return false;
  await placements.delete(placementId);
  log.info('placement deleted', { tenantId, orgId, placementId });
  return true;
}

// ── Affinity rebuild (mined from Order lines — the derived cache) ────────────
/** The order states that represent money actually taken. `pending` (unpaid),
 *  `refunding`/`refunded` (money returned) and `canceled` must never shape what the
 *  store recommends. `partially_refunded` keeps its place: part of it settled. */
const SETTLED_FOR_AFFINITY: ReadonlySet<string> = new Set(['paid', 'fulfilled', 'partially_refunded']);

/** Rebuild the co-occurrence + trending cache for one org from its orders.
 *  Bounded by the commerce per-org order cap; a full recompute (idempotent) — which
 *  means rows that no longer qualify are REMOVED, not merely left unwritten
 *  (R2 REC2-B3). Returns both counts so the operator is told what actually happened. */
export async function rebuildAffinity(tenantId: string, orgId: string): Promise<{ written: number; removed: number }> {
  const orders = await listOrders(tenantId, orgId);
  const co = new Map<string, Map<string, number>>();
  const trending = new Map<string, number>();
  const bump = (a: string, b: string): void => {
    let m = co.get(a); if (!m) { m = new Map(); co.set(a, m); }
    m.set(b, (m.get(b) ?? 0) + 1);
  };
  for (const o of orders) {
    // R2 REC2-M3 — the comment here said "only settled revenue counts (pending carts are
    // noise)" while the code excluded ONLY `canceled`. `pending` is created-but-unpaid
    // and `refunded` is money returned, so 50 unpaid orders for one SKU made it the
    // store's #1 Trending product — and the top co-purchase for every anchor it touched
    // — before a cent settled. Now the code matches the intent, in one named constant.
    if (!SETTLED_FOR_AFFINITY.has(o.status)) continue;
    const ids = Array.from(new Set(o.items.map((i) => i.productId)));
    for (const it of o.items) trending.set(it.productId, (trending.get(it.productId) ?? 0) + it.quantity);
    for (let i = 0; i < ids.length; i++) {
      for (let j = 0; j < ids.length; j++) {
        if (i === j) continue;
        bump(ids[i]!, ids[j]!);
      }
    }
  }
  const productIds = new Set<string>([...trending.keys(), ...co.keys()]);
  let written = 0;
  const computedAt = nowIso();
  for (const productId of productIds) {
    const relatedMap = co.get(productId) ?? new Map<string, number>();
    const related = Array.from(relatedMap.entries())
      .map(([relatedId, coScore]) => ({ relatedId, coScore }))
      .sort((a, b) => b.coScore - a.coScore)
      .slice(0, MAX.related);
    const row: RecoAffinity = {
      key: affKey(tenantId, orgId, productId), tenantId, orgId, productId,
      related, trendingScore: trending.get(productId) ?? 0, computedAt,
    };
    await affinity.put(row);
    written++;
  }
  // R2 REC2-B3 — a full recompute must also REMOVE what no longer qualifies (best-effort,
  // bounded by the tenant index: a row whose index marker is missing is not enumerated
  // this pass, so it survives — review IM-4, and the reason this comment does not promise
  // more than it can do). This was
  // put-only, so a product whose orders were all canceled (or purged by retention) kept
  // its old row forever: `resolveRecommendations` reads EVERY affinity row to build the
  // trending ranking, so the store went on promoting last quarter's top seller as
  // "Trending" with a frozen score, while the rebuild toast reported a count that
  // excluded it — reading as "nothing to do". The docstring above already claimed this
  // was "a full recompute (idempotent)"; now it is.
  let removed = 0;
  for (const row of await affinity.listForTenantIndexed(tenantId)) {
    if (row.orgId !== orgId || productIds.has(row.productId)) continue;
    // Review IM-2 — counting a FAILED delete as a removal would let the route report
    // "5 stale entries removed" when nothing was removed. Count successes only.
    try { await affinity.delete(row.key); removed++; }
    catch (err) { log.warn('stale affinity row could not be removed', { tenantId, orgId, productId: row.productId, error: err instanceof Error ? err.message : String(err) }); }
  }
  return { written, removed };
}

/** Rebuild affinity (daemon tick) for every org with an ACTIVE placement — the
 *  only orgs whose cache is ever read. Bounded by the placement count; the single
 *  cross-tenant scan (`placements.list()`) is daemon-only, never a request path. */
export async function rebuildAllAffinity(): Promise<number> {
  const pairs = new Set<string>();
  for (const p of await placements.list()) if (p.active) pairs.add(`${p.tenantId}::${p.orgId}`);
  let total = 0;
  for (const pair of pairs) {
    const [tenantId, orgId] = pair.split('::');
    total += (await rebuildAffinity(tenantId!, orgId!)).written;
  }
  return total;
}

// ── Resolve (the funnel read) ───────────────────────────────────────────────
export interface ResolveInput {
  tenantId: string; orgId: string; slot: RecoSlot;
  productId?: string;
  /** Authed/operator preview only — the PUBLIC route MUST NOT accept a raw contactId
   *  (ADR 0273 IDOR invariant); public identity comes from the session/owx token. */
  contactId?: string;
  sessionKey?: string;
  limit?: number;
}
export interface ResolveResult {
  placementId?: string; source?: RecoSource;
  variant?: 'treatment' | 'control';
  products: Product[];
  /** R2 REC2-B2 — a placement for this slot EXISTS but targets a segment, and this call
   *  had no `contactId`. Without this the console said "no active placement matches…
   *  add a placement above" about a placement sitting active in the table. */
  segmentTargetedSkipped?: true;
  /** Review MJ-1 — a targeted placement WAS evaluated against a real contact, and the
   *  contact is not in the segment. Distinct from `segmentTargetedSkipped` (no contact
   *  supplied) and from "this slot has no placement at all". */
  segmentNotMatched?: true;
  /** R2 REC2-M1 — placements skipped because their segment could not be resolved
   *  (deleted, or a typo — `segmentId` is free text and unvalidated at write).
   *  Review MJ-2 — carried on the MATCHED returns too: M1's own scenario is a shopper
   *  falling through to the GENERIC placement, which is a matched result, so reporting
   *  it only on the empty path told nobody in the case the finding describes. */
  unresolvedSegmentIds?: string[];
  /** R2 REC2-M2 — the placement declares a holdout but this call carried no
   *  `sessionKey`, so there is no stable identity to bucket on and the holdout is NOT
   *  being enforced. The table shows a percentage; this says whether it bites. */
  holdoutInert?: true;
  /** R3 M4 (freshness half) — when the ranking consumed affinity rows, the
   *  NEWEST `computedAt` among them. `computedAt` was written and read by
   *  nothing; without it a store serving last quarter's frozen affinity looked
   *  identical to a fresh one. Absent when no affinity contributed. */
  affinityComputedAt?: string;
}

const RECO_CRITERIA = (weights: { affinity: number; categoryMatch: number; recency: number }): CriteriaSet => ({
  aggregation: 'weighted-sum',
  criteria: [
    { id: 'affinity', name: 'Co-purchase affinity', weight: weights.affinity, direction: 'benefit' },
    { id: 'categoryMatch', name: 'Category / tag overlap', weight: weights.categoryMatch, direction: 'benefit' },
    { id: 'recency', name: 'Recency', weight: weights.recency, direction: 'benefit' },
  ],
});
const DEFAULT_WEIGHTS = { affinity: 6, categoryMatch: 3, recency: 1 } as const;

function overlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const set = new Set(a);
  let n = 0; for (const x of b) if (set.has(x)) n++;
  return n;
}

export async function resolveRecommendations(input: ResolveInput): Promise<ResolveResult> {
  const { tenantId, orgId, slot } = input;
  const limit = Math.min(Math.max(1, input.limit ?? 8), MAX.limit);
  // REC-FLAKE-1 (the defect the flake was hiding) — a GENERIC placement is by
  // definition the fallback, and the loop below takes the first match, so a generic
  // placement created BEFORE a segment-targeted one shadowed it completely: every
  // targeted shopper silently got the fallback, no targeting was ever applied, and
  // nothing said so. Which one came first was decided by a millisecond tie-break, so
  // the same two placements could behave differently on two machines. Targeted
  // placements are evaluated first; the generic fallback is what you fall back TO.
  const candidatesPlacements = (await listPlacements(tenantId, orgId))
    .filter((p) => p.active && p.slot === slot)
    .sort((a, b) => Number(!a.segmentId) - Number(!b.segmentId));
  // Pick the first placement whose segment target (if any) matches the caller.
  let placement: RecoPlacement | undefined;
  const unresolvedSegmentIds: string[] = [];
  let segmentTargetedSkipped = false;
  let segmentNotMatched = false;
  for (const p of candidatesPlacements) {
    if (!p.segmentId) { placement = p; break; }
    if (!input.contactId) { segmentTargetedSkipped = true; continue; } // anonymous caller ⇒ skip
    // R2 REC2-M1 — `.catch(() => [])` turned a DELETED or mistyped segment into "this
    // shopper is not a member", silently downgrading every targeted shopper to the
    // generic placement with no log, no badge, no notice. `segmentId` is free text and
    // is never validated at write, so a typo is the likely case, not the exotic one.
    let members: { contactId: string }[] = [];
    try {
      members = await resolveSegmentMembers(tenantId, p.segmentId);
    } catch (err) {
      log.warn('recommendation placement targets a segment that could not be resolved — skipping it', {
        tenantId, orgId, placementId: p.placementId, segmentId: p.segmentId,
        error: err instanceof Error ? err.message : String(err),
      });
      unresolvedSegmentIds.push(p.segmentId);
      continue;
    }
    if (members.some((m) => m.contactId === input.contactId)) { placement = p; break; }
    // Review MJ-1 — the LIKELY outcome of the new "preview as contact" field: the
    // operator guesses a contact who is not in the segment. Without this the page fell
    // back to "no active placement matches — add a placement above", i.e. the new UI
    // manufactured fresh instances of the very lie it was built to remove.
    segmentNotMatched = true;
  }
  // R2 REC2-B2/M1 — the bare shape means "no placement matched", and the CALLER cannot
  // tell why. Say which reasons applied so the console can distinguish "you never
  // configured this slot" from "the only match targets a segment and you previewed
  // anonymously" or "its segment no longer resolves".
  if (!placement) {
    return {
      products: [],
      ...(segmentTargetedSkipped ? { segmentTargetedSkipped: true } : {}),
      ...(segmentNotMatched ? { segmentNotMatched: true } : {}),
      ...(unresolvedSegmentIds.length ? { unresolvedSegmentIds } : {}),
    };
  }

  // Holdout: a control-cohort caller (sticky by sessionKey) sees NO recs, so lift is
  // measurable against them (ADR 0236 bucketing; no second bucketer).
  // R2 REC2-M2 — a holdout with no `sessionKey` is INERT: there is no stable identity
  // to bucket on, so the table can say "20%" while the effective holdout is 0% and the
  // lift measurement has an empty control arm. Report that rather than let the operator
  // read a number that is not being enforced.
  const holdoutInert = !!placement.holdoutPct && placement.holdoutPct > 0 && !input.sessionKey;
  if (placement.holdoutPct && placement.holdoutPct > 0 && input.sessionKey) {
    const inControl = bucketOf(input.sessionKey, placement.placementId, HOLDOUT_SALT) < placement.holdoutPct * 100;
    if (inControl) return { placementId: placement.placementId, source: placement.source, variant: 'control', products: [] };
  }
  const holdoutNote = {
    ...(holdoutInert ? { holdoutInert: true as const } : {}),
    ...(unresolvedSegmentIds.length ? { unresolvedSegmentIds } : {}),
  };

  const anchor = input.productId ? await getProduct(tenantId, orgId, input.productId) : null;
  const all = (await listProducts(tenantId, orgId)).filter((p) => p.active !== false);
  const byId = new Map(all.map((p) => [p.productId, p]));
  const aff = anchor ? await affinity.get(affKey(tenantId, orgId, anchor.productId)) : null;
  const affScore = new Map<string, number>((aff?.related ?? []).map((r) => [r.relatedId, r.coScore]));
  const maxCo = Math.max(1, ...(aff?.related ?? []).map((r) => r.coScore));
  // Trending signal (product → units sold) from the derived cache, for the anchorless slot.
  const trendRows = (await affinity.listForTenantIndexed(tenantId)).filter((a) => a.orgId === orgId);
  const trendById = new Map(trendRows.map((a) => [a.productId, a.trendingScore]));
  // R3 M4 — the freshness stamp of what this resolve actually consumed.
  const affinityComputedAt = [aff, ...trendRows].reduce<string | undefined>(
    (acc, row) => (row && (!acc || row.computedAt > acc) ? row.computedAt : acc), undefined);
  const maxTrend = Math.max(1, ...trendRows.map((a) => a.trendingScore));

  // Candidate generation per source.
  let candidateIds: string[];
  switch (placement.source) {
    case 'bought_together':
    case 'cross_sell':
      candidateIds = (aff?.related ?? []).map((r) => r.relatedId);
      if (placement.source === 'cross_sell' && anchor) {
        for (const p of all) if (p.productId !== anchor.productId && overlap(anchor.tags, p.tags) > 0) candidateIds.push(p.productId);
      }
      break;
    case 'upsell':
      candidateIds = anchor
        ? all.filter((p) => p.productId !== anchor.productId && p.currency === anchor.currency && p.price > anchor.price && overlap(anchor.categories, p.categories) > 0).map((p) => p.productId)
        : [];
      break;
    case 'similar':
      candidateIds = anchor
        ? all.filter((p) => p.productId !== anchor.productId && (overlap(anchor.categories, p.categories) > 0 || overlap(anchor.tags, p.tags) > 0)).map((p) => p.productId)
        : [];
      break;
    case 'trending':
    default:
      candidateIds = [...trendById.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
      break;
  }

  // Dedupe, resolve to active products, exclude the anchor.
  const seen = new Set<string>();
  const candidates: Product[] = [];
  for (const id of candidateIds) {
    if (seen.has(id) || (anchor && id === anchor.productId)) continue;
    seen.add(id);
    const p = byId.get(id);
    if (p) candidates.push(p);
  }
  if (candidates.length === 0) return { placementId: placement.placementId, source: placement.source, variant: 'treatment', products: [], ...holdoutNote, ...(affinityComputedAt ? { affinityComputedAt } : {}) };

  // Explainable, margin-aware-ready ranking via the shared scoring engine. `margin`
  // is intentionally omitted in Phase 1 (Product.costMinor lands with MERCH-B); the
  // set degrades to affinity/category/recency (ADR 0273 graceful-degradation).
  const set = RECO_CRITERIA(DEFAULT_WEIGHTS);
  const times = candidates.map((p) => Date.parse(p.createdAt) || 0);
  const minT = Math.min(...times); const maxT = Math.max(...times);
  const ranked = rankByPriority(set, candidates, (p) => {
    const affinityScore = anchor
      ? ((affScore.get(p.productId) ?? 0) / maxCo) * 10
      : ((trendById.get(p.productId) ?? 0) / maxTrend) * 10;
    const catScore = anchor ? Math.min(10, (overlap(anchor.categories, p.categories) + overlap(anchor.tags, p.tags)) * 5) : 0;
    const t = Date.parse(p.createdAt) || 0;
    const recency = maxT > minT ? ((t - minT) / (maxT - minT)) * 10 : 5;
    return { affinity: affinityScore, categoryMatch: catScore, recency };
  });
  return {
    placementId: placement.placementId, source: placement.source, variant: 'treatment',
    products: ranked.slice(0, limit).map((r) => r.item),
    ...holdoutNote,
    ...(affinityComputedAt ? { affinityComputedAt } : {}),
  };
}

export async function __resetRecommendations(): Promise<void> {
  await placements.__clear();
  await affinity.__clear();
}
