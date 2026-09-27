/**
 * `demo-merchandising` seeder (app-seeding-strategy.md §4 Phase 5, ADR 0271–0279).
 *
 * Three toggle-gated sub-steps over the Phase-4 catalog: promotions (every type +
 * a loss-leader with a budget cap + a scheduled window), discovery (collections +
 * a one-level taxonomy + merch rules, then an embeddings rebuild), and
 * recommendations (placements, then an affinity rebuild that mines the Phase-4
 * orders). `dependsOn: ['demo-commerce-depth']`.
 *
 * Each sub-step SKIPS HONESTLY when its feature toggle is off and NEVER flips a
 * toggle. Derived caches (`reco:affinity`, product embeddings) are rebuilt AFTER
 * the sources exist, per app-seeding-strategy.md §5.
 */
import { createLogger } from '../observability/logger.js';
import { DurableCollection } from './hostExtPersistence.js';
import { resolveOne } from './featureToggles/service.js';
import { listOrgs } from './accessControlService.js';
import { listProducts } from '../features/commerce/commerceService.js';
import {
  createPromotion, listPromotions, deletePromotion,
} from '../features/promotions/promotionsService.js';
import {
  createCollection, listCollections, deleteCollection,
  createMerchRule, listMerchRules, deleteMerchRule,
} from '../features/discovery/discoveryService.js';
import { rebuildProductEmbeddings, invalidateProductEmbeddings } from '../features/discovery/productEmbeddingIndex.js';
import {
  createPlacement, listPlacements, deletePlacement, rebuildAffinity,
} from '../features/recommendations/recommendationsService.js';
import {
  SOLSTICE_CATALOG, SOLSTICE_PROMOTIONS, SOLSTICE_COLLECTIONS, SOLSTICE_MERCH_RULES, SOLSTICE_PLACEMENTS,
  DEMO_MERCH_ACTOR, DEMO_COMMERCE_ACTOR, demoCrmSegmentId,
} from './seed-data/solsticeDemo.js';

const log = createLogger('seed.demoMerchandising');

const affinityStore = new DurableCollection<{ key: string; tenantId: string; productId?: string }>('reco:affinity', (a) => a.key, undefined, (a) => a.tenantId);

async function orgIdFor(tenantId: string): Promise<string> {
  return (await listOrgs(tenantId))[0]?.orgId ?? tenantId;
}
async function gate(id: string, tenantId: string): Promise<boolean> {
  return Boolean((await resolveOne(id, { tenantId }))?.enabled);
}

/** slug → productId for the Phase-4 catalog (products store name, not slug). */
async function productMap(tenantId: string, orgId: string): Promise<Map<string, string>> {
  const byName = new Map((await listProducts(tenantId, orgId)).filter((p) => p.createdBy === DEMO_COMMERCE_ACTOR).map((p) => [p.name, p.productId]));
  const bySlug = new Map<string, string>();
  for (const c of SOLSTICE_CATALOG) { const id = byName.get(c.name); if (id) bySlug.set(c.slug, id); }
  return bySlug;
}

export async function countDemoMerchandising(tenantId: string): Promise<number> {
  const orgId = await orgIdFor(tenantId);
  const [promos, cols, rules, placements] = await Promise.all([
    listPromotions(tenantId, orgId), listCollections(tenantId, orgId),
    listMerchRules(tenantId, orgId), listPlacements(tenantId, orgId),
  ]);
  return promos.filter((p) => p.createdBy === DEMO_MERCH_ACTOR).length
    + cols.filter((c) => c.createdBy === DEMO_MERCH_ACTOR).length
    + rules.filter((r) => r.createdBy === DEMO_MERCH_ACTOR).length
    + placements.filter((p) => p.createdBy === DEMO_MERCH_ACTOR).length;
}

export async function seedDemoMerchandising(tenantId: string): Promise<{ created: number; details?: Record<string, unknown> }> {
  const SEGMENT_ID = (slug: string): string => demoCrmSegmentId(tenantId, slug);
  const orgId = await orgIdFor(tenantId);
  const nowMs = Date.now();
  const [promoOn, discoveryOn, recoOn] = await Promise.all([gate('promotions', tenantId), gate('discovery', tenantId), gate('recommendations', tenantId)]);
  if (!promoOn && !discoveryOn && !recoOn) {
    return { created: 0, details: { skipped: 'promotions, discovery, and recommendations are all off' } };
  }
  const slugToId = await productMap(tenantId, orgId);
  const ids = (slugs: string[]): string[] => slugs.map((s) => slugToId.get(s)).filter((x): x is string => !!x);
  let created = 0;
  const skipped: string[] = [];

  // 1) PROMOTIONS.
  if (promoOn) {
    const existing = new Set((await listPromotions(tenantId, orgId)).filter((p) => p.createdBy === DEMO_MERCH_ACTOR).map((p) => p.name));
    for (const promo of SOLSTICE_PROMOTIONS) {
      if (existing.has(promo.name)) continue;
      const scope = promo.scope ? {
        ...(promo.scope.productSlugs ? { productIds: ids(promo.scope.productSlugs) } : {}),
        ...(promo.scope.categories ? { categories: promo.scope.categories } : {}),
        ...(promo.scope.all ? { all: true } : {}),
      } : undefined;
      await createPromotion({
        tenantId, orgId, createdBy: DEMO_MERCH_ACTOR, name: promo.name, type: promo.type, reward: promo.reward,
        ...(scope ? { scope } : {}),
        ...(promo.minSpend !== undefined ? { minSpend: promo.minSpend } : {}),
        ...(promo.minQuantity !== undefined ? { minQuantity: promo.minQuantity } : {}),
        ...(promo.bogo ? { bogo: promo.bogo } : {}),
        ...(promo.budget ? { budget: promo.budget } : {}),
        ...(promo.segmentSlug ? { segmentId: SEGMENT_ID(promo.segmentSlug) } : {}),
        ...(promo.schedule ? { schedule: { startAt: new Date(nowMs + promo.schedule.startDays * 86400_000).toISOString(), endAt: new Date(nowMs + promo.schedule.endDays * 86400_000).toISOString() } } : {}),
        ...(promo.priority !== undefined ? { priority: promo.priority } : {}),
      });
      created += 1;
    }
  } else skipped.push('promotions');

  // 2) DISCOVERY — collections (parents before children) + merch rules + embeddings.
  if (discoveryOn) {
    const existingCols = (await listCollections(tenantId, orgId)).filter((c) => c.createdBy === DEMO_MERCH_ACTOR);
    const colIdByName = new Map<string, string>(existingCols.map((c) => [c.name, c.collectionId]));
    for (const col of SOLSTICE_COLLECTIONS) {
      if (colIdByName.has(col.name)) continue;
      const c = await createCollection({
        tenantId, orgId, createdBy: DEMO_MERCH_ACTOR, name: col.name, type: col.type,
        ...(col.productSlugs ? { productIds: ids(col.productSlugs) } : {}),
        ...(col.rule ? { rule: col.rule } : {}),
        ...(col.parentName && colIdByName.get(col.parentName) ? { parentId: colIdByName.get(col.parentName) } : {}),
      });
      colIdByName.set(col.name, c.collectionId);
      created += 1;
    }
    const existingRules = new Set((await listMerchRules(tenantId, orgId)).filter((r) => r.createdBy === DEMO_MERCH_ACTOR).map((r) => r.name));
    for (const rule of SOLSTICE_MERCH_RULES) {
      if (existingRules.has(rule.name)) continue;
      const actions = rule.actions.map((a) => a.kind === 'pin' ? { kind: 'pin' as const, productId: slugToId.get(a.productSlug) ?? a.productSlug, position: a.position } : a);
      await createMerchRule({ tenantId, orgId, createdBy: DEMO_MERCH_ACTOR, name: rule.name, scope: rule.scope, actions, ...(rule.holdoutPct !== undefined ? { holdoutPct: rule.holdoutPct } : {}) });
      created += 1;
    }
    await rebuildProductEmbeddings(tenantId, orgId);
  } else skipped.push('discovery');

  // 3) RECOMMENDATIONS — placements + affinity rebuild (mines Phase-4 orders).
  if (recoOn) {
    const existing = new Set((await listPlacements(tenantId, orgId)).filter((p) => p.createdBy === DEMO_MERCH_ACTOR).map((p) => `${p.slot}:${p.source}`));
    for (const pl of SOLSTICE_PLACEMENTS) {
      if (existing.has(`${pl.slot}:${pl.source}`)) continue;
      await createPlacement({ tenantId, orgId, createdBy: DEMO_MERCH_ACTOR, slot: pl.slot, source: pl.source, ...(pl.holdoutPct !== undefined ? { holdoutPct: pl.holdoutPct } : {}), ...(pl.segmentSlug ? { segmentId: SEGMENT_ID(pl.segmentSlug) } : {}) });
      created += 1;
    }
    await rebuildAffinity(tenantId, orgId);
  } else skipped.push('recommendations');

  log.info('demo_merchandising_seeded', { tenantId, created, skipped });
  return { created, details: { skipped } };
}

export async function clearDemoMerchandising(tenantId: string): Promise<{ cleared: number; details?: Record<string, unknown> }> {
  const orgId = await orgIdFor(tenantId);
  let cleared = 0;
  for (const p of (await listPromotions(tenantId, orgId)).filter((x) => x.createdBy === DEMO_MERCH_ACTOR)) {
    if (await deletePromotion(tenantId, orgId, p.promotionId)) cleared += 1;
  }
  for (const c of (await listCollections(tenantId, orgId)).filter((x) => x.createdBy === DEMO_MERCH_ACTOR)) {
    if (await deleteCollection(tenantId, orgId, c.collectionId)) cleared += 1;
  }
  for (const r of (await listMerchRules(tenantId, orgId)).filter((x) => x.createdBy === DEMO_MERCH_ACTOR)) {
    if (await deleteMerchRule(tenantId, orgId, r.ruleId)) cleared += 1;
  }
  for (const p of (await listPlacements(tenantId, orgId)).filter((x) => x.createdBy === DEMO_MERCH_ACTOR)) {
    if (await deletePlacement(tenantId, orgId, p.placementId)) cleared += 1;
  }
  // Derived caches (review #1358 LOW): the catalog itself is owned by
  // demo-commerce-depth and is NOT removed here. We explicitly delete the
  // reco:affinity rows keyed on demo products, and TTL-invalidate the embeddings
  // index (a rebuild recomputes it from whatever catalog remains).
  const demoProductIds = new Set((await listProducts(tenantId, orgId)).filter((p) => p.createdBy === DEMO_COMMERCE_ACTOR).map((p) => p.productId));
  for (const a of (await affinityStore.listForTenantIndexed(tenantId)).filter((x) => x.productId && demoProductIds.has(x.productId))) {
    await affinityStore.delete(a.key);
  }
  await invalidateProductEmbeddings(tenantId, orgId);
  log.info('demo_merchandising_cleared', { tenantId, cleared });
  return { cleared };
}
