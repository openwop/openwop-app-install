/**
 * ADR 0409 Phase 1 — the `neverPublic` guard: a system type flagged
 * `neverPublic` (CRM records) can NEVER be served by the anonymous
 * public-entities surface. Two locks, both pinned here:
 *   lock 1 — `updateEntityType` refuses to set `publicRead` on it;
 *   lock 2 — the anonymous gate refuses it OUTRIGHT even if `publicRead` were
 *            force-set (constructed here via the re-mint path).
 * Plus a positive control: a NON-neverPublic system type still works publicly
 * (cms.page's ADR 0408 Phase D publicRead is not regressed).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  mintSystemType, putSystemEntity, updateEntityType, getEntityType,
} from '../src/features/entities/entitiesService.js';
import { readPublicEntities } from '../src/features/entities/publicRead.js';

const T = 'tenant-neverpublic';
const ON = { status: 'on' as const, bucketUnit: 'tenant' as const };
const FIELDS = [{ key: 'name', label: 'Name', type: 'string', required: true }];

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerToggleDefault({ id: 'entities', salt: 'entities', ...ON });
  await saveConfig({ id: 'entities', salt: 'entities', ...ON }, 'test');
});

const read = (typeName: string) => readPublicEntities({ tenantId: T, typeName, limit: 10 });

describe('ADR 0409 Phase 1 — neverPublic guard', () => {
  it('mints a neverPublic type and NEVER serves it anonymously (default publicRead unset)', async () => {
    const type = await mintSystemType({ tenantId: T, name: 'crm.contact', displayName: 'Contact', fields: FIELDS, neverPublic: true, actor: 'sys' });
    expect(type.neverPublic).toBe(true);
    await putSystemEntity({ tenantId: T, typeName: 'crm.contact', entityId: 'c1', values: { name: 'Ada Lovelace' }, actor: 'sys' });
    await expect(read('crm.contact')).rejects.toMatchObject({ httpStatus: 404, code: 'not_found' });
  });

  it('lock 1 — updateEntityType refuses to set publicRead on a neverPublic type', async () => {
    await expect(updateEntityType({ tenantId: T, name: 'crm.contact', patch: { publicRead: true }, actor: 'sys' }))
      .rejects.toThrow(/never be made publicly readable/);
    // Still 404 afterward — the flag never took.
    await expect(read('crm.contact')).rejects.toMatchObject({ httpStatus: 404, code: 'not_found' });
  });

  it('lock 2 — the anonymous gate refuses a neverPublic type EVEN IF publicRead is force-set', async () => {
    // Construct the "impossible" state: a non-neverPublic type gets publicRead,
    // then a re-mint stamps neverPublic on top (carrying publicRead forward).
    await mintSystemType({ tenantId: T, name: 'crm.deal', displayName: 'Deal', fields: FIELDS, actor: 'sys' });
    await updateEntityType({ tenantId: T, name: 'crm.deal', patch: { publicRead: true }, actor: 'sys' });
    await mintSystemType({ tenantId: T, name: 'crm.deal', displayName: 'Deal', fields: FIELDS, neverPublic: true, actor: 'sys' });
    const forced = await getEntityType(T, undefined, 'crm.deal');
    expect(forced?.publicRead).toBe(true);   // publicRead really is set…
    expect(forced?.neverPublic).toBe(true);  // …and neverPublic too
    await putSystemEntity({ tenantId: T, typeName: 'crm.deal', entityId: 'd1', values: { name: 'Big Deal' }, actor: 'sys' });
    await expect(read('crm.deal')).rejects.toMatchObject({ httpStatus: 404, code: 'not_found' }); // lock 2 wins
  });

  it('positive control — a NON-neverPublic system type is still served publicly (no regression)', async () => {
    await mintSystemType({ tenantId: T, name: 'shop.item', displayName: 'Item', fields: FIELDS, actor: 'sys' });
    await updateEntityType({ tenantId: T, name: 'shop.item', patch: { publicRead: true }, actor: 'sys' });
    await putSystemEntity({ tenantId: T, typeName: 'shop.item', entityId: 'i1', values: { name: 'Widget' }, actor: 'sys' });
    const res = await read('shop.item');
    expect(res.entities.map((e) => e.values.name)).toContain('Widget');
  });
});
