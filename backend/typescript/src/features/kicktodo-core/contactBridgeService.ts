/**
 * Participant ⇄ CRM Contact bridge (ADR 0449 P2). KickTodo people are opaque
 * subjects (ADR 0426 — never PII); this maps a subject to a CRM Contact ONLY
 * after a CONSENT event has already produced/attached a Contact (a paid
 * checkout, a reminder consent that carried an email, …). The subject stays
 * the internal identity; the Contact is the consented projection.
 *
 * Privacy: the row stores the OPAQUE `contactId` (an internal id), never an
 * email/name — so it is purge-safe (tenant-in-content + tenantOf) and adds no
 * PII surface. There is no route that serves this link anonymously.
 *
 * Idempotent: first-write-wins per (tenant, subject). Re-linking the SAME
 * contact is a no-op; a DIFFERENT contact is a logged conflict, never a silent
 * overwrite (a subject should resolve to one stable contact).
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { resolveContactSurvivor } from '../crm/contactsService.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('kicktodo.contact-bridge');

export type ContactLinkSource = 'paid-checkout' | 'reminder-consent' | 'leaderboard-optin';

export interface SubjectContactLink {
  tenantId: string;
  ownerSubject: string;
  /** Opaque CRM contact id — NEVER email/name (ADR 0426 privacy). */
  contactId: string;
  source: ContactLinkSource;
  linkedAt: string;
}

const links = new DurableCollection<SubjectContactLink>(
  'kicktodo-subject-contact',
  (l) => `${l.tenantId}::${l.ownerSubject}`,
  undefined,
  (l) => l.tenantId, // KTD-1 purge-safe
);

const nowIso = (): string => new Date().toISOString();

/** Link a KickTodo subject to a CRM contact (idempotent; first-write-wins).
 *  Returns the effective link. Best-effort at the call sites (a link failure
 *  must never affect the primary action — entitlement grant, consent, etc.). */
export async function linkSubjectToContact(
  tenantId: string,
  ownerSubject: string,
  contactId: string,
  source: ContactLinkSource,
): Promise<SubjectContactLink> {
  const key = `${tenantId}::${ownerSubject}`;
  const existing = await links.get(key);
  if (existing) {
    if (existing.contactId !== contactId) {
      // A subject already bound to a DIFFERENT contact — keep the first binding
      // (stable identity) and log; never silently re-point.
      log.warn('kicktodo_contact_link_conflict', { ownerSubject, existing: existing.contactId, attempted: contactId, source });
    }
    return existing;
  }
  const link: SubjectContactLink = { tenantId, ownerSubject, contactId, source, linkedAt: nowIso() };
  await links.put(link);
  log.info('kicktodo_contact_linked', { ownerSubject, source });
  return link;
}

/** The subject's LIVE CRM contact id, or null. Merge-aware + delete-safe
 *  (grade-data): CRM's `mergeContacts` relinks only the references it owns, not
 *  this cross-feature link, so a stored contactId may point at a MERGED
 *  (tombstoned) or DELETED contact. KT-PORT-7b — the merge-chain follow now lives
 *  in CRM's ONE canonical `resolveContactSurvivor` (CRM owns merge); this delegates
 *  rather than hand-rolling it (the old copy followed only one hop and lost the
 *  survivor of an A→B→C chain). Fail-closed. */
export async function resolveContactForSubject(tenantId: string, ownerSubject: string): Promise<string | null> {
  const link = await links.get(`${tenantId}::${ownerSubject}`);
  if (!link) return null;
  const survivor = await resolveContactSurvivor(tenantId, link.contactId);
  return survivor?.contactId ?? null;
}

// ── ADR 0458 Phase 0 — compliance (subject erasure + the subject-key resolver) ──
// This authoritative store is the ONE place a KickTodo opaque subject is joined to
// a real CRM identity (the consented `contactId`). It therefore backs both a DSAR
// eraser (drop the linkage) AND the ADR 0381 subject-key resolver (expand a subject
// to its linked contactId, and vice-versa, so a DSAR keyed on either side reaches
// the other's data before any eraser runs). Only store-backed keys are returned —
// never a heuristic — which is what keeps the erasure from over-reaching.

/** DSAR erasure: drop the subject→contact link for the subject. Idempotent;
 *  no-op on a falsy tenant/subject. */
export async function eraseContactLinkForSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  await links.delete(`${tenantId}::${subjectKey}`);
}

/** Resolver forward hop: the contactId(s) linked to a subject (0 or 1 today —
 *  first-write-wins per (tenant, subject)). Returns the RAW stored contactId
 *  (authoritative), not the merge-resolved survivor — erasure keys on the stored id. */
export async function linkedContactIdsForSubject(tenantId: string, subjectKey: string): Promise<string[]> {
  if (!tenantId || !subjectKey) return [];
  const link = await links.get(`${tenantId}::${subjectKey}`);
  return link ? [link.contactId] : [];
}

/** Resolver reverse hop: the subject(s) linked to a contactId (bounded
 *  tenant-prefix scan + filter — fine at erasure frequency). */
export async function subjectsForContact(tenantId: string, contactId: string): Promise<string[]> {
  if (!tenantId || !contactId) return [];
  return (await links.listForTenantIndexed(tenantId))
    .filter((l) => l.contactId === contactId)
    .map((l) => l.ownerSubject);
}

/** Test-only reset. */
export async function __resetContactBridge(): Promise<void> {
  await links.__clear();
}
