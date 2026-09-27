/**
 * ADR 0627 D4 (`CRM-19` / `CRM-20`) — merge tombstones are PII-safe and
 * erasure-reachable.
 *
 *  (a) `tombstoneContact` does not refresh `updatedAt` — a tombstone's purge
 *      clock is its PRE-MERGE `updatedAt` (the source's raw PII no longer earns
 *      a fresh retention window at merge time).
 *  (b) erasing the survivor anonymizes every tombstone whose `mergedInto` chain
 *      resolves to it (walked over merge-event survivor→source edges, bounded).
 *  (c) an email/phone-shaped subject key resolves through the tenant-scoped
 *      `cdp:contact-ident` index to the contact BEFORE being treated as a
 *      contactId — so a by-userId erasure, which the seam expands ONE hop to the
 *      user's email (`usersEmailKeyResolver`) and deliberately not two, reaches
 *      the contact holding that address.
 *
 * Mechanism and wiring are witnessed SEPARATELY (the 9605-green lesson): the
 * `eraseCrmSubject` cases prove the eraser, the final case drives the real
 * host `eraseSubject` fan-out by userId on the booted app.
 *
 * SABOTAGE: skip the tombstone walk (`tombstones = []`) → "erase the survivor"
 * red; drop the ident resolution → "email-shaped key" + the by-userId case red;
 * re-add `updatedAt: now` to `tombstoneContact` → the clock case red; delete
 * every key-set claim regardless of holder (review S3) → "Z's claim" red.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { eraseCrmSubject, ERASED_VALUE } from '../src/features/crm/erasure.js';
import { createContact, getContact, getContactKeyClaim, removeContactIdentifier, __resetCrmStore } from '../src/features/crm/contactsService.js';
import { resolveContactIdByIdentifier } from '../src/features/crm/contactIdentityService.js';
import { mergeContacts, unmergeContacts } from '../src/features/crm/crmMergeService.js';
import { listMergeEvents } from '../src/features/crm/crmMergeEventsService.js';
import { createUser, usersEmailKeyResolver, __resetUsersStore } from '../src/features/users/usersService.js';
import { eraseSubject } from '../src/host/subjectErasure.js';

const T = 'crm-tombstone-erasure-tenant';
const OTHER = 'crm-tombstone-erasure-other';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(async () => {
  await __resetCrmStore();
  await __resetUsersStore();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function person(name: string, email: string, tenantId = T): Promise<string> {
  const c = await createContact({
    tenantId, name, email, address: `${name} Street 1`, title: 'Buyer',
    identifiers: [{ type: 'phone', value: `+1555${Math.floor(Math.random() * 1e7).toString().padStart(7, '0')}`, source: 'manual' }],
  });
  return c.contactId;
}

function expectAnonymized(c: { name: string; email?: string; address?: string; title?: string; identifiers?: unknown[] } | null, label: string): void {
  expect(c, `${label} — the row survives`).not.toBeNull();
  expect(c!.name, `${label} — name`).toBe(ERASED_VALUE);
  expect(c!.email, `${label} — email`).toBeUndefined();
  expect(c!.address, `${label} — address`).toBeUndefined();
  expect(c!.title, `${label} — title`).toBeUndefined();
  expect(c!.identifiers, `${label} — phone/identifiers`).toBeUndefined();
}

describe('ADR 0627 D4a — the tombstone clock', () => {
  it('a merge tombstone keeps its PRE-MERGE updatedAt (mergedAt carries the merge moment)', async () => {
    const survivor = await person('Keep', 'keep@acme.test');
    const source = await person('Dup', 'dup@acme.test');
    const before = (await getContact(source))!.updatedAt;
    await sleep(5); // make "now" observably later than the pre-merge clock
    await mergeContacts(T, survivor, source);
    const tomb = (await getContact(source))!;
    expect(tomb.mergedInto).toBe(survivor);
    expect(tomb.updatedAt, 'the purge clock is the pre-merge updatedAt').toBe(before);
    expect(tomb.mergedAt! > before, 'mergedAt is the merge moment').toBe(true);
  });
});

describe('ADR 0627 D4b — erasing the survivor reaches its tombstones', () => {
  it('erase the survivor → the source tombstone carries no name/address/email/phone', async () => {
    const survivor = await person('Keep', 'keep@acme.test');
    const source = await person('Dup', 'dup@acme.test');
    await mergeContacts(T, survivor, source);
    await eraseCrmSubject(T, survivor);

    expectAnonymized(await getContact(survivor), 'survivor');
    const tomb = await getContact(source);
    expectAnonymized(tomb, 'source tombstone');
    expect(tomb!.mergedInto, 'it stays a tombstone (provenance)').toBe(survivor);
    // The absorbed address is not resolvable to anyone anymore.
    expect(await resolveContactIdByIdentifier(T, 'email', 'dup@acme.test')).toBeNull();
    expect(await resolveContactIdByIdentifier(T, 'email', 'keep@acme.test')).toBeNull();
    // And the merge-event snapshot (which held the source's email) is tombstoned too.
    const ev = (await listMergeEvents(T)).find((e) => e.sourceId === source)!;
    expect(ev.absorbedIdentifiers.length).toBeGreaterThan(0);
    for (const i of ev.absorbedIdentifiers) expect(i.value).toBe(ERASED_VALUE);
  });

  it('follows a MULTI-HOP chain (A→B→C): erasing C anonymizes B and A, and the A→B event snapshot', async () => {
    const a = await person('A', 'a@acme.test');
    const b = await person('B', 'b@acme.test');
    const c = await person('C', 'c@acme.test');
    await mergeContacts(T, b, a);
    await mergeContacts(T, c, b);
    await eraseCrmSubject(T, c);
    expectAnonymized(await getContact(a), 'A (two hops away)');
    expectAnonymized(await getContact(b), 'B (one hop away)');
    expectAnonymized(await getContact(c), 'C (the subject)');
    // Only THIS chain's events — merge events are not cleared between cases.
    const chain = new Set([a, b, c]);
    const events = (await listMergeEvents(T)).filter((ev) => chain.has(ev.sourceId));
    expect(events).toHaveLength(2);
    for (const ev of events) {
      for (const i of ev.absorbedIdentifiers) expect(i.value).toBe(ERASED_VALUE);
      for (const v of Object.values(ev.filledFields)) expect(v).toBe(ERASED_VALUE);
    }
  });

  it('an UNMERGED source is live again and is NOT touched by erasing its former survivor', async () => {
    const survivor = await person('Keep', 'keep@acme.test');
    const source = await person('Dup', 'dup@acme.test');
    await mergeContacts(T, survivor, source);
    const ev = (await listMergeEvents(T)).find((e) => e.sourceId === source)!;
    await unmergeContacts(T, ev.mergeEventId);
    await eraseCrmSubject(T, survivor);
    expectAnonymized(await getContact(survivor), 'survivor');
    const restored = (await getContact(source))!;
    expect(restored.name, 'a live contact is a different person\'s record — untouched').toBe('Dup');
    expect(restored.email).toBe('dup@acme.test');
  });

  it("another tenant's tombstone chain is untouched", async () => {
    const mine = await person('Keep', 'keep@acme.test');
    const theirsSurvivor = await person('Keep', 'keep@acme.test', OTHER);
    const theirsSource = await person('Dup', 'dup@acme.test', OTHER);
    await mergeContacts(OTHER, theirsSurvivor, theirsSource);
    await eraseCrmSubject(T, mine);
    expect((await getContact(theirsSource))!.name).toBe('Dup');
    expect((await getContact(theirsSurvivor))!.email).toBe('keep@acme.test');
  });

  it("erasing a survivor keeps a DIFFERENT live contact's claim on an address the chain once held (review S3)", async () => {
    const survivor = await person('Keep', 'keep@acme.test');
    const source = await person('Dup', 'dup@acme.test');
    await mergeContacts(T, survivor, source); // dup@ → released, a secondary of the survivor
    await removeContactIdentifier(survivor, T, 'email', 'dup@acme.test'); // the survivor drops it: index entry gone
    const z = await createContact({ tenantId: T, name: 'Zed', email: 'dup@acme.test' }); // a NEW person, legitimately
    expect(await getContactKeyClaim(T, 'dup@acme.test')).toMatchObject({ contactId: z.contactId });
    await eraseCrmSubject(T, survivor);
    // The tombstone's old address is in the erased key-set, but the claim is Z's
    // record, not the subject's — the first cut stripped it and Z became
    // duplicable at its own address.
    expect(await getContactKeyClaim(T, 'dup@acme.test'), "Z's claim survives the survivor's erasure").toMatchObject({ contactId: z.contactId });
    expect(await getContactKeyClaim(T, 'keep@acme.test'), "the subject's own claim goes").toBeNull();
    expect((await getContact(z.contactId))?.email, 'Z itself is untouched').toBe('dup@acme.test');
  });

  it('is idempotent (a second run touches nothing new) and leaves the address re-creatable (claim rows gone)', async () => {
    const survivor = await person('Keep', 'keep@acme.test');
    const source = await person('Dup', 'dup@acme.test');
    await mergeContacts(T, survivor, source);
    await eraseCrmSubject(T, survivor);
    await eraseCrmSubject(T, survivor);
    expect(await getContactKeyClaim(T, 'keep@acme.test')).toBeNull();
    expect(await getContactKeyClaim(T, 'dup@acme.test')).toBeNull();
    // A NEW person at the same address is a new record — never a phantom 409.
    const fresh = await createContact({ tenantId: T, name: 'New Person', email: 'keep@acme.test' });
    expect(fresh.contactId).not.toBe(survivor);
  });
});

describe('ADR 0627 D4c — an email-shaped key resolves through the ident index', () => {
  it('eraseCrmSubject(tenant, email) anonymizes the contact holding that email (+ its tombstones)', async () => {
    const survivor = await person('Keep', 'keep@acme.test');
    const source = await person('Dup', 'dup@acme.test');
    await mergeContacts(T, survivor, source);
    await eraseCrmSubject(T, 'Keep@Acme.Test'); // case-folded through the index
    expectAnonymized(await getContact(survivor), 'survivor by email');
    expectAnonymized(await getContact(source), 'its tombstone');
  });

  it('an absorbed (secondary) address reaches the survivor too', async () => {
    const survivor = await person('Keep', 'keep@acme.test');
    const source = await person('Dup', 'dup@acme.test');
    await mergeContacts(T, survivor, source);
    await eraseCrmSubject(T, 'dup@acme.test');
    expectAnonymized(await getContact(survivor), 'survivor via the absorbed address');
  });

  it('an address nobody is indexed at erases nothing — store-backed, never a heuristic match', async () => {
    const c = await person('Keep', 'keep@acme.test');
    await eraseCrmSubject(T, 'stranger@acme.test');
    expect((await getContact(c))!.name).toBe('Keep');
  });

  it('WIRING: erasing BY USERID through the host fan-out reaches the CRM contact at the user\'s email', async () => {
    const user = await createUser({ tenantId: T, principalId: 'password:erase@acme.test', email: 'Erase@Acme.Test', emailProvenance: 'idp' });
    expect(await usersEmailKeyResolver(T, user.userId), 'the one-hop expansion the seam performs').toEqual(['erase@acme.test']);
    const survivor = await person('Keep', 'erase@acme.test');
    const source = await person('Dup', 'dup@acme.test');
    await mergeContacts(T, survivor, source);

    const result = await eraseSubject(T, user.userId);
    expect(result.failed, JSON.stringify(result)).toBe(0);
    expectAnonymized(await getContact(survivor), 'the contact reached by userId → email → ident index');
    expectAnonymized(await getContact(source), 'and its tombstone');
  });
});
