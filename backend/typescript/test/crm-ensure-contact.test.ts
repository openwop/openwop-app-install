/**
 * ADR 0449 P1 — the shared `ensureContact` seam. Pins the find-or-create
 * contract that commerce checkout + webinars now share (and KickTodo will be
 * the third consumer of): D3 privacy floor (no email ⇒ no contact), no
 * duplicate on re-ensure, leadSource + name fallback, and merge-awareness
 * (a re-ensure after a merge resolves to the survivor, never a new row).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
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
    // The loser's email now resolves (via the identifier index + tombstone follow)
    // to the survivor — ensureContact must return the survivor, not mint a new row.
    const resolved = await ensureContact({ tenantId: T, email: 'dup@x.test', name: 'X' });
    expect(resolved?.contactId).toBe(survivor.contactId);
    // And findContactByEmail agrees (ensureContact adds no divergence).
    expect((await findContactByEmail(T, 'dup@x.test'))?.contactId).toBe(survivor.contactId);
  });

  it('is tenant-scoped — a same-email contact in another tenant is never returned', async () => {
    await ensureContact({ tenantId: 'tOther', email: 'shared@x.test', name: 'Other' });
    const mine = await ensureContact({ tenantId: T, email: 'shared@x.test', name: 'Mine' });
    expect(mine?.name).toBe('Mine'); // a fresh row in T, not tOther's
    expect(mine?.tenantId).toBe(T);
  });
});
