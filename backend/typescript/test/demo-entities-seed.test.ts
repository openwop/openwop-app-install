/**
 * `demo-entities` seeder (ADR 0407 Phase 3): toggle-off honest skip, idempotent
 * re-seed (deterministic ids), the deliberate draft entry, publish + publicRead
 * flipped on the type, and clear() removing only demo-marked rows.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault, registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { seedDemoEntities, countDemoEntities, clearDemoEntities, DEMO_ENTITIES_ACTOR } from '../src/host/demoEntitiesSeed.js';
import { getEntityType, listEntities, createEntity } from '../src/features/entities/entitiesService.js';

const TENANT = 'tenant-seed-entities';

beforeAll(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  // Bare-storage harness (the demo-cdp test pattern): the feature registry
  // isn't booted, so pin the toggle default here — OFF, like the real default.
  registerToggleDefault({ id: 'entities', salt: 'entities', status: 'off', bucketUnit: 'tenant' });
});

describe('demo-entities seeder', () => {
  it('skips honestly while the entities toggle is off', async () => {
    const r = await seedDemoEntities(TENANT);
    expect(r.created).toBe(0);
    expect(r.details?.skipped).toBeDefined();
    expect(await countDemoEntities(TENANT)).toBe(0);
  });

  it('seeds a published + publicRead type with a roster (one draft) and is idempotent', async () => {
    const d = getToggleDefault('entities');
    if (!d) throw new Error('no entities toggle default');
    await saveConfig({ ...d, status: 'on' }, 'test');

    const first = await seedDemoEntities(TENANT);
    expect(first.created).toBeGreaterThan(0);

    const type = await getEntityType(TENANT, undefined, 'team-member');
    expect(type?.status).toBe('published');
    expect(type?.publicRead).toBe(true);

    const rows = (await listEntities({ tenantId: TENANT, typeName: 'team-member', limit: 200 })).entities;
    expect(rows.length).toBe(6);
    expect(rows.filter((r) => r.status === 'draft').length).toBe(1);
    expect(rows.every((r) => r.createdBy === DEMO_ENTITIES_ACTOR)).toBe(true);
    expect(rows.every((r) => (r.termIds ?? []).length === 1)).toBe(true);

    // Re-run converges (deterministic ids, idempotent re-create).
    const second = await seedDemoEntities(TENANT);
    expect(second.created).toBe(0);
    expect((await listEntities({ tenantId: TENANT, typeName: 'team-member', limit: 200 })).entities.length).toBe(6);
  });

  it('clear() removes only demo-marked rows and keeps a user-authored one (type retained)', async () => {
    await createEntity({
      tenantId: TENANT,
      typeName: 'team-member',
      entityId: 'user-authored-1',
      values: { name: 'Kept Human' },
      createdBy: 'user:someone',
    });
    const r = await clearDemoEntities(TENANT);
    expect(r.cleared).toBeGreaterThan(0);
    const rows = (await listEntities({ tenantId: TENANT, typeName: 'team-member', limit: 200 })).entities;
    expect(rows.map((x) => x.entityId)).toEqual(['user-authored-1']);
    // The type survives because a user-authored row remains.
    expect(await getEntityType(TENANT, undefined, 'team-member')).not.toBeNull();
  });
});
