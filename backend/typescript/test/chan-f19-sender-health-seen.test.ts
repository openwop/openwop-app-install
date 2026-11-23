/**
 * CHAN-F19 (ADR 0464 §9) — `crm:sender-health-seen`, the bounce/complaint dedup rows of the
 * ADR 0955 D7 breaker, held the RAW bounced address in the row key and were never deleted.
 *
 * What is pinned here:
 *  - a new row's key carries a hash of the address, never the address;
 *  - the store is on the kvAgeOut lane, and a LEGACY raw-key row ages out on it (the sweep
 *    selects by prefix and ages by `at`, so no migration is needed);
 *  - a same-day redelivery counts once under the hashed key. (The read-only transition read
 *    of the legacy key was removed 2026-11-22, after its 2-day window closed.)
 *  - erasure deletes a subject's rows in BOTH key shapes, through the crm subject eraser
 *    for an email-keyed DSAR, and leaves another address's rows alone.
 *
 * Sabotage witnessed (each reds the named case, restored after):
 *  - the key built from the raw address again                    → "never the address"
 *  - the registerKvAgeOut line removed                           → "ages out"
 *  - the putIfAbsent dedupe replaced with a put                  → "counts once"
 *  - the legacy suffix dropped from eraseSenderHealthSeen        → "both key shapes"
 *  - the email-keyed call in eraseCrmSubject removed             → "crm subject eraser"
 *  - leg 6c (the key-set call) in eraseCrmSubject removed        → "contactId-keyed DSAR"
 *  - the declarePiiFields line removed → the census reds in subject-erasure-feature-stores
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { __listKvAgeOutForTest, __runKvAgeOutOnce } from '../src/host/kvAgeOut.js';
import { recordBounceSignal, windowCounts, eraseSenderHealthSeen, SEEN_TTL_DAYS } from '../src/features/crm/senderHealth.js';
import { eraseCrmSubject } from '../src/features/crm/erasure.js';
import { createContact } from '../src/features/crm/contactsService.js';

const PREFIX = 'hostext:crm:sender-health-seen:';
const NOW = new Date('2026-11-13T12:00:00Z');
const DAY = 86_400_000;

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

const seenKeys = async (): Promise<string[]> =>
  (await storage.kvList(PREFIX)).map((r) => r.key.slice(PREFIX.length));

/** A row written the way the code wrote it before CHAN-F19: the raw address in the key. */
async function seedLegacy(tenantId: string, orgId: string, at: Date, reason: 'bounced' | 'complaint', address: string): Promise<string> {
  const col = new DurableCollection<{ key: string; tenantId: string; at: string }>('crm:sender-health-seen', (s) => s.key, undefined, (s) => s.tenantId);
  const key = `${tenantId}::${orgId}::${at.toISOString().slice(0, 10)}::${reason}::${address.toLowerCase()}`;
  await col.put({ key, tenantId, at: at.toISOString() });
  return key;
}

describe('CHAN-F19 — crm:sender-health-seen holds no raw address and is bounded', () => {
  it('a new dedup row keys a hash of the address, never the address', async () => {
    await recordBounceSignal('t1', 'org-a', 'bounced', 'Person.One@Example.test', NOW);
    const keys = await seenKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^t1::org-a::2026-11-13::bounced::h:[0-9a-f]{64}$/);
    expect(keys[0]!.toLowerCase()).not.toContain('person.one');
  });

  it('is registered on the age-out lane, and a legacy raw-key row ages out on it', async () => {
    expect(__listKvAgeOutForTest().find((r) => r.id === 'crm:sender-health-seen'))
      .toMatchObject({ prefix: PREFIX, ttlDays: SEEN_TTL_DAYS, timestampField: 'at' });
    const old = await seedLegacy('t1', 'org-a', new Date(NOW.getTime() - (SEEN_TTL_DAYS + 1) * DAY), 'bounced', 'old@example.test');
    await recordBounceSignal('t1', 'org-a', 'bounced', 'fresh@example.test', NOW);
    await __runKvAgeOutOnce(storage, NOW);
    const keys = await seenKeys();
    expect(keys).not.toContain(old);
    expect(keys).toHaveLength(1); // today's hashed row is inside the TTL and stays
  });

  it('a same-day redelivery under the hashed key counts once', async () => {
    expect(await recordBounceSignal('t1', 'org-a', 'bounced', 'same@example.test', NOW)).toBe(false);
    expect(await recordBounceSignal('t1', 'org-a', 'bounced', 'Same@Example.test', NOW)).toBe(false);
    expect((await windowCounts('t1', 'org-a', NOW)).hardBounces).toBe(1);
    expect(await seenKeys()).toHaveLength(1);
  });
});

describe('CHAN-F19 — erasure reaches both key shapes', () => {
  it('deletes the subject’s hashed and legacy rows in both key shapes, and spares another address', async () => {
    const legacy = await seedLegacy('t1', 'org-a', NOW, 'complaint', 'subject@example.test');
    await recordBounceSignal('t1', 'org-b', 'bounced', 'subject@example.test', NOW);
    await recordBounceSignal('t1', 'org-a', 'bounced', 'other@example.test', NOW);
    await recordBounceSignal('t2', 'org-a', 'bounced', 'subject@example.test', NOW); // another tenant
    const before = await seenKeys();

    expect(await eraseSenderHealthSeen('t1', ['Subject@Example.test'])).toBe(2);
    const after = await seenKeys();
    expect(after).not.toContain(legacy);
    expect(after).toHaveLength(before.length - 2);
    expect(after.filter((k) => k.startsWith('t1::'))).toHaveLength(1); // other@ stays
    expect(after.filter((k) => k.startsWith('t2::'))).toHaveLength(1); // the other tenant is untouched
    expect(await eraseSenderHealthSeen('t1', ['subject@example.test'])).toBe(0); // idempotent
  });

  it('a contactId-keyed DSAR reaches them through the contact’s address key-set', async () => {
    const c = await createContact({ tenantId: 't1', name: 'Pat Doe', email: 'Pat@Example.test' });
    await seedLegacy('t1', 'org-a', NOW, 'complaint', 'pat@example.test');
    await recordBounceSignal('t1', 'org-b', 'bounced', 'pat@example.test', NOW);
    await recordBounceSignal('t1', 'org-a', 'bounced', 'kept@example.test', NOW);
    await eraseCrmSubject('t1', c.contactId);
    const keys = await seenKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^t1::org-a::2026-11-13::bounced::h:/);
  });

  it('an email-keyed DSAR reaches them through the crm subject eraser, contact or not', async () => {
    await seedLegacy('t1', 'org-a', NOW, 'bounced', 'gone@example.test');
    await recordBounceSignal('t1', 'org-b', 'complaint', 'gone@example.test', NOW);
    await recordBounceSignal('t1', 'org-a', 'bounced', 'kept@example.test', NOW);
    await eraseCrmSubject('t1', 'gone@example.test'); // no CRM contact holds this address
    const keys = await seenKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^t1::org-a::2026-11-13::bounced::h:/);
  });
});
