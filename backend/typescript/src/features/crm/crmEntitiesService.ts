/**
 * CRM org-scoped business objects (ADR 0008) — Companies, Deals, Pipelines
 * (Phase 1); Tasks, Activities (Phase 2); custom-field defs (Phase 3). Distinct
 * from the legacy tenant-scoped `contactsService` (preserved untouched): these
 * are org-scoped and RBAC-gated. Every record carries tenantId + orgId and every
 * accessor verifies BOTH (CTI-1 IDOR guard).
 *
 * @see docs/adr/0008-crm-full-port.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString, optionalCleanString, cleanTagList } from '../../host/boundedStrings.js';

const MAX = { name: 160, short: 120, tags: 24, tag: 48, body: 4000, stages: 24, customKeys: 50, perOrgEntities: 5000 } as const;

function nowIso(): string {
  return new Date().toISOString();
}
const cleanStr = (raw: unknown, max: number, fallback = ''): string => cleanString(raw, max, fallback);
const optStr = (raw: unknown, max: number): string | undefined => optionalCleanString(raw, max);
const cleanTags = (raw: unknown): string[] => cleanTagList(raw, { maxTags: MAX.tags, maxLen: MAX.tag });

/** Per-org entity count cap (code-review #5 — parity with media's per-org caps).
 *  Refuses a create that would exceed `MAX.perOrgEntities` for that entity. */
function assertEntityCap(count: number, label: string): void {
  if (count >= MAX.perOrgEntities) {
    throw new OpenwopError('validation_error', `This org has the maximum ${MAX.perOrgEntities} ${label}.`, 409, { max: MAX.perOrgEntities });
  }
}

// ── Pipelines ─────────────────────────────────────────────────────────────

export interface PipelineStage {
  stageId: string;
  name: string;
  probability: number; // 0..100
}
export interface Pipeline {
  pipelineId: string;
  tenantId: string;
  orgId: string;
  name: string;
  stages: PipelineStage[];
  createdAt: string;
  updatedAt: string;
}

const pipelines = new DurableCollection<Pipeline>('crm:pipeline', (p) => p.pipelineId);

const DEFAULT_STAGES: Array<{ name: string; probability: number }> = [
  { name: 'New', probability: 10 },
  { name: 'Qualified', probability: 30 },
  { name: 'Proposal', probability: 60 },
  { name: 'Won', probability: 100 },
  { name: 'Lost', probability: 0 },
];

function stage(name: string, probability: number): PipelineStage {
  return { stageId: `stg:${randomUUID()}`, name: cleanStr(name, MAX.short, 'Stage'), probability: Math.max(0, Math.min(100, Math.round(probability))) };
}

export async function listPipelines(tenantId: string, orgId: string): Promise<Pipeline[]> {
  return (await pipelines.list()).filter((p) => p.tenantId === tenantId && p.orgId === orgId);
}

export async function getPipeline(tenantId: string, orgId: string, pipelineId: string): Promise<Pipeline | null> {
  const p = await pipelines.get(pipelineId);
  return p && p.tenantId === tenantId && p.orgId === orgId ? p : null;
}

/** The org's pipeline, lazily seeding a default the first time (so a deal always
 *  has a pipeline to sit on). */
export async function getOrCreateDefaultPipeline(tenantId: string, orgId: string): Promise<Pipeline> {
  const existing = await listPipelines(tenantId, orgId);
  if (existing.length > 0) return existing[0]!;
  const ts = nowIso();
  const p: Pipeline = {
    pipelineId: `pipe:${randomUUID()}`,
    tenantId,
    orgId,
    name: 'Default pipeline',
    stages: DEFAULT_STAGES.map((s) => stage(s.name, s.probability)),
    createdAt: ts,
    updatedAt: ts,
  };
  await pipelines.put(p);
  return p;
}

export async function createPipeline(tenantId: string, orgId: string, name: string, stageInput: Array<{ name: string; probability?: number }>): Promise<Pipeline> {
  const stages = (stageInput.length > 0 ? stageInput : DEFAULT_STAGES).slice(0, MAX.stages).map((s) => stage(s.name, typeof s.probability === 'number' ? s.probability : 0));
  const ts = nowIso();
  const p: Pipeline = { pipelineId: `pipe:${randomUUID()}`, tenantId, orgId, name: cleanStr(name, MAX.name, 'Pipeline'), stages, createdAt: ts, updatedAt: ts };
  await pipelines.put(p);
  return p;
}

export async function updatePipeline(
  tenantId: string,
  orgId: string,
  pipelineId: string,
  patch: { name?: string; stages?: Array<{ stageId?: string; name: string; probability?: number }> },
): Promise<Pipeline | null> {
  const p = await getPipeline(tenantId, orgId, pipelineId);
  if (!p) return null;
  const next: Pipeline = { ...p, updatedAt: nowIso() };
  if (patch.name !== undefined) next.name = cleanStr(patch.name, MAX.name, p.name);
  if (patch.stages !== undefined) {
    // Preserve a stage's id (and thus deals on it) when the caller keeps it.
    const byId = new Map(p.stages.map((s) => [s.stageId, s]));
    next.stages = patch.stages.slice(0, MAX.stages).map((s) => {
      const keep = s.stageId ? byId.get(s.stageId) : undefined;
      return {
        stageId: keep?.stageId ?? `stg:${randomUUID()}`,
        name: cleanStr(s.name, MAX.short, keep?.name ?? 'Stage'),
        probability: typeof s.probability === 'number' ? Math.max(0, Math.min(100, Math.round(s.probability))) : (keep?.probability ?? 0),
      };
    });
    // Referential integrity (code-review #1): refuse to drop a stage that deals
    // sit on — orphaning them onto a dead stageId. Same guard as deletePipeline.
    const survivingIds = new Set(next.stages.map((s) => s.stageId));
    const removedIds = p.stages.filter((s) => !survivingIds.has(s.stageId)).map((s) => s.stageId);
    if (removedIds.length > 0) {
      const orphaned = (await deals.list()).filter(
        (d) => d.tenantId === tenantId && d.orgId === orgId && d.pipelineId === pipelineId && removedIds.includes(d.stageId),
      );
      if (orphaned.length > 0) {
        throw new OpenwopError('validation_error', 'A removed stage still has deals — move them to another stage first.', 409, { dealsOnRemovedStages: orphaned.length });
      }
    }
  }
  await pipelines.put(next);
  return next;
}

export async function deletePipeline(tenantId: string, orgId: string, pipelineId: string): Promise<boolean> {
  const p = await getPipeline(tenantId, orgId, pipelineId);
  if (!p) return false;
  const referencing = (await deals.list()).some((d) => d.tenantId === tenantId && d.orgId === orgId && d.pipelineId === pipelineId);
  if (referencing) {
    throw new OpenwopError('validation_error', 'Pipeline still has deals — move or delete them first.', 409, { pipelineId });
  }
  await pipelines.delete(pipelineId);
  return true;
}

// ── Companies ───────────────────────────────────────────────────────────────

export interface Company {
  companyId: string;
  tenantId: string;
  orgId: string;
  name: string;
  domain?: string;
  industry?: string;
  tags: string[];
  customFields: Record<string, string | number | boolean>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const companies = new DurableCollection<Company>('crm:company', (c) => c.companyId);

export async function listCompanies(tenantId: string, orgId: string, q?: string): Promise<Company[]> {
  const needle = q?.trim().toLowerCase();
  return (await companies.list()).filter(
    (c) => c.tenantId === tenantId && c.orgId === orgId && (!needle || c.name.toLowerCase().includes(needle)),
  );
}

export async function getCompany(tenantId: string, orgId: string, companyId: string): Promise<Company | null> {
  const c = await companies.get(companyId);
  return c && c.tenantId === tenantId && c.orgId === orgId ? c : null;
}

export async function createCompany(input: {
  tenantId: string;
  orgId: string;
  name: string;
  domain?: unknown;
  industry?: unknown;
  tags?: unknown;
  customFields?: Record<string, string | number | boolean>;
  createdBy: string;
}): Promise<Company> {
  assertEntityCap((await listCompanies(input.tenantId, input.orgId)).length, 'companies');
  const ts = nowIso();
  const c: Company = {
    companyId: `cmp:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    name: cleanStr(input.name, MAX.name, 'Untitled company'),
    ...(optStr(input.domain, MAX.short) ? { domain: optStr(input.domain, MAX.short) } : {}),
    ...(optStr(input.industry, MAX.short) ? { industry: optStr(input.industry, MAX.short) } : {}),
    tags: cleanTags(input.tags),
    customFields: input.customFields ?? {},
    createdBy: input.createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  await companies.put(c);
  return c;
}

export async function updateCompany(
  tenantId: string,
  orgId: string,
  companyId: string,
  patch: { name?: string; domain?: string | null; industry?: string | null; tags?: unknown; customFields?: Record<string, string | number | boolean> },
): Promise<Company | null> {
  const c = await getCompany(tenantId, orgId, companyId);
  if (!c) return null;
  const next: Company = { ...c, updatedAt: nowIso() };
  if (patch.name !== undefined) next.name = cleanStr(patch.name, MAX.name, c.name);
  if (patch.domain !== undefined) {
    if (patch.domain === null) delete next.domain;
    else next.domain = optStr(patch.domain, MAX.short);
  }
  if (patch.industry !== undefined) {
    if (patch.industry === null) delete next.industry;
    else next.industry = optStr(patch.industry, MAX.short);
  }
  if (patch.tags !== undefined) next.tags = cleanTags(patch.tags);
  if (patch.customFields !== undefined) next.customFields = patch.customFields;
  await companies.put(next);
  return next;
}

export async function deleteCompany(tenantId: string, orgId: string, companyId: string): Promise<boolean> {
  const c = await getCompany(tenantId, orgId, companyId);
  if (!c) return false;
  await companies.delete(companyId);
  return true;
}

// ── Deals ─────────────────────────────────────────────────────────────────

export interface Deal {
  dealId: string;
  tenantId: string;
  orgId: string;
  title: string;
  pipelineId: string;
  stageId: string;
  amount?: number;
  currency?: string;
  companyId?: string;
  contactId?: string;
  customFields: Record<string, string | number | boolean>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const deals = new DurableCollection<Deal>('crm:deal', (d) => d.dealId);

/** Resolve the (pipeline, stage) a deal should sit on — defaulting to the org's
 *  default pipeline's first stage, validating any explicit ids belong to the org. */
async function resolveStage(tenantId: string, orgId: string, pipelineId?: string, stageId?: string): Promise<{ pipelineId: string; stageId: string }> {
  const pipeline = pipelineId ? await getPipeline(tenantId, orgId, pipelineId) : await getOrCreateDefaultPipeline(tenantId, orgId);
  if (!pipeline) throw new OpenwopError('not_found', 'Pipeline not found in this org.', 404, { pipelineId });
  if (pipeline.stages.length === 0) throw new OpenwopError('validation_error', 'Pipeline has no stages.', 409, { pipelineId: pipeline.pipelineId });
  const resolvedStage = stageId ? pipeline.stages.find((s) => s.stageId === stageId) : pipeline.stages[0];
  if (!resolvedStage) throw new OpenwopError('not_found', 'Stage not found in this pipeline.', 404, { stageId });
  return { pipelineId: pipeline.pipelineId, stageId: resolvedStage.stageId };
}

export async function listDeals(tenantId: string, orgId: string, filter: { pipelineId?: string; stageId?: string; companyId?: string; q?: string } = {}): Promise<Deal[]> {
  const needle = filter.q?.trim().toLowerCase();
  return (await deals.list()).filter(
    (d) =>
      d.tenantId === tenantId &&
      d.orgId === orgId &&
      (filter.pipelineId === undefined || d.pipelineId === filter.pipelineId) &&
      (filter.stageId === undefined || d.stageId === filter.stageId) &&
      (filter.companyId === undefined || d.companyId === filter.companyId) &&
      (!needle || d.title.toLowerCase().includes(needle)),
  );
}

export async function getDeal(tenantId: string, orgId: string, dealId: string): Promise<Deal | null> {
  const d = await deals.get(dealId);
  return d && d.tenantId === tenantId && d.orgId === orgId ? d : null;
}

export async function createDeal(input: {
  tenantId: string;
  orgId: string;
  title: string;
  pipelineId?: string;
  stageId?: string;
  amount?: number;
  currency?: unknown;
  companyId?: string;
  contactId?: string;
  customFields?: Record<string, string | number | boolean>;
  createdBy: string;
  validateCompany: (companyId: string) => Promise<boolean>;
  validateContact: (contactId: string) => Promise<boolean>;
}): Promise<Deal> {
  assertEntityCap((await listDeals(input.tenantId, input.orgId)).length, 'deals');
  const { pipelineId, stageId } = await resolveStage(input.tenantId, input.orgId, input.pipelineId, input.stageId);
  if (input.companyId && !(await input.validateCompany(input.companyId))) {
    throw new OpenwopError('not_found', 'Linked company not found in this org.', 404, { companyId: input.companyId });
  }
  if (input.contactId && !(await input.validateContact(input.contactId))) {
    throw new OpenwopError('not_found', 'Linked contact not found in this tenant.', 404, { contactId: input.contactId });
  }
  const ts = nowIso();
  const d: Deal = {
    dealId: `deal:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    title: cleanStr(input.title, MAX.name, 'Untitled deal'),
    pipelineId,
    stageId,
    ...(typeof input.amount === 'number' && Number.isFinite(input.amount) ? { amount: input.amount } : {}),
    ...(optStr(input.currency, 8) ? { currency: optStr(input.currency, 8) } : {}),
    ...(input.companyId ? { companyId: input.companyId } : {}),
    ...(input.contactId ? { contactId: input.contactId } : {}),
    customFields: input.customFields ?? {},
    createdBy: input.createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  await deals.put(d);
  return d;
}

export async function updateDeal(
  tenantId: string,
  orgId: string,
  dealId: string,
  patch: { title?: string; stageId?: string; pipelineId?: string; amount?: number | null; currency?: string | null; companyId?: string | null; contactId?: string | null; customFields?: Record<string, string | number | boolean> },
  validators: { validateCompany: (id: string) => Promise<boolean>; validateContact: (id: string) => Promise<boolean> },
): Promise<Deal | null> {
  const d = await getDeal(tenantId, orgId, dealId);
  if (!d) return null;
  const next: Deal = { ...d, updatedAt: nowIso() };
  if (patch.title !== undefined) next.title = cleanStr(patch.title, MAX.name, d.title);
  if (patch.pipelineId !== undefined || patch.stageId !== undefined) {
    const { pipelineId, stageId } = await resolveStage(tenantId, orgId, patch.pipelineId ?? d.pipelineId, patch.stageId);
    next.pipelineId = pipelineId;
    next.stageId = stageId;
  }
  if (patch.amount !== undefined) {
    if (patch.amount === null) delete next.amount;
    else if (Number.isFinite(patch.amount)) next.amount = patch.amount;
  }
  if (patch.currency !== undefined) {
    if (patch.currency === null) delete next.currency;
    else next.currency = optStr(patch.currency, 8);
  }
  if (patch.companyId !== undefined) {
    if (patch.companyId === null) delete next.companyId;
    else {
      if (!(await validators.validateCompany(patch.companyId))) throw new OpenwopError('not_found', 'Linked company not found in this org.', 404, { companyId: patch.companyId });
      next.companyId = patch.companyId;
    }
  }
  if (patch.contactId !== undefined) {
    if (patch.contactId === null) delete next.contactId;
    else {
      if (!(await validators.validateContact(patch.contactId))) throw new OpenwopError('not_found', 'Linked contact not found in this tenant.', 404, { contactId: patch.contactId });
      next.contactId = patch.contactId;
    }
  }
  if (patch.customFields !== undefined) next.customFields = patch.customFields;
  await deals.put(next);
  return next;
}

export async function deleteDeal(tenantId: string, orgId: string, dealId: string): Promise<boolean> {
  const d = await getDeal(tenantId, orgId, dealId);
  if (!d) return false;
  await deals.delete(dealId);
  return true;
}

// ── Tasks (Phase 2) ─────────────────────────────────────────────────────────

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

const tasks = new DurableCollection<Task>('crm:task', (t) => t.taskId);

export interface LinkValidators {
  validateDeal: (id: string) => Promise<boolean>;
  validateCompany: (id: string) => Promise<boolean>;
  validateContact: (id: string) => Promise<boolean>;
}

/** Validate the optional deal/company/contact links a task or activity carries. */
async function assertLinks(v: LinkValidators, links: { dealId?: string; companyId?: string; contactId?: string }): Promise<void> {
  if (links.dealId && !(await v.validateDeal(links.dealId))) throw new OpenwopError('not_found', 'Linked deal not found in this org.', 404, { dealId: links.dealId });
  if (links.companyId && !(await v.validateCompany(links.companyId))) throw new OpenwopError('not_found', 'Linked company not found in this org.', 404, { companyId: links.companyId });
  if (links.contactId && !(await v.validateContact(links.contactId))) throw new OpenwopError('not_found', 'Linked contact not found in this tenant.', 404, { contactId: links.contactId });
}

export async function listTasks(tenantId: string, orgId: string, filter: { status?: string; dealId?: string } = {}): Promise<Task[]> {
  return (await tasks.list()).filter(
    (t) => t.tenantId === tenantId && t.orgId === orgId && (filter.status === undefined || t.status === filter.status) && (filter.dealId === undefined || t.dealId === filter.dealId),
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
}): Promise<Task> {
  assertEntityCap((await listTasks(input.tenantId, input.orgId)).length, 'tasks');
  await assertLinks(input.validators, input);
  const ts = nowIso();
  const t: Task = {
    taskId: `task:${randomUUID()}`,
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
  return t;
}

export async function updateTask(
  tenantId: string,
  orgId: string,
  taskId: string,
  patch: { title?: string; status?: TaskStatus; dueDate?: string | null; assignee?: string | null },
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
  return next;
}

export async function deleteTask(tenantId: string, orgId: string, taskId: string): Promise<boolean> {
  const t = await getTask(tenantId, orgId, taskId);
  if (!t) return false;
  await tasks.delete(taskId);
  return true;
}

// ── Activities (Phase 2) — append-only timeline ──────────────────────────────

export type ActivityKind = 'note' | 'call' | 'email' | 'meeting';
export const ACTIVITY_KINDS: ActivityKind[] = ['note', 'call', 'email', 'meeting'];

export interface Activity {
  activityId: string;
  tenantId: string;
  orgId: string;
  kind: ActivityKind;
  body: string;
  dealId?: string;
  contactId?: string;
  companyId?: string;
  createdBy: string;
  createdAt: string;
  /** Monotonic creation sequence — a STABLE newest-first tiebreaker when two
   *  activities land in the same millisecond (the flaky-sort fix). */
  seq: number;
}

const activities = new DurableCollection<Activity>('crm:activity', (a) => a.activityId);
let activitySeq = 0;

export async function listActivities(tenantId: string, orgId: string, filter: { dealId?: string; contactId?: string; companyId?: string } = {}): Promise<Activity[]> {
  return (await activities.list())
    .filter(
      (a) =>
        a.tenantId === tenantId &&
        a.orgId === orgId &&
        (filter.dealId === undefined || a.dealId === filter.dealId) &&
        (filter.contactId === undefined || a.contactId === filter.contactId) &&
        (filter.companyId === undefined || a.companyId === filter.companyId),
    )
    // Newest first: createdAt primary (RESTART-SAFE — the seq counter resets on
    // restart), seq as a same-millisecond tiebreaker only (code-review #3).
    .sort((x, y) => (x.createdAt !== y.createdAt ? (x.createdAt < y.createdAt ? 1 : -1) : (y.seq ?? 0) - (x.seq ?? 0)));
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
  createdBy: string;
  validators: LinkValidators;
}): Promise<Activity> {
  if (!ACTIVITY_KINDS.includes(input.kind)) {
    throw new OpenwopError('validation_error', `kind must be one of: ${ACTIVITY_KINDS.join(', ')}`, 400, { field: 'kind' });
  }
  assertEntityCap((await listActivities(input.tenantId, input.orgId)).length, 'activities');
  await assertLinks(input.validators, input);
  const a: Activity = {
    activityId: `act:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    kind: input.kind,
    body: cleanStr(input.body, MAX.body, ''),
    ...(input.dealId ? { dealId: input.dealId } : {}),
    ...(input.contactId ? { contactId: input.contactId } : {}),
    ...(input.companyId ? { companyId: input.companyId } : {}),
    createdBy: input.createdBy,
    createdAt: nowIso(),
    seq: ++activitySeq,
  };
  await activities.put(a);
  return a;
}

// ── Custom field definitions (Phase 3) ──────────────────────────────────────

export type FieldType = 'string' | 'number' | 'boolean';
export const FIELD_TYPES: FieldType[] = ['string', 'number', 'boolean'];
export type CustomEntity = 'company' | 'deal';
export const CUSTOM_ENTITIES: CustomEntity[] = ['company', 'deal'];

export interface FieldDef {
  defId: string;
  tenantId: string;
  orgId: string;
  entityType: CustomEntity;
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  createdAt: string;
}

const fieldDefs = new DurableCollection<FieldDef>('crm:fielddef', (f) => f.defId);

export async function listFieldDefs(tenantId: string, orgId: string, entityType?: CustomEntity): Promise<FieldDef[]> {
  return (await fieldDefs.list()).filter((f) => f.tenantId === tenantId && f.orgId === orgId && (entityType === undefined || f.entityType === entityType));
}

export async function createFieldDef(input: { tenantId: string; orgId: string; entityType: CustomEntity; key: string; label: string; type: FieldType; required?: boolean }): Promise<FieldDef> {
  const key = cleanStr(input.key, 60).toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!key) throw new OpenwopError('validation_error', 'Field `key` is required.', 400, { field: 'key' });
  if (!FIELD_TYPES.includes(input.type)) throw new OpenwopError('validation_error', `type must be one of: ${FIELD_TYPES.join(', ')}`, 400, { field: 'type' });
  const existing = await listFieldDefs(input.tenantId, input.orgId, input.entityType);
  if (existing.some((f) => f.key === key)) throw new OpenwopError('validation_error', `A field \`${key}\` already exists for ${input.entityType}.`, 409, { key });
  if (existing.length >= MAX.customKeys) throw new OpenwopError('validation_error', `This org has the maximum ${MAX.customKeys} custom fields for ${input.entityType}.`, 409, { max: MAX.customKeys });
  const def: FieldDef = {
    defId: `fdef:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    entityType: input.entityType,
    key,
    label: cleanStr(input.label, MAX.short, key),
    type: input.type,
    required: input.required === true,
    createdAt: nowIso(),
  };
  await fieldDefs.put(def);
  return def;
}

export async function deleteFieldDef(tenantId: string, orgId: string, defId: string): Promise<boolean> {
  const f = await fieldDefs.get(defId);
  if (!f || f.tenantId !== tenantId || f.orgId !== orgId) return false;
  await fieldDefs.delete(defId);
  return true;
}

/**
 * Validate a `customFields` map against the org's active field defs for an
 * entity: every provided key MUST be defined and type-correct; on create
 * (`requireAll`) every required def must be present. Returns the validated map
 * (only defined keys) — unknown keys are rejected, not silently dropped.
 */
export async function validateCustomFields(
  tenantId: string,
  orgId: string,
  entityType: CustomEntity,
  provided: Record<string, unknown>,
  opts: { requireAll: boolean },
): Promise<Record<string, string | number | boolean>> {
  const defs = await listFieldDefs(tenantId, orgId, entityType);
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(provided)) {
    const def = byKey.get(key);
    if (!def) throw new OpenwopError('validation_error', `Unknown custom field \`${key}\` for ${entityType}.`, 400, { key });
    if (def.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new OpenwopError('validation_error', `Custom field \`${key}\` must be a number.`, 400, { key });
      out[key] = value;
    } else if (def.type === 'boolean') {
      if (typeof value !== 'boolean') throw new OpenwopError('validation_error', `Custom field \`${key}\` must be a boolean.`, 400, { key });
      out[key] = value;
    } else {
      out[key] = cleanStr(value, MAX.short);
    }
  }
  if (opts.requireAll) {
    for (const def of defs) {
      if (def.required && !(def.key in out)) throw new OpenwopError('validation_error', `Custom field \`${def.key}\` is required.`, 400, { key: def.key });
    }
  }
  return out;
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __resetCrmEntities(): Promise<void> {
  await pipelines.__clear();
  await companies.__clear();
  await deals.__clear();
  await tasks.__clear();
  await activities.__clear();
  await fieldDefs.__clear();
}
