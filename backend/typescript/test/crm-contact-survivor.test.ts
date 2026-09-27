/**
 * KT-PORT-7b — the ONE canonical merge-chain survivor resolver (`resolveContactSurvivor`),
 * consolidated into CRM (the merge owner) from the hand-rolled one-hop copies in
 * `findContactByEmail` + kicktodo `contactBridgeService`. Pins the multi-hop fix +
 * fail-closed edges, and that `findContactByEmail` never returns a tombstone.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createContact, resolveContactSurvivor, findContactByEmail, getContact } from '../src/features/crm/contactsService.js';
import { mergeContacts } from '../src/features/crm/crmMergeService.js';

const T = 'tenant-survivor';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('resolveContactSurvivor (KT-PORT-7b)', () => {
  it('follows a MULTI-HOP chain (A→B→C) to the live survivor — the one-hop bug', async () => {
    const a = await createContact({ tenantId: T, name: 'A', email: 'a@s.test' });
    const b = await createContact({ tenantId: T, name: 'B', email: 'b@s.test' });
    const c = await createContact({ tenantId: T, name: 'C', email: 'c@s.test' });
    await mergeContacts(T, b.contactId, a.contactId); // A → B
    await mergeContacts(T, c.contactId, b.contactId); // B → C
    expect((await resolveContactSurvivor(T, a.contactId))?.contactId).toBe(c.contactId);
    expect((await resolveContactSurvivor(T, b.contactId))?.contactId).toBe(c.contactId);
    // A live (un-merged) contact resolves to itself.
    expect((await resolveContactSurvivor(T, c.contactId))?.contactId).toBe(c.contactId);
  });

  it('fails closed: unknown id, and a cross-tenant id, resolve to null', async () => {
    const a = await createContact({ tenantId: T, name: 'A', email: 'x@s.test' });
    expect(await resolveContactSurvivor(T, 'contact:nope')).toBeNull();
    expect(await resolveContactSurvivor('other-tenant', a.contactId)).toBeNull();
  });

  it('findContactByEmail never returns a tombstone across a chain (returns a LIVE contact)', async () => {
    const a = await createContact({ tenantId: T, name: 'A', email: 'chain@s.test' });
    const b = await createContact({ tenantId: T, name: 'B', email: 'b2@s.test' });
    const c = await createContact({ tenantId: T, name: 'C', email: 'c2@s.test' });
    await mergeContacts(T, b.contactId, a.contactId);
    await mergeContacts(T, c.contactId, b.contactId);
    const found = await findContactByEmail(T, 'chain@s.test');
    expect(found).not.toBeNull();
    expect(found!.mergedInto).toBeUndefined(); // never a tombstone
    // and it IS the live survivor (getContact confirms it's not merged away)
    expect((await getContact(found!.contactId))?.mergedInto).toBeUndefined();
  });
});
