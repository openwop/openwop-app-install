/**
 * Project schedule client (ADR 0046 follow-on) — drives
 * /v1/host/openwop-app/projects/:id/schedules. A project schedule is a
 * `ScheduledJob` owned by the `project:<id>` subject on the ONE scheduler; this
 * client just lists/creates/updates/deletes the project's own jobs.
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface ProjectSchedule {
  jobId: string;
  cronExpr: string;
  workflowId?: string;
  timezone?: string;
  enabled: boolean;
  lastRunAt?: string;
  nextFireAt?: number;
  createdAt?: string;
}

const baseFor = (projectId: string): string => `${config.baseUrl}/v1/host/openwop-app/projects/${encodeURIComponent(projectId)}/schedules`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) throw new Error(`${ctx} failed (${res.status})`);
  return res.json() as Promise<T>;
}

export async function listSchedules(projectId: string): Promise<ProjectSchedule[]> {
  return (await asJson<{ schedules: ProjectSchedule[] }>(await fetch(baseFor(projectId), fetchOpts({ headers: authedHeaders() })), 'listSchedules')).schedules;
}

export async function createSchedule(projectId: string, input: { cronExpr: string; workflowId?: string; timezone?: string }): Promise<ProjectSchedule> {
  return asJson<ProjectSchedule>(await fetch(baseFor(projectId), fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) })), 'createSchedule');
}

export async function updateSchedule(projectId: string, jobId: string, patch: { enabled?: boolean; cronExpr?: string; workflowId?: string; timezone?: string }): Promise<ProjectSchedule> {
  return asJson<ProjectSchedule>(await fetch(`${baseFor(projectId)}/${encodeURIComponent(jobId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) })), 'updateSchedule');
}

export async function deleteSchedule(projectId: string, jobId: string): Promise<void> {
  const res = await fetch(`${baseFor(projectId)}/${encodeURIComponent(jobId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`deleteSchedule failed (${res.status})`);
}
