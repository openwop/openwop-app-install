/**
 * CRM contact identity graph — the multi-identifier index (ADR 0263 / CDP-A).
 *
 * A CDP resolves a customer by ANY identifier (email, phone, loyalty, device,
 * cookie, external-system id), not just email. Today `contactsService.ts` carries
 * one optional `email` and resolves it with a linear tenant scan
 * (`findContactByEmail`). This module adds:
 *
 *  - a non-email `identifiers[]` set on the Contact (`ContactIdentifier`), and
 *  - a tenant-scoped by-identifier INDEX (`cdp:contact-ident`), keyed
 *    `${tenantId}::${type}::${normalizedValue}` → contactId, so resolution is an
 *    O(1) point lookup instead of a scan.
 *
 * §Boundary (ADR 0263 correction): the index lives in the **crm** package — crm
 * owns the customer record AND its lookup indexes; there is NO second identity
 * authority. The `cdp` feature package only READS this (`resolveContactIdByIdentifier`)
 * to compose a golden record; it never owns a contact store. (This refines the ADR's
 * "cdp owns the index" to avoid a crm→cdp write dependency, an ADR 0001 cross-feature
 * import smell.)
 *
 * §Consistency (review finding #5 / TOCTOU): the index is a derived structure kept
 * consistent with the contact on every create/update/merge/tombstone via
 * `reindexContact`. The index is last-writer-wins on a key; `resolveContactIdByIdentifier`
 * is therefore paired with a tombstone re-check at the read site (the caller follows
 * `mergedInto`), so a stale key can never resolve to a live-looking tombstone.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';

/** The closed host vocabulary of identifier types. Adding one is a host change
 *  (host-ext), never a wire change. `external:<system>` is modeled as type
 *  `external` with the system encoded in the value by the caller. */
export const IDENTIFIER_TYPES = ['email', 'phone', 'loyalty', 'device', 'cookie', 'external'] as const;
export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

/** A non-email external identifier a contact resolves by. `email` is NOT stored
 *  here (it stays the `Contact.email` convenience field) but IS indexed uniformly
 *  by `computeIndexEntries`. */
export interface ContactIdentifier {
  type: IdentifierType;
  /** Raw as supplied; normalized only for the index key (`normalizeIdentifierValue`). */
  value: string;
  /** Who asserted it (e.g. 'form', 'import', 'manual', 'analytics'). */
  source: string;
  verifiedAt?: string;
}

export function isIdentifierType(t: string): t is IdentifierType {
  return (IDENTIFIER_TYPES as readonly string[]).includes(t);
}

/** Normalize a value for the index key ONLY (the stored `value` keeps the raw
 *  form). Deterministic + replay-stable: email→lowercased/trimmed; phone→digits
 *  and a leading `+`; everything else→trimmed. */
export function normalizeIdentifierValue(type: string, value: string): string {
  const v = value.trim();
  if (type === 'email') return v.toLowerCase();
  if (type === 'phone') return v.replace(/[^\d+]/g, '');
  return v;
}

interface IdentIndexRow {
  /** `${tenantId}::${type}::${normalizedValue}` */
  key: string;
  tenantId: string;
  type: string;
  value: string; // normalized
  contactId: string;
}

// Tenant secondary index armed (mirrors `crm:contact`) so a tenant slice is a
// bounded scan and the retention/erasure paths stay tenant-scoped.
const identIndex = new DurableCollection<IdentIndexRow>(
  'cdp:contact-ident',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);

function indexKey(tenantId: string, type: string, normValue: string): string {
  return `${tenantId}::${type}::${normValue}`;
}

/** A minimal contact shape the index needs (avoids importing the full Contact
 *  type + a cycle). */
export interface IndexableContact {
  tenantId: string;
  contactId: string;
  email?: string;
  identifiers?: ContactIdentifier[];
}

/** The full set of {type, normalizedValue} keys a contact should index under —
 *  the `email` field plus every entry in `identifiers[]`. */
function computeIndexEntries(contact: IndexableContact): { type: string; norm: string; raw: string }[] {
  const out: { type: string; norm: string; raw: string }[] = [];
  if (contact.email && contact.email.trim()) {
    out.push({ type: 'email', norm: normalizeIdentifierValue('email', contact.email), raw: contact.email });
  }
  for (const id of contact.identifiers ?? []) {
    if (!id.value || !id.value.trim()) continue;
    out.push({ type: id.type, norm: normalizeIdentifierValue(id.type, id.value), raw: id.value });
  }
  return out;
}

/**
 * Bring the index in line with a contact's current identifiers. Deletes keys the
 * contact no longer has and (re)points its current keys at `next.contactId`.
 * Idempotent; safe to call on every write. `prev` is the pre-write row (or null
 * on create) so stale keys are removed. A merge passes the survivor as `next` to
 * re-point the source's keys.
 */
export async function reindexContact(prev: IndexableContact | null, next: IndexableContact | null): Promise<void> {
  const tenantId = next?.tenantId ?? prev?.tenantId;
  if (!tenantId) return;
  const prevKeys = new Set((prev ? computeIndexEntries(prev) : []).map((e) => indexKey(prev!.tenantId, e.type, e.norm)));
  const nextEntries = next ? computeIndexEntries(next) : [];
  const nextKeyed = nextEntries.map((e) => ({ k: indexKey(next!.tenantId, e.type, e.norm), e }));
  const nextKeys = new Set(nextKeyed.map((x) => x.k));

  for (const k of prevKeys) {
    if (!nextKeys.has(k)) await identIndex.delete(k);
  }
  if (next) {
    for (const { k, e } of nextKeyed) {
      await identIndex.put({ key: k, tenantId: next.tenantId, type: e.type, value: e.norm, contactId: next.contactId });
    }
  }
}

/** Drop every index entry a contact owns (hard delete of the contact). */
export async function unindexContact(contact: IndexableContact): Promise<void> {
  await reindexContact(contact, null);
}

/**
 * Resolve a contactId by any identifier (O(1) point lookup). Returns null when
 * unknown. Tenant-guarded. The caller MUST re-check the resolved contact for a
 * `mergedInto` tombstone and follow it (the index is last-writer-wins and does
 * not itself prune tombstones — the golden-record resolver does).
 */
export async function resolveContactIdByIdentifier(tenantId: string, type: string, value: string): Promise<string | null> {
  if (!tenantId || !isIdentifierType(type)) return null;
  const norm = normalizeIdentifierValue(type, value);
  if (!norm) return null;
  const row = await identIndex.get(indexKey(tenantId, type, norm));
  return row && row.tenantId === tenantId ? row.contactId : null;
}

/** Merge two identifier lists, de-duplicating by (type, normalizedValue); the
 *  survivor's entry wins on collision (keeps its `source`/`verifiedAt`). */
export function unionIdentifiers(survivor: ContactIdentifier[] | undefined, source: ContactIdentifier[] | undefined): ContactIdentifier[] {
  const seen = new Map<string, ContactIdentifier>();
  for (const id of survivor ?? []) seen.set(`${id.type}::${normalizeIdentifierValue(id.type, id.value)}`, id);
  for (const id of source ?? []) {
    const k = `${id.type}::${normalizeIdentifierValue(id.type, id.value)}`;
    if (!seen.has(k)) seen.set(k, id);
  }
  return [...seen.values()];
}

/** Validate + normalize a caller-supplied identifier for storage. Throws
 *  `validation_error` on an unknown type or empty value. */
export function validateIdentifier(input: { type: string; value: string; source?: string; verifiedAt?: string }): ContactIdentifier {
  if (!isIdentifierType(input.type)) {
    throw new OpenwopError('validation_error', `Unknown identifier type '${input.type}'.`, 400, { type: input.type });
  }
  const value = (input.value ?? '').trim();
  if (!value) throw new OpenwopError('validation_error', 'Identifier value is required.', 400, {});
  const out: ContactIdentifier = { type: input.type, value, source: input.source?.trim() || 'manual' };
  if (input.verifiedAt) out.verifiedAt = input.verifiedAt;
  return out;
}
