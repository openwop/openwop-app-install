/**
 * ADR 0668 D1 (CMSLWF-13) — the ADR 0593 §C9 cross-tenant section guard applies to BOTH
 * axes (base `data` and localization overlays) on ALL FOUR write lanes.
 *
 * Born red: legs 2, 3 and 4 all ACCEPTED a foreign `tenantId`, and leg 5 measured the
 * consequence — a reader sending `Accept-Language: es` was served `tenantId: FOREIGN`.
 * Leg 1 was green before and must stay green.
 *
 * Legs 3 and 4 exist because the FIRST draft of this ADR's boundaries audit declared the
 * shared-section lane safe. It is not: `createSharedSection`/`updateSharedSection` never
 * call `validateSection`, so the guard had never run there on EITHER axis — and
 * `resolveSharedRefs` serves one poisoned shared section into every referencing page.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  validateSection, createPage, updatePage, createSharedSection, updateSharedSection,
} from '../src/features/cms/cmsService.js';
import { resolveSection } from '../src/host/i18n/resolveSection.js';

const MINE = 'tMine';
const FOREIGN = 'tForeign';
const ORG = 'org-1';
const entitySection = (dataTenant: string, overlayTenant?: string): Record<string, unknown> => ({
  type: 'entityList',
  data: { tenantId: dataTenant, typeName: 'product', titleField: 'name' },
  ...(overlayTenant ? { localizations: { es: { tenantId: overlayTenant } } } : {}),
});

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

describe('ADR 0668 D1 — the tenant guard covers both axes', () => {
  it('leg 1: the BASE axis still refuses a foreign tenant (ADR 0593 §C9, must not regress)', () => {
    expect(() => validateSection(entitySection(FOREIGN), 'en', MINE)).toThrow(/own workspace/i);
    expect(() => validateSection(entitySection(MINE), 'en', MINE), 'own tenant still accepted').not.toThrow();
  });

  it('leg 2: the OVERLAY axis refuses the SAME value the base axis refuses', () => {
    expect(() => validateSection(entitySection(MINE, FOREIGN), 'en', MINE)).toThrow(/own workspace/i);
    // Parity, not strictness: an overlay naming no tenant inherits the base and stays legal,
    // and an overlay restating this page's own tenant is accepted exactly as the base is.
    expect(() => validateSection({ type: 'entityList', data: { tenantId: MINE, typeName: 'p', titleField: 'n' }, localizations: { es: { titleField: 'nombre' } } }, 'en', MINE)).not.toThrow();
    expect(() => validateSection(entitySection(MINE, MINE), 'en', MINE)).not.toThrow();
  });

  it('leg 3: the SHARED-SECTION create lane refuses on BOTH axes', async () => {
    await expect(createSharedSection(MINE, ORG, {
      name: 'Foreign base', type: 'entityList',
      data: { tenantId: FOREIGN, typeName: 'product', titleField: 'name' },
    }, 'u1')).rejects.toThrow(/own workspace/i);

    await expect(createSharedSection(MINE, ORG, {
      name: 'Foreign overlay', type: 'entityList',
      data: { tenantId: MINE, typeName: 'product', titleField: 'name' },
      localizations: { es: { tenantId: FOREIGN } },
    }, 'u1')).rejects.toThrow(/own workspace/i);

    // ...and an honest shared section still saves.
    const ok = await createSharedSection(MINE, ORG, {
      name: 'Honest', type: 'entityList',
      data: { tenantId: MINE, typeName: 'product', titleField: 'name' },
    }, 'u1');
    expect(ok.sharedSectionId).toMatch(/^shsec:/);
  });

  it('leg 4: the SHARED-SECTION update lane refuses on BOTH axes', async () => {
    const s = await createSharedSection(MINE, ORG, {
      name: 'Honest', type: 'entityList',
      data: { tenantId: MINE, typeName: 'product', titleField: 'name' },
    }, 'u1');
    await expect(updateSharedSection(MINE, ORG, s.sharedSectionId, {
      data: { tenantId: FOREIGN, typeName: 'product', titleField: 'name' },
    }, 'u1')).rejects.toThrow(/own workspace/i);
    await expect(updateSharedSection(MINE, ORG, s.sharedSectionId, {
      localizations: { es: { tenantId: FOREIGN } },
    }, 'u1')).rejects.toThrow(/own workspace/i);
  });

  it('leg 5: the DELIVERED consequence — no locale can serve another workspace', async () => {
    // The measured defect: es delivered tenantId=FOREIGN while en delivered MINE.
    // Nothing may now construct that state through a page write...
    await expect(createPage({
      tenantId: MINE, orgId: ORG, title: 'P', createdBy: 'u1',
      sections: [entitySection(MINE, FOREIGN)],
    })).rejects.toThrow(/own workspace/i);

    // ...and an honest page resolves to its OWN tenant in every locale.
    const page = await createPage({
      tenantId: MINE, orgId: ORG, title: 'P2', createdBy: 'u1',
      sections: [{ type: 'entityList', data: { tenantId: MINE, typeName: 'product', titleField: 'name' }, localizations: { es: { titleField: 'nombre' } } }],
    });
    const sec = page.sections[0] as never;
    expect((resolveSection(sec, 'en', 'en') as Record<string, unknown>).tenantId).toBe(MINE);
    expect((resolveSection(sec, 'es', 'en') as Record<string, unknown>).tenantId,
      'the es reader gets THIS workspace, not another').toBe(MINE);
  });

  it('leg 6: the PATCH lane refuses a foreign overlay on an existing page', async () => {
    const page = await createPage({
      tenantId: MINE, orgId: ORG, title: 'P3', createdBy: 'u1',
      sections: [entitySection(MINE)],
    });
    await expect(updatePage(MINE, ORG, page.pageId, {
      sections: [entitySection(MINE, FOREIGN)],
    }, 'u1')).rejects.toThrow(/own workspace/i);
  });
});
