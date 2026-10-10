/**
 * Project schedule client (ADR 0046 follow-on) — drives
 * /host/openwop-app/projects/:id/schedules. A project schedule is a
 * `ScheduledJob` owned by the `project:<id>` subject on the ONE scheduler; this
 * client just lists/creates/updates/deletes the project's own jobs.
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { ApiError } from '../../client/requestJson.js';

export interface ProjectSchedule {
  jobId: string;
  cronExpr: string;
  workflowId?: string;
  timezone?: string;
  enabled: boolean;
  lastRunAt?: string;
  /** Paired with `lastRunAt` — the run it links to. */
  lastRunId?: string;
  /** WF-PRJ-2 — a fire that consumed its slot and produced no run. */
  lastSkippedAt?: string;
  lastSkipReason?: string;
  /** ADR 0820 §7 — computed per read while the plan refuses the owning feature. */
  planLapsed?: { featureId: string };
  nextFireAt?: number;
  createdAt?: string;
}

const baseFor = (projectId: string): string => `${config.baseUrl}/host/openwop-app/projects/${encodeURIComponent(projectId)}/schedules`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/** ADR 0787 — a structured `ApiError` carrying the server's body, so the panel
 *  can say "no permission" for a 403 and the server's sentence for a 400. */
async function failure(res: Response, ctx: string): Promise<ApiError> {
  let body: unknown;
  try { body = await res.json(); } catch { body = undefined; }
  const said = body && typeof body === 'object' ? (body as { message?: unknown }).message : undefined;
  return new ApiError({ status: res.status, statusText: res.statusText, url: res.url, body, message: typeof said === 'string' && said.length > 0 ? said : `${ctx} failed (${res.status})` });
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) throw await failure(res, ctx);
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
  if (!res.ok) throw await failure(res, 'deleteSchedule');
}
