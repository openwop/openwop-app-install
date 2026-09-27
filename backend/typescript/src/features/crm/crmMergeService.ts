/**
 * CRM duplicate review + merge (ADR 0209 §1/§2).
 *
 * Duplicate groups are EXACT-key groupings only (contacts by case-folded
 * email; companies by case-folded domain, else case-folded name) — no fuzzy
 * matching (ADR 0209 "Alternatives rejected").
 *
 * Merge is a field-precedence merge (survivor wins; source only fills a BLANK
 * survivor field — never regresses an existing value), then relinks the
 * referencing rows THIS PACKAGE owns (deals, tasks, activities) to the survivor,
 * THEN tombstones the source. Relink-before-tombstone is deliberate: a mid-way
 * crash leaves both records live and re-mergeable (idempotent re-run relinks the
 * remainder), never a dangling in-package reference to a tombstone.
 *
 * CRM-5 CORRECTION — this docblock used to claim the merge "RELINKS **every**
 * referencing row … never a dangling reference to a tombstone". It relinked three
 * collections, and ~20 cross-feature stores were left on the tombstone. Merge now
 * fires `fireCrmRecordMerged` after committing, so a consumer feature can move its
 * own references; the claim above is narrowed to what this module actually does.
 * A store whose owner has not registered a merge handler is still uncovered —
 * that is a real, stated gap, not a guarantee.
 *
 * CRMGAP-8 (TOCTOU): the survivor field-fill write is CAS-guarded — two
 * concurrent merges into the SAME survivor (different sources) used to race a
 * plain get→put, where the second writer's `put` could silently clobber the
 * first writer's fill (last-writer-wins losing an update, not just losing a
 * key). Each attempt re-reads the survivor fresh, recomputes the fill against
 * THAT read, and swaps via `compareAndSwap`; a lost race retries once with a
 * fresh read, and a second loss surfaces as a `409 conflict` rather than
 * silently dropping a fill or proceeding to relink/tombstone against a
 * survivor state this call never actually wrote.
 */
import { OpenwopError } from '../../types.js';
import { crmMutated, type CrmEmitOptions } from './emit.js';
import { cleanTagList } from '../../host/boundedStrings.js';
import { fireCrmRecordMerged, fireCrmRecordUnmerged } from '../../host/crmRecordLifecycle.js';
import { type Contact, casUpdateContact, getContact, getContactForCas, listContacts, tombstoneContact, unmergeRestore, repointContactKeyClaimForMerge } from './contactsService.js';
import { reindexContact, unionIdentifiers, normalizeIdentifierValue, type ContactIdentifier } from './contactIdentityService.js';
import { recordMergeEvent, getMergeEvent, consumeMergeEvent } from './crmMergeEventsService.js';
import { recordCompanyMergeEvent, getCompanyMergeEvent, consumeCompanyMergeEvent } from './crmCompanyMergeEventsService.js';
import { captureContactRefIds, restoreContactRefs } from './entities/activities.js';
import {
  type Company,
  casUpdateCompany,
  getCompany,
  getCompanyForCas,
  listCompanies,
  relinkCompanyReferences,
  relinkContactReferences,
  tombstoneCompany,
  untombstoneCompany,
  casRevertCompanyAbsorption,
  captureCompanyRefIds,
  restoreCompanyRefsToSource,
} from './crmEntitiesService.js';

/** Two attempts total: the first read + one retry on a lost CAS race. */
const MAX_MERGE_ATTEMPTS = 2;

export interface ContactDuplicateGroup {
  key: string;
  contacts: Contact[];
}
export interface CompanyDuplicateGroup {
  key: string;
  companies: Company[];
}

/** Groups contacts by case-folded email; email-less contacts are never grouped. */
export async function findDuplicateContacts(tenantId: string): Promise<{ groups: ContactDuplicateGroup[] }> {
  const byEmail = new Map<string, Contact[]>();
  for (const c of await listContacts(tenantId)) {
    const key = c.email?.trim().toLowerCase();
    if (!key) continue;
    const arr = byEmail.get(key);
    if (arr) arr.push(c);
    else byEmail.set(key, [c]);
  }
  const groups = [...byEmail.entries()]
    .filter(([, contacts]) => contacts.length > 1)
    .map(([key, contacts]) => ({ key, contacts }));
  return { groups };
}

/** Groups companies by case-folded domain; domain-less companies group by
 *  exact case-folded name instead. */
export async function findDuplicateCompanies(tenantId: string, orgId: string): Promise<{ groups: CompanyDuplicateGroup[] }> {
  const byKey = new Map<string, Company[]>();
  for (const c of await listCompanies(tenantId, orgId)) {
    const key = c.domain ? `domain:${c.domain.trim().toLowerCase()}` : `name:${c.name.trim().toLowerCase()}`;
    const arr = byKey.get(key);
    if (arr) arr.push(c);
    else byKey.set(key, [c]);
  }
  const groups = [...byKey.entries()]
    .filter(([, companies]) => companies.length > 1)
    .map(([key, companies]) => ({ key, companies }));
  return { groups };
}

/** Merge `sourceContactId` into `survivorId` (tenant-scoped — contacts are the
 *  tenant-wide rolodex). Returns the merged survivor. CAS-guarded (CRMGAP-8,
 *  see file doc) against a concurrent merge into the same survivor. */
export async function mergeContacts(tenantId: string, survivorId: string, sourceContactId: string, actor = 'system', opts: Omit<CrmEmitOptions, 'actor'> = {}): Promise<Contact> {
  if (survivorId === sourceContactId) {
    throw new OpenwopError('conflict', 'Cannot merge a contact into itself.', 409, { contactId: survivorId });
  }
  const source = await getContact(sourceContactId);
  if (!source || source.tenantId !== tenantId) {
    throw new OpenwopError('not_found', 'Contact not found.', 404, { contactId: sourceContactId });
  }
  if (source.mergedInto) {
    throw new OpenwopError('conflict', 'Source contact is already merged.', 409, { contactId: sourceContactId });
  }

  let merged: Contact | null = null;
  // ADR 0264 — captured on the winning attempt for the merge-event audit snapshot.
  let capturedFill: { email?: string; company?: string; owner?: string } = {};
  let capturedAbsorbed: ContactIdentifier[] = [];
  for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS && !merged; attempt++) {
    const survivorRaw = await getContactForCas(survivorId);
    if (!survivorRaw || survivorRaw.tenantId !== tenantId) {
      throw new OpenwopError('not_found', 'Contact not found.', 404, { contactId: survivorId });
    }
    if (survivorRaw.mergedInto) {
      throw new OpenwopError('conflict', 'Survivor contact is itself a merge tombstone.', 409, { contactId: survivorId });
    }
    // Survivor wins; source only fills a field the survivor is missing (email,
    // company, owner never regress an existing survivor value — stage is left
    // untouched entirely, so it trivially never regresses). Recomputed against
    // a FRESH read every attempt — never a stale snapshot from a prior loop.
    const fill: { email?: string; company?: string; owner?: string; identifiers?: ContactIdentifier[] } = {};
    if (!survivorRaw.email && source.email) fill.email = source.email;
    if (!survivorRaw.company && source.company) fill.company = source.company;
    if (!survivorRaw.owner && source.owner) fill.owner = source.owner;
    // ADR 0263 — the merged customer resolves by BOTH profiles' identifiers.
    // Union the source's non-email identifiers; when the survivor keeps its own
    // email (source's email is NOT promoted to the survivor's primary), absorb
    // the source email as an `email` identifier so it still resolves to the survivor.
    const absorbed: ContactIdentifier[] = [...(source.identifiers ?? [])];
    const keepsSourceEmail =
      source.email &&
      !fill.email && // survivor is NOT taking source's email as its primary
      survivorRaw.email &&
      normalizeIdentifierValue('email', source.email) !== normalizeIdentifierValue('email', survivorRaw.email);
    if (keepsSourceEmail) absorbed.push({ type: 'email', value: source.email!, source: 'merge' });
    const identifiers = unionIdentifiers(survivorRaw.identifiers, absorbed);
    if (absorbed.length) fill.identifiers = identifiers;
    merged = await casUpdateContact(survivorRaw, fill);
    if (merged) {
      const { identifiers: _omit, ...scalarFill } = fill;
      capturedFill = scalarFill;
      capturedAbsorbed = absorbed;
    }
  }
  if (!merged) {
    throw new OpenwopError('conflict', 'Survivor contact was updated concurrently — retry the merge.', 409, { contactId: survivorId });
  }

  // ADR 0264 — capture the source's refs BEFORE relink moves them, so an unmerge
  // can restore EXACTLY these (not the survivor's own).
  const capturedRefIds = await captureContactRefIds(tenantId, sourceContactId);
  await relinkContactReferences(tenantId, sourceContactId, survivorId);
  // ADR 0627 D6 — the source's primary-email CLAIM follows the address: re-pointed
  // to the survivor when it adopted the email as its primary, released otherwise
  // (see `ContactKeyClaim` in contactsService for the decision). BEFORE the
  // tombstone (review N1): a tombstoned holder reads as a stale claim, so the
  // old order left a takeover window between the two writes.
  await repointContactKeyClaimForMerge(source, merged);
  await tombstoneContact(sourceContactId, tenantId, survivorId);
  // ADR 0263 — re-point the source's identifier keys (incl. its email) at the
  // survivor. `merged` already carries the unioned identifiers, so this both
  // adds the absorbed keys and re-writes the survivor's own keys (idempotent).
  await reindexContact(source, merged);
  // ADR 0264 — audit snapshot of what this merge did (best-effort; the merge has
  // already committed). Records the substrate a future unmerge would replay.
  await recordMergeEvent({
    tenantId, survivorId, sourceId: sourceContactId, actor,
    filledFields: capturedFill as Record<string, string>,
    absorbedIdentifiers: capturedAbsorbed,
    refIds: capturedRefIds,
  });
  // CRM-5 — the CROSS-FEATURE relink. `relinkContactReferences` covers exactly the
  // three collections this package owns (deals, tasks, activities); everything else
  // was left pointing at the tombstone, including two compliance-grade stores: the
  // source's `consent:record` (so an opt-out was lost while the survivor absorbed
  // the source's email identifier) and the `email:sendlog` dedupe ledger (so the
  // survivor could be re-sent a campaign the source already received). Fired AFTER
  // the merge has committed — see the seam's docblock for why the ordering is the
  // opposite of the delete seam's.
  await fireCrmRecordMerged({ tenantId, entity: 'contact', sourceId: sourceContactId, survivorId });
  // ADR 0627 D2 — the ONE `contact.merged` site (direct route + steward approval lane).
  crmMutated({ entity: 'contact', verb: 'merged', tenantId, entityId: survivorId, sourceEntityId: sourceContactId, actor, ...opts });
  return merged;
}

/**
 * Reverse a recorded merge (ADR 0264) — restore the source as a live contact with
 * its own fields, identifiers, and refs, and strip what the survivor absorbed.
 * Replays the merge-event snapshot; idempotent (a consumed event no-ops). Fails
 * closed if the recorded state no longer holds.
 */
export async function unmergeContacts(tenantId: string, mergeEventId: string, opts: CrmEmitOptions = {}): Promise<{ survivorId: string; sourceId: string }> {
  const ev = await getMergeEvent(tenantId, mergeEventId);
  if (!ev) throw new OpenwopError('not_found', 'Merge event not found.', 404, { mergeEventId });
  if (ev.unmergedAt) throw new OpenwopError('conflict', 'This merge was already reversed.', 409, { mergeEventId });
  const ok = await unmergeRestore({
    survivorId: ev.survivorId, sourceId: ev.sourceId, tenantId,
    filledFields: ev.filledFields, absorbedIdentifiers: ev.absorbedIdentifiers,
  });
  if (!ok) {
    throw new OpenwopError('conflict', 'Cannot unmerge — the contacts changed since the merge.', 409, { mergeEventId });
  }
  // repoint the captured deal/task/activity refs back to the source
  await restoreContactRefs(tenantId, ev.refIds, ev.sourceId);
  // CRM-5 — and the CROSS-FEATURE refs a merge handler moved. Fired before the
  // event is consumed, so a mid-way failure leaves the (idempotent) unmerge
  // retriable rather than stranding a moved row on the survivor.
  await fireCrmRecordUnmerged({ tenantId, entity: 'contact', sourceId: ev.sourceId, survivorId: ev.survivorId });
  await consumeMergeEvent(tenantId, mergeEventId);
  // The restored source is a live row again: `mergedInto` is the field the
  // unmerge cleared (review S5 — a real field name, the same for both entities).
  crmMutated({ entity: 'contact', verb: 'updated', tenantId, entityId: ev.sourceId, changed: ['mergedInto'], ...opts });
  return { survivorId: ev.survivorId, sourceId: ev.sourceId };
}

/** Merge `sourceCompanyId` into `companyId` (org-scoped). Returns the merged
 *  survivor. Also merges `customFields` (survivor wins per-key) and unions
 *  tags. CAS-guarded (CRMGAP-8, see file doc) against a concurrent merge into
 *  the same survivor. */
export async function mergeCompanies(tenantId: string, orgId: string, survivorId: string, sourceCompanyId: string, actor = 'system', opts: Omit<CrmEmitOptions, 'actor'> = {}): Promise<Company> {
  if (survivorId === sourceCompanyId) {
    throw new OpenwopError('conflict', 'Cannot merge a company into itself.', 409, { companyId: survivorId });
  }
  const source = await getCompany(tenantId, orgId, sourceCompanyId);
  if (!source) throw new OpenwopError('not_found', 'Company not found.', 404, { companyId: sourceCompanyId });
  if (source.mergedInto) {
    throw new OpenwopError('conflict', 'Source company is already merged.', 409, { companyId: sourceCompanyId });
  }

  let merged: Company | null = null;
  // GEN-7 — captured on the winning attempt: exactly what the survivor ABSORBED, so an
  // unmerge can strip precisely these (never the survivor's own pre-existing values).
  let capturedFilled: Record<string, string> = {};
  let capturedAbsorbedTags: string[] = [];
  let capturedAbsorbedCF: Record<string, string | number | boolean> = {};
  for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS && !merged; attempt++) {
    const survivorRaw = await getCompanyForCas(tenantId, orgId, survivorId);
    if (!survivorRaw) throw new OpenwopError('not_found', 'Company not found.', 404, { companyId: survivorId });
    if (survivorRaw.mergedInto) {
      throw new OpenwopError('conflict', 'Survivor company is itself a merge tombstone.', 409, { companyId: survivorId });
    }
    // Recomputed against a FRESH read every attempt — never a stale snapshot.
    const patch: { domain?: string; industry?: string; tags?: string[]; customFields?: Record<string, string | number | boolean> } = {};
    if (!survivorRaw.domain && source.domain) patch.domain = source.domain;
    if (!survivorRaw.industry && source.industry) patch.industry = source.industry;
    const unionTags = cleanTagList([...survivorRaw.tags, ...source.tags], { maxTags: 24, maxLen: 48 });
    const addedTags = unionTags.filter((t) => !survivorRaw.tags.includes(t));
    if (unionTags.length !== survivorRaw.tags.length || unionTags.some((t, i) => t !== survivorRaw.tags[i])) patch.tags = unionTags;
    const survivorCf = survivorRaw.customFields ?? {};
    const absorbedCf: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(source.customFields ?? {})) if (!(k in survivorCf)) absorbedCf[k] = v;
    const mergedCustomFields = { ...(source.customFields ?? {}), ...survivorCf }; // survivor wins per-key
    if (Object.keys(mergedCustomFields).length > 0) patch.customFields = mergedCustomFields;
    merged = await casUpdateCompany(survivorRaw, patch);
    if (merged) {
      capturedFilled = { ...(patch.domain ? { domain: patch.domain } : {}), ...(patch.industry ? { industry: patch.industry } : {}) };
      capturedAbsorbedTags = addedTags;
      capturedAbsorbedCF = absorbedCf;
    }
  }
  if (!merged) {
    throw new OpenwopError('conflict', 'Survivor company was updated concurrently — retry the merge.', 409, { companyId: survivorId });
  }

  // GEN-7 — capture the source's refs BEFORE relink moves them, so an unmerge restores
  // EXACTLY these. Then relink + tombstone, then record the audit/reversal snapshot
  // (best-effort; the merge has already committed).
  const capturedRefIds = await captureCompanyRefIds(tenantId, orgId, sourceCompanyId);
  await relinkCompanyReferences(tenantId, orgId, sourceCompanyId, survivorId);
  await tombstoneCompany(tenantId, orgId, sourceCompanyId, survivorId);
  await recordCompanyMergeEvent({
    tenantId, orgId, survivorId, sourceId: sourceCompanyId, actor,
    filledFields: capturedFilled, absorbedTags: capturedAbsorbedTags,
    absorbedCustomFields: capturedAbsorbedCF, refIds: capturedRefIds,
  });
  // CRM-5 — same seam, org-scoped entity (see `mergeContacts` above).
  await fireCrmRecordMerged({ tenantId, orgId, entity: 'company', sourceId: sourceCompanyId, survivorId });
  crmMutated({ entity: 'company', verb: 'merged', tenantId, orgId, entityId: survivorId, sourceEntityId: sourceCompanyId, actor, ...opts });
  return merged;
}

/**
 * GEN-7 — reverse a recorded company merge (the sibling of `unmergeContacts`). Order is
 * fail-closed + idempotent-until-consume: un-tombstone the source (the must-succeed core
 * restore — its own data was left intact by the merge), repoint the captured refs back,
 * then strip what the survivor absorbed (per-field fail-closed: a survivor value edited
 * since the merge is respected/left). Consumes the event LAST, so a mid-way failure is
 * safely retried. Idempotent (`unmergedAt` → 409 already-reversed).
 */
export async function unmergeCompanies(tenantId: string, orgId: string, mergeEventId: string, opts: CrmEmitOptions = {}): Promise<{ survivorId: string; sourceId: string }> {
  const ev = await getCompanyMergeEvent(tenantId, mergeEventId);
  if (!ev || ev.orgId !== orgId) throw new OpenwopError('not_found', 'Company merge event not found.', 404, { mergeEventId });
  if (ev.unmergedAt) throw new OpenwopError('conflict', 'This merge was already reversed.', 409, { mergeEventId });

  // 1. Restore the source as a live company (its domain/industry/tags/customFields were
  //    never touched by the merge — un-tombstoning gives it all back). Must succeed.
  const live = await untombstoneCompany(tenantId, orgId, ev.sourceId);
  if (!live) throw new OpenwopError('conflict', 'Cannot unmerge — the source company could not be restored (it may have been deleted).', 409, { mergeEventId });
  // 2. Repoint exactly the pre-merge refs back to the source (post-merge refs stay put).
  await restoreCompanyRefsToSource(tenantId, orgId, ev.refIds, ev.sourceId);
  // 3. Strip what the survivor absorbed, fail-closed per field. Returns false ONLY on
  //    CAS-contention exhaustion (the survivor exists but a concurrent write kept winning);
  //    a gone survivor is vacuously reverted (true). On contention, DON'T consume the event —
  //    throw retriable so a re-invoke re-runs the idempotent restore + revert (else the
  //    survivor would keep the absorbed fields forever, defeating consume-last retriability).
  const reverted = await casRevertCompanyAbsorption(tenantId, orgId, ev.survivorId, {
    filledFields: ev.filledFields, absorbedTags: ev.absorbedTags, absorbedCustomFields: ev.absorbedCustomFields,
  });
  if (!reverted) throw new OpenwopError('conflict', 'The survivor company was updated concurrently — retry the unmerge.', 409, { mergeEventId });
  // CRM-5 — the cross-feature reverse leg (see `unmergeContacts`).
  await fireCrmRecordUnmerged({ tenantId, orgId, entity: 'company', sourceId: ev.sourceId, survivorId: ev.survivorId });
  await consumeCompanyMergeEvent(tenantId, mergeEventId);
  crmMutated({ entity: 'company', verb: 'updated', tenantId, orgId, entityId: ev.sourceId, changed: ['mergedInto'], ...opts }); // review S5 — same shape as unmergeContacts
  return { survivorId: ev.survivorId, sourceId: ev.sourceId };
}
