/**
 * System brand (ADR 0170 Phase 2) — the reserved app-brand record. Verifies it is
 * seeded into the EXISTING reserved host-site org (not a new org), is idempotent
 * across concurrent boots, seeds sparsely (no identity husk), and is frozen against
 * re-seed once edited (ensureBrand is create-if-absent).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __clearBrands, listBrands, getBrand, ensureBrand } from '../src/features/brand/brandService.js';
import { ensureSystemBrand, getAppBrand, editAppBrand, __resetSystemBrand, SYSTEM_BRAND_ID } from '../src/host/systemBrand.js';
import { getOrg } from '../src/host/accessControlService.js';
import { SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG } from '../src/host/systemSite.js';

describe('system brand (ADR 0170)', () => {
  beforeEach(async () => {
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __clearBrands();
    __resetSystemBrand(); // drop the run-once cache so each test re-seeds fresh storage
  });

  it('seeds the reserved brand in the existing host-site org (no new reserved org)', async () => {
    const b = await ensureSystemBrand();
    expect(b.id).toBe(SYSTEM_BRAND_ID);
    expect(b.tenantId).toBe(SYSTEM_SITE_TENANT);
    expect(b.orgId).toBe(SYSTEM_SITE_ORG); // reuses the system-site org
    const org = await getOrg(SYSTEM_SITE_ORG);
    expect(org?.orgId).toBe(SYSTEM_SITE_ORG);
  });

  it('seeds sparsely — no identity husk on a fresh install', async () => {
    const b = await ensureSystemBrand();
    expect(b.identity).toBeUndefined(); // SPA falls back to its build-time brand
  });

  it('is idempotent — concurrent ensures converge on one record', async () => {
    const [a, b, c] = await Promise.all([ensureSystemBrand(), ensureSystemBrand(), ensureSystemBrand()]);
    expect(a.id).toBe(b.id);
    expect(b.id).toBe(c.id);
    const all = await listBrands(SYSTEM_SITE_TENANT);
    expect(all.filter((x) => x.id === SYSTEM_BRAND_ID)).toHaveLength(1); // no duplicate
  });

  it('is invisible to a normal tenant (reserved host: tenant)', async () => {
    await ensureSystemBrand();
    expect(await listBrands('user:alice')).toEqual([]); // tenant-prefixed scan excludes host:site
    expect(await getBrand('user:alice', SYSTEM_BRAND_ID)).toBeNull();
  });

  it('persists a super-admin edit and getAppBrand reflects it (fresh re-read)', async () => {
    await ensureSystemBrand();
    const edited = await editAppBrand({ identity: { productName: 'Acme', colors: { accent: '#abc' } } }, 'super:1');
    expect(edited.identity?.productName).toBe('Acme');
    expect((await getAppBrand()).identity?.productName).toBe('Acme'); // re-read, not stale cache
  });

  it('freeze guarantee — ensureBrand never clobbers an edited record', async () => {
    await ensureSystemBrand();
    await editAppBrand({ identity: { productName: 'Acme' } }, 'super:1');
    // a fresh boot path: ensureBrand on the same id must return the EDITED record untouched
    const reseeded = await ensureBrand(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, SYSTEM_BRAND_ID, 'system', {
      name: 'App identity',
    });
    expect(reseeded.identity?.productName).toBe('Acme'); // create-if-absent left it alone
  });
});
