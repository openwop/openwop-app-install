/**
 * CRM-2 — first-class Contact attributes (title / address / leadSource) + the DERIVED phone.
 * title/address/leadSource are stored optional fields (fail-closed validation, null-clear).
 * `phone` is a read-only projection of the phone IDENTIFIER (the identity-resolution SoT):
 * a `phone` write-input upserts the identifier and NEVER persists a scalar, so identity
 * resolution is unchanged and there is no drift.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { createContact, updateContact, getContact } from '../src/features/crm/contactsService.js';
import { resolveContactIdByIdentifier } from '../src/features/crm/contactIdentityService.js';

const T = 'tA';
const mk = (over: Record<string, unknown> = {}) => createContact({ tenantId: T, name: 'Jane', ...over });
// Raw stored row (bypasses the read projection) — to assert phone is NEVER persisted.
const rawStore = () => new DurableCollection<{ contactId: string; phone?: unknown; identifiers?: Array<{ type: string; value: string }> }>('crm:contact', (c) => c.contactId);

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

describe('CRM-2 — contact title/address/leadSource + derived phone', () => {
  it('persists title/address/leadSource and reads them back', async () => {
    const c = await mk({ title: 'VP Sales', address: '1 Main St, Springfield', leadSource: 'Webinar Q3' });
    expect(await getContact(c.contactId)).toMatchObject({ title: 'VP Sales', address: '1 Main St, Springfield', leadSource: 'Webinar Q3' });
  });

  it('validates fail-closed: a non-string field 400s', async () => {
    await expect(mk({ title: 42 })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(mk({ leadSource: { x: 1 } })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('phone: a write-input upserts the phone IDENTIFIER, is derived on read, and is NEVER stored as a scalar', async () => {
    const c = await mk({ phone: '+1 (555) 123-4567' });
    // derived on read
    expect((await getContact(c.contactId))!.phone).toBe('+1 (555) 123-4567');
    // stored as an identifier (normalized), resolvable by the identity index
    const raw = await rawStore().get(c.contactId);
    expect(raw!.phone).toBeUndefined(); // NEVER a stored scalar
    expect(raw!.identifiers?.some((i) => i.type === 'phone')).toBe(true);
    const resolved = await resolveContactIdByIdentifier(T, 'phone', '+1 (555) 123-4567');
    expect(resolved).toBe(c.contactId); // identity resolution works off the identifier
  });

  it('update sets/clears the strings; a phone update re-points the identifier; empty clears it', async () => {
    const c = await mk({ title: 'SDR', phone: '5551110000' });
    await updateContact(c.contactId, { title: 'AE', phone: '5559998888' });
    const got = await getContact(c.contactId);
    expect(got).toMatchObject({ title: 'AE', phone: '5559998888' });
    expect(await resolveContactIdByIdentifier(T, 'phone', '5559998888')).toBe(c.contactId);
    // the OLD phone no longer resolves (identifier re-pointed, not duplicated)
    expect(await resolveContactIdByIdentifier(T, 'phone', '5551110000')).toBeNull();
    // clear the string + the phone
    await updateContact(c.contactId, { title: null, phone: '' });
    const cleared = await getContact(c.contactId);
    expect(cleared!.title).toBeUndefined();
    expect(cleared!.phone).toBeUndefined();
  });
});
