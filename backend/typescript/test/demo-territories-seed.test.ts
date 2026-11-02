/**
 * `demo-territories` round-trip (app-seeding-strategy.md §4 Phase 6, ADR 0272).
 *
 * Verifies the sales org over the Phase-3 CRM: types, one active + one planning
 * model (the one-active CAS), an 8-territory 2-level hierarchy, first-match-wins
 * assignment rules + a reassignment, per-leaf quotas, real /attainment numbers,
 * and a clean orphan-free round-trip. TST-CVA-3.
 *
 * Red when: a deal rule is created per metro instead of one per rep (10 rules
 * pinned), the clear stops deleting TERRITORY rows (each captured territory id
 * is read back by id after the clear — `countDemoTerritories` only counts
 * territories of surviving demo models, so it reads 0 for orphans and cannot
 * show the leak), a re-seed re-creates the planning model, or seeding activates
 * the demo plan over a tenant's own active model (review #1359 HIGH, case 2).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { openStorage } from '../src/storage/index.js';
import { seedDemoPeople } from '../src/host/demoPeopleSeed.js';
import { seedDemoCrm } from '../src/host/demoCrmSeed.js';
import { seedDemoTerritories, clearDemoTerritories, countDemoTerritories } from '../src/host/demoTerritoriesSeed.js';
import { listModels, listTerritories, getActiveModelId, getTerritory, createModel, activateModel, getModel } from '../src/features/territories/entities/territories.js';
import { listOrgs } from '../src/host/accessControlService.js';
import { listRules } from '../src/features/territories/entities/assignment.js';
import { computeAttainment } from '../src/features/territories/entities/quota.js';

const ON = { status: 'on' as const, bucketUnit: 'tenant' as const };

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerToggleDefault({ id: 'crm', salt: 'crm', ...ON });
  registerToggleDefault({ id: 'territories', salt: 'territories', ...ON });
});

describe('demo-territories seeder', () => {
  it('seeds types/models/hierarchy/rules/quotas, activates, reassigns; idempotent; clears clean', async () => {
    const tenantId = 'demo-terr-t1';
    await seedDemoPeople(tenantId);
    await seedDemoCrm(tenantId);
    const orgId = (await listOrgs(tenantId))[0]!.orgId;

    const first = await seedDemoTerritories(tenantId);
    expect(first.created).toBeGreaterThan(10);

    // Two demo models; exactly one active (the CAS).
    const models = (await listModels(tenantId, orgId)).filter((m) => m.createdBy === 'demo:territories');
    expect(models).toHaveLength(2);
    const activeId = await getActiveModelId(tenantId, orgId);
    expect(models.some((m) => m.modelId === activeId)).toBe(true);
    expect(activeId).toBeTruthy();

    // 8-territory hierarchy on the active model.
    const terrs = await listTerritories(tenantId, orgId, activeId!);
    expect(terrs).toHaveLength(8);
    expect(terrs.filter((t) => t.parentTerritoryId === null)).toHaveLength(2); // roots
    expect(terrs.filter((t) => t.parentTerritoryId !== null)).toHaveLength(6); // metros
    expect((await listRules(tenantId, orgId, activeId!)).length).toBe(10); // 6 company + 4 deal (one per rep; two reps share metros)

    // Attainment computes against the reassigned deals — real numbers.
    const att = await computeAttainment(tenantId, orgId, activeId!);
    expect(att.territories.length).toBeGreaterThan(0);
    const anyNumbers = att.territories.some((t) => (t.rolled?.weightedPipeline ?? 0) > 0 || (t.rolled?.won ?? 0) > 0);
    expect(anyNumbers).toBe(true);

    // Idempotent re-seed.
    const before = await countDemoTerritories(tenantId);
    const second = await seedDemoTerritories(tenantId);
    expect(second.created).toBe(0);
    expect(await countDemoTerritories(tenantId)).toBe(before);

    // Clear — no orphans; count back to zero.
    const territoryIds = terrs.map((t) => t.territoryId);
    await clearDemoTerritories(tenantId);
    expect(await countDemoTerritories(tenantId)).toBe(0);
    // Each territory row is gone from the store (read by id, not via its model).
    for (const territoryId of territoryIds) {
      await expect(getTerritory(tenantId, orgId, activeId!, territoryId)).rejects.toMatchObject({ code: 'not_found' });
    }
    expect((await listModels(tenantId, orgId)).filter((m) => m.createdBy === 'demo:territories')).toHaveLength(0);

    // Round-trips.
    const third = await seedDemoTerritories(tenantId);
    // Identical round-trip, minus the 3 territory TYPES the clear deliberately
    // leaves (review #1359 MEDIUM) and the re-seed reuses by name.
    expect(third.created).toBe(first.created - 3);
  });

  it('never archives a tenant\'s pre-existing active model (review #1359 HIGH)', async () => {
    const tenantId = 'demo-terr-foreign';
    await seedDemoPeople(tenantId); // just need an org + a foreign active model
    const orgId = (await listOrgs(tenantId))[0]!.orgId;

    // A user's own model, activated.
    const userModel = await createModel(tenantId, orgId, { name: 'User FY26 Plan' }, 'user:real');
    await activateModel(tenantId, orgId, userModel.modelId, 'user:real');
    expect(await getActiveModelId(tenantId, orgId)).toBe(userModel.modelId);

    // Seeding must NOT steal the active pointer or archive the user's model.
    await seedDemoTerritories(tenantId);
    expect(await getActiveModelId(tenantId, orgId)).toBe(userModel.modelId);
    expect((await getModel(tenantId, orgId, userModel.modelId)).state).not.toBe('archived');
  });
});
