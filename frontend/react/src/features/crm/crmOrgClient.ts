/**
 * CRM org-scoped API client (ADR 0008) — Companies, Deals, Pipelines, Tasks
 * under /host/openwop-app/crm/orgs/:orgId/*. Separate from the legacy contacts
 * client (`crmClient.ts`), which is preserved unchanged.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { CrmRequestError } from './crmRequestError.js';

export interface Org {
  orgId: string;
  name: string;
}
export interface PipelineStage {
  stageId: string;
  name: string;
  probability: number;
}
export interface Pipeline {
  pipelineId: string;
  name: string;
  stages: PipelineStage[];
}
export interface Company {
  companyId: string;
  name: string;
  domain?: string;
  industry?: string;
  /** CRM-2 — firmographics: `size` = employee count, `revenue` = annual revenue (major units). */
  size?: number;
  revenue?: number;
  tags: string[];
}
export type DealStatus = 'open' | 'won' | 'lost';
export const DEAL_STATUSES: readonly DealStatus[] = ['open', 'won', 'lost'];
export interface Deal {
  dealId: string;
  title: string;
  pipelineId: string;
  stageId: string;
  amount?: number;
  currency?: string;
  companyId?: string;
  contactId?: string;
  owner?: string;
  closeDate?: string;
  status?: DealStatus;
}
export const ACTIVITY_KINDS = ['note', 'call', 'email', 'meeting'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export interface Activity {
  activityId: string;
  kind: ActivityKind;
  body: string;
  dealId?: string;
  contactId?: string;
  companyId?: string;
  createdBy: string;
  createdAt: string;
}
export type TaskStatus = 'open' | 'doing' | 'done';
export const TASK_STATUSES: readonly TaskStatus[] = ['open', 'doing', 'done'];
export interface Task {
  taskId: string;
  title: string;
  status: TaskStatus;
  dueDate?: string;
  dealId?: string;
}

const root = `${config.baseUrl}/host/openwop-app`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

// CRM-UX-14 — the class lives in `crmRequestError.ts` (shared with the
// tenant-scoped client + the UI helper); re-exported so existing imports hold.
export { CrmRequestError };

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string })?.message ?? '';
    } catch {
      /* non-JSON */
    }
    throw new CrmRequestError(detail || `${ctx} returned ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${root}/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

const orgBase = (orgId: string): string => `${root}/crm/orgs/${encodeURIComponent(orgId)}`;

export async function listPipelines(orgId: string): Promise<Pipeline[]> {
  const res = await fetch(`${orgBase(orgId)}/pipelines`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ pipelines: Pipeline[] }>(res, 'listPipelines')).pipelines;
}

/** CRM-UX-2 — the write half of the pipelines API. `POST/PATCH/DELETE …/pipelines`
 *  shipped in `orgRoutes.ts` with ZERO frontend consumers (this client exported
 *  `listPipelines` alone), so the board's columns were whatever the backend
 *  seeded and the weighted forecast multiplied by stage probabilities no user
 *  could see or change. `PipelinesPage.tsx` is the consumer.
 *
 *  Caps mirrored from the server (`entities/shared.ts` MAX): 24 stages, name 160
 *  chars, stage name 120, probability an integer 0–100 (clamped server-side). */
export const PIPELINE_MAX = { stages: 24, name: 160, stageName: 120 } as const;

export async function createPipeline(orgId: string, input: { name: string; stages: Array<{ name: string; probability: number }> }): Promise<Pipeline> {
  const res = await fetch(`${orgBase(orgId)}/pipelines`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<Pipeline>(res, 'createPipeline');
}

/** `stages` REPLACES the set, and it is the array ORDER that orders the board's
 *  columns. Carry a `stageId` for every stage you are keeping — the server
 *  preserves the id (and therefore the deals sitting on it) only when you send
 *  it back, and refuses (409) to drop a stage that still has deals. */
export async function updatePipeline(
  orgId: string,
  pipelineId: string,
  patch: { name?: string; stages?: Array<{ stageId?: string; name: string; probability: number }> },
): Promise<Pipeline> {
  const res = await fetch(`${orgBase(orgId)}/pipelines/${encodeURIComponent(pipelineId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<Pipeline>(res, 'updatePipeline');
}

/** The server refuses (409) while any deal still references the pipeline. */
export async function deletePipeline(orgId: string, pipelineId: string): Promise<void> {
  const res = await fetch(`${orgBase(orgId)}/pipelines/${encodeURIComponent(pipelineId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) await asJson<unknown>(res, 'deletePipeline');
}

export async function listCompanies(orgId: string, q?: string): Promise<Company[]> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  const res = await fetch(`${orgBase(orgId)}/companies${qs}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ companies: Company[] }>(res, 'listCompanies')).companies;
}
export async function getCompany(orgId: string, companyId: string): Promise<Company> {
  const res = await fetch(`${orgBase(orgId)}/companies/${encodeURIComponent(companyId)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<Company>(res, 'getCompany');
}
export async function updateCompany(orgId: string, companyId: string, patch: { name?: string; domain?: string | null; industry?: string | null; size?: number | null; revenue?: number | null }): Promise<Company> {
  const res = await fetch(`${orgBase(orgId)}/companies/${encodeURIComponent(companyId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<Company>(res, 'updateCompany');
}
export async function createCompany(orgId: string, input: { name: string; domain?: string; size?: number; revenue?: number }): Promise<Company> {
  const res = await fetch(`${orgBase(orgId)}/companies`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<Company>(res, 'createCompany');
}
export async function deleteCompany(orgId: string, companyId: string): Promise<void> {
  const res = await fetch(`${orgBase(orgId)}/companies/${encodeURIComponent(companyId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) await asJson<unknown>(res, 'deleteCompany');
}

export async function listDeals(orgId: string, filter?: { pipelineId?: string; companyId?: string }): Promise<Deal[]> {
  const params = new URLSearchParams();
  if (filter?.pipelineId) params.set('pipelineId', filter.pipelineId);
  if (filter?.companyId) params.set('companyId', filter.companyId);
  const qs = params.size > 0 ? `?${params.toString()}` : '';
  const res = await fetch(`${orgBase(orgId)}/deals${qs}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ deals: Deal[] }>(res, 'listDeals')).deals;
}
export async function getDeal(orgId: string, dealId: string): Promise<Deal> {
  const res = await fetch(`${orgBase(orgId)}/deals/${encodeURIComponent(dealId)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<Deal>(res, 'getDeal');
}
export async function createDeal(orgId: string, input: { title: string; amount?: number; currency?: string; companyId?: string; pipelineId?: string; stageId?: string; closeDate?: string }): Promise<Deal> {
  const res = await fetch(`${orgBase(orgId)}/deals`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<Deal>(res, 'createDeal');
}
export async function updateDeal(
  orgId: string,
  dealId: string,
  patch: { title?: string; stageId?: string; amount?: number | null; currency?: string | null; companyId?: string | null; owner?: string | null; closeDate?: string | null; status?: DealStatus },
): Promise<Deal> {
  const res = await fetch(`${orgBase(orgId)}/deals/${encodeURIComponent(dealId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<Deal>(res, 'updateDeal');
}
export async function moveDeal(orgId: string, dealId: string, stageId: string): Promise<Deal> {
  const res = await fetch(`${orgBase(orgId)}/deals/${encodeURIComponent(dealId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ stageId }) }));
  return asJson<Deal>(res, 'moveDeal');
}
export async function listActivities(orgId: string, filter?: { dealId?: string; contactId?: string; companyId?: string }): Promise<Activity[]> {
  const params = new URLSearchParams();
  if (filter?.dealId) params.set('dealId', filter.dealId);
  if (filter?.contactId) params.set('contactId', filter.contactId);
  if (filter?.companyId) params.set('companyId', filter.companyId);
  const qs = params.size > 0 ? `?${params.toString()}` : '';
  const res = await fetch(`${orgBase(orgId)}/activities${qs}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ activities: Activity[] }>(res, 'listActivities')).activities;
}
export async function createActivity(
  orgId: string,
  input: { kind: ActivityKind; body: string; dealId?: string; contactId?: string; companyId?: string },
): Promise<Activity> {
  const res = await fetch(`${orgBase(orgId)}/activities`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<Activity>(res, 'createActivity');
}
export async function deleteDeal(orgId: string, dealId: string): Promise<void> {
  const res = await fetch(`${orgBase(orgId)}/deals/${encodeURIComponent(dealId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) await asJson<unknown>(res, 'deleteDeal');
}

export async function listTasks(orgId: string, filter?: { dealId?: string }): Promise<Task[]> {
  const qs = filter?.dealId ? `?dealId=${encodeURIComponent(filter.dealId)}` : '';
  const res = await fetch(`${orgBase(orgId)}/tasks${qs}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ tasks: Task[] }>(res, 'listTasks')).tasks;
}
export async function createTask(orgId: string, input: { title: string; status?: TaskStatus; dueDate?: string; dealId?: string }): Promise<Task> {
  const res = await fetch(`${orgBase(orgId)}/tasks`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<Task>(res, 'createTask');
}
/** UX_UPGRADE-crm-console CRM-G1 — set/clear a task's due date. The PATCH route
 *  already accepted `dueDate` (and `null` to clear); only the UI never sent it,
 *  so an agent could set a date a human could neither see nor change. */
export async function setTaskDueDate(orgId: string, taskId: string, dueDate: string | null): Promise<Task> {
  const res = await fetch(`${orgBase(orgId)}/tasks/${encodeURIComponent(taskId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ dueDate }) }));
  return asJson<Task>(res, 'setTaskDueDate');
}
export async function setTaskStatus(orgId: string, taskId: string, status: TaskStatus): Promise<Task> {
  const res = await fetch(`${orgBase(orgId)}/tasks/${encodeURIComponent(taskId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ status }) }));
  return asJson<Task>(res, 'setTaskStatus');
}
export async function deleteTask(orgId: string, taskId: string): Promise<void> {
  const res = await fetch(`${orgBase(orgId)}/tasks/${encodeURIComponent(taskId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) await asJson<unknown>(res, 'deleteTask');
}
