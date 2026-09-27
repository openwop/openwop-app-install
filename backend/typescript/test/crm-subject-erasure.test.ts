/**
 * CRM-2 — CRM registered ZERO subject erasers while eight of its collections held
 * contact PII, and the compensating control its own code cited ("a distinct
 * DSAR-by-email path (its own route/ADR)") was never built. So `eraseSubject`
 * returned `{failed: 0}`, consent wrote `reason: 'erasure_complete'`, the route
 * returned `ok: true` — and the subject's email was still sitting in
 * `cdp:contact-ident` (in the KEY), `crm:merge-event`, `crm:suppression`,
 * `crm:booking`, `crm:sign-request` and `crm:signature-record`.
 *
 * These cases assert the HONEST OUTCOME per store, not that an eraser ran. They
 * also pin the three decisions that are easy to get backwards:
 *
 *  - the contact row SURVIVES (anonymized) — deleting it would destroy the org's
 *    own deals/tasks/timeline to erase a name from them;
 *  - `crm:suppression` KEEPS the address — it is the key that honours the refusal,
 *    so purging it would make the erased person mailable again;
 *  - an email-keyed DSAR reaches CRM through the registered `SubjectKeyResolver`,
 *    resolving through the authoritative identifier index and never a heuristic
 *    match (which is what prevents over-erasure).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { DurableCollection, __hostExtStorage, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import type { Storage } from '../src/storage/storage.js';
import {
  eraseCrmSubject, resolveCrmSubjectKeys, ERASED_VALUE,
} from '../src/features/crm/erasure.js';
import { createContact, getContact, __resetCrmStore } from '../src/features/crm/contactsService.js';
import { resolveContactIdByIdentifier } from '../src/features/crm/contactIdentityService.js';
import { mergeContacts } from '../src/features/crm/crmMergeService.js';
import { listMergeEvents } from '../src/features/crm/crmMergeEventsService.js';
import {
  addSuppression, listSuppressions, isSuppressed, __clearSuppressions,
} from '../src/features/crm/suppressionService.js';
import type { Booking } from '../src/features/crm/entities/bookings.js';
import type { SignRequest, SignatureRecord } from '../src/features/crm/entities/signRequests.js';

const T = 'crm-erasure-tenant';
const OTHER = 'crm-erasure-other-tenant';
let server: http.Server;

const bookings = new DurableCollection<Booking>('crm:booking', (b) => b.bookingId, undefined, (b) => b.tenantId);
const signRequests = new DurableCollection<SignRequest>('crm:sign-request', (r) => r.signRequestId, undefined, (r) => r.tenantId);
const signatureRecords = new DurableCollection<SignatureRecord>('crm:signature-record', (r) => r.recordId, undefined, (r) => r.tenantId);

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(async () => {
  await __resetCrmStore();
  await __clearSuppressions();
  await bookings.__clear();
  await signRequests.__clear();
  await signatureRecords.__clear();
});

const EMAIL = 'erase-me@acme.test';

async function seedContact(tenantId = T, email = EMAIL): Promise<string> {
  const c = await createContact({
    tenantId, name: 'Erase Me', stage: 'customer', email, company: 'Acme Ltd',
    title: 'Head of Buying', address: '1 Example Street',
    identifiers: [{ type: 'phone', value: '+15550109999', source: 'manual' }],
  });
  return c.contactId;
}

describe('CRM-2 — the contact record itself', () => {
  it('the row SURVIVES but its identifying fields do not', async () => {
    const contactId = await seedContact();
    await eraseCrmSubject(T, contactId);

    const after = await getContact(contactId);
    expect(after, "the row anchors the org's own records — never deleted").not.toBeNull();
    expect(after!.name).toBe(ERASED_VALUE);
    expect(after!.email).toBeUndefined();
    expect(after!.address).toBeUndefined();
    expect(after!.title).toBeUndefined();
    expect(after!.identifiers, 'the identifier set is a person identifier too').toBeUndefined();
    // Relationship attributes stay — the org keeps a usable record of the deal it did.
    expect(after!.company).toBe('Acme Ltd');
    expect(after!.stage).toBe('customer');
  });

  it('the cdp:contact-ident index — whose KEY is the address — is gone', async () => {
    const contactId = await seedContact();
    expect(await resolveContactIdByIdentifier(T, 'email', EMAIL), 'precondition').toBe(contactId);

    await eraseCrmSubject(T, contactId);
    expect(
      await resolveContactIdByIdentifier(T, 'email', EMAIL),
      'the erased person must not stay resolvable by the address they asked to have removed',
    ).toBeNull();
    expect(await resolveContactIdByIdentifier(T, 'phone', '+15550109999')).toBeNull();
  });

  it("another tenant's contact with the SAME address is untouched", async () => {
    const mine = await seedContact(T);
    const theirs = await seedContact(OTHER);
    await eraseCrmSubject(T, mine);

    const other = await getContact(theirs);
    expect(other!.email, 'erasure is tenant-scoped').toBe(EMAIL);
    expect(await resolveContactIdByIdentifier(OTHER, 'email', EMAIL)).toBe(theirs);
  });

  it('a subject key from another identity space matches nothing (a harmless no-op)', async () => {
    const contactId = await seedContact();
    await eraseCrmSubject(T, 'user:some-app-principal');
    expect((await getContact(contactId))!.email, 'an unrelated key must not erase a contact').toBe(EMAIL);
  });

  it('a blank tenant or subject erases nothing (fail-closed — never a tenant-wide sweep)', async () => {
    const contactId = await seedContact();
    await eraseCrmSubject('', contactId);
    await eraseCrmSubject(T, '');
    expect((await getContact(contactId))!.email).toBe(EMAIL);
  });

  it('is idempotent — the contract invokes it once per linked identity key', async () => {
    const contactId = await seedContact();
    await eraseCrmSubject(T, contactId);
    const first = await getContact(contactId);
    await eraseCrmSubject(T, contactId);
    expect(await getContact(contactId)).toEqual(first);
  });
});

describe('CRM-2 — the downstream stores a "successful" erasure used to leave behind', () => {
  it('crm:merge-event no longer carries the absorbed raw email/phone', async () => {
    const survivorId = await seedContact(T, 'survivor@acme.test');
    const sourceId = await seedContact(T, EMAIL);
    await mergeContacts(T, survivorId, sourceId, 'test');

    const [ev] = await listMergeEvents(T);
    expect(
      JSON.stringify(ev!.absorbedIdentifiers),
      'precondition: the audit snapshot really does hold the raw values',
    ).toContain(EMAIL);

    await eraseCrmSubject(T, sourceId);
    const [after] = await listMergeEvents(T);
    expect(JSON.stringify(after)).not.toContain(EMAIL);
    expect(after!.mergeEventId, 'the event survives — it is the substrate an unmerge replays').toBe(ev!.mergeEventId);
  });

  it('crm:booking invitee PII is erased — including a PUBLIC booking with no contactId', async () => {
    const contactId = await seedContact();
    await bookings.put({
      bookingId: 'bk:linked', tenantId: T, orgId: 'org1', bookingLinkId: 'lnk1',
      slotStartUtcMs: 1, durationMin: 30, status: 'confirmed',
      inviteeName: 'Erase Me', inviteeEmail: EMAIL, inviteeNote: 'call me on my mobile',
      contactId, createdAt: 'x', updatedAt: 'x',
    });
    await bookings.put({
      // The case a contactId-only match would miss: an unauthenticated public
      // booking that was never linked to a contact.
      bookingId: 'bk:public', tenantId: T, orgId: 'org1', bookingLinkId: 'lnk1',
      slotStartUtcMs: 2, durationMin: 30, status: 'confirmed',
      inviteeName: 'Erase Me', inviteeEmail: EMAIL, createdAt: 'x', updatedAt: 'x',
    });
    await bookings.put({
      bookingId: 'bk:someone-else', tenantId: T, orgId: 'org1', bookingLinkId: 'lnk1',
      slotStartUtcMs: 3, durationMin: 30, status: 'confirmed',
      inviteeName: 'Other Person', inviteeEmail: 'other@acme.test', createdAt: 'x', updatedAt: 'x',
    });

    await eraseCrmSubject(T, contactId);

    for (const id of ['bk:linked', 'bk:public']) {
      const b = await bookings.get(id);
      expect(b!.inviteeEmail, id).toBe(ERASED_VALUE);
      expect(b!.inviteeName, id).toBe(ERASED_VALUE);
      expect(b!.inviteeNote, id).toBeUndefined();
      expect(b!.status, 'the slot itself is the org calendar and survives').toBe('confirmed');
    }
    const untouched = await bookings.get('bk:someone-else');
    expect(untouched!.inviteeEmail, 'another invitee must not be caught in the sweep').toBe('other@acme.test');
  });

  it('crm:sign-request signers and the crm:signature-record typedName are erased; the evidence is kept', async () => {
    const contactId = await seedContact();
    await signRequests.put({
      signRequestId: 'sr1', tenantId: T, orgId: 'org1', title: 'MSA', target: { kind: 'document', id: 'd1' },
      contentHash: 'hash-abc', provider: 'native', status: 'completed', createdBy: 'u1',
      signers: [
        { signerId: 's1', email: EMAIL, name: 'Erase Me', status: 'signed' },
        { signerId: 's2', email: 'counterparty@acme.test', name: 'Counterparty', status: 'signed' },
      ],
      createdAt: 'x', updatedAt: 'x',
    } as SignRequest);
    await signatureRecords.put({
      recordId: 'sr1:s1', tenantId: T, signRequestId: 'sr1', signerId: 's1', signedAt: 'x',
      ipHash: 'iph', userAgentHash: 'uah', contentHashAtSign: 'hash-abc', method: 'click-to-sign',
      typedName: 'Erase Me',
    });
    await signatureRecords.put({
      recordId: 'sr1:s2', tenantId: T, signRequestId: 'sr1', signerId: 's2', signedAt: 'x',
      ipHash: 'iph', userAgentHash: 'uah', contentHashAtSign: 'hash-abc', method: 'click-to-sign',
      typedName: 'Counterparty',
    });

    await eraseCrmSubject(T, contactId);

    const sr = await signRequests.get('sr1');
    expect(sr!.signers.find((s) => s.signerId === 's1')!.email).toBe(ERASED_VALUE);
    expect(sr!.signers.find((s) => s.signerId === 's1')!.name).toBe(ERASED_VALUE);
    expect(
      sr!.signers.find((s) => s.signerId === 's2')!.email,
      "the counterparty is a different person and is not erased",
    ).toBe('counterparty@acme.test');
    expect(sr!.contentHash, 'the evidence a signature happened survives').toBe('hash-abc');

    expect((await signatureRecords.get('sr1:s1'))!.typedName).toBeUndefined();
    expect((await signatureRecords.get('sr1:s2'))!.typedName).toBe('Counterparty');
    expect((await signatureRecords.get('sr1:s1'))!.contentHashAtSign).toBe('hash-abc');
  });

  it('crm:gmailsync rows for the erased APP USER are deleted (the other identity space)', async () => {
    // The row is seeded directly rather than through `createGmailSync`, which would
    // drag in the Connections broker and the scheduler; the property under test is
    // the ERASER's reach, and a seeded row exercises exactly that.
    const { listGmailSyncs } = await import('../src/features/crm/gmailSyncService.js');
    const syncs = new DurableCollection<{ syncId: string; tenantId: string; orgId: string; userId: string; connectionId: string; cadence: string; jobId: string; status: string; createdAt: string; updatedAt: string }>(
      'crm:gmailsync', (s) => `${s.tenantId}:${s.syncId}`,
    );
    await syncs.put({
      syncId: 'gmailsync:erase-me', tenantId: T, orgId: 'org1', userId: 'user:erased-one',
      connectionId: 'conn-1', cadence: 'daily', jobId: 'gmailsync:gmailsync:erase-me',
      status: 'active', createdAt: 'x', updatedAt: 'x',
    });
    await syncs.put({
      syncId: 'gmailsync:keep-me', tenantId: T, orgId: 'org1', userId: 'user:someone-else',
      connectionId: 'conn-2', cadence: 'daily', jobId: 'gmailsync:gmailsync:keep-me',
      status: 'active', createdAt: 'x', updatedAt: 'x',
    });

    // Precondition asserted, so an empty seed can never make the check below vacuous.
    expect(await listGmailSyncs(T, { userId: 'user:erased-one' })).toHaveLength(1);

    await eraseCrmSubject(T, 'user:erased-one');

    expect(await listGmailSyncs(T, { userId: 'user:erased-one' })).toHaveLength(0);
    expect(
      await listGmailSyncs(T, { userId: 'user:someone-else' }),
      "another user's mailbox sync must not be swept up",
    ).toHaveLength(1);
    await syncs.__clear();
  });
});

describe('CRM-2 — suppression is RETAINED on purpose, and the reason matters', () => {
  it('the address stays suppressed after erasure — erasing a refusal must not lift it', async () => {
    const contactId = await seedContact();
    await addSuppression(T, EMAIL, 'complaint', 'webhook:test', 'marked as spam');

    await eraseCrmSubject(T, contactId);

    expect(
      await isSuppressed(T, EMAIL),
      'deleting the suppression row would make the erased person mailable again',
    ).toBe(true);
  });

  it('...but the free-text context on that row IS erased', async () => {
    const contactId = await seedContact();
    await addSuppression(T, EMAIL, 'complaint', 'user:admin@acme.test', 'said to stop emailing, per phone call with Jane');

    await eraseCrmSubject(T, contactId);

    const [row] = await listSuppressions(T);
    expect(row!.email, 'the key that does the work stays').toBe(EMAIL);
    expect(row!.note, 'the free-text context does not').toBeUndefined();
    expect(row!.actor).toBe(ERASED_VALUE);
    expect(row!.reason, 'the reason is the compliance fact, not PII').toBe('complaint');
  });
});

describe('CRM-2 — an email-keyed DSAR reaches CRM (the route that was promised and never built)', () => {
  it('an email subject key resolves to the contactId through the authoritative index', async () => {
    const contactId = await seedContact();
    expect(await resolveCrmSubjectKeys(T, EMAIL)).toEqual([contactId]);
    expect(await resolveCrmSubjectKeys(T, '+15550109999')).toEqual([contactId]);
  });

  it('an UNKNOWN address resolves to nothing — never a heuristic match', async () => {
    // Over-erasure is the failure mode a resolver has to avoid; the contract says
    // "ONLY authoritative, store-backed same-subject keys".
    await seedContact();
    expect(await resolveCrmSubjectKeys(T, 'stranger@acme.test')).toEqual([]);
    expect(await resolveCrmSubjectKeys(T, 'not-an-address')).toEqual([]);
    expect(await resolveCrmSubjectKeys('', EMAIL)).toEqual([]);
  });

  it("an address belonging to ANOTHER tenant's contact does not resolve here", async () => {
    const theirs = await seedContact(OTHER, 'theirs@acme.test');
    expect(theirs).toBeTruthy();
    expect(await resolveCrmSubjectKeys(T, 'theirs@acme.test')).toEqual([]);
  });
});

/**
 * FOLD-IN B2 — the eraser used to DESTROY ITS OWN ADDRESS KEY-SET before the
 * address-keyed passes ran, so a RETRY after a partial failure reported success
 * over data that was still there.
 *
 * The old leg order was: derive `values` from the LIVE contact row → anonymize the
 * contact (leg 2) → THEN match bookings-by-invitee-address, sign-requests and
 * suppression on `values` (legs 4/5/6). A run that partial-failed anywhere after
 * leg 2 surfaced as `erasure_partial`. The retry then re-read an ALREADY-ANONYMIZED
 * contact, computed `values = ∅`, matched nothing, returned `failed: 0`, consent
 * wrote `erasure_complete`, and the route answered `ok: true` — with the person's
 * address still in every address-keyed store. Reported-success-over-live-PII, on a
 * compliance path.
 *
 * The cases below force a real mid-run failure at the FIRST address-keyed leg and
 * then assert the retry actually finishes the job. They discriminate the ORDER: a
 * booking with no `contactId` (a public booking) and a sign-request signer are
 * reachable ONLY through the address key-set, so under the old order run 2 finds
 * nothing at all.
 */
describe('CRM-2 / B2 — a RETRY after a partial failure must still erase', () => {
  /** Run `fn` with a storage layer that throws on any write into `nsPrefix`. */
  async function withWriteFailure(nsPrefix: string, fn: () => Promise<void>): Promise<unknown> {
    const real = __hostExtStorage()!;
    let thrown: unknown = null;
    initHostExtPersistence(new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'kvSet') {
          return async (key: string, value: string) => {
            if (key.startsWith(nsPrefix)) throw new Error(`injected storage failure on ${key}`);
            return (target as Storage).kvSet(key, value);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Storage);
    try {
      await fn();
    } catch (err) {
      thrown = err;
    } finally {
      initHostExtPersistence(real);
    }
    return thrown;
  }

  async function seedAddressKeyedRows(contactId: string): Promise<void> {
    // A PUBLIC booking — no contactId, so it is reachable ONLY by address. This is
    // the row the old order could never recover on a retry.
    await bookings.put({
      bookingId: 'bk:retry-public', tenantId: T, orgId: 'org1', bookingLinkId: 'lnk1',
      slotStartUtcMs: 7, durationMin: 30, status: 'confirmed',
      inviteeName: 'Erase Me', inviteeEmail: EMAIL, inviteeNote: 'ring my mobile',
      createdAt: 'x', updatedAt: 'x',
    });
    await signRequests.put({
      signRequestId: 'sr:retry', tenantId: T, orgId: 'org1', title: 'NDA',
      target: { kind: 'document', id: 'd9' }, contentHash: 'hash-xyz', provider: 'native',
      status: 'completed', createdBy: 'u1',
      signers: [{ signerId: 's1', email: EMAIL, name: 'Erase Me', status: 'signed' }],
      createdAt: 'x', updatedAt: 'x',
    } as SignRequest);
    await addSuppression(T, EMAIL, 'complaint', 'user:admin@acme.test', 'asked to stop, per call with Jane');
    expect(contactId).toBeTruthy();
  }

  it('run 1 fails at the first address-keyed leg; run 2 STILL erases every address-keyed row', async () => {
    const contactId = await seedContact();
    await seedAddressKeyedRows(contactId);

    // Run 1 — the booking write throws. Under the OLD order the contact row and the
    // identifier index were already erased by the time this leg ran.
    const thrown = await withWriteFailure('hostext:crm:booking:', async () => {
      await eraseCrmSubject(T, contactId);
    });
    expect(thrown, 'precondition: run 1 must really have failed mid-erasure').toBeTruthy();

    // Run 2 — the honest retry. This is the assertion the old order could not pass.
    await eraseCrmSubject(T, contactId);

    const b = await bookings.get('bk:retry-public');
    expect(b!.inviteeEmail, 'a public booking is reachable ONLY by address — the retry must still reach it').toBe(ERASED_VALUE);
    expect(b!.inviteeName).toBe(ERASED_VALUE);
    expect(b!.inviteeNote).toBeUndefined();

    const sr = await signRequests.get('sr:retry');
    expect(sr!.signers[0]!.email, 'signers are matched by address too').toBe(ERASED_VALUE);
    expect(sr!.signers[0]!.name).toBe(ERASED_VALUE);

    const [supp] = await listSuppressions(T);
    expect(supp!.email, 'the address itself is retained on purpose — it honours the refusal').toBe(EMAIL);
    expect(supp!.actor, 'but the free-text context must be gone after the retry').toBe(ERASED_VALUE);
    expect(supp!.note).toBeUndefined();

    // And the contact + its identifier index are finished too.
    expect((await getContact(contactId))!.name).toBe(ERASED_VALUE);
    expect(await resolveContactIdByIdentifier(T, 'email', EMAIL)).toBeNull();
  });

  it('a run that reports COMPLETE leaves no row still matching the address', async () => {
    // The general property, stated as an invariant rather than per-store: if
    // `eraseCrmSubject` returns without throwing, nothing keyed on the subject's
    // address may still carry it. That is what "erasure_complete" is supposed to mean.
    const contactId = await seedContact();
    await seedAddressKeyedRows(contactId);

    const thrown = await withWriteFailure('hostext:crm:booking:', async () => {
      await eraseCrmSubject(T, contactId);
    });
    expect(thrown).toBeTruthy();

    await eraseCrmSubject(T, contactId); // returns normally ⇒ claims completion

    const survivors: string[] = [];
    for (const b of await bookings.list()) if (b.tenantId === T && b.inviteeEmail === EMAIL) survivors.push(`booking:${b.bookingId}`);
    for (const r of await signRequests.list()) {
      if (r.tenantId !== T) continue;
      for (const s of r.signers ?? []) if (s.email === EMAIL) survivors.push(`signer:${r.signRequestId}:${s.signerId}`);
    }
    for (const row of await listSuppressions(T)) if (row.note !== undefined || row.actor !== ERASED_VALUE) survivors.push(`suppression:${row.email}`);
    expect(survivors, 'a completed erasure must not leave the address anywhere it was matched on').toEqual([]);
  });

  it('the identifier index is the LAST thing removed, so an email-keyed retry can still find the contact', async () => {
    // `resolveCrmSubjectKeys` turns an email-shaped DSAR key back into the contactId
    // THROUGH `cdp:contact-ident`. Deleting that index first (it was leg 1) meant a
    // retry of an email-keyed erasure could not even locate the subject.
    const contactId = await seedContact();
    await seedAddressKeyedRows(contactId);

    const thrown = await withWriteFailure('hostext:crm:booking:', async () => {
      await eraseCrmSubject(T, contactId);
    });
    expect(thrown).toBeTruthy();

    expect(
      await resolveCrmSubjectKeys(T, EMAIL),
      'after a failed run the email must still resolve, or the retry has no subject to erase',
    ).toEqual([contactId]);
  });
});
