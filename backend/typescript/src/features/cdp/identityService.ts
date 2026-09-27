/**
 * CDP identity resolution (ADR 0263 / CDP-A) — the golden-record composer.
 *
 * §Boundary (ADR 0262 ruling #1): the `cdp` package is NOT a second identity
 * authority. It owns no contact store; it READS the crm-owned identifier index
 * (`crm/contactIdentityService`) + the crm contact + the analytics anon→known
 * link to assemble a read-only golden record. This is the documented cross-feature
 * READS pattern (like `campaign-connectors` reading crm/consent/suppression).
 */

import {
  findContactByEmail,
  resolveContactSurvivor,
  type Contact,
  type ContactIdentifier,
} from '../crm/contactsService.js';
import { resolveContactIdByIdentifier, isIdentifierType } from '../crm/contactIdentityService.js';
import { contactForSession } from '../analytics/identityLinkService.js';
import { maskPiiValue, maskRecordForRead } from '../../host/dataClassification.js';
import { resolveRecordAccess } from '../../host/recordAccessPolicy.js';
import { recordGovernanceDecision } from '../../host/governanceDecisionLog.js';

/** Identifier types whose value is PII (masked for scope-limited callers). */
const PII_IDENTIFIER_TYPES = new Set(['email', 'phone']);

/**
 * Mask a golden record's PII for a caller without a pii-read grant (ADR 0268 /
 * CDP-F), via the same deterministic pseudonymizer. Structure-preserving (unlike the
 * coarse whole-field masker); leaves non-PII (company, stage, title, loyalty/device
 * ids, the opaque contactId) intact.
 *
 * CLNP-3 correction: this used to hand-list `name` + `email` and spread the rest of
 * the contact through, so the derived `phone` and the DECLARED-PII `address` crossed a
 * boundary labelled "masked" in clear — and since the CDP node records this record,
 * into the durable run log. The contact's declared PII fields now come from the ONE
 * registry (`declarePiiFields('crm.contact', …)`) through `maskRecordForRead`, so a
 * field added there is masked here without a second list to drift. `identifiers` keeps
 * its structured mask (the registry's whole-value mask would hash the array itself).
 * `customFields` are tenant-defined with no PII classification, so string values are
 * masked fail-closed; numbers and booleans are not person-identifying on their own.
 */
export function maskGoldenRecord(r: GoldenRecord): GoldenRecord {
  const { identifiers, customFields, ...rest } = r.contact;
  const maskedContact: Contact = {
    ...maskRecordForRead('crm.contact', rest),
    customFields: Object.fromEntries(
      Object.entries(customFields ?? {}).map(([k, v]) => [k, typeof v === 'string' ? maskPiiValue(v) : v]),
    ),
    ...(identifiers ? { identifiers: identifiers.map((i) => (PII_IDENTIFIER_TYPES.has(i.type) ? { ...i, value: maskPiiValue(i.value) } : i)) } : {}),
  };
  return {
    contact: maskedContact,
    identifiers: r.identifiers.map((i) => (PII_IDENTIFIER_TYPES.has(i.type) ? { ...i, value: maskPiiValue(i.value) } : i)),
    resolvedBy: PII_IDENTIFIER_TYPES.has(r.resolvedBy.type) ? { type: r.resolvedBy.type, value: maskPiiValue(r.resolvedBy.value) } : r.resolvedBy,
    // `mergedFrom` is an opaque contact id, not person PII — carried through
    // masking for the same reason `contact.contactId` is.
    ...(r.mergedFrom ? { mergedFrom: r.mergedFrom } : {}),
  };
}

export interface GoldenRecord {
  /** The live customer record (a tombstone is followed to its survivor). */
  contact: Contact;
  /** Every non-email identifier the customer resolves by (mirrors contact.identifiers). */
  identifiers: ContactIdentifier[];
  /** The identifier the lookup matched on. */
  resolvedBy: { type: string; value: string };
  /**
   * CDP-G2 — set when the identifier matched a contact that has since been
   * MERGED AWAY, and the answer above is therefore the surviving record rather
   * than the one the identifier was filed under. The resolver already walks
   * this chain; reporting it is what stops the console from silently answering
   * about a different customer than the one you asked for. Absent on a direct
   * hit, and absent when the matched id is unknowable (the legacy pre-index
   * email scan) — we never *guess* a merge happened.
   */
  mergedFrom?: { contactId: string };
}

/**
 * Resolve a customer by ANY identifier → the golden record. Returns null when
 * unknown. Tenant-guarded. Follows a merge tombstone (`mergedInto`) to the live
 * survivor so a merged customer still resolves. (ADR 0263 §3)
 */
export async function resolveIdentity(tenantId: string, type: string, value: string): Promise<GoldenRecord | null> {
  if (!tenantId || !isIdentifierType(type)) return null;
  let contact: Contact | null;
  /** The contact the IDENTIFIER is filed under, before any merge-follow. Null
   *  when unknowable (the legacy pre-index email scan), which is why a merge is
   *  only ever reported, never inferred. */
  let matchedId: string | null;
  if (type === 'email') {
    // Delegate to the crm owner: index lookup + self-healing scan for legacy
    // (pre-index) rows + tombstone-follow, all in one place (ADR 0263).
    contact = await findContactByEmail(tenantId, value);
    // CDP-G2 — the owner returns the survivor, so ask the index (an O(1) read)
    // what the identifier itself points at. A legacy row has no index entry ⇒
    // null ⇒ no merge claimed.
    matchedId = contact ? await resolveContactIdByIdentifier(tenantId, 'email', value) : null;
  } else {
    // Non-email identifiers only exist post-ADR-0263, so a pure index lookup is
    // complete (no legacy rows to backfill).
    let id = await resolveContactIdByIdentifier(tenantId, type, value);
    // ADR 0263 P2 — anonymous→known: a `cookie` value is also the analytics
    // session key. Fall back to the identity-link (read-only compose — the
    // cleaner alternative to writing a cookie edge from analytics into crm; see
    // the ADR 0263 §4 correction). Lets prior anonymous events attribute once a
    // session is linked to a known contact.
    if (!id && type === 'cookie') id = await contactForSession(tenantId, value);
    matchedId = id;
    // CDP-G1 — the canonical merge-chain resolver (CRM owns merge, so it owns
    // this). Was a hand-rolled `while (mergedInto && hops < 8)` loop with no
    // cycle guard, which FAILED OPEN: a cycle or a >8 chain fell out of the loop
    // still holding a tombstone and handed it back as the golden record.
    // `resolveContactSurvivor` is cycle-guarded, tenant-checked, and fails closed
    // — and its docblock already names two earlier hand-rolled copies that each
    // got the follow wrong. This was the third.
    contact = id ? await resolveContactSurvivor(tenantId, id) : null;
  }
  if (!contact || contact.tenantId !== tenantId) return null;
  return {
    contact,
    identifiers: contact.identifiers ?? [],
    resolvedBy: { type, value },
    ...(matchedId && matchedId !== contact.contactId ? { mergedFrom: { contactId: matchedId } } : {}),
  };
}

/**
 * XCH-HOLE-6 (LLM-EXCHANGE-AUDIT round 3) — resolve + label-based access as
 * ONE shared helper so the HTTP route and the agent tool cannot drift
 * (ARCHITECTURE.md read-tool contract). A `crm.contact` is classified
 * confidential-pii (ADR 0268 / CDP-F): a caller WITHOUT a pii-read grant gets
 * a MASKED golden record, and the masking decision is governance-logged.
 * Returns null when the identifier resolves to nobody.
 */
export async function resolveIdentityWithAccess(
  tenantId: string,
  type: string,
  value: string,
  hasPiiGrant: boolean,
): Promise<{ record: GoldenRecord; masked: boolean } | null> {
  const record = await resolveIdentity(tenantId, type, value);
  if (!record) return null;
  const access = resolveRecordAccess('crm.contact', hasPiiGrant);
  if (access === 'masked') {
    void recordGovernanceDecision({ tenantId, kind: 'masking', outcome: 'allow', reason: 'pii-masked-for-scope-limited-caller', resource: 'crm.contact' });
    return { record: maskGoldenRecord(record), masked: true };
  }
  return { record, masked: false };
}
