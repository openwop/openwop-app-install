/**
 * CRM-3 (ADR 0212 §4) — first-class CSM account commercial depth (renewalDate / arr / owner).
 * Additive optional fields on the KV-blob Account (no migration); fail-closed validation;
 * null-clears on update; they flow through the surface projection to reads.
 *
 * Red if (grade-tests w7 probes): a negative `arr` or an unparseable `renewalDate` is
 * accepted (depth-arr-neg, depth-date); create drops `owner`/`renewalDate`
 * (depth-owner-create, depth-renewal-create); an explicit `null` on update stops
 * clearing (depth-owner-null). Internal-column stripping is csm-feature.test.ts's claim;
 * the two OWNER fields are this file's: they are stored, and the surface read (the run
 * lane, recorded in the run-event log) never carries `owner` or `ownerUserId`
 * (ADR 0882 D3, CSM2CD-5).
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
    await expect(createAccount({ tenantId: T, name: 'X', arr: -1 }))
      .rejects.toMatchObject({ code: 'validation_error', details: { field: 'arr' } });
    await expect(createAccount({ tenantId: T, name: 'X', renewalDate: 'not-a-date' }))
      .rejects.toMatchObject({ code: 'validation_error', details: { field: 'renewalDate' } });
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
    const a = await createAccount({ tenantId: T, name: 'Acme', arr: 90000, renewalDate: '2027-06-01', owner: 'Dana Cs-Lead', ownerUserId: 'user:cs-owner' });
    // Control: both owner fields ARE stored, so their absence below is the
    // projection's doing, not a write that dropped them.
    expect(await getAccountForTenant(T, a.accountId)).toMatchObject({ owner: 'Dana Cs-Lead', ownerUserId: 'user:cs-owner' });
    const surface = buildCsmSurface({ tenantId: T });
    const out = await surface.listAccounts!({}) as { accounts: Array<Record<string, unknown>> };
    expect(out.accounts).toHaveLength(1);
    expect(out.accounts[0]).toMatchObject({ accountId: a.accountId, arr: 90000, renewalDate: '2027-06-01' });
    // ADR 0882 D3 (CSM2CD-5) — the owner is a person, as a typed name (`owner`)
    // or a member id (`ownerUserId`): read outputs are recorded in the run-event
    // log and reach model context, so the run lane carries neither.
    expect(out.accounts[0]).not.toHaveProperty('owner');
    expect(out.accounts[0]).not.toHaveProperty('ownerUserId');
  });
});
