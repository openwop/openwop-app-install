/**
 * ADR 1110 P4 — the per-org product cap is a deployment setting.
 *
 * Pins: the setting sets the cap, and the refusal names the setting; an unset value is
 * the 5,000 default; a value outside 1..500,000 (or not a whole number) is logged and
 * falls back to the default, never raising the cap.
 *
 * Sabotage, each restored, each red: the cap read from `MAX.perOrg` again (the setting
 * case); a bad value used as-is (the 600000 case).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { __forgetCatalogIndexReady, createProduct, maxProductsPerOrg, PRODUCT_CAP_SETTING } from '../src/features/commerce/commerceService.js';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  __forgetCatalogIndexReady();
});
afterEach(() => { delete process.env[PRODUCT_CAP_SETTING]; });

describe('ADR 1110 P4 — the product cap setting', () => {
  it('the setting sets the cap, and the refusal names it', async () => {
    process.env[PRODUCT_CAP_SETTING] = '2';
    const mk = (name: string) => createProduct({ tenantId: 'tenant-cap', orgId: 'org-cap', createdBy: 'u', type: 'digital', name, price: 1, currency: 'USD' });
    await mk('one');
    await mk('two');
    await expect(mk('three')).rejects.toMatchObject({ httpStatus: 409, details: { max: 2, setting: PRODUCT_CAP_SETTING } });
  });

  it('unset is the default; a bad value falls back to it and never raises the cap', () => {
    expect(maxProductsPerOrg()).toBe(5000);
    process.env[PRODUCT_CAP_SETTING] = '500000';
    expect(maxProductsPerOrg()).toBe(500_000);
    for (const bad of ['600000', '0', '-5', '12.5', 'lots']) {
      process.env[PRODUCT_CAP_SETTING] = bad;
      expect(maxProductsPerOrg(), bad).toBe(5000);
    }
  });
});
