/**
 * `demo-territories` round-trip (app-seeding-strategy.md §4 Phase 6, ADR 0272).
 *
 * Verifies the sales org over the Phase-3 CRM: types, one active + one planning
 * model (the one-active CAS), an 8-territory 2-level hierarchy, first-match-wins
 * assignment rules + a reassignment, per-leaf quotas, real /attainment numbers,
 * and a clean orphan-free round-trip.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { openStorage } from '../src/storage/index.js';
import { seedDemoPeople } from '../src/host/demoPeopleSeed.js';
import { seedDemoCrm } from '../src/host/demoCrmSeed.js';
import { seedDemoTerritories, clearDemoTerritories, countDemoTerritories } from '../src/host/demoTerritoriesSeed.js';
import { listModels, listTerritories, getActiveModelId } from '../src/features/territories/entities/territories.js';
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
    const orgId = (await (await import('../src/host/accessControlService.js')).listOrgs(tenantId))[0]!.orgId;

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
    await clearDemoTerritories(tenantId);
    expect(await countDemoTerritories(tenantId)).toBe(0);
    expect((await listModels(tenantId, orgId)).filter((m) => m.createdBy === 'demo:territories')).toHaveLength(0);

    // Round-trips.
    const third = await seedDemoTerritories(tenantId);
    expect(third.created).toBeGreaterThan(10);
  });

  it('never archives a tenant\'s pre-existing active model (review #1359 HIGH)', async () => {
    const tenantId = 'demo-terr-foreign';
    await seedDemoPeople(tenantId); // just need an org + a foreign active model
    const orgId = (await (await import('../src/host/accessControlService.js')).listOrgs(tenantId))[0]!.orgId;
    const { createModel, activateModel, getActiveModelId, getModel } = await import('../src/features/territories/entities/territories.js');

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
