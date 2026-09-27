/**
 * CRM contacts store (host-extension, best-effort — ADR 0001 §4).
 *
 * Tenant-scoped contacts backed by the durable host_ext_kv collection (same
 * read-through, cross-instance store as roster/kanban; no schema migration).
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { cleanString } from '../../host/boundedStrings.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { fireCrmRecordDeleted } from '../../host/crmRecordLifecycle.js';
import { changedFields, crmMutated, emitOptsOf, type CrmEmitOptions } from './emit.js';
import { OpenwopError } from '../../types.js';
import {
  reindexContact,
  unindexContact,
  resolveContactIdByIdentifier,
  validateIdentifier,
  normalizeIdentifierValue,
  type ContactIdentifier,
} from './contactIdentityService.js';

export type { ContactIdentifier } from './contactIdentityService.js';

// ADR 0077 P1 — declare this entity's PII fields once at module load (the
// `registerSubjectEraser` side-effect pattern). `name` + `email` identify a person;
// `company` is an org attribute, not personal data. `identifiers` (ADR 0263) carries
// phone/loyalty/device values → PII, masked as a whole in logs (nested-array values
// aren't field-named, so the coarse array mask is the honest floor).
// `phone` (CLNP-3): not a stored column but a DERIVED field on the public read
// (`deriveContactRead`), so every read-side masker must see it as PII too — it was the
// one field of the CDP golden record that crossed a "masked" boundary in clear.
declarePiiFields('crm.contact', ['name', 'email', 'identifiers', 'address', 'phone']);

export type ContactStage = 'lead' | 'qualified' | 'customer' | 'churned';
export const CONTACT_STAGES: readonly ContactStage[] = ['lead', 'qualified', 'customer', 'churned'];

/**
 * Shared `stage` field parser (CRMGAP-11) — the ONE definition `routes.ts`
 * and `surface.ts` used to duplicate. `opts.required` (default `false`)
 * matches the two call shapes both callers needed: `routes.ts`'s PATCH body
 * treats an absent `stage` as "leave unchanged" (returns `undefined`);
 * `ctx.features.crm`'s `updateContactStage` verb requires it (throws when
 * absent). Present-but-invalid always throws, regardless of `required`.
 */
export function parseStage(value: unknown, opts: { required: boolean } = { required: false }): ContactStage | undefined {
  if (value === undefined) {
    if (opts.required) {
      throw new OpenwopError('validation_error', 'Field `stage` is required.', 400, { field: 'stage' });
    }
    return undefined;
  }
  if (typeof value === 'string' && (CONTACT_STAGES as readonly string[]).includes(value)) return value as ContactStage;
  throw new OpenwopError('validation_error', `Field \`stage\` MUST be one of ${CONTACT_STAGES.join(', ')}.`, 400, {
    field: 'stage',
    allowed: CONTACT_STAGES,
  });
}

export interface Contact {
  contactId: string;
  tenantId: string;
  name: string;
  email?: string;
  company?: string;
  stage: ContactStage;
  /** Opaque owning-subject id (RFC 0048) — an assignment reference, NOT person
   *  PII, so deliberately absent from declarePiiFields. (ADR 0008 amendment.) */
  owner?: string;
  /** Denormalized last-triage stamp written by the triage route at dispatch
   *  time. The run (run.metadata) stays the provenance SSoT; this is a list-
   *  sortable projection. Score/priority land here once the real triage chain
   *  writes back through the governed verb (gap-analysis C2). */
  lastTriage?: { variant: string | null; runId: string; at: string };
  /** Set by a merge (ADR 0209 §2): this contact is a TOMBSTONE — kept for
   *  provenance (referencing rows relinked to `mergedInto` before this was
   *  set), excluded from `listContacts`/duplicate groups, but still resolvable
   *  by id so external refs don't dangle. */
  mergedInto?: string;
  mergedAt?: string;
  /** Tenant-scoped custom fields (ADR 0213 §2) — validated at write against
   *  the tenant's `contact` field defs (`crmEntitiesService.resolveContactCustomFields`).
   *  Defaults to `{}`; a pre-ADR-0208 row read back without this key is
   *  projected to `{}` by `projectContact`, never `undefined`. */
  customFields: Record<string, string | number | boolean>;
  /** CRM-2 (ADR 0383) — first-class contact attributes promoted from customFields.
   *  All optional; `leadSource` is a FREE string (tenant-specific vocabulary, not an enum). */
  title?: string;
  address?: string;
  leadSource?: string;
  /** Non-email external identifiers (ADR 0263 / CDP-A). Additive — pre-0263 rows
   *  have no key. `email` is NOT duplicated here (stays the field above) but is
   *  indexed uniformly by `contactIdentityService`. */
  identifiers?: ContactIdentifier[];
  /** CRM-2 (ADR 0383) — DERIVED, READ-ONLY: the phone identifier surfaced as a first-class
   *  field. NEVER stored (the `identifiers[]` phone entry stays the identity-resolution SoT);
   *  `getContact`/`listContacts` derive it on read, and a `phone` write-input upserts the
   *  identifier. Absent from the stored row, so write round-trips can't persist it. */
  phone?: string;
  createdAt: string;
  updatedAt: string;
}

/** Read projection — pre-ADR-0208 rows have no `customFields` (mirrors
 *  `crmEntitiesService.projectDeal`'s pre-amendment `status` backfill). */
const projectContact = (c: Contact): Contact => (c.customFields ? c : { ...c, customFields: {} });

/** CRM-2 (ADR 0383) PUBLIC read projection — `projectContact` + the DERIVED read-only `phone`
 *  (from the phone identifier). Applied ONLY at the public read boundary (`getContact` /
 *  `listContacts`), NEVER on the write round-trip (which uses `store.get` + `projectContact`),
 *  so `phone` can never leak into the stored row. */
function deriveContactRead(c: Contact): Contact {
  const base = projectContact(c);
  const phone = (base.identifiers ?? []).find((i) => i.type === 'phone')?.value;
  return phone ? { ...base, phone } : base;
}

const MAX_TITLE = 200, MAX_ADDRESS = 500, MAX_LEADSOURCE = 100;
/** CRM-2 bounded string validators — fail-closed (a non-string 400s); '' / null ⇒ undefined. */
function optContactStr(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new OpenwopError('validation_error', `Field \`${field}\` MUST be a string.`, 400, { field });
  return cleanString(v, max) || undefined;
}

// GOV-1: `tenantOf` arms the tenant secondary index so the retention purger scans only
// this tenant's slice (`listForTenantIndexed`) instead of the whole collection.
const store = new DurableCollection<Contact>('crm:contact', (c) => c.contactId, undefined, (c) => c.tenantId);

/**
 * ADR 0627 D6 (`CRM-22`) — the PRIMARY-EMAIL uniqueness claim. `createContact`
 * inserts one row per `(tenant, normalized email)` via `compareAndSwap(null, …)`
 * (insert-only-if-absent — the `convertService` `crm:companykeyclaim` shape), so
 * two concurrent creates for the same address settle on exactly ONE contact and
 * the loser gets a 409 carrying the winner's id. NOT a CAS on the
 * `cdp:contact-ident` row: `reindexContact` writes and re-points that index with
 * a plain `put` on every merge/update, so it cannot double as a claim.
 *
 * WHAT IS AND IS NOT CLAIMED (stated, per the ADR):
 *  - only the `email` field (the primary address) — a contact with no email is
 *    never claimed, and never blocks anyone;
 *  - a SECONDARY `identifiers[]` email (an address a survivor absorbed on merge,
 *    or one added via `addContactIdentifier`) is NOT claimed: `createContact`
 *    for that address succeeds and the pair surfaces in duplicate review;
 *  - `updateContact` gates an email PATCH the same way (review S1 — the first
 *    cut left PATCH "best-effort" and thereby minted the exact duplicate the
 *    create lane refuses): the new address is claimed BEFORE the row lands and
 *    a live holder is the same 409; the old address's claim is released AFTER
 *    the put (else a re-created contact with the old email could never exist).
 *  - the `cdp:contact-ident` index is the identity SSoT a create/patch MUST
 *    respect (review S2): after the claim lands, an address the index resolves
 *    to a live contact other than self (a legacy pre-claim row, or a survivor
 *    that absorbed it as a secondary) releases the claim and 409s naming that
 *    contact — otherwise `reindexContact`'s plain put would silently steal the
 *    survivor's identity. "Secondaries are not claimed" stays true; they are
 *    still not CREATABLE over, because the index says who they belong to.
 *
 * CLAIM LIFECYCLE — the decision the ADR asked for. The claim follows the
 * contact that holds the address as PRIMARY:
 *  - `deleteContact` releases it (the retention purger routes through
 *    `deleteContact`, so a purge releases too);
 *  - a MERGE re-points the source's claim to the survivor when the survivor
 *    ADOPTED the source's email as its primary (`fill.email`), and RELEASES it
 *    otherwise (the address became an unclaimed secondary identifier of the
 *    survivor — `ensureContact` still resolves it to the survivor through the
 *    ident index, so no lane mints a duplicate by accident);
 *  - an UNMERGE re-claims for the restored source, best-effort (a contact
 *    created at that address in between keeps the claim; the pair shows in
 *    duplicate review);
 *  - erasure (`erasure.ts`) DELETES the row outright — its KEY embeds the
 *    address, the same reason `cdp:contact-ident` rows go.
 * A claim whose holder is FOREIGN or TOMBSTONED is stale and is taken over by
 * the next claimant (CAS on the old claim, never read-then-put). A claim whose
 * holder row is MISSING is NOT stale — it is the winner of a concurrent create
 * that has claimed but not yet landed its `store.put` (review B1: with 5 ms of
 * write latency the first cut read "missing ⇒ stale", took the claim over, and
 * two rows landed — the in-process sqlite hid it; Postgres would not). It is
 * treated as in flight for `CLAIM_INFLIGHT_GRACE_MS` from `claimedAt`; only a
 * phantom older than that (a crash between claim and put — `createContact`
 * releases on a FAILED put, so a crash is the only way one forms) is taken over.
 *
 * Tenant-teardown-reachable via the top-level `tenantId` (+ `tenantOf`);
 * erasure-reachable via `contactId` (the ADR 0464 feature-store gate binds it).
 */
export interface ContactKeyClaim {
  /** `${tenantId}::email::${normalizedEmail}` */
  claimId: string;
  tenantId: string;
  contactId: string;
  /** ISO — when this claim was taken; the in-flight grace clock (review B1).
   *  Optional only for rows written before the field existed: those are past
   *  any grace window by construction. */
  claimedAt?: string;
}
/** How long a claim whose holder row is not yet readable counts as IN FLIGHT
 *  (a concurrent create between its claim and its put) rather than a phantom. */
export const CLAIM_INFLIGHT_GRACE_MS = 60_000;
const contactKeyClaims = new DurableCollection<ContactKeyClaim>('crm:contactkeyclaim', (c) => c.claimId, undefined, (c) => c.tenantId);

function contactKeyClaimId(tenantId: string, email: string): string {
  return `${tenantId}::email::${normalizeIdentifierValue('email', email)}`;
}

/** The `details` shape of the D6 duplicate-email 409 — `existingContactId` is
 *  what `ensureContact` (and any create-or-adopt lane) resolves through. */
export function duplicateEmailContactIdOf(err: unknown): string | null {
  if (!(err instanceof OpenwopError) || err.httpStatus !== 409 || err.code !== 'validation_error') return null;
  const id = err.details?.existingContactId;
  return typeof id === 'string' && id ? id : null;
}

/** Is `holder` a claim that still describes a LIVE primary holder other than
 *  `contactId`? Self / foreign / tombstoned ⇒ stale ⇒ takeover-able. A MISSING
 *  holder row is live while inside the in-flight grace window (review B1). */
async function claimHolderIsLive(holder: ContactKeyClaim, tenantId: string, contactId: string): Promise<boolean> {
  if (holder.tenantId !== tenantId || holder.contactId === contactId) return false;
  const c = await store.get(holder.contactId);
  if (c) return c.tenantId === tenantId && !c.mergedInto;
  const at = holder.claimedAt ? Date.parse(holder.claimedAt) : NaN;
  return Number.isFinite(at) && Date.now() - at < CLAIM_INFLIGHT_GRACE_MS;
}

function duplicateEmailError(existingContactId: string): OpenwopError {
  return new OpenwopError('validation_error', 'A contact with this email already exists.', 409, { field: 'email', existingContactId });
}

/**
 * The ONE guard a create or an email PATCH runs before its row lands: claim
 * the address (insert-only CAS; a stale holder is taken over by CAS on the old
 * claim), then respect the `cdp:contact-ident` index (review S2). Throws the
 * D6 409 naming the live holder; on the index refusal the just-taken claim is
 * released first so nothing is left half-claimed.
 */
async function claimPrimaryEmailOrThrow(tenantId: string, email: string, contactId: string): Promise<void> {
  const holder = await claimContactKey(tenantId, email, contactId);
  if (holder) throw duplicateEmailError(holder);
  const indexed = await resolveContactIdByIdentifier(tenantId, 'email', email);
  if (indexed && indexed !== contactId) {
    const live = await resolveContactSurvivor(tenantId, indexed);
    if (live && live.contactId !== contactId) {
      await releaseContactKey(tenantId, email, contactId);
      throw duplicateEmailError(live.contactId);
    }
  }
}

/**
 * Claim `email` for `contactId`. Returns `null` on success, or the id of the
 * LIVE contact that already holds it. ONE takeover attempt on a stale holder —
 * a second loss means a concurrent live claimant won, which is a duplicate.
 */
async function claimContactKey(tenantId: string, email: string, contactId: string): Promise<string | null> {
  const claimId = contactKeyClaimId(tenantId, email);
  const next: ContactKeyClaim = { claimId, tenantId, contactId, claimedAt: new Date().toISOString() };
  if (await contactKeyClaims.compareAndSwap(null, next)) return null;
  const holder = await contactKeyClaims.get(claimId);
  if (holder && (await claimHolderIsLive(holder, tenantId, contactId))) return holder.contactId;
  if (await contactKeyClaims.compareAndSwap(holder, next)) return null;
  const again = await contactKeyClaims.get(claimId);
  return again && again.contactId !== contactId ? again.contactId : null;
}

/** Release `email`'s claim iff `contactId` holds it (never another contact's). */
async function releaseContactKey(tenantId: string, email: string, contactId: string): Promise<void> {
  const claimId = contactKeyClaimId(tenantId, email);
  const holder = await contactKeyClaims.get(claimId);
  if (holder && holder.contactId === contactId) await contactKeyClaims.delete(claimId);
}

/** Keep ONE contact's claim in step with an email change (`prev` → `next` row of
 *  the SAME contact): release the old primary if it changed, claim the new one
 *  best-effort (a loss to a live holder is NOT an error here — see the docblock). */
async function syncContactKeyClaim(prev: IndexableContactLike | null, next: IndexableContactLike | null): Promise<void> {
  const prevNorm = prev?.email?.trim() ? normalizeIdentifierValue('email', prev.email) : '';
  const nextNorm = next?.email?.trim() ? normalizeIdentifierValue('email', next.email) : '';
  if (prevNorm === nextNorm) return;
  if (prev && prevNorm) await releaseContactKey(prev.tenantId, prev.email!, prev.contactId);
  if (next && nextNorm) await claimContactKey(next.tenantId, next.email!, next.contactId);
}
type IndexableContactLike = { tenantId: string; contactId: string; email?: string };

/**
 * ADR 0627 D6 — the MERGE leg of the claim lifecycle (called by `mergeContacts`
 * BEFORE the source is tombstoned — review N1: a tombstoned holder reads as
 * stale, so re-pointing after the tombstone opened a takeover window). Re-point
 * the source's primary-email claim to the survivor when the survivor now holds
 * that address as ITS primary (CAS on the old claim, never read-then-put);
 * release it otherwise. Idempotent: a claim not held by the source is left alone.
 */
export async function repointContactKeyClaimForMerge(source: IndexableContactLike, survivor: IndexableContactLike): Promise<void> {
  if (!source.email?.trim()) return;
  const claimId = contactKeyClaimId(source.tenantId, source.email);
  const holder = await contactKeyClaims.get(claimId);
  if (!holder || holder.contactId !== source.contactId) return;
  const survivorHoldsIt = !!survivor.email?.trim()
    && normalizeIdentifierValue('email', survivor.email) === normalizeIdentifierValue('email', source.email);
  if (survivorHoldsIt) await contactKeyClaims.compareAndSwap(holder, { ...holder, contactId: survivor.contactId, claimedAt: new Date().toISOString() });
  else await contactKeyClaims.delete(claimId);
}

/** Read a claim (tests + the merge/erasure witnesses). */
export async function getContactKeyClaim(tenantId: string, email: string): Promise<ContactKeyClaim | null> {
  return contactKeyClaims.get(contactKeyClaimId(tenantId, email));
}

/** The caller's contacts, newest first. Tombstoned (merged-away) contacts are
 *  excluded — a merge source stays resolvable by id (`getContact`) but never
 *  reappears in the rolodex or duplicate groups (ADR 0209 §2). */
export async function listContacts(tenantId: string): Promise<Contact[]> {
  // CRMGAP-5: the tenant index was already armed (GOV-1, above) for the
  // retention purger but this read path kept scanning the whole collection —
  // switch to the bounded per-tenant slice.
  const all = await store.listForTenantIndexed(tenantId);
  return all.filter((c) => !c.mergedInto).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(deriveContactRead);
}

export async function getContact(contactId: string): Promise<Contact | null> {
  const c = await store.get(contactId);
  return c ? deriveContactRead(c) : null;
}

/**
 * KT-PORT-7b — the ONE canonical merge-chain survivor resolver (CRM owns merge, so
 * it owns this). Follow `mergedInto` from a possibly-tombstoned contact id to its
 * LIVE survivor, tenant-checked, returning null when the target is gone or
 * cross-tenant. `mergeContacts` permits a chain (A→B→C), so this follows MULTI-hop
 * with a cycle + depth guard — the hand-rolled one-hop copies (this file's
 * `findContactByEmail`, kicktodo `contactBridgeService`) each MISSED a 2-long chain
 * (returning a tombstone or null). Consolidated here so a caller never re-implements
 * the follow, and never hands out a dead id. Fail-closed.
 */
export async function resolveContactSurvivor(tenantId: string, contactId: string): Promise<Contact | null> {
  const seen = new Set<string>();
  let current: string | undefined = contactId;
  // Depth bound is defensive; the cycle guard is the real protection (a malformed
  // chain fails closed rather than looping).
  for (let hops = 0; current && hops < 32; hops++) {
    if (seen.has(current)) return null; // cycle ⇒ fail closed
    seen.add(current);
    const contact = await getContact(current);
    if (!contact || contact.tenantId !== tenantId) return null; // deleted / cross-tenant
    if (!contact.mergedInto) return contact; // the live survivor
    current = contact.mergedInto;
  }
  return null; // over-deep / dead-end
}

/** Find a tenant's contact by exact email match, case-insensitive (ADR 0252 §2
 *  — no by-email index exists, so this is `listContacts` + an in-memory find,
 *  bounded by the tenant's contact cap). Excludes tombstoned (merged-away)
 *  contacts — `listContacts` already filters those out. Returns null when no
 *  contact carries this email; the caller (Gmail inbox sync) never creates one. */
export async function findContactByEmail(tenantId: string, email: string): Promise<Contact | null> {
  const needle = email.trim();
  if (!needle) return null;
  // ADR 0263 — O(1) index lookup (was a linear tenant scan). Follow a tombstone
  // to its survivor so a merged contact still resolves to the live record.
  const id = await resolveContactIdByIdentifier(tenantId, 'email', needle);
  if (id) {
    // KT-PORT-7b — the canonical multi-hop survivor resolver (was a one-hop follow
    // that returned a tombstone on an A→B→C chain).
    const survivor = await resolveContactSurvivor(tenantId, id);
    if (survivor) return survivor;
  }
  // Self-healing fallback (ADR 0263): a contact created BEFORE the index existed
  // has no entry. Scan once, and opportunistically seed the index so the next
  // lookup is O(1) — no separate backfill migration needed, and never a silent
  // miss for legacy data. Tombstones are excluded (listContacts already omits them).
  const lower = needle.toLowerCase();
  const found = (await listContacts(tenantId)).find((c) => c.email?.toLowerCase() === lower) ?? null;
  if (found) await reindexContact(null, found);
  return found;
}

/**
 * ADR 0449 P1 — the ONE shared "find-or-create a contact by email" seam. Extracts
 * the pattern that was hand-rolled (and divergent) in commerce checkout and the
 * webinars processor into a single owner. Merge-aware + O(1) via `findContactByEmail`
 * (so a guest whose contact was later merged resolves to the survivor).
 *
 * Returns `null` when no email is present — the ADR 0449 D3 privacy floor: a
 * contact is minted ONLY when the caller supplies a real email (no speculative
 * PII for anonymous actors). Callers own best-effort error handling (a CRM
 * failure must not block the caller's primary action) — this never swallows.
 *
 * ADR 0627 D6 closed the limitation this docblock used to record ("two
 * concurrent calls for the SAME new email both miss the lookup and each create
 * a row"): `createContact` now CLAIMS the address, so the loser of that race
 * gets the D6 duplicate 409 — which THIS seam maps to "return the existing
 * survivor", so the anon-widget / webinar / commerce / booking lanes race
 * safely and both callers get the same id.
 */
export async function ensureContact(input: {
  tenantId: string; email?: string | null; name?: string; leadSource?: string;
} & CrmEmitOptions): Promise<Contact | null> {
  return (await ensureContactWithOutcome(input)).contact;
}

/**
 * `ensureContact` that also says WHETHER it created the row — for a batch lane
 * that counts its creations (the webinar participant sync's ONE
 * `contact.imported { count }`), so it need not pre-read by email to find out.
 * `created:false` covers found-existing AND a lost create race (the row exists;
 * this caller did not mint it).
 */
export async function ensureContactWithOutcome(input: {
  tenantId: string; email?: string | null; name?: string; leadSource?: string;
} & CrmEmitOptions): Promise<{ contact: Contact | null; created: boolean }> {
  const email = (input.email ?? '').trim();
  if (!email) return { contact: null, created: false }; // no email ⇒ no contact (D3)
  const existing = await findContactByEmail(input.tenantId, email);
  if (existing) return { contact: existing, created: false };
  // ADR 0627 D2 — `contact.created` fires from `createContact` (the ONE site)
  // for a NEW row only; the found-existing return above emits nothing.
  try {
    const contact = await createContact({
      tenantId: input.tenantId,
      name: (input.name ?? '').trim() || email,
      email,
      ...(input.leadSource ? { leadSource: input.leadSource } : {}),
      ...emitOptsOf(input),
    });
    return { contact, created: true };
  } catch (err) {
    const existingId = duplicateEmailContactIdOf(err);
    if (!existingId) throw err;
    // Lost the create race to a concurrent claimant — adopt its row (followed to
    // the live survivor; the claim holder is live by construction, so this is a
    // point read, never a scan).
    const winner = await resolveContactSurvivor(input.tenantId, existingId);
    if (winner) return { contact: winner, created: false };
    // Review B1 (3): the winner has claimed but its put has not landed yet (a
    // network round-trip away). ONE short backoff + re-read by email before the
    // honest 409 — never a spin.
    await new Promise<void>((r) => setTimeout(r, 25));
    const landed = await findContactByEmail(input.tenantId, email);
    if (landed) return { contact: landed, created: false };
    throw err; // still not there — surface the honest 409
  }
}

export async function createContact(input: {
  tenantId: string;
  name: string;
  email?: string;
  company?: string;
  stage?: ContactStage;
  owner?: string;
  /** Tenant-scoped custom fields (ADR 0213 §2) — pre-validated by the caller
   *  (`crmEntitiesService.resolveContactCustomFields`), stored as-is. */
  customFields?: Record<string, string | number | boolean>;
  /** Non-email external identifiers (ADR 0263) — pre-validated via `validateIdentifier`. */
  identifiers?: ContactIdentifier[];
  /** CRM-2 (ADR 0383) — first-class attributes; `phone` upserts the phone IDENTIFIER (the SoT),
   *  never a stored scalar. */
  title?: unknown;
  address?: unknown;
  leadSource?: unknown;
  phone?: unknown;
  /** Caller-supplied deterministic id (ADR 0162 pattern — ADR 0208 §2 groundwork).
   *  MUST be `crm:`-prefixed. A row already at this id in the SAME tenant is
   *  returned unchanged (idempotent re-run/fork); a row at this id in a
   *  DIFFERENT tenant 404s rather than leaking or being silently overwritten. */
  contactId?: string;
} & CrmEmitOptions): Promise<Contact> {
  if (input.contactId !== undefined) {
    if (!input.contactId.startsWith('crm:')) {
      throw new OpenwopError('validation_error', 'contactId must be `crm:`-prefixed.', 400, { contactId: input.contactId });
    }
    const existing = await store.get(input.contactId);
    if (existing) {
      if (existing.tenantId === input.tenantId) return deriveContactRead(existing);
      throw new OpenwopError('not_found', 'Contact not found.', 404, { contactId: input.contactId });
    }
  }
  const title = optContactStr(input.title, 'title', MAX_TITLE);
  const address = optContactStr(input.address, 'address', MAX_ADDRESS);
  const leadSource = optContactStr(input.leadSource, 'leadSource', MAX_LEADSOURCE);
  // CRM-2 — a `phone` input becomes a phone IDENTIFIER (validated + deduped), never a scalar.
  const phone = optContactStr(input.phone, 'phone', 64);
  const identifiers = phone
    ? [...(input.identifiers ?? []).filter((i) => i.type !== 'phone'), validateIdentifier({ type: 'phone', value: phone })]
    : input.identifiers;
  const now = new Date().toISOString();
  const contact: Contact = {
    contactId: input.contactId ?? `crm:${randomUUID()}`,
    tenantId: input.tenantId,
    name: input.name,
    stage: input.stage ?? 'lead',
    customFields: input.customFields ?? {},
    createdAt: now,
    updatedAt: now,
    ...(input.email ? { email: input.email } : {}),
    ...(input.company ? { company: input.company } : {}),
    ...(input.owner ? { owner: input.owner } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(address !== undefined ? { address } : {}),
    ...(leadSource !== undefined ? { leadSource } : {}),
    ...(identifiers && identifiers.length ? { identifiers } : {}),
  };
  // ADR 0627 D6 (`CRM-22`) — claim the primary email BEFORE the row lands
  // (insert-only CAS + the ident-index check, see `ContactKeyClaim`). A
  // duplicate is a typed 409 that NAMES the existing contact. No email ⇒ no claim.
  if (contact.email) await claimPrimaryEmailOrThrow(contact.tenantId, contact.email, contact.contactId);
  try {
    await store.put(contact);
    await reindexContact(null, contact); // ADR 0263 — seed the by-identifier index
  } catch (err) {
    // Review B1 (2): a failed put must not leave a claim with no row behind it —
    // a phantom claim is the CRASH case only, never the failed-write case.
    if (contact.email) await releaseContactKey(contact.tenantId, contact.email, contact.contactId).catch(() => undefined);
    throw err;
  }
  // ADR 0627 D2 — the ONE `contact.created` site, NEW row only (the idempotent
  // same-id return above is not a creation). Bulk lanes pass `{ silent: true }`.
  crmMutated({ entity: 'contact', verb: 'created', tenantId: contact.tenantId, entityId: contact.contactId, ...emitOptsOf(input) });
  return deriveContactRead(contact);
}

export async function updateContact(
  contactId: string,
  patch: { name?: string; email?: string | null; company?: string | null; stage?: ContactStage; owner?: string | null; customFields?: Record<string, string | number | boolean>; title?: unknown; address?: unknown; leadSource?: unknown; phone?: unknown },
  opts: CrmEmitOptions = {},
): Promise<Contact | null> {
  const existing = await store.get(contactId);
  if (!existing) return null;
  const prev = projectContact(existing);
  const next: Contact = { ...prev, updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.stage !== undefined) next.stage = patch.stage;
  if (patch.email !== undefined) {
    if (patch.email === null || patch.email === '') delete next.email;
    else next.email = patch.email;
  }
  if (patch.company !== undefined) {
    if (patch.company === null || patch.company === '') delete next.company;
    else next.company = patch.company;
  }
  if (patch.owner !== undefined) {
    if (patch.owner === null || patch.owner === '') delete next.owner;
    else next.owner = patch.owner;
  }
  // CRM-2 — first-class strings: null/'' clears, a value validates fail-closed.
  if (patch.title !== undefined) { const v = optContactStr(patch.title, 'title', MAX_TITLE); if (v === undefined) delete next.title; else next.title = v; }
  if (patch.address !== undefined) { const v = optContactStr(patch.address, 'address', MAX_ADDRESS); if (v === undefined) delete next.address; else next.address = v; }
  if (patch.leadSource !== undefined) { const v = optContactStr(patch.leadSource, 'leadSource', MAX_LEADSOURCE); if (v === undefined) delete next.leadSource; else next.leadSource = v; }
  // CRM-2 — `phone` upserts/removes the phone IDENTIFIER (the SoT), never a stored scalar.
  if (patch.phone !== undefined) {
    const v = optContactStr(patch.phone, 'phone', 64);
    const kept = (next.identifiers ?? []).filter((i) => i.type !== 'phone');
    const identifiers = v ? [...kept, validateIdentifier({ type: 'phone', value: v })] : kept;
    if (identifiers.length) next.identifiers = identifiers; else delete next.identifiers;
  }
  if (patch.customFields !== undefined) next.customFields = patch.customFields;
  // ADR 0627 D6 (review S1) — an email change is gated like a create: claim the
  // NEW address (+ the ident-index check) BEFORE the row lands, 409 on a live
  // holder; the OLD address's claim is released only AFTER the put.
  const prevNorm = prev.email?.trim() ? normalizeIdentifierValue('email', prev.email) : '';
  const nextNorm = next.email?.trim() ? normalizeIdentifierValue('email', next.email) : '';
  const emailChanged = prevNorm !== nextNorm;
  if (emailChanged && nextNorm) await claimPrimaryEmailOrThrow(next.tenantId, next.email!, contactId);
  try {
    await store.put(next);
    await reindexContact(prev, next); // ADR 0263 — an email/phone change re-points the index
  } catch (err) {
    if (emailChanged && nextNorm) await releaseContactKey(next.tenantId, next.email!, contactId).catch(() => undefined);
    throw err;
  }
  if (emailChanged && prevNorm) await releaseContactKey(prev.tenantId, prev.email!, contactId);
  // ADR 0627 D2 — `changed` is the FIELD NAMES whose value differs between the
  // pre-image and the landed row (never values): an empty patch AND a
  // value-equal re-PATCH are not updates and emit nothing (review S1).
  const changed = changedFields(prev, next);
  if (changed.length > 0) crmMutated({ entity: 'contact', verb: 'updated', tenantId: next.tenantId, entityId: contactId, changed, ...opts });
  return deriveContactRead(next);
}

/**
 * Add (or refresh) a non-email identifier on a contact + reindex. Tenant-guarded.
 * Idempotent on (type, normalized value): re-adding updates source/verifiedAt.
 * Returns the updated contact, or null if the contact is missing/foreign. (ADR 0263)
 */
export async function addContactIdentifier(
  contactId: string,
  tenantId: string,
  input: { type: string; value: string; source?: string; verifiedAt?: string },
  opts: CrmEmitOptions = {},
): Promise<Contact | null> {
  const existing = await store.get(contactId);
  if (!existing || existing.tenantId !== tenantId) return null;
  const ident = validateIdentifier(input);
  const prev = projectContact(existing);
  const norm = normalizeIdentifierValue(ident.type, ident.value);
  const kept = (prev.identifiers ?? []).filter((i) => !(i.type === ident.type && normalizeIdentifierValue(i.type, i.value) === norm));
  const next: Contact = { ...prev, identifiers: [...kept, ident], updatedAt: new Date().toISOString() };
  await store.put(next);
  await reindexContact(prev, next);
  crmMutated({ entity: 'contact', verb: 'updated', tenantId, entityId: contactId, changed: ['identifiers'], ...opts });
  return next;
}

/** Remove a non-email identifier from a contact + reindex. Tenant-guarded. (ADR 0263) */
export async function removeContactIdentifier(
  contactId: string,
  tenantId: string,
  type: string,
  value: string,
  opts: CrmEmitOptions = {},
): Promise<Contact | null> {
  const existing = await store.get(contactId);
  if (!existing || existing.tenantId !== tenantId) return null;
  const prev = projectContact(existing);
  const norm = normalizeIdentifierValue(type, value);
  const identifiers = (prev.identifiers ?? []).filter((i) => !(i.type === type && normalizeIdentifierValue(i.type, i.value) === norm));
  const next: Contact = { ...prev, identifiers, updatedAt: new Date().toISOString() };
  await store.put(next);
  await reindexContact(prev, next);
  crmMutated({ entity: 'contact', verb: 'updated', tenantId, entityId: contactId, changed: ['identifiers'], ...opts });
  return next;
}

/** Raw stored row (CRMGAP-8) — deliberately NOT `projectContact`-ed. A CAS
 *  compare is a byte-identical match against what's actually persisted;
 *  `getContact`'s pre-ADR-0208 `customFields:{}` backfill would make a
 *  PROJECTED snapshot mismatch the raw stored row and every CAS on a legacy
 *  row would spuriously lose. `crmMergeService.mergeContacts` is the one
 *  caller — pair with `casUpdateContact`. */
export async function getContactForCas(contactId: string): Promise<Contact | null> {
  return store.get(contactId);
}

/**
 * CAS-guarded contact field-fill (CRMGAP-8) — `expected` MUST be the exact
 * value from `getContactForCas` (or the caller's own retry re-read); the swap
 * only lands if the stored row is still byte-identical, so two concurrent
 * merges into the SAME survivor can't lose one fill to the other's
 * last-writer-wins `put`. An empty `patch` is a no-op success (nothing to
 * race on). Returns the new row on success, `null` on a lost race — NEVER
 * throws; the caller (a merge) decides the retry/409 policy.
 */
export async function casUpdateContact(
  expected: Contact,
  patch: { email?: string; company?: string; owner?: string; identifiers?: ContactIdentifier[] },
): Promise<Contact | null> {
  if (Object.keys(patch).length === 0) return projectContact(expected);
  const next: Contact = { ...expected, ...patch, updatedAt: new Date().toISOString() };
  const swapped = await store.compareAndSwap(expected, next);
  return swapped ? projectContact(next) : null;
}

/** Stamp the last-triage projection onto a contact (tenant-guarded — the
 *  triage route is the only caller). Best-effort denormalization: a missing
 *  contact is a no-op, never an error, so a race with delete can't fail the
 *  triage dispatch that already 202'd. */
export async function setContactTriage(
  contactId: string,
  tenantId: string,
  stamp: { variant: string | null; runId: string; at: string },
): Promise<void> {
  const existing = await store.get(contactId);
  if (!existing || existing.tenantId !== tenantId) return;
  await store.put({ ...existing, lastTriage: stamp, updatedAt: new Date().toISOString() });
}

/**
 * Reverse a merge's PROFILE-level effects (ADR 0264 / CDP-B): strip the identifiers
 * the survivor absorbed + clear the fields the merge filled (they were blank
 * pre-merge), then un-tombstone the source and re-point its identifier keys back to
 * itself. Reindexes both sides. Returns false when the recorded state no longer
 * holds (survivor/source gone, or source isn't a tombstone of this survivor) — the
 * caller then leaves everything untouched (fail-closed). Ref re-pointing is done by
 * the caller (crmMergeService) from the captured ref ids.
 */
export async function unmergeRestore(input: {
  survivorId: string; sourceId: string; tenantId: string;
  filledFields: Record<string, string>; absorbedIdentifiers: ContactIdentifier[];
}): Promise<boolean> {
  const survivor = await store.get(input.survivorId);
  const source = await store.get(input.sourceId);
  if (!survivor || survivor.tenantId !== input.tenantId) return false;
  if (!source || source.tenantId !== input.tenantId || source.mergedInto !== input.survivorId) return false;

  // 1. survivor: drop absorbed identifiers + clear filled fields
  const sPrev = projectContact(survivor);
  const absorbedKeys = new Set(input.absorbedIdentifiers.map((i) => `${i.type}::${normalizeIdentifierValue(i.type, i.value)}`));
  const survivorIdentifiers = (sPrev.identifiers ?? []).filter((i) => !absorbedKeys.has(`${i.type}::${normalizeIdentifierValue(i.type, i.value)}`));
  const sNext: Contact = { ...sPrev, updatedAt: new Date().toISOString() };
  if (survivorIdentifiers.length > 0) sNext.identifiers = survivorIdentifiers;
  else delete sNext.identifiers;
  for (const f of Object.keys(input.filledFields)) {
    if (f === 'email') delete sNext.email;
    else if (f === 'company') delete sNext.company;
    else if (f === 'owner') delete sNext.owner;
  }
  await store.put(sNext);
  await reindexContact(sPrev, sNext);
  await syncContactKeyClaim(sPrev, sNext); // ADR 0627 D6 — a cleared filled email releases the survivor's claim

  // 2. source: un-tombstone + re-point its own identifier keys back to itself
  const srcPrev = projectContact(source);
  const srcNext: Contact = { ...srcPrev, updatedAt: new Date().toISOString() };
  delete srcNext.mergedInto;
  delete srcNext.mergedAt;
  await store.put(srcNext);
  await reindexContact(null, srcNext);
  // ADR 0627 D6 — the restored source re-claims its primary, best-effort (see
  // `ContactKeyClaim`: a contact created at that address meanwhile keeps it).
  if (srcNext.email) await claimContactKey(srcNext.tenantId, srcNext.email, srcNext.contactId);
  return true;
}

export async function deleteContact(contactId: string, opts: CrmEmitOptions = {}): Promise<boolean> {
  // ADR 0263 — drop the contact's index entries first so a hard delete can't
  // leave a stale identifier key pointing at a gone contact (fail-closed order).
  const existing = await store.get(contactId);
  if (existing) await unindexContact(existing);
  const deleted = await store.delete(contactId);
  // ADR 0627 D6 — release the primary-email claim (iff this contact holds it) so
  // a re-created contact at that address can exist; the retention purger routes
  // through here, so a purge releases too.
  if (existing?.email) await releaseContactKey(existing.tenantId, existing.email, contactId);
  if (deleted && existing) {
    // ADR 0283 — fire AFTER the row is gone (fail-closed ordering) so consumer
    // features can drop their soft references. Contacts are tenant-scoped: no orgId.
    await fireCrmRecordDeleted({ tenantId: existing.tenantId, entity: 'contact', recordId: contactId });
    crmMutated({ entity: 'contact', verb: 'deleted', tenantId: existing.tenantId, entityId: contactId, ...opts });
  }
  return deleted;
}

/** Tombstone a merge SOURCE contact (ADR 0209 §2): keep the row (provenance +
 *  no dangling external refs) but stamp `mergedInto`/`mergedAt` so it drops out
 *  of `listContacts` and duplicate groups. Tenant-guarded; a no-op if the
 *  contact is already gone or foreign.
 *
 *  ADR 0627 D4 (`CRM-19`) — `updatedAt` is deliberately NOT refreshed. The
 *  retention purger ages on `updatedAt`, and a tombstone is a record nobody
 *  touches again: refreshing the clock at merge time handed the source's raw PII
 *  a fresh full retention window. Its purge clock is its PRE-MERGE `updatedAt`;
 *  `mergedAt` carries the merge moment. */
export async function tombstoneContact(contactId: string, tenantId: string, survivorId: string): Promise<void> {
  const existing = await store.get(contactId);
  if (!existing || existing.tenantId !== tenantId) return;
  await store.put({ ...existing, mergedInto: survivorId, mergedAt: new Date().toISOString() });
}

// CRM-2 CORRECTION — this block used to read: "DELIBERATELY NOT a
// `registerSubjectEraser` consumer (crm is retention-only) … 'Erase the third party I
// hold a record about' is a distinct DSAR-by-email path (its own route/ADR), never this
// shared principal-keyed seam". THAT ROUTE WAS NEVER BUILT, and the sentence describing
// it as an alternative made this package read as covered to every later auditor while a
// "successful" erasure left the subject's email in `cdp:contact-ident` (in the KEY),
// `crm:merge-event`, `crm:suppression`, `crm:booking`, `crm:sign-request` and
// `crm:signature-record`.
//
// The half that WAS right is preserved and is why the eraser anonymizes rather than
// deletes: a CRM contact anchors the workspace's own deals, tasks and timeline, so
// deleting the row to remove a name would destroy the org's records. See
// `features/crm/erasure.ts` — the identifying FIELDS go, the row and its business
// attributes survive, and an email-keyed DSAR reaches CRM through a registered
// `SubjectKeyResolver` over the authoritative identifier index rather than a second
// erasure entry point. `crm:suppression` is retained ON PURPOSE (the address is the key
// that honours the refusal); that decision is recorded in the coverage ratchet.

// ADR 0081 P5 — time-based retention (ADR 0077 seam). A contact carries person PII
// (name/email, declared above). Delete this tenant's contacts NOT touched within the
// window — age on `updatedAt` (abandoned records, not merely old ones: a durable entity
// differs from analytics' event-time `ts`). No-op on a falsy tenant / non-PII
// classification (fail-closed — never a cross-tenant/global purge).
registerRetentionPurger({
  feature: 'crm',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    return purgeRowsByAge('crm', await store.listForTenantIndexed(tenantId), tenantId, cutoffIso,
      (c) => ({ tenantId: c.tenantId, updatedAt: c.updatedAt, id: c.contactId }),
      // CRM-3 — `deleteContact`, NOT `store.delete`. The raw collection delete
      // bypassed both halves of the deliberate ordering 40 lines above: the
      // `unindexContact` that must run FIRST, and the `fireCrmRecordDeleted`
      // cascade. So the one per-person PII control CRM has was RETAINING the exact
      // field it exists to purge — a `cdp:contact-ident` row whose KEY is
      // `${tenantId}::email::<the address>` and whose value holds the normalized
      // email/phone survived every retention purge — while the 8 registered
      // lifecycle consumers never dropped their soft references.
      // ADR 0627 D2 — a retention purge is a BULK lane (N stale rows ⇒ N bound
      // runs otherwise), so it is silent like import/seed; the purger has its
      // own audit (`purgeRowsByAge`).
      (id) => deleteContact(id, { actor: 'system:retention', silent: true }));
  },
});

/** Test-only: clear all contacts (+ their primary-email claims). */
export async function __resetCrmStore(): Promise<void> {
  await store.__clear();
  await contactKeyClaims.__clear();
}
