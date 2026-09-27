/**
 * CRM Tasks (ADR 0008 Phase 2) — org-scoped and RBAC-gated. Also the home of
 * `LinkValidators`/`makeLinkValidators`/`assertLinks` (CRMGAP-10 split kept
 * these where the pre-split god-file declared them — right after the Tasks
 * collection): `activities.ts` imports them from here rather than duplicating
 * (one-way edge, no cycle — this file never needs anything from
 * `activities.ts`). Split out of the former `crmEntitiesService.ts` god-file —
 * re-exported unchanged via that file's barrel.
 *
 * @see docs/adr/0008-crm-full-port.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { onCrmRecordDeleted } from '../../../host/crmRecordLifecycle.js';
import { OpenwopError } from '../../../types.js';
import { MAX, MAX_PER_ORG_ENTITIES, assertUnderCap, cleanStr, nowIso, optStr } from './shared.js';
import { getCompany } from './companies.js';
import { getDeal } from './deals.js';
// tasks.ts/activities.ts never import back from contactsService.ts, so this
// one-way edge is cycle-free (mirrors crmEntitiesService.ts's original note).
import { getContact as ctGetContact } from '../contactsService.js';
import { changedFields, crmMutated, emitOptsOf, type CrmEmitOptions } from '../emit.js';

export type TaskStatus = 'open' | 'doing' | 'done';
export const TASK_STATUSES: TaskStatus[] = ['open', 'doing', 'done'];

export interface Task {
  taskId: string;
  tenantId: string;
  orgId: string;
  title: string;
  status: TaskStatus;
  dueDate?: string;
  assignee?: string;
  dealId?: string;
  contactId?: string;
  companyId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const tasks = new DurableCollection<Task>('crm:task', (t) => t.taskId, undefined, (t) => t.tenantId);

// ADR 0627 D7 (`CRM-25`) — UNLINK-AND-KEEP on the ADR 0580/0283 delete seam,
// mirroring `deals-crm-unlink` (deals.ts) and this file's merge-relink slice: a
// deleted contact (tenant-wide), company or deal (org-scoped) leaves its tasks
// in place with the dangling pointer dropped. A task is the org's own to-do —
// deleting it because its deal went away is a NEW semantic this ADR deliberately
// does not introduce (the SPA's confirm copy promises "kept and unlinked").
// Idempotent + bounded (`listForTenantIndexed`) + best-effort (the seam swallows).
onCrmRecordDeleted('tasks-crm-unlink', async ({ tenantId, orgId, entity, recordId }) => {
  const field: 'contactId' | 'companyId' | 'dealId' = entity === 'contact' ? 'contactId' : entity === 'company' ? 'companyId' : 'dealId';
  for (const t of await tasks.listForTenantIndexed(tenantId)) {
    if (t.tenantId !== tenantId || t[field] !== recordId) continue;
    if (entity !== 'contact' && t.orgId !== orgId) continue; // company/deal ids are org-scoped
    const next: Task = { ...t, updatedAt: nowIso() };
    delete next[field];
    await tasks.put(next);
  }
});

export interface LinkValidators {
  validateDeal: (id: string) => Promise<boolean>;
  validateCompany: (id: string) => Promise<boolean>;
  validateContact: (id: string) => Promise<boolean>;
}

/**
 * Link validators bound to a tenant/org (CRMGAP-11) — the ONE definition
 * `orgRoutes.ts` and `surface.ts` used to duplicate. A deal/company is
 * org-scoped; a contact is the tenant-wide rolodex (contacts stay
 * tenant-scoped, ADR 0008) — same asymmetry both duplicated copies encoded.
 */
export function makeLinkValidators(tenantId: string, orgId: string): LinkValidators {
  return {
    validateDeal: async (id) => (await getDeal(tenantId, orgId, id)) !== null,
    validateCompany: async (id) => (await getCompany(tenantId, orgId, id)) !== null,
    validateContact: async (id) => {
      const c = await ctGetContact(id);
      return c !== null && c.tenantId === tenantId;
    },
  };
}

/** Validate the optional deal/company/contact links a task or activity carries. */
export async function assertLinks(v: LinkValidators, links: { dealId?: string; companyId?: string; contactId?: string }): Promise<void> {
  if (links.dealId && !(await v.validateDeal(links.dealId))) throw new OpenwopError('not_found', 'Linked deal not found in this org.', 404, { dealId: links.dealId });
  if (links.companyId && !(await v.validateCompany(links.companyId))) throw new OpenwopError('not_found', 'Linked company not found in this org.', 404, { companyId: links.companyId });
  if (links.contactId && !(await v.validateContact(links.contactId))) throw new OpenwopError('not_found', 'Linked contact not found in this tenant.', 404, { contactId: links.contactId });
}

export async function listTasks(tenantId: string, orgId: string, filter: { status?: string; dealId?: string } = {}): Promise<Task[]> {
  return (await tasks.listForTenantIndexed(tenantId)).filter(
    (t) => t.orgId === orgId && (filter.status === undefined || t.status === filter.status) && (filter.dealId === undefined || t.dealId === filter.dealId),
  );
}

export async function getTask(tenantId: string, orgId: string, taskId: string): Promise<Task | null> {
  const t = await tasks.get(taskId);
  return t && t.tenantId === tenantId && t.orgId === orgId ? t : null;
}

export async function createTask(input: {
  tenantId: string;
  orgId: string;
  title: string;
  status?: TaskStatus;
  dueDate?: unknown;
  assignee?: unknown;
  dealId?: string;
  contactId?: string;
  companyId?: string;
  createdBy: string;
  validators: LinkValidators;
  /** Caller-supplied deterministic id (ADR 0162 pattern). MUST be `task:`-prefixed.
   *  Same short-circuit / cross-tenant-404 contract as `createCompany`. */
  taskId?: string;
} & CrmEmitOptions): Promise<Task> {
  if (input.taskId !== undefined) {
    if (!input.taskId.startsWith('task:')) {
      throw new OpenwopError('validation_error', 'taskId must be `task:`-prefixed.', 400, { taskId: input.taskId });
    }
    const existing = await tasks.get(input.taskId);
    if (existing) {
      if (existing.tenantId === input.tenantId && existing.orgId === input.orgId) return existing;
      throw new OpenwopError('not_found', 'Task not found.', 404, { taskId: input.taskId });
    }
  }
  assertUnderCap((await listTasks(input.tenantId, input.orgId)).length, MAX_PER_ORG_ENTITIES, 'tasks');
  await assertLinks(input.validators, input);
  const ts = nowIso();
  const t: Task = {
    taskId: input.taskId ?? `task:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    title: cleanStr(input.title, MAX.name, 'Untitled task'),
    status: input.status && TASK_STATUSES.includes(input.status) ? input.status : 'open',
    ...(optStr(input.dueDate, 40) ? { dueDate: optStr(input.dueDate, 40) } : {}),
    ...(optStr(input.assignee, MAX.short) ? { assignee: optStr(input.assignee, MAX.short) } : {}),
    ...(input.dealId ? { dealId: input.dealId } : {}),
    ...(input.contactId ? { contactId: input.contactId } : {}),
    ...(input.companyId ? { companyId: input.companyId } : {}),
    createdBy: input.createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  await tasks.put(t);
  // ADR 0627 D2 — the ONE `task.created` site, NEW row only.
  crmMutated({ entity: 'task', verb: 'created', tenantId: t.tenantId, orgId: t.orgId, entityId: t.taskId, ...emitOptsOf(input) });
  return t;
}

export async function updateTask(
  tenantId: string,
  orgId: string,
  taskId: string,
  patch: { title?: string; status?: TaskStatus; dueDate?: string | null; assignee?: string | null },
  opts: CrmEmitOptions = {},
): Promise<Task | null> {
  const t = await getTask(tenantId, orgId, taskId);
  if (!t) return null;
  const next: Task = { ...t, updatedAt: nowIso() };
  if (patch.title !== undefined) next.title = cleanStr(patch.title, MAX.name, t.title);
  if (patch.status !== undefined && TASK_STATUSES.includes(patch.status)) next.status = patch.status;
  if (patch.dueDate !== undefined) {
    if (patch.dueDate === null) delete next.dueDate;
    else next.dueDate = optStr(patch.dueDate, 40);
  }
  if (patch.assignee !== undefined) {
    if (patch.assignee === null) delete next.assignee;
    else next.assignee = optStr(patch.assignee, MAX.short);
  }
  await tasks.put(next);
  // ADR 0627 D2 — `completed` iff the status FLIPPED to `done` (done→done is a
  // re-PATCH, not a transition — the surface + org route used to re-emit it).
  const changed = changedFields(t, next); // pre-image vs landed (review S1) — a value-equal re-PATCH is silent
  if (changed.length > 0) crmMutated({ entity: 'task', verb: 'updated', tenantId, orgId, entityId: taskId, changed, ...opts });
  if (t.status !== 'done' && next.status === 'done') crmMutated({ entity: 'task', verb: 'completed', tenantId, orgId, entityId: taskId, ...opts });
  return next;
}

export async function deleteTask(tenantId: string, orgId: string, taskId: string, opts: CrmEmitOptions = {}): Promise<boolean> {
  const t = await getTask(tenantId, orgId, taskId);
  if (!t) return false;
  await tasks.delete(taskId);
  crmMutated({ entity: 'task', verb: 'deleted', tenantId, orgId, entityId: taskId, ...opts });
  return true;
}

// ── Merge relink (ADR 0209 §2) — the tasks slice; composed with deals'/
// activities' counterparts by `activities.ts`'s `relinkContactReferences`/
// `relinkCompanyReferences` (CRMGAP-10 split).
//
// CRM-11 — every read below goes through `listForTenantIndexed`. They were bare
// `.list()` calls: ONE `kvList` over the whole collection, ALL TENANTS, six times
// in this file and six more in `activities.ts`, so a single
// `POST /contacts/:id/merge` issued 4+ cross-tenant scans each followed by
// per-row writes. `deals.ts` was fixed and these two siblings were not, while
// their docblocks claimed parity and `host/crmRecordLifecycle.ts` states handlers
// "MUST bound their work (indexed/point reads — never a cross-tenant scan)".
// `tenantOf` was already armed on this collection, so the index was there the
// whole time. The `t.tenantId === tenantId` filters are kept as defense in depth.
// ────────────────────────────────────────────────────────────────────────────

/** Relink every tenant-scoped task pointing at `sourceContactId` to
 *  `survivorContactId`. */
export async function relinkTasksForContact(tenantId: string, sourceContactId: string, survivorContactId: string): Promise<void> {
  for (const t of await tasks.listForTenantIndexed(tenantId)) {
    if (t.tenantId === tenantId && t.contactId === sourceContactId) {
      await tasks.put({ ...t, contactId: survivorContactId, updatedAt: nowIso() });
    }
  }
}

/** ADR 0264 — task ids currently pointing at `contactId` (captured pre-merge). */
export async function taskIdsForContact(tenantId: string, contactId: string): Promise<string[]> {
  return (await tasks.listForTenantIndexed(tenantId)).filter((t) => t.tenantId === tenantId && t.contactId === contactId).map((t) => t.taskId);
}

/** ADR 0264 — repoint EXACTLY the listed tasks back to `contactId` (unmerge restore). */
export async function repointTasksToContact(tenantId: string, taskIds: readonly string[], contactId: string): Promise<void> {
  if (taskIds.length === 0) return;
  const set = new Set(taskIds);
  for (const t of await tasks.listForTenantIndexed(tenantId)) {
    if (t.tenantId === tenantId && set.has(t.taskId)) await tasks.put({ ...t, contactId, updatedAt: nowIso() });
  }
}

/** Relink every org-scoped task pointing at `sourceCompanyId` to `survivorCompanyId`. */
export async function relinkTasksForCompany(tenantId: string, orgId: string, sourceCompanyId: string, survivorCompanyId: string): Promise<void> {
  for (const t of await tasks.listForTenantIndexed(tenantId)) {
    if (t.tenantId === tenantId && t.orgId === orgId && t.companyId === sourceCompanyId) {
      await tasks.put({ ...t, companyId: survivorCompanyId, updatedAt: nowIso() });
    }
  }
}

/** GEN-7 — task ids currently pointing at `companyId` (captured PRE-merge for a reversible unmerge). */
export async function taskIdsForCompany(tenantId: string, orgId: string, companyId: string): Promise<string[]> {
  return (await tasks.listForTenantIndexed(tenantId)).filter((t) => t.tenantId === tenantId && t.orgId === orgId && t.companyId === companyId).map((t) => t.taskId);
}

/** GEN-7 — repoint EXACTLY the listed tasks back to `companyId` (company unmerge restore). */
export async function repointTasksToCompany(tenantId: string, orgId: string, taskIds: readonly string[], companyId: string): Promise<void> {
  if (taskIds.length === 0) return;
  const set = new Set(taskIds);
  for (const t of await tasks.listForTenantIndexed(tenantId)) {
    if (t.tenantId === tenantId && t.orgId === orgId && set.has(t.taskId)) await tasks.put({ ...t, companyId, updatedAt: nowIso() });
  }
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __clearTasks(): Promise<void> {
  await tasks.__clear();
}
