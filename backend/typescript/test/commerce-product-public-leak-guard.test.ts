/**
 * ADR 0410 Phase 3 — the withdraw-for-safety guard.
 *
 * Phase 3 WITHDREW the productGrid→entityList convergence: flipping `publicRead`
 * on `commerce.product` would route the storefront through the generic anonymous
 * `public-entities` read, whose `toPublicEntity` serves the kernel row's `values`
 * VERBATIM (no field allowlist). `commerce.product`'s `values` carry `cost`
 * (merchant MARGIN) and `inventory` — operational fields the purpose-built
 * `/public-store` read deliberately strips. So `publicRead` here is not a
 * lower-fidelity read, it is a merchant-confidential DATA LEAK.
 *
 * This test pins the decision two ways so a future well-meaning flip trips red:
 *   1) the invariant — `commerce.product` is NOT anonymously readable; and
 *   2) the REASON — the kernel row's `values` really do carry cost + inventory,
 *      i.e. the generic read (which projects nothing) would expose them.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { createProduct } from '../src/features/commerce/commerceService.js';
import { getEntityType, getSystemEntity, mintSystemType, putSystemEntity, updateEntityType } from '../src/features/entities/entitiesService.js';
import { readPublicEntities } from '../src/features/entities/publicRead.js';

const T = 'tenant-leak-guard';
const ORG = 'org-leak-guard';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  // The anonymous read 404s FIRST when the `entities` toggle is off (its default), before
  // it ever looks at `publicRead`. With the toggle off, (3) below passed for the wrong
  // reason (round-1 probe removing the publicRead check was vacuous). Turn it on so the
  // 404 can only come from the type gate. File-scoped registry default — no global save.
  registerToggleDefault({ id: 'entities', salt: 'entities', status: 'on', bucketUnit: 'tenant' });
});

describe('ADR 0410 Phase 3 — commerce.product must never be anonymously public (cost/inventory leak guard)', () => {
  it('keeps publicRead UNSET and 404s the anonymous read — while the row carries the confidential fields that flip would expose', async () => {
    const p = await createProduct({
      tenantId: T, orgId: ORG, createdBy: 'u1',
      type: 'physical', name: 'Guarded Roaster', price: 199.99, currency: 'USD', inventory: 12, cost: 90,
    });

    // (1) The invariant: the type is façade-only — neither public flag set.
    const type = await getEntityType(T, undefined, 'commerce.product');
    expect(type?.system).toBe(true);
    expect(type?.publicRead).toBeUndefined(); // ← the withdrawal: never flip this on
    expect(type?.neverPublic).toBeUndefined(); // eligible in principle, but NOT enabled

    // (2) The reason: the kernel row's `values` carry cost (margin) + inventory —
    // `toPublicEntity` would serve these verbatim, so publicRead == leak. (This pins the
    // REASON, not a requirement: if the kernel projection ever stops carrying cost, these
    // two lines may be deleted — the guard is (1) + (3).)
    const rec = await getSystemEntity(T, 'commerce.product', p.productId);
    expect(rec?.values.cost).toBe(90);
    expect(rec?.values.inventory).toBe(12);

    // (3) The enforcement: the anonymous read refuses the type (publicRead unset).
    // POSITIVE CONTROL first: in this same tenant a published system type WITH publicRead
    // is served — so the read is live, and the commerce.product 404 below is the type gate.
    await mintSystemType({ tenantId: T, name: 'leakguard.item', displayName: 'Item', fields: [{ key: 'name', label: 'Name', type: 'string', required: true }], actor: 'sys' });
    await updateEntityType({ tenantId: T, name: 'leakguard.item', patch: { publicRead: true }, actor: 'sys' });
    await putSystemEntity({ tenantId: T, typeName: 'leakguard.item', entityId: 'i1', values: { name: 'Public Widget' }, actor: 'sys' });
    const served = await readPublicEntities({ tenantId: T, typeName: 'leakguard.item', limit: 10 });
    expect(served.entities.map((e) => e.values.name)).toContain('Public Widget');
    await expect(readPublicEntities({ tenantId: T, typeName: 'commerce.product', limit: 10 }))
      .rejects.toMatchObject({ httpStatus: 404, code: 'not_found' });
  });
});
