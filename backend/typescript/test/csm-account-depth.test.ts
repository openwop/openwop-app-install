/**
 * CRM-3 — first-class CSM account commercial depth (renewalDate / arr / owner).
 * Additive optional fields on the KV-blob Account (no migration); fail-closed validation;
 * null-clears on update; they flow through the surface projection to reads.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createAccount, updateAccount, getAccountForTenant, __resetCsmStore } from '../src/features/csm/accountsService.js';
import { buildCsmSurface } from '../src/features/csm/surface.js';

const T = 'tA';

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __resetCsmStore();
});

describe('CRM-3 — CSM account depth', () => {
  it('persists renewalDate / arr / owner on create and reads them back', async () => {
    const a = await createAccount({ tenantId: T, name: 'Acme', renewalDate: '2027-01-31', arr: 48000, owner: 'user:cs-lead' });
    const got = await getAccountForTenant(T, a.accountId);
    expect(got).toMatchObject({ renewalDate: '2027-01-31', arr: 48000, owner: 'user:cs-lead' });
  });

  it('validates fail-closed: a negative arr and a non-date renewalDate 400', async () => {
    await expect(createAccount({ tenantId: T, name: 'X', arr: -1 })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(createAccount({ tenantId: T, name: 'X', renewalDate: 'not-a-date' })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('update sets a value, and an explicit null clears it', async () => {
    const a = await createAccount({ tenantId: T, name: 'Acme', arr: 1000 });
    await updateAccount(a.accountId, { arr: 5000, owner: 'user:new' });
    expect(await getAccountForTenant(T, a.accountId)).toMatchObject({ arr: 5000, owner: 'user:new' });
    await updateAccount(a.accountId, { arr: null, owner: null });
    const cleared = await getAccountForTenant(T, a.accountId);
    expect(cleared!.arr).toBeUndefined();
    expect(cleared!.owner).toBeUndefined();
  });

  it('flows through the surface projection to reads', async () => {
    await createAccount({ tenantId: T, name: 'Acme', arr: 90000, renewalDate: '2027-06-01', owner: 'user:cs' });
    const surface = buildCsmSurface({ tenantId: T } as Parameters<typeof buildCsmSurface>[0]);
    const out = await surface.listAccounts!({}) as { accounts: Array<Record<string, unknown>> };
    expect(out.accounts[0]).toMatchObject({ arr: 90000, renewalDate: '2027-06-01', owner: 'user:cs' });
    // internal columns still stripped
    expect(out.accounts[0]).not.toHaveProperty('tenantId');
  });
});
