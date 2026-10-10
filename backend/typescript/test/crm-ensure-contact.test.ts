/**
 * ADR 0449 P1 — the shared `ensureContact` seam. Pins the find-or-create
 * contract that commerce checkout + webinars now share (and KickTodo will be
 * the third consumer of): D3 privacy floor (no email ⇒ no contact), no
 * duplicate on re-ensure, leadSource + name fallback, and merge-awareness
 * (a re-ensure after a merge resolves to the survivor, never a new row).
 *
 * Sabotage-witnessed (w4 grade-tests): dropping the no-email floor reds case 1;
 * a non-email name fallback reds case 3; a bare `getContact` in place of the
 * survivor follow reds the merge case (the index row is pinned at the tombstone
 * first — a merge's own `reindexContact` otherwise re-points it at the survivor
 * and the follow is never exercised); a tenant-blind identity-index key reds the
 * tenant case (the other tenant's index entry is read back).
 *
 * Double guard (recorded ceiling): "creates once, then finds" holds whether the
 * find-first runs or the 409 → survivor adoption catches the second create — both
 * return the same row with `created:false`, so neither layer is observable alone.
 * The adoption path is witnessed on its own by `crm-email-claim.test.ts` ›
 * "ensureContact race".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { hostExtStorage, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { resolveContactIdByIdentifier } from '../src/features/crm/contactIdentityService.js';
import { ensureContact, createContact, findContactByEmail } from '../src/features/crm/contactsService.js';
import { mergeContacts } from '../src/features/crm/crmMergeService.js';

const T = 'tA';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('ensureContact (ADR 0449 P1)', () => {
  it('returns null when no email — the D3 privacy floor (no speculative PII)', async () => {
    expect(await ensureContact({ tenantId: T, name: 'Anon' })).toBeNull();
    expect(await ensureContact({ tenantId: T, email: '  ' })).toBeNull();
    expect(await ensureContact({ tenantId: T, email: null })).toBeNull();
  });

  it('creates once, then finds — never a duplicate on re-ensure', async () => {
    const a = await ensureContact({ tenantId: T, email: 'Jo@X.test', name: 'Jo', leadSource: 'kicktodo' });
    expect(a?.email).toBe('Jo@X.test');
    expect(a?.leadSource).toBe('kicktodo');
    // Re-ensure with a different-cased email + different name resolves to the SAME row.
    const b = await ensureContact({ tenantId: T, email: 'jo@x.test', name: 'Different' });
    expect(b?.contactId).toBe(a?.contactId);
    expect(b?.name).toBe('Jo'); // existing row wins; no clobber
  });

  it('name falls back to the email when none is given', async () => {
    const c = await ensureContact({ tenantId: T, email: 'noname@x.test' });
    expect(c?.name).toBe('noname@x.test');
  });

  it('is merge-aware — a re-ensure after a merge resolves to the SURVIVOR (the win over a raw scan)', async () => {
    const loser = await createContact({ tenantId: T, name: 'Dup', email: 'dup@x.test' });
    const survivor = await createContact({ tenantId: T, name: 'Keep', email: 'keep@x.test' });
    await mergeContacts(T, survivor.contactId, loser.contactId);
    // Pin the loser's address at the TOMBSTONE in the identity index (what a
    // lagging / pre-merge index holds) so the lookup must follow `mergedInto`.
    const identKey = `hostext:cdp:contact-ident:${T}::email::dup@x.test`;
    const row = JSON.parse((await hostExtStorage().kvGet(identKey))!) as { contactId: string };
    await hostExtStorage().kvSet(identKey, JSON.stringify({ ...row, contactId: loser.contactId }));
    // The loser's email now resolves (via the identifier index + tombstone follow)
    // to the survivor — ensureContact must return the survivor, not mint a new row.
    const resolved = await ensureContact({ tenantId: T, email: 'dup@x.test', name: 'X' });
    expect(resolved?.contactId).toBe(survivor.contactId);
    // And findContactByEmail agrees (ensureContact adds no divergence).
    expect((await findContactByEmail(T, 'dup@x.test'))?.contactId).toBe(survivor.contactId);
  });

  it('is tenant-scoped — a same-email contact in another tenant is never returned', async () => {
    const other = await ensureContact({ tenantId: 'tOther', email: 'shared@x.test', name: 'Other' });
    const mine = await ensureContact({ tenantId: T, email: 'shared@x.test', name: 'Mine' });
    expect(mine?.name).toBe('Mine'); // a fresh row in T, not tOther's
    expect(mine?.tenantId).toBe(T);
    // Each tenant's identity index still names its own row — T's ensure did not
    // re-point tOther's address (a tenant-blind index key did, while the fresh-row
    // assertions above stayed green behind the survivor tenant check).
    expect(await resolveContactIdByIdentifier('tOther', 'email', 'shared@x.test')).toBe(other?.contactId);
    expect(await resolveContactIdByIdentifier(T, 'email', 'shared@x.test')).toBe(mine?.contactId);
  });
});
