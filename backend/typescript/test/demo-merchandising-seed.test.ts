/**
 * `demo-merchandising` round-trip (app-seeding-strategy.md §4 Phase 5).
 *
 * Verifies the three toggle-gated sub-steps over the Phase-4 catalog: promotions
 * (every type + loss-leader budget cap + scheduled window), discovery
 * (collections + taxonomy + merch rules + embeddings rebuild), recommendations
 * (placements + affinity rebuild). Also asserts the honest skip when toggles are
 * off, and a clean round-trip.
 *
 * TST-CUE-5. The all-off case turns the three toggles off for ITS tenant only (a
 * per-tenant override) — it used to re-register the global defaults OFF, which
 * broke the seed case whenever it ran second. Red when a re-seed re-creates
 * promotions, when clear leaves demo affinity rows, or when the all-off gate is
 * skipped (each sub-step then reports its own skip instead).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { getEffectiveConfig, saveConfig } from '../src/host/featureToggles/service.js';
import { openStorage } from '../src/storage/index.js';
import { seedDemoPeople } from '../src/host/demoPeopleSeed.js';
import { seedDemoMedia } from '../src/host/demoMediaSeed.js';
import { seedDemoCrm } from '../src/host/demoCrmSeed.js';
import { seedDemoCommerceDepth } from '../src/host/demoCommerceDepthSeed.js';
import { seedDemoMerchandising, clearDemoMerchandising, countDemoMerchandising } from '../src/host/demoMerchandisingSeed.js';
import { listPromotions } from '../src/features/promotions/promotionsService.js';
import { listCollections, listMerchRules } from '../src/features/discovery/discoveryService.js';
import { listPlacements } from '../src/features/recommendations/recommendationsService.js';

const affinityStore = new DurableCollection<{ key: string; tenantId: string }>('reco:affinity', (a) => a.key, undefined, (a) => a.tenantId);
const ACTOR = 'demo:merch';
const ON = { status: 'on' as const, bucketUnit: 'tenant' as const };

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'owp-demo-merch-')) });
  for (const id of ['crm', 'commerce', 'promotions', 'discovery', 'recommendations']) {
    registerToggleDefault({ id, salt: id, ...ON });
  }
});

describe('demo-merchandising seeder', () => {
  it('ADR 1025 D7 — a product-scoped promotion whose products are missing is SKIPPED, not a thrown seed', async () => {
    // No commerce-depth seed, so the catalog has none of the demo products: the
    // house-blend loss leader and the ceramic-mug BOGO would have an empty scope, which
    // intake now refuses. The rest of the seed must still land.
    const tenantId = 'demo-merch-t-empty';
    await seedDemoPeople(tenantId);
    await seedDemoCrm(tenantId);
    const res = await seedDemoMerchandising(tenantId);
    const skipped = (res.details?.skipped ?? []) as string[];
    expect(skipped.filter((s) => s.startsWith('promotion:')).length).toBeGreaterThan(0);
    const orgId = (await (await import('../src/host/accessControlService.js')).listOrgs(tenantId))[0]!.orgId;
    expect((await listCollections(tenantId, orgId)).length).toBeGreaterThan(0);
  });

  it('seeds promotions/discovery/recos over the catalog, idempotent; clears clean', async () => {
    const tenantId = 'demo-merch-t1';
    await seedDemoPeople(tenantId);
    await seedDemoMedia(tenantId);
    await seedDemoCrm(tenantId);
    await seedDemoCommerceDepth(tenantId);
    const orgId = (await (await import('../src/host/accessControlService.js')).listOrgs(tenantId))[0]!.orgId;

    const first = await seedDemoMerchandising(tenantId);
    expect(first.created).toBe(6 + 6 + 4 + 5); // promos + collections + rules + placements

    const promos = (await listPromotions(tenantId, orgId)).filter((p) => p.createdBy === ACTOR);
    expect(promos).toHaveLength(6);
    expect(promos.some((p) => p.type === 'loss_leader' && (p.budget?.maxDiscount ?? 0) > 0 && p.segmentId)).toBe(true);
    expect(promos.some((p) => p.schedule?.startAt && p.schedule?.endAt)).toBe(true);
    expect(new Set(promos.map((p) => p.type)).size).toBeGreaterThanOrEqual(4);
    // ADR 1025 D4 — the catalog is USD, and a promotion that carries an amount must say so,
    // or it applies to no order (prod's two demo rows were seeded without one).
    expect(promos.filter((p) => p.currency !== 'USD').map((p) => p.name)).toEqual([]);

    const cols = (await listCollections(tenantId, orgId)).filter((c) => c.createdBy === ACTOR);
    expect(cols).toHaveLength(6);
    expect(cols.some((c) => c.type === 'dynamic' && c.rule)).toBe(true);
    expect(cols.some((c) => c.parentId)).toBe(true); // taxonomy

    const rules = (await listMerchRules(tenantId, orgId)).filter((r) => r.createdBy === ACTOR);
    expect(new Set(rules.flatMap((r) => r.actions.map((a) => a.kind)))).toEqual(new Set(['pin', 'boost', 'bury', 'hide']));
    expect(rules.some((r) => (r.holdoutPct ?? 0) > 0)).toBe(true);

    const placements = (await listPlacements(tenantId, orgId)).filter((p) => p.createdBy === ACTOR);
    expect(placements).toHaveLength(5);
    expect(placements.some((p) => (p.holdoutPct ?? 0) > 0)).toBe(true);
    expect(placements.some((p) => p.segmentId)).toBe(true);

    // Derived caches rebuilt: affinity mined from the Phase-4 orders.
    expect((await affinityStore.listForTenantIndexed(tenantId)).length).toBeGreaterThan(0);

    // Idempotent re-seed.
    const before = await countDemoMerchandising(tenantId);
    const second = await seedDemoMerchandising(tenantId);
    expect(second.created).toBe(0);
    expect(await countDemoMerchandising(tenantId)).toBe(before);

    // Clear.
    await clearDemoMerchandising(tenantId);
    expect(await countDemoMerchandising(tenantId)).toBe(0);
    // Derived affinity rows for demo products are cleared too (review #1358 LOW).
    expect((await affinityStore.listForTenantIndexed(tenantId)).length).toBe(0);

    // Round-trips.
    const third = await seedDemoMerchandising(tenantId);
    expect(third.created).toBe(21);
  });

  it('skips honestly when all three toggles are off', async () => {
    const tenantId = 'demo-merch-off';
    // OFF for this tenant only — the global defaults (ON) stay as the seed case needs them.
    for (const id of ['promotions', 'discovery', 'recommendations']) {
      const cfg = await getEffectiveConfig(id);
      if (!cfg) throw new Error(`no ${id} toggle config`);
      await saveConfig({ ...cfg, tenantOverrides: { ...(cfg.tenantOverrides ?? {}), [tenantId]: { status: 'off' } } }, 'test');
    }
    const r = await seedDemoMerchandising(tenantId);
    expect(r.created).toBe(0);
    // the single all-off skip (a string), not three per-step skips (an array)
    const skipped = r.details?.skipped;
    expect(typeof skipped).toBe('string');
    expect(skipped).toBe('promotions, discovery, and recommendations are all off');
  });
});
