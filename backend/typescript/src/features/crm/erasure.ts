/**
 * CRM-2 — subject erasure for CRM.
 *
 * WHAT WAS WRONG. CRM registered ZERO erasers while eight of its collections hold
 * contact PII. The opt-out was explicit, in `contactsService.ts`: crm is
 * "retention-only", and "erase the third party I hold a record about" is "a
 * distinct DSAR-by-email path (its own route/ADR)". **That path was never built** —
 * grepping `features/crm/` for `dsar|erase|forget` returned nothing — and the
 * absence was PINNED by a negative test asserting the contact survives. Meanwhile
 * `contactId` IS a live subject key in the fan-out (`analytics/identityLinkService`
 * expands to it; `email/emailService` erases by it), so the seam was already
 * delivering a CRM contactId to every registered eraser. CRM simply was not
 * listening. `eraseSubject` returned `{failed: 0}`, consent wrote
 * `reason: 'erasure_complete'`, and the route returned `ok: true` — failure
 * rendered as success, on a compliance path.
 *
 * ANONYMIZE, DO NOT DELETE — the `features/documents/erasure.ts` precedent, and it
 * is the reason the original opt-out was half-right. A CRM contact is the anchor
 * for the workspace's own business records: deals, tasks, timeline activities,
 * orders. Deleting the row to erase someone's name from it would destroy the
 * org's records and strand every reference. The host contract sanctions the
 * alternative directly — `SubjectEraser` "deletes or anonymizes this tenant's rows
 * keyed by `subjectKey`" — so the identifying FIELDS go and the row survives.
 *
 * THE ONE STORE DELIBERATELY NOT PURGED IS `crm:suppression`, and the reasoning is
 * the whole point of getting this right. A suppression row is the mechanism that
 * HONOURS an unsubscribe, a bounce or a spam complaint: the address is the key an
 * egress path looks up. Deleting it on erasure would make the person mailable
 * again — erasing the record of a refusal by removing the refusal. So the address
 * stays and the free-text context (`note`, `actor`) is redacted, which is the
 * minimum that keeps the protection working. That decision is recorded in the
 * erasure-coverage ratchet rather than left as a silent omission.
 *
 * REACHING CRM FROM AN EMAIL-KEYED DSAR. Rather than build the never-built
 * "DSAR-by-email route", CRM registers a `SubjectKeyResolver`: an email-shaped
 * subject key resolves — through the authoritative, store-backed
 * `cdp:contact-ident` index, never a heuristic match — to the contactId. That is
 * exactly what the seam's contract asks a resolver to be, and it makes an erasure
 * keyed by ANY of the identity spaces reach all of them.
 *
 * Idempotent by construction (the contract requires it — the eraser runs once per
 * linked identity key, so a non-idempotent side effect would fire K times): every
 * write sets a field to the tombstone, which is a no-op the second time.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { registerSubjectEraser, registerSubjectKeyResolver } from '../../host/subjectErasure.js';
import { createLogger } from '../../observability/logger.js';
import { resolveContactIdByIdentifier, normalizeIdentifierValue, type ContactIdentifier } from './contactIdentityService.js';
import { resolveContactSurvivor, type Contact, type ContactKeyClaim } from './contactsService.js';
import type { Booking } from './entities/bookings.js';
import type { SignRequest, SignatureRecord } from './entities/signRequests.js';
import type { SuppressionEntry } from './suppressionService.js';
import { listGmailSyncs, deleteGmailSync } from './gmailSyncService.js';

const log = createLogger('features.crm.erasure');

/** What an erased identifier becomes. Not `''` — an empty name reads as "unknown
 *  because nobody set it", which is a different fact from "erased on request".
 *  Mirrors `documents/erasure.ts`'s `ERASED_SUBJECT`. */
export const ERASED_VALUE = 'erased:subject';

// Same namespaces + key functions as the owning services — this module reads and
// writes the SAME rows. Declared here rather than exported from each service so the
// erasure seam does not widen five public surfaces (the documents precedent).
const contacts = new DurableCollection<Contact>('crm:contact', (c) => c.contactId, undefined, (c) => c.tenantId);
const idents = new DurableCollection<{ key: string; tenantId: string; type: string; value: string; contactId: string }>(
  'cdp:contact-ident', (r) => r.key, undefined, (r) => r.tenantId,
);
const mergeEvents = new DurableCollection<{
  mergeEventId: string; tenantId: string; survivorId: string; sourceId: string;
  filledFields: Record<string, string>; absorbedIdentifiers: ContactIdentifier[];
}>('crm:merge-event', (e) => e.mergeEventId, undefined, (e) => e.tenantId);
const bookings = new DurableCollection<Booking>('crm:booking', (b) => b.bookingId, undefined, (b) => b.tenantId);
const signRequests = new DurableCollection<SignRequest>('crm:sign-request', (r) => r.signRequestId, undefined, (r) => r.tenantId);
const signatureRecords = new DurableCollection<SignatureRecord>('crm:signature-record', (r) => r.recordId, undefined, (r) => r.tenantId);
const suppressions = new DurableCollection<SuppressionEntry>('crm:suppression', (s) => s.key);
// ADR 0627 D6 — the primary-email claim rows (`contactsService.ContactKeyClaim`):
// the KEY embeds the address, so they go the way `cdp:contact-ident` rows go.
const keyClaims = new DurableCollection<ContactKeyClaim>('crm:contactkeyclaim', (c) => c.claimId, undefined, (c) => c.tenantId);

/** Bound on the survivor→source tombstone walk (the `resolveContactSurvivor`
 *  guard shape: a visited set is the real protection, the hop bound is defensive). */
const MAX_TOMBSTONE_HOPS = 32;

/**
 * ADR 0627 D4 (`CRM-20`) — every tombstone whose `mergedInto` chain resolves to
 * `contactId`, walked over the merge-event survivor→source edges (A→B→C: erasing
 * C reaches B and A). Only rows that ARE tombstones (`mergedInto` set) of this
 * tenant are returned — an unmerged event's source is live again and is not one.
 * Cycles cannot arise (`mergeContacts` refuses a tombstoned source or survivor;
 * unmerge deletes `mergedInto`), but the walk is guarded anyway: a malformed
 * chain terminates instead of looping.
 */
async function tombstonesMergedInto(tenantId: string, contactId: string): Promise<Contact[]> {
  const sourcesOf = new Map<string, string[]>();
  for (const ev of await mergeEvents.listForTenantIndexed(tenantId)) {
    if (ev.tenantId !== tenantId) continue;
    const arr = sourcesOf.get(ev.survivorId);
    if (arr) arr.push(ev.sourceId); else sourcesOf.set(ev.survivorId, [ev.sourceId]);
  }
  const out: Contact[] = [];
  const seen = new Set<string>([contactId]);
  let frontier = [contactId];
  for (let hops = 0; frontier.length > 0 && hops < MAX_TOMBSTONE_HOPS; hops++) {
    const next: string[] = [];
    for (const survivor of frontier) {
      for (const sourceId of sourcesOf.get(survivor) ?? []) {
        if (seen.has(sourceId)) continue; // cycle / diamond ⇒ visit once
        seen.add(sourceId);
        const row = await contacts.get(sourceId);
        if (!row || row.tenantId !== tenantId || !row.mergedInto) continue; // gone / foreign / un-merged
        out.push(row);
        next.push(sourceId);
      }
    }
    frontier = next;
  }
  return out;
}

/** The identifying fields, gone; the row and its relationship attributes, kept.
 *  Shared by the live-contact leg and the tombstone leg so the two cannot drift. */
function anonymizedContact(contact: Contact): Contact {
  const next: Contact = { ...contact, name: ERASED_VALUE };
  delete next.email;
  delete next.identifiers;
  delete next.address;
  delete next.title;
  return next;
}

/** The set of addresses/identifier values a contact is reachable at, normalized —
 *  what the address-keyed stores below must be matched on. */
function reachableValues(contact: Contact): Set<string> {
  const out = new Set<string>();
  if (contact.email?.trim()) out.add(normalizeIdentifierValue('email', contact.email));
  for (const id of contact.identifiers ?? []) {
    if (id.value?.trim()) out.add(normalizeIdentifierValue(id.type, id.value));
  }
  return out;
}

/**
 * The registered eraser. `subjectKey` is treated as a CANDIDATE contactId: a key
 * from another identity space simply matches no row, which is the harmless no-op
 * the contract describes.
 *
 * ADR 0627 D4 (`CRM-20`) — EXCEPT an email/phone-shaped key, which is first
 * resolved through the tenant-scoped `cdp:contact-ident` index (ONE contactId per
 * `(tenant, type, norm)` — the live survivor) and only then treated as a
 * contactId. The seam expands a by-userId erasure ONE hop (userId → the user's
 * email, `usersEmailKeyResolver`) and deliberately not two (ADR 0622's
 * over-erasure reasoning), so this eraser used to receive the email and match
 * nothing. Resolving here reaches the contact without widening the host fan-out.
 * Store-backed, never heuristic: an unindexed address resolves to nothing.
 */
export async function eraseCrmSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return; // fail-closed — never a tenant-wide sweep
  const keyType = subjectKey.includes('@') ? 'email' : subjectKey.startsWith('+') ? 'phone' : null;
  const resolvedId = keyType ? await resolveContactIdByIdentifier(tenantId, keyType, subjectKey) : null;
  if (keyType && !resolvedId) return; // an address nobody is indexed at: nothing of ours to erase
  // Review N2 — an index key can point at a TOMBSTONE (last-writer-wins, never
  // pruned); follow `mergedInto` to the live survivor, the same way
  // `findContactByEmail` does. A dead chain falls back to the indexed id.
  const contactId = resolvedId ? ((await resolveContactSurvivor(tenantId, resolvedId))?.contactId ?? resolvedId) : subjectKey;
  const contact = await contacts.get(contactId);
  const isOurs = !!contact && contact.tenantId === tenantId;
  let touched = 0;

  // ADR 0627 D4 (`CRM-19`/`CRM-20`) — the merge tombstones that resolve to this
  // contact. `reindexContact` re-points a source's identifier keys at the
  // survivor on merge, so an address-keyed DSAR lands on the SURVIVOR while the
  // source row keeps its raw name/email/address/phone as a tombstone that no key
  // reaches. Walked here, BEFORE the key-set is derived, so their addresses join
  // `values` and every address-keyed leg below sees them too.
  const tombstones = isOurs ? await tombstonesMergedInto(tenantId, contactId) : [];
  const chainIds = new Set<string>([contactId, ...tombstones.map((t) => t.contactId)]);

  // ── THE ADDRESS KEY-SET, AND WHY THE LEG ORDER BELOW IS LOAD-BEARING ────────
  //
  // Fold-in B2. The first cut derived `values` from the LIVE contact row, then
  // anonymized that row as leg 2, and only THEN ran the three address-keyed legs
  // (bookings-by-invitee-address, sign-requests, suppression). That is a retry
  // trap, not a style point: a run that partial-failed after the anonymize
  // reported `erasure_partial`, and the RETRY re-read an already-anonymized
  // contact, computed `values = ∅`, found nothing to match, returned `failed: 0`,
  // and consent wrote `erasure_complete` — `ok: true` with the person's address
  // still sitting in every address-keyed store. Success reported over data that
  // is still there is the exact class this whole module exists to close.
  //
  // Two independent repairs, because one alone is not enough:
  //
  //  (a) The key-set is sourced from BOTH the contact row AND the authoritative
  //      `cdp:contact-ident` rows. Either survivor re-derives it.
  //  (b) The legs are ordered so that everything the key-set is DERIVED FROM is
  //      erased LAST: every address-keyed and id-keyed pass runs first, then the
  //      contact is anonymized, then the ident rows go. So a failure anywhere
  //      leaves at least one derivation source intact for the retry — and the
  //      idents (which are also what resolves an EMAIL-keyed erasure back to this
  //      contactId in `resolveCrmSubjectKeys`) are the very last thing removed,
  //      so a retry can still find its way here at all.
  const identRows = (await idents.listForTenantIndexed(tenantId))
    .filter((row) => row.tenantId === tenantId && chainIds.has(row.contactId));
  const values = isOurs ? reachableValues(contact) : new Set<string>();
  for (const t of tombstones) for (const v of reachableValues(t)) values.add(v);
  for (const row of identRows) {
    if (row.value?.trim()) values.add(normalizeIdentifierValue(row.type, row.value));
  }

  // 1. crm:merge-event — the audit snapshot carries the SOURCE's email in
  //    `filledFields` and raw emails/phones in `absorbedIdentifiers[]`. The event
  //    is the substrate an unmerge replays, so the row survives; the identifying
  //    values are tombstoned. (An unmerge after an erasure restores a contact
  //    without the erased fields, which is correct: they were erased on request.)
  //    ADR 0627 D4 — an event anywhere on the tombstone chain counts (A→B's
  //    snapshot holds A's email even when the subject is C).
  for (const ev of await mergeEvents.listForTenantIndexed(tenantId)) {
    if (ev.tenantId !== tenantId) continue;
    if (!chainIds.has(ev.survivorId) && !chainIds.has(ev.sourceId)) continue;
    const filled = Object.fromEntries(Object.keys(ev.filledFields ?? {}).map((k) => [k, ERASED_VALUE]));
    const absorbed = (ev.absorbedIdentifiers ?? []).map((i) => ({ ...i, value: ERASED_VALUE }));
    if (JSON.stringify(filled) === JSON.stringify(ev.filledFields) && JSON.stringify(absorbed) === JSON.stringify(ev.absorbedIdentifiers)) continue;
    await mergeEvents.put({ ...ev, filledFields: filled, absorbedIdentifiers: absorbed });
    touched += 1;
  }

  // 2. crm:booking — invitee name/email/note captured from a PUBLIC,
  //    unauthenticated link. Matched by `contactId` when the booking was linked to
  //    one, and by the invitee address otherwise (a public booking often has no
  //    contactId at all, which is exactly the case a contactId-only match would
  //    miss). The slot, status and timings survive: they are the org's calendar.
  for (const b of await bookings.listForTenantIndexed(tenantId)) {
    if (b.tenantId !== tenantId) continue;
    const byId = !!b.contactId && chainIds.has(b.contactId);
    const byAddress = !!b.inviteeEmail && values.has(normalizeIdentifierValue('email', b.inviteeEmail));
    if (!byId && !byAddress) continue;
    if (b.inviteeName === ERASED_VALUE && b.inviteeEmail === ERASED_VALUE && b.inviteeNote === undefined) continue;
    const next: Booking = { ...b, inviteeName: ERASED_VALUE, inviteeEmail: ERASED_VALUE, updatedAt: new Date().toISOString() };
    delete next.inviteeNote;
    await bookings.put(next);
    touched += 1;
  }

  // 3. crm:sign-request + crm:signature-record — `signers[].email`/`.name` and the
  //    signature's `typedName` (whose own comment says signature records "MUST be
  //    purgeable on erasure"). The signer's IDENTITY goes; the evidence that a
  //    signature happened — timestamps, the content hash, the hashed IP/UA — stays,
  //    because that is the org's legal record of its own transaction and holds no
  //    plaintext PII.
  for (const r of await signRequests.listForTenantIndexed(tenantId)) {
    if (r.tenantId !== tenantId) continue;
    const hit = (r.signers ?? []).some((s) => !!s.email && values.has(normalizeIdentifierValue('email', s.email)));
    if (!hit) continue;
    const signers = r.signers.map((s) => {
      if (!s.email || !values.has(normalizeIdentifierValue('email', s.email))) return s;
      const next = { ...s, email: ERASED_VALUE, name: ERASED_VALUE };
      return next;
    });
    const requestedBy = r.requestedBy?.email && values.has(normalizeIdentifierValue('email', r.requestedBy.email))
      ? { name: ERASED_VALUE, email: ERASED_VALUE }
      : r.requestedBy;
    await signRequests.put({ ...r, signers, ...(requestedBy ? { requestedBy } : {}), updatedAt: new Date().toISOString() });
    touched += 1;

    const erasedSignerIds = new Set(r.signers.filter((s) => !!s.email && values.has(normalizeIdentifierValue('email', s.email))).map((s) => s.signerId));
    for (const rec of await signatureRecords.listForTenantIndexed(tenantId)) {
      if (rec.tenantId !== tenantId || rec.signRequestId !== r.signRequestId) continue;
      if (!erasedSignerIds.has(rec.signerId) || rec.typedName === undefined) continue;
      const next: SignatureRecord = { ...rec };
      delete next.typedName;
      await signatureRecords.put(next);
      touched += 1;
    }
  }

  // 4. crm:suppression — the address is RETAINED on purpose (see the docblock: it
  //    is the key that honours the refusal). Only the free-text context goes.
  for (const value of values) {
    const row = await suppressions.get(`${tenantId}::${value}`);
    if (!row || row.tenantId !== tenantId) continue;
    if (row.actor === ERASED_VALUE && row.note === undefined) continue;
    const next: SuppressionEntry = { ...row, actor: ERASED_VALUE };
    delete next.note;
    await suppressions.put(next);
    touched += 1;
  }

  // 5. crm:gmailsync — per-APP-USER mailbox sync state (cursor + the bound
  //    connectionId + a scheduler job). The subject key here is a `User.userId`,
  //    not a contactId, so this leg fires on the OTHER identity space the eraser
  //    receives. `deleteGmailSync` removes the sync row AND its scheduler job — a
  //    surviving job would keep firing a sync for an erased person's mailbox. (It
  //    ARCHIVES rather than deletes the per-sync workflow definition, which is the
  //    ADR 0369 rule for a definition a run may replay against; the definition
  //    holds no subject PII — the mailbox binding lives on the row and the
  //    connection, both of which are gone.) This was RECORDED_DEBT in the coverage
  //    ratchet on the grounds that "a re-sync from empty" needed confirming; that
  //    concern is about a user who still EXISTS, which by construction is not this
  //    case.
  for (const sync of await listGmailSyncs(tenantId, { userId: subjectKey })) {
    await deleteGmailSync(tenantId, sync.syncId);
    touched += 1;
  }

  // 6. The contact row itself — anonymized, never deleted (see the docblock). It
  //    runs LATE, after every address-keyed leg above, because it is one of the two
  //    sources `values` is derived from (fold-in B2).
  if (isOurs && contact.name !== ERASED_VALUE) {
    // `company`, `stage`, `owner`, `leadSource` and `customFields` are business
    // attributes of the RELATIONSHIP, not person PII (`declarePiiFields` below
    // names exactly `name`/`email`/`identifiers`/`address`), so they stay — the
    // org keeps a usable record of the deal it did.
    await contacts.put({ ...anonymizedContact(contact), updatedAt: new Date().toISOString() });
    touched += 1;
  }
  //    ADR 0627 D4 (`CRM-19`/`CRM-20`) — and every tombstone on the chain, same
  //    fields. `updatedAt` is left as-is on a tombstone: its purge clock is its
  //    pre-merge `updatedAt` (D4a), and an anonymized tombstone holds nothing a
  //    longer window could retain. Idempotent: an already-erased one is skipped.
  for (const t of tombstones) {
    if (t.name === ERASED_VALUE) continue;
    await contacts.put(anonymizedContact(t));
    touched += 1;
  }

  // 6b. crm:contactkeyclaim — the ADR 0627 D6 primary-email claim, whose KEY
  //     embeds the address (`${tenantId}::email::<address>`). Every claim held by
  //     a contact on the chain goes. A claim on an address in the key-set that
  //     ANOTHER contact holds goes only when that holder is not live (review
  //     S3: the first cut deleted it regardless, so erasing a survivor whose
  //     former address a new contact Z had legitimately re-created stripped Z's
  //     claim — a different person's record). A live holder outside the chain
  //     keeps its claim; the address itself is not this subject's anymore.
  for (const row of await keyClaims.listForTenantIndexed(tenantId)) {
    if (row.tenantId !== tenantId) continue;
    const addr = row.claimId.split('::').slice(2).join('::');
    if (!chainIds.has(row.contactId)) {
      if (!values.has(addr)) continue;
      const holder = await contacts.get(row.contactId);
      if (holder && holder.tenantId === tenantId && !holder.mergedInto) continue; // Z's — not ours to strip
    }
    await keyClaims.delete(row.claimId);
    touched += 1;
  }

  // 7. cdp:contact-ident — the index whose KEY is `${tenantId}::email::<address>`
  //    and whose value field holds the normalized email/phone. Deleted outright: it
  //    is a derived lookup structure, not a business record, and leaving it would
  //    keep the erased person resolvable by the very address they asked to have
  //    removed.
  //
  //    DEAD LAST, and that is deliberate (fold-in B2). These rows are both the
  //    second derivation source for `values` AND what `resolveCrmSubjectKeys` uses
  //    to turn an email-shaped DSAR key back into this contactId. Delete them early
  //    and a partial failure leaves a retry that cannot even find the contact, let
  //    alone the addresses.
  for (const row of identRows) {
    await idents.delete(row.key);
    touched += 1;
  }

  // Logged because a silent erasure is indistinguishable from one that never ran —
  // which is exactly how this package's absence went unnoticed.
  log.info('crm_subject_erased', { tenantId, rows: touched, matchedContact: isOurs });
}

/**
 * ADR 0381 subject-key resolver. Given an email/phone-shaped key, return the CRM
 * contactId it resolves to — through `cdp:contact-ident`, which is authoritative
 * and store-backed. MUST NOT be a heuristic match (that is what prevents
 * over-erasure), and it is not: an unindexed value resolves to nothing.
 *
 * This is what replaces the "distinct DSAR-by-email path (its own route/ADR)" the
 * old opt-out promised and never built. A route would have been a second erasure
 * entry point with its own authorization surface; a resolver reuses the one that
 * already exists.
 */
export async function resolveCrmSubjectKeys(tenantId: string, subjectKey: string): Promise<readonly string[]> {
  if (!tenantId || !subjectKey) return [];
  const out: string[] = [];
  const type = subjectKey.includes('@') ? 'email' : subjectKey.startsWith('+') ? 'phone' : null;
  if (!type) return out;
  const contactId = await resolveContactIdByIdentifier(tenantId, type, subjectKey);
  if (contactId) out.push(contactId);
  return out;
}

export function registerCrmErasure(): void {
  registerSubjectEraser(eraseCrmSubject);
  registerSubjectKeyResolver(resolveCrmSubjectKeys);

  // Field-level declarations for the stores this module erases, following the
  // repo's existing reasoning: declare the person-identifying values and the free
  // text that may name people; do NOT declare opaque ids (`contactId`,
  // `signerId`), which the comments feature already settled as not-PII.
  // `crm.contact` is declared by `contactsService` itself and is not repeated.
  declarePiiFields('crm:booking', ['inviteeName', 'inviteeEmail', 'inviteeNote']);
  declarePiiFields('crm:sign-request', ['signers', 'requestedBy']);
  declarePiiFields('crm:signature-record', ['typedName']);
  declarePiiFields('crm:suppression', ['email', 'note']);
  declarePiiFields('crm:merge-event', ['filledFields', 'absorbedIdentifiers']);
  declarePiiFields('cdp:contact-ident', ['value']);
  // ADR 0627 D6 — the claim's `claimId` KEY embeds the normalized address.
  // `maskGloballyByFieldName:false` — `claimId` is a generic name (`crm:companykeyclaim`
  // and `crm:dealkeyclaim` carry non-PII claimIds); only THIS entity's is masked.
  declarePiiFields('crm:contactkeyclaim', ['claimId'], { maskGloballyByFieldName: false });
  // A timeline activity's `body` is author free text that may name or quote
  // people — the same case `comments` declares its `body` for. It is declared
  // (so log masking and retention see it) but NOT erased: an activity is the
  // org's record of an interaction, and blanket-redacting a tenant's timeline
  // to remove one person's name is the disproportionate move `documents`
  // reasoned its way out of. Stated here rather than left implicit.
  declarePiiFields('crm:activity', ['body']);
}
