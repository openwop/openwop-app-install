/**
 * CRM Activities (ADR 0008 Phase 2) — append-only timeline, org-scoped and
 * RBAC-gated. Also the home of the composed merge-relink orchestrator
 * (`relinkContactReferences`/`relinkCompanyReferences`, ADR 0209 §2): each of
 * deals.ts/tasks.ts/this file owns its OWN entity's relink slice
 * (`relinkDealsForContact`, `relinkTasksForContact`, …) and this file
 * composes all three — the last of the three touched entities, so it's the
 * natural place for the composition without any file needing to import
 * "sideways". Split out of the former `crmEntitiesService.ts` god-file
 * (CRMGAP-10) — re-exported unchanged via that file's barrel.
 *
 * CRM-11 — the relink/capture/restore reads below go through
 * `listForTenantIndexed`, not the bare `.list()` they used to (one `kvList` over
 * the whole collection, ALL TENANTS, six times in this file). See the same note
 * in `tasks.ts` — `deals.ts` was fixed and these two siblings were not, while
 * this docblock claimed parity with it.
 *
 * @see docs/adr/0008-crm-full-port.md, docs/adr/0209-crm-dedup-merge-conversion.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { onCrmRecordDeleted } from '../../../host/crmRecordLifecycle.js';
import { OpenwopError } from '../../../types.js';
import { MAX, MAX_PER_ORG_ENTITIES, assertUnderCap, cleanStr, nowIso } from './shared.js';
import { assertLinks, type LinkValidators } from './tasks.js';
import { relinkDealsForCompany, relinkDealsForContact, dealIdsForContact, repointDealsToContact, dealIdsForCompany, repointDealsToCompany } from './deals.js';
import { relinkTasksForCompany, relinkTasksForContact, taskIdsForContact, repointTasksToContact, taskIdsForCompany, repointTasksToCompany } from './tasks.js';
import { crmMutated, emitOptsOf, type CrmEmitOptions } from '../emit.js';

export type ActivityKind = 'note' | 'call' | 'email' | 'meeting' | 'webinar';
export const ACTIVITY_KINDS: ActivityKind[] = ['note', 'call', 'email', 'meeting', 'webinar'];

export interface Activity {
  activityId: string;
  tenantId: string;
  orgId: string;
  kind: ActivityKind;
  body: string;
  dealId?: string;
  contactId?: string;
  companyId?: string;
  /** Opaque external ref (no PII/content) — e.g. the Gmail thread a
   *  metadata-only email activity belongs to, for future conversation
   *  grouping / deep-linking (ADR 0252 §1). */
  threadId?: string;
  createdBy: string;
  createdAt: string;
  /** Monotonic creation sequence — a STABLE newest-first tiebreaker when two
   *  activities land in the same millisecond (the flaky-sort fix). */
  seq: number;
}

const activities = new DurableCollection<Activity>('crm:activity', (a) => a.activityId, undefined, (a) => a.tenantId);
let activitySeq = 0;

// ADR 0627 D7 (`CRM-25`) — UNLINK-AND-KEEP, the sibling of `tasks-crm-unlink`
// and `deals-crm-unlink`. An activity is the org's TIMELINE: deleting the
// activities of a deleted company would destroy the record of every interaction
// the org had, so the dangling `contactId`/`companyId`/`dealId` is dropped and
// the row stays (its `body` is the org's own note, unchanged). Idempotent +
// bounded + best-effort, same as the other two consumers.
onCrmRecordDeleted('activities-crm-unlink', async ({ tenantId, orgId, entity, recordId }) => {
  const field: 'contactId' | 'companyId' | 'dealId' = entity === 'contact' ? 'contactId' : entity === 'company' ? 'companyId' : 'dealId';
  for (const a of await activities.listForTenantIndexed(tenantId)) {
    if (a.tenantId !== tenantId || a[field] !== recordId) continue;
    if (entity !== 'contact' && a.orgId !== orgId) continue; // company/deal ids are org-scoped
    const next: Activity = { ...a };
    delete next[field];
    await activities.put(next);
  }
});

export async function listActivities(tenantId: string, orgId: string, filter: { dealId?: string; contactId?: string; companyId?: string } = {}): Promise<Activity[]> {
  return (await activities.listForTenantIndexed(tenantId))
    .filter(
      (a) =>
        a.orgId === orgId &&
        (filter.dealId === undefined || a.dealId === filter.dealId) &&
        (filter.contactId === undefined || a.contactId === filter.contactId) &&
        (filter.companyId === undefined || a.companyId === filter.companyId),
    )
    // Newest first: createdAt primary (RESTART-SAFE — the seq counter resets on
    // restart), seq as a same-millisecond tiebreaker only (code-review #3).
    .sort((x, y) => (x.createdAt !== y.createdAt ? (x.createdAt < y.createdAt ? 1 : -1) : (y.seq ?? 0) - (x.seq ?? 0)));
}

/** ADR 0404 — activities whose deterministic id starts with `idPrefix` (a BOUNDED
 *  storage prefix scan, not a full-collection list). Backs the webinar
 *  compute-on-read counts + no-show reconciliation (`act:webinar:<eventId>:`).
 *  Cross-tenant by storage; the caller MUST filter tenant+org. */
export async function listActivitiesByIdPrefix(tenantId: string, orgId: string, idPrefix: string): Promise<Activity[]> {
  return (await activities.listByPrefix(idPrefix)).filter((a) => a.tenantId === tenantId && a.orgId === orgId);
}

/** Delete a contact's activities whose id starts with `idPrefix` (tenant-scoped,
 *  bounded prefix scan). Lets a feature that appended deterministic-id activities
 *  (e.g. webinars' `act:webinar:*`) prune them when the contact is deleted, so a
 *  compute-on-read count stops counting the dead contact (ADR 0404 grade-data
 *  WEB-1). Returns how many were removed. */
export async function deleteActivitiesForContactByPrefix(tenantId: string, contactId: string, idPrefix: string): Promise<number> {
  const rows = (await activities.listByPrefix(idPrefix)).filter((a) => a.tenantId === tenantId && a.contactId === contactId);
  for (const a of rows) await activities.delete(a.activityId);
  return rows.length;
}

/** One activity by (tenant, org, id) — CRMGAP-13: lets a deterministic-id
 *  SYSTEM caller (the email→activity bridge) point-read existence BEFORE
 *  appending, so a resend can skip both the append and the `crmMutated`
 *  event emit when the row already exists, instead of relying on
 *  `createActivity`'s own dedup (which still appends nothing new but had
 *  already re-emitted the event on every call). */
export async function getActivity(tenantId: string, orgId: string, activityId: string): Promise<Activity | null> {
  const a = await activities.get(activityId);
  return a && a.tenantId === tenantId && a.orgId === orgId ? a : null;
}

/** Append an activity. The timeline is append-only — no update/delete (history). */
export async function createActivity(input: {
  tenantId: string;
  orgId: string;
  kind: ActivityKind;
  body: string;
  dealId?: string;
  contactId?: string;
  companyId?: string;
  /** Opaque external thread ref (no content) — see `Activity.threadId`. */
  threadId?: string;
  createdBy: string;
  validators: LinkValidators;
  /** Caller-supplied deterministic id (ADR 0162 pattern). MUST be `act:`-prefixed.
   *  Same short-circuit / cross-tenant-404 contract as `createCompany`. */
  activityId?: string;
  /** Back-date the timeline entry to when the event actually happened (the
   *  email's own timestamp), not `nowIso()` — a SYSTEM append backfilling
   *  historical events (the Gmail bridge, ADR 0252 §1) MUST set this or a
   *  6-day-old email sorts as "just now". User-driven paths omit it. */
  createdAt?: string;
  /** Audit CRMGAP-2: a deterministic-id SYSTEM append (the email bridge —
   *  bounded by contacts × campaigns, idempotent) may skip the cap check so a
   *  send batch doesn't pay one full-collection scan per contact. User-driven
   *  paths (routes/verbs) never set this. */
  skipCapCheck?: boolean;
} & CrmEmitOptions): Promise<Activity> {
  if (!ACTIVITY_KINDS.includes(input.kind)) {
    throw new OpenwopError('validation_error', `kind must be one of: ${ACTIVITY_KINDS.join(', ')}`, 400, { field: 'kind' });
  }
  if (input.activityId !== undefined) {
    if (!input.activityId.startsWith('act:')) {
      throw new OpenwopError('validation_error', 'activityId must be `act:`-prefixed.', 400, { activityId: input.activityId });
    }
    const existing = await activities.get(input.activityId);
    if (existing) {
      if (existing.tenantId === input.tenantId && existing.orgId === input.orgId) return existing;
      throw new OpenwopError('not_found', 'Activity not found.', 404, { activityId: input.activityId });
    }
  }
  if (input.skipCapCheck !== true) {
    assertUnderCap((await listActivities(input.tenantId, input.orgId)).length, MAX_PER_ORG_ENTITIES, 'activities');
  }
  await assertLinks(input.validators, input);
  const a: Activity = {
    activityId: input.activityId ?? `act:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    kind: input.kind,
    body: cleanStr(input.body, MAX.body, ''),
    ...(input.dealId ? { dealId: input.dealId } : {}),
    ...(input.contactId ? { contactId: input.contactId } : {}),
    ...(input.companyId ? { companyId: input.companyId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    createdBy: input.createdBy,
    createdAt: input.createdAt ?? nowIso(),
    seq: ++activitySeq,
  };
  await activities.put(a);
  // ADR 0627 D2 — the ONE `activity.logged` site, on the CREATED branch only:
  // the deterministic-id dedup hit above returns the existing row and emits
  // nothing (a resend/re-sync is not a new log entry — the CRMGAP-13 lesson).
  crmMutated({ entity: 'activity', verb: 'logged', tenantId: a.tenantId, orgId: a.orgId, entityId: a.activityId, ...emitOptsOf(input) });
  return a;
}

// ── Merge relink (ADR 0209 §2) ───────────────────────────────────────────────
// Referencing rows are relinked to the survivor BEFORE the source is
// tombstoned (crmMergeService orders the calls) — a mid-way crash leaves both
// records live and re-mergeable, never a dangling reference to a tombstone.

/** Relink every tenant-scoped deal/task/activity pointing at `sourceContactId`
 *  to `survivorContactId`. Contacts are tenant-wide (not org-scoped), so this
 *  scans across every org in the tenant — the same shape `listContacts` uses.
 *  Composes deals.ts/tasks.ts's per-entity relink with this file's own
 *  activities slice (CRMGAP-10 split — same three-collection sweep, same
 *  order, as the pre-split single function). */
export async function relinkContactReferences(tenantId: string, sourceContactId: string, survivorContactId: string): Promise<void> {
  await relinkDealsForContact(tenantId, sourceContactId, survivorContactId);
  await relinkTasksForContact(tenantId, sourceContactId, survivorContactId);
  for (const a of await activities.listForTenantIndexed(tenantId)) {
    if (a.tenantId === tenantId && a.contactId === sourceContactId) {
      await activities.put({ ...a, contactId: survivorContactId });
    }
  }
}

/** The ref ids (deals/tasks/activities) currently pointing at a contact — captured
 *  PRE-merge so a reversible unmerge can restore EXACTLY the source's own refs (not
 *  the survivor's), the data-integrity crux (ADR 0264). */
export interface ContactRefIds { deals: string[]; tasks: string[]; activities: string[] }

export async function captureContactRefIds(tenantId: string, contactId: string): Promise<ContactRefIds> {
  const acts = (await activities.listForTenantIndexed(tenantId)).filter((a) => a.tenantId === tenantId && a.contactId === contactId).map((a) => a.activityId);
  return { deals: await dealIdsForContact(tenantId, contactId), tasks: await taskIdsForContact(tenantId, contactId), activities: acts };
}

/** Repoint the captured refs back to `contactId` (unmerge restore). */
export async function restoreContactRefs(tenantId: string, refs: ContactRefIds, contactId: string): Promise<void> {
  await repointDealsToContact(tenantId, refs.deals, contactId);
  await repointTasksToContact(tenantId, refs.tasks, contactId);
  if (refs.activities.length > 0) {
    const set = new Set(refs.activities);
    for (const a of await activities.listForTenantIndexed(tenantId)) {
      if (a.tenantId === tenantId && set.has(a.activityId)) await activities.put({ ...a, contactId });
    }
  }
}

/** Relink every org-scoped deal/task/activity pointing at `sourceCompanyId` to
 *  `survivorCompanyId` (both companies must already be validated as belonging
 *  to `orgId` by the caller). */
export async function relinkCompanyReferences(tenantId: string, orgId: string, sourceCompanyId: string, survivorCompanyId: string): Promise<void> {
  await relinkDealsForCompany(tenantId, orgId, sourceCompanyId, survivorCompanyId);
  await relinkTasksForCompany(tenantId, orgId, sourceCompanyId, survivorCompanyId);
  for (const a of await activities.listForTenantIndexed(tenantId)) {
    if (a.tenantId === tenantId && a.orgId === orgId && a.companyId === sourceCompanyId) {
      await activities.put({ ...a, companyId: survivorCompanyId });
    }
  }
}

/** GEN-7 — the source company's deal/task/activity ids, captured PRE-merge so a company
 *  unmerge repoints EXACTLY these back (a ref created post-merge stays with the survivor). */
export interface CompanyRefIds { deals: string[]; tasks: string[]; activities: string[] }

export async function captureCompanyRefIds(tenantId: string, orgId: string, companyId: string): Promise<CompanyRefIds> {
  const acts = (await activities.listForTenantIndexed(tenantId)).filter((a) => a.tenantId === tenantId && a.orgId === orgId && a.companyId === companyId).map((a) => a.activityId);
  return {
    deals: await dealIdsForCompany(tenantId, orgId, companyId),
    tasks: await taskIdsForCompany(tenantId, orgId, companyId),
    activities: acts,
  };
}

/** GEN-7 — repoint EXACTLY the captured refs back to the (un-tombstoned) source company. */
export async function restoreCompanyRefsToSource(tenantId: string, orgId: string, refs: CompanyRefIds, companyId: string): Promise<void> {
  await repointDealsToCompany(tenantId, orgId, refs.deals, companyId);
  await repointTasksToCompany(tenantId, orgId, refs.tasks, companyId);
  if (refs.activities.length > 0) {
    const set = new Set(refs.activities);
    for (const a of await activities.listForTenantIndexed(tenantId)) {
      if (a.tenantId === tenantId && a.orgId === orgId && set.has(a.activityId)) await activities.put({ ...a, companyId });
    }
  }
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __clearActivities(): Promise<void> {
  await activities.__clear();
}
