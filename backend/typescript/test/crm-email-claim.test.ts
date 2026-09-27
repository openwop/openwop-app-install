/**
 * ADR 0627 D6 (`CRM-22`) — the primary-email uniqueness claim
 * (`crm:contactkeyclaim`, insert-only CAS in `createContact`).
 *
 * Every case asserts an OUTCOME (row count, the id both racers received, the
 * 409's `details.existingContactId`), never that a claim row exists — a claim
 * that exists but does not gate would pass a row-exists assertion.
 *
 * SABOTAGE MAP (each case is pinned to one mechanism):
 *  - replace the `compareAndSwap(null, …)` claim in `createContact` with a plain
 *    `put` → "concurrent creates" goes red (two rows land);
 *  - drop the 409 → "duplicate → 409" red;
 *  - drop the `ensureContact` catch → "ensureContact race" red;
 *  - drop the release in `deleteContact` → "delete releases" red (phantom 409);
 *  - drop `repointContactKeyClaimForMerge` → both merge cases red;
 *  - (review B1) make a MISSING holder row read as stale again (drop the
 *    `claimedAt` grace in `claimHolderIsLive`) → "WRITE LATENCY" red (two rows);
 *  - (review S1) let the email PATCH claim best-effort → "PATCH onto a held
 *    address" red; (review S2) drop the ident-index check in
 *    `claimPrimaryEmailOrThrow` → "legacy unclaimed row" + the merge-release
 *    case red.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createContact, ensureContact, listContacts, deleteContact, updateContact, getContactKeyClaim, duplicateEmailContactIdOf,
  CLAIM_INFLIGHT_GRACE_MS,
} from '../src/features/crm/contactsService.js';
import type { Storage } from '../src/storage/storage.js';
import { mergeContacts, unmergeContacts } from '../src/features/crm/crmMergeService.js';
import { listMergeEvents } from '../src/features/crm/crmMergeEventsService.js';
import { OpenwopError } from '../src/types.js';

const T = 'tenant-email-claim';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (err) { return err; }
  return null;
}

describe('ADR 0627 D6 — createContact claims the primary email', () => {
  it('a duplicate (case-folded) → 409 validation_error naming the existing contact; exactly one row', async () => {
    const first = await createContact({ tenantId: T, name: 'Ada', email: 'Ada@Acme.Test' });
    const err = await rejection(createContact({ tenantId: T, name: 'Ada Again', email: 'ada@acme.test' }));
    expect(err).toBeInstanceOf(OpenwopError);
    const e = err as OpenwopError;
    expect(e.httpStatus).toBe(409);
    expect(e.code).toBe('validation_error');
    expect(e.details?.existingContactId).toBe(first.contactId);
    expect(duplicateEmailContactIdOf(err), 'the helper the adopt lanes use reads the same shape').toBe(first.contactId);
    expect(await listContacts(T)).toHaveLength(1);
  });

  it('is tenant-scoped: the same address in another tenant is a fresh row', async () => {
    await createContact({ tenantId: T, name: 'Mine', email: 'shared@acme.test' });
    const theirs = await createContact({ tenantId: 'tenant-other', name: 'Theirs', email: 'shared@acme.test' });
    expect(theirs.tenantId).toBe('tenant-other');
  });

  it('no email ⇒ no claim: email-less contacts never collide', async () => {
    await createContact({ tenantId: T, name: 'A' });
    await createContact({ tenantId: T, name: 'B' });
    expect(await listContacts(T)).toHaveLength(2);
  });

  it('a SECONDARY identifiers[] email is NOT claimed, yet a create at it is refused by the ident index naming its holder (review S2)', async () => {
    const holder = await createContact({ tenantId: T, name: 'Holder', email: 'primary@acme.test', identifiers: [{ type: 'email', value: 'alias@acme.test', source: 'manual' }] });
    expect(await getContactKeyClaim(T, 'alias@acme.test'), 'no claim row for a secondary').toBeNull();
    const err = await rejection(createContact({ tenantId: T, name: 'Alias Owner', email: 'alias@acme.test' }));
    expect((err as OpenwopError).httpStatus).toBe(409);
    expect(duplicateEmailContactIdOf(err)).toBe(holder.contactId);
    expect(await getContactKeyClaim(T, 'alias@acme.test'), 'the refused create left no claim behind').toBeNull();
    expect((await ensureContact({ tenantId: T, email: 'alias@acme.test' }))?.contactId).toBe(holder.contactId);
  });

  it('CONCURRENT creates for the same address → exactly one row + one 409 (the insert-only CAS)', async () => {
    const results = await Promise.allSettled([
      createContact({ tenantId: T, name: 'Racer 1', email: 'race@acme.test' }),
      createContact({ tenantId: T, name: 'Racer 2', email: 'race@acme.test' }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won, 'exactly one create wins').toHaveLength(1);
    expect(lost, 'exactly one create loses').toHaveLength(1);
    const winnerId = (won[0] as PromiseFulfilledResult<{ contactId: string }>).value.contactId;
    expect(duplicateEmailContactIdOf((lost[0] as PromiseRejectedResult).reason)).toBe(winnerId);
    expect(await listContacts(T)).toHaveLength(1);
  });

  it('ensureContact race → ONE row, BOTH callers get the same id (the 409 → survivor map)', async () => {
    const [a, b] = await Promise.all([
      ensureContact({ tenantId: T, email: 'guest@acme.test', name: 'Guest A' }),
      ensureContact({ tenantId: T, email: 'guest@acme.test', name: 'Guest B' }),
    ]);
    expect(a?.contactId).toBeTruthy();
    expect(a?.contactId).toBe(b?.contactId);
    expect(await listContacts(T)).toHaveLength(1);
  });
});

describe('ADR 0627 D6 — the claim follows the PRIMARY holder (lifecycle decision)', () => {
  it('deleteContact releases: the address can be re-created (no phantom 409)', async () => {
    const c = await createContact({ tenantId: T, name: 'Gone', email: 'gone@acme.test' });
    await deleteContact(c.contactId);
    expect(await getContactKeyClaim(T, 'gone@acme.test')).toBeNull();
    const again = await createContact({ tenantId: T, name: 'Back', email: 'gone@acme.test' });
    expect(again.contactId).not.toBe(c.contactId);
  });

  it('an email PATCH releases the old primary (re-creatable) and CLAIMS the new one', async () => {
    const c = await createContact({ tenantId: T, name: 'Mover', email: 'old@acme.test' });
    await updateContact(c.contactId, { email: 'new@acme.test' });
    expect(await getContactKeyClaim(T, 'old@acme.test')).toBeNull();
    expect(await getContactKeyClaim(T, 'new@acme.test')).toMatchObject({ contactId: c.contactId });
    await createContact({ tenantId: T, name: 'Old Reused', email: 'old@acme.test' }); // no 409
    const err = await rejection(createContact({ tenantId: T, name: 'New Dup', email: 'new@acme.test' }));
    expect((err as OpenwopError).httpStatus).toBe(409);
  });

  it('an email PATCH onto a held address is the SAME 409 (review S1 — the PATCH lane must not mint the duplicate the create lane refuses)', async () => {
    const holder = await createContact({ tenantId: T, name: 'Holder', email: 'held@acme.test' });
    const mover = await createContact({ tenantId: T, name: 'Mover', email: 'mover@acme.test' });
    const err = await rejection(updateContact(mover.contactId, { email: 'held@acme.test' }));
    expect((err as OpenwopError).httpStatus).toBe(409);
    expect(duplicateEmailContactIdOf(err)).toBe(holder.contactId);
    // Nothing moved: the mover keeps its address AND its claim; the holder keeps its own.
    expect((await listContacts(T)).find((x) => x.contactId === mover.contactId)?.email).toBe('mover@acme.test');
    expect(await getContactKeyClaim(T, 'mover@acme.test')).toMatchObject({ contactId: mover.contactId });
    expect(await getContactKeyClaim(T, 'held@acme.test')).toMatchObject({ contactId: holder.contactId });
    // A value-equal / case-only re-PATCH of its OWN address is not a collision.
    await updateContact(mover.contactId, { email: 'Mover@Acme.Test' });
    expect(await getContactKeyClaim(T, 'mover@acme.test')).toMatchObject({ contactId: mover.contactId });
  });

  it('MERGE where the survivor ADOPTS the source email → the claim re-points to the survivor', async () => {
    const survivor = await createContact({ tenantId: T, name: 'Keep' }); // no email
    const source = await createContact({ tenantId: T, name: 'Dup', email: 'adopted@acme.test' });
    const merged = await mergeContacts(T, survivor.contactId, source.contactId);
    expect(merged.email).toBe('adopted@acme.test');
    expect(await getContactKeyClaim(T, 'adopted@acme.test')).toMatchObject({ contactId: survivor.contactId });
    const err = await rejection(createContact({ tenantId: T, name: 'Again', email: 'adopted@acme.test' }));
    expect((err as OpenwopError).httpStatus).toBe(409);
    expect((err as OpenwopError).details?.existingContactId, 'the 409 names the SURVIVOR, not the tombstone').toBe(survivor.contactId);
  });

  it('MERGE where the survivor keeps its own email → the source claim is RELEASED, yet the address stays the survivor\'s (review S2: the ident index is the identity SSoT a create must respect)', async () => {
    const survivor = await createContact({ tenantId: T, name: 'Keep', email: 'keep@acme.test' });
    const source = await createContact({ tenantId: T, name: 'Dup', email: 'absorbed@acme.test' });
    await mergeContacts(T, survivor.contactId, source.contactId);
    expect(await getContactKeyClaim(T, 'absorbed@acme.test'), 'released — the address is now a secondary identifier of the survivor').toBeNull();
    expect(await getContactKeyClaim(T, 'keep@acme.test')).toMatchObject({ contactId: survivor.contactId });
    // ensureContact resolves the absorbed address to the survivor (ident index) …
    expect((await ensureContact({ tenantId: T, email: 'absorbed@acme.test' }))?.contactId).toBe(survivor.contactId);
    // … and a DIRECT create at that address is refused NAMING the survivor: the
    // first cut let it through, and `reindexContact`'s plain put then re-pointed
    // the index at the new row — the survivor silently lost its identity.
    const err = await rejection(createContact({ tenantId: T, name: 'Fresh', email: 'absorbed@acme.test' }));
    expect((err as OpenwopError).httpStatus).toBe(409);
    expect(duplicateEmailContactIdOf(err)).toBe(survivor.contactId);
    expect((await ensureContact({ tenantId: T, email: 'absorbed@acme.test' }))?.contactId, 'the survivor still owns the address').toBe(survivor.contactId);
    expect(await getContactKeyClaim(T, 'absorbed@acme.test'), 'the refused create released the claim it had just taken').toBeNull();
  });

  it('a LEGACY (pre-claim, unclaimed) contact is protected by the ident index alone (review S2)', async () => {
    const legacy = await createContact({ tenantId: T, name: 'Legacy', email: 'legacy@acme.test' });
    const { hostExtStorage } = await import('../src/host/hostExtPersistence.js');
    // Rows written before the claim existed have an index entry and NO claim row.
    await hostExtStorage().kvDelete(`hostext:crm:contactkeyclaim:${T}::email::legacy@acme.test`);
    expect(await getContactKeyClaim(T, 'legacy@acme.test')).toBeNull();
    const err = await rejection(createContact({ tenantId: T, name: 'Newer', email: 'legacy@acme.test' }));
    expect((err as OpenwopError).httpStatus).toBe(409);
    expect(duplicateEmailContactIdOf(err)).toBe(legacy.contactId);
    expect(await listContacts(T)).toHaveLength(1);
  });

  it('UNMERGE re-claims for the restored source', async () => {
    const survivor = await createContact({ tenantId: T, name: 'Keep' });
    const source = await createContact({ tenantId: T, name: 'Dup', email: 'restore@acme.test' });
    await mergeContacts(T, survivor.contactId, source.contactId);
    const [ev] = await listMergeEvents(T);
    await unmergeContacts(T, ev!.mergeEventId);
    expect(await getContactKeyClaim(T, 'restore@acme.test')).toMatchObject({ contactId: source.contactId });
    const err = await rejection(createContact({ tenantId: T, name: 'Again', email: 'restore@acme.test' }));
    expect(duplicateEmailContactIdOf(err)).toBe(source.contactId);
  });

  it('a claim whose holder row is MISSING is IN FLIGHT inside the grace window (409), and a phantom older than the window is taken over (review B1)', async () => {
    // Simulate a crash between claim and put: claim exists, holder row does not.
    const c = await createContact({ tenantId: T, name: 'Crash', email: 'stale@acme.test' });
    const { hostExtStorage } = await import('../src/host/hostExtPersistence.js');
    await hostExtStorage().kvDelete(`hostext:crm:contact:${c.contactId}`);
    // Fresh claim, no row: this is what a concurrent create looks like between
    // its claim and its put — it MUST read as live, never be taken over.
    const early = await rejection(createContact({ tenantId: T, name: 'Too Soon', email: 'stale@acme.test' }));
    expect((early as OpenwopError)?.httpStatus, 'inside the grace window the missing holder is in flight').toBe(409);
    // Age the claim past the window: now it is a phantom and is taken over.
    const claimKey = `hostext:crm:contactkeyclaim:${T}::email::stale@acme.test`;
    const raw = JSON.parse((await hostExtStorage().kvGet(claimKey))!);
    await hostExtStorage().kvSet(claimKey, JSON.stringify({ ...raw, claimedAt: new Date(Date.now() - CLAIM_INFLIGHT_GRACE_MS - 1000).toISOString() }));
    const again = await createContact({ tenantId: T, name: 'Recovered', email: 'stale@acme.test' });
    expect(await getContactKeyClaim(T, 'stale@acme.test')).toMatchObject({ contactId: again.contactId });
  });

  it('WRITE LATENCY: concurrent creates with a slow kvSet still land exactly one row (review B1 — the in-process store hid the takeover)', async () => {
    const real = await openStorage('memory://');
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const storage = new Proxy(real, {
      get(t: Storage, p: string | symbol) {
        const v = (t as unknown as Record<string | symbol, unknown>)[p];
        if (typeof v !== 'function') return v;
        if (p === 'kvSet') return async (...a: unknown[]) => { await delay(5); return (v as (...x: unknown[]) => unknown).apply(t, a); };
        return (v as (...x: unknown[]) => unknown).bind(t);
      },
    });
    initHostExtPersistence(storage);
    const results = await Promise.allSettled([
      createContact({ tenantId: T, name: 'Racer 1', email: 'slow@acme.test' }),
      createContact({ tenantId: T, name: 'Racer 2', email: 'slow@acme.test' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled'), 'exactly one create wins under latency').toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await listContacts(T)).toHaveLength(1);
    const winnerId = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ contactId: string }>).value.contactId;
    expect(await getContactKeyClaim(T, 'slow@acme.test')).toMatchObject({ contactId: winnerId });
  });
});
