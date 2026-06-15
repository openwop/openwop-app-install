/**
 * CRM org-scoped API client (ADR 0008) — Companies, Deals, Pipelines, Tasks
 * under /v1/host/openwop-app/crm/orgs/:orgId/*. Separate from the legacy contacts
 * client (`crmClient.ts`), which is preserved unchanged.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

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
  tags: string[];
}
export interface Deal {
  dealId: string;
  title: string;
  pipelineId: string;
  stageId: string;
  amount?: number;
  currency?: string;
  companyId?: string;
  contactId?: string;
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

const root = `${config.baseUrl}/v1/host/openwop-app`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string })?.message ?? '';
    } catch {
      /* non-JSON */
    }
    throw new Error(detail || `${ctx} returned ${res.status}`);
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

export async function listCompanies(orgId: string, q?: string): Promise<Company[]> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  const res = await fetch(`${orgBase(orgId)}/companies${qs}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ companies: Company[] }>(res, 'listCompanies')).companies;
}
export async function createCompany(orgId: string, input: { name: string; domain?: string }): Promise<Company> {
  const res = await fetch(`${orgBase(orgId)}/companies`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<Company>(res, 'createCompany');
}
export async function deleteCompany(orgId: string, companyId: string): Promise<void> {
  const res = await fetch(`${orgBase(orgId)}/companies/${encodeURIComponent(companyId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) await asJson<unknown>(res, 'deleteCompany');
}

export async function listDeals(orgId: string): Promise<Deal[]> {
  const res = await fetch(`${orgBase(orgId)}/deals`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ deals: Deal[] }>(res, 'listDeals')).deals;
}
export async function createDeal(orgId: string, input: { title: string; amount?: number; companyId?: string; stageId?: string }): Promise<Deal> {
  const res = await fetch(`${orgBase(orgId)}/deals`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<Deal>(res, 'createDeal');
}
export async function moveDeal(orgId: string, dealId: string, stageId: string): Promise<Deal> {
  const res = await fetch(`${orgBase(orgId)}/deals/${encodeURIComponent(dealId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ stageId }) }));
  return asJson<Deal>(res, 'moveDeal');
}
export async function deleteDeal(orgId: string, dealId: string): Promise<void> {
  const res = await fetch(`${orgBase(orgId)}/deals/${encodeURIComponent(dealId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) await asJson<unknown>(res, 'deleteDeal');
}

export async function listTasks(orgId: string): Promise<Task[]> {
  const res = await fetch(`${orgBase(orgId)}/tasks`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ tasks: Task[] }>(res, 'listTasks')).tasks;
}
export async function createTask(orgId: string, input: { title: string; status?: TaskStatus }): Promise<Task> {
  const res = await fetch(`${orgBase(orgId)}/tasks`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<Task>(res, 'createTask');
}
export async function setTaskStatus(orgId: string, taskId: string, status: TaskStatus): Promise<Task> {
  const res = await fetch(`${orgBase(orgId)}/tasks/${encodeURIComponent(taskId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ status }) }));
  return asJson<Task>(res, 'setTaskStatus');
}
export async function deleteTask(orgId: string, taskId: string): Promise<void> {
  const res = await fetch(`${orgBase(orgId)}/tasks/${encodeURIComponent(taskId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) await asJson<unknown>(res, 'deleteTask');
}
