/**
 * CRM-2 — first-class Company firmographics (size / revenue) + the employees→size backfill.
 * Additive optional fields on the KV-blob Company (no SQL migration); fail-closed validation;
 * null-clears; APP_MIGRATION 4 lifts legacy `customFields.employees` onto `size`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createCompany, updateCompany, getCompany, backfillCompanySizeFromEmployees } from '../src/features/crm/entities/companies.js';

const T = 'tA';
const ORG = 'org:1';
const mk = (over: Record<string, unknown> = {}) => createCompany({ tenantId: T, orgId: ORG, name: 'Acme', createdBy: 'u', ...over });

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

describe('CRM-2 — company size/revenue', () => {
  it('persists size + revenue on create and reads them back', async () => {
    const c = await mk({ size: 240, revenue: 12_500_000 });
    const got = await getCompany(T, ORG, c.companyId);
    expect(got).toMatchObject({ size: 240, revenue: 12_500_000 });
  });

  it('validates fail-closed: non-integer/negative size and negative revenue 400', async () => {
    await expect(mk({ size: 12.5 })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(mk({ size: -3 })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(mk({ revenue: -1 })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('update sets values and an explicit null clears them', async () => {
    const c = await mk({ size: 10 });
    await updateCompany(T, ORG, c.companyId, { size: 50, revenue: 900000 });
    expect(await getCompany(T, ORG, c.companyId)).toMatchObject({ size: 50, revenue: 900000 });
    await updateCompany(T, ORG, c.companyId, { size: null, revenue: null });
    const cleared = await getCompany(T, ORG, c.companyId);
    expect(cleared!.size).toBeUndefined();
    expect(cleared!.revenue).toBeUndefined();
  });

  it('APP_MIGRATION 4 lifts customFields.employees → size, drops the customField, idempotent', async () => {
    const c = await mk({ customFields: { employees: 88, region: 'EU' } });
    const n = await backfillCompanySizeFromEmployees();
    expect(n).toBe(1);
    const got = await getCompany(T, ORG, c.companyId);
    expect(got!.size).toBe(88);
    expect(got!.customFields.employees).toBeUndefined(); // customField dropped
    expect(got!.customFields.region).toBe('EU');         // other customFields kept
    // idempotent: a re-run touches nothing (size already present)
    expect(await backfillCompanySizeFromEmployees()).toBe(0);
  });

  it('backfill skips a row that already has a first-class size (no clobber)', async () => {
    await mk({ size: 5, customFields: { employees: 999 } });
    expect(await backfillCompanySizeFromEmployees()).toBe(0);
  });

  it('backfill does NOT lift a non-conforming employees (float/negative) — the size invariant holds', async () => {
    const flt = await mk({ customFields: { employees: 12.5 } });   // float — not a valid size
    const neg = await mk({ customFields: { employees: -5 } });      // negative — not a valid size
    expect(await backfillCompanySizeFromEmployees()).toBe(0);       // neither lifted
    const gotFlt = await getCompany(T, ORG, flt.companyId);
    expect(gotFlt!.size).toBeUndefined();                           // no invalid size written
    expect(gotFlt!.customFields.employees).toBe(12.5);             // left in place
    expect((await getCompany(T, ORG, neg.companyId))!.size).toBeUndefined();
  });
});
