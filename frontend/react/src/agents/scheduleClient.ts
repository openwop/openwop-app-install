/**
 * Agent-scoped scheduler client (host extension; RFC 0052 reference impl).
 *
 *   GET    /host/openwop-app/scheduler/jobs[?rosterId=]      → { jobs }
 *   POST   /host/openwop-app/scheduler/jobs                  → job
 *   PATCH  /host/openwop-app/scheduler/jobs/:jobId           → job   (enable/disable)
 *   DELETE /host/openwop-app/scheduler/jobs/:jobId
 *   POST   /host/openwop-app/scheduler/jobs/:jobId/trigger   → { runsFired, runId? | skipped? }
 *
 * Tenant scoping is the backend's job; the client never sends a tenantId.
 */

import { authedHeaders, config, fetchOpts } from '../client/config.js';
import { ApiError } from '../client/requestJson.js';

/** ADR 0787 — a failed call throws a structured `ApiError` (status + the
 *  server's JSON body), not `new Error('… returned 403')`: `writeErrorMessage`
 *  then says "you don't have permission" for a 403 and the server's own
 *  sentence for a 400 (an unknown time zone, a cadence that never fires). */
async function failure(res: Response, what: string): Promise<ApiError> {
  let body: unknown;
  try { body = await res.json(); } catch { body = undefined; }
  const said = body && typeof body === 'object' ? (body as { message?: unknown }).message : undefined;
  return new ApiError({
    status: res.status,
    statusText: res.statusText,
    url: res.url,
    body,
    message: typeof said === 'string' && said.length > 0 ? said : `${what} returned ${res.status}`,
  });
}

/** Why a fire produced no run (ADR 0787). `no-next-fire` is different in kind:
 *  the cadence has no FURTHER slot inside the horizon. */
export type ScheduleSkipReason = 'budget' | 'workflow-unresolved' | 'dispatch-error' | 'feature-disabled' | 'plan-lapsed' | 'actor-inactive' | 'agent-paused' | 'policy-denied' | 'awaiting-approval' | 'goal-closed' | 'no-next-fire';

/** "Run now" outcome: a run, or the reason none started. */
export interface TriggerResult {
  runsFired: number;
  runId?: string;
  skipped?: string;
}

export interface ScheduledJob {
  jobId: string;
  tenantId: string;
  cronExpr: string;
  lastFiredTick: number | null;
  workflowId?: string;
  rosterId?: string;
  /** ADR 0025 — a human user that owns this schedule (profile "Schedules" tab). */
  ownerUserId?: string;
  agentId?: string;
  enabled: boolean;
  metadata?: Record<string, unknown>;
  lastRunId?: string;
  /** ISO-8601 wall-clock time of the most recent fire. */
  lastRunAt?: string;
  /** GEN-PRJ-1 — a fire that consumed its slot and produced NO run (the daemon's
   *  `recordJobSkipped` record; see `ScheduleSkipReason`). Wire value — kept a
   *  string so an unknown reason from a newer backend still renders. */
  lastSkippedAt?: string;
  lastSkipReason?: string;
  /** ADR 0820 §7 — present while the workspace's plan no longer includes the
   *  job's owning feature. Computed by the server on each read: the job is
   *  skipped (never failed) and resumes by itself when access returns. */
  planLapsed?: { featureId: string };
  /** Epoch-ms of the next computed fire. ABSENT ⇒ the schedule will not fire:
   *  either the cron expression didn't parse (inert, ADR 0313 D3) or a
   *  one-shot ('once') already spent itself. */
  nextFireAt?: number;
  /** IANA timezone the cadence is expressed in (informational). */
  timezone?: string;
  createdAt?: string;
}

const base = `${config.baseUrl}/host/openwop-app/scheduler/jobs`;
const jsonHeaders = (): HeadersInit => authedHeaders({ 'content-type': 'application/json' });

/** List jobs, optionally filtered to one roster member (the agent's tab). */
export async function listJobs(rosterId?: string): Promise<ScheduledJob[]> {
  const url = rosterId ? `${base}?rosterId=${encodeURIComponent(rosterId)}` : base;
  const res = await fetch(url, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) throw await failure(res, 'listJobs');
  return ((await res.json()) as { jobs: ScheduledJob[] }).jobs;
}

export async function createJob(input: {
  cronExpr: string;
  workflowId?: string;
  rosterId?: string;
  /** ADR 0025 — `'me'` creates a user-owned schedule (server derives the owner). */
  owner?: 'me';
  agentId?: string;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
  timezone?: string;
}): Promise<ScheduledJob> {
  const res = await fetch(base, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  if (!res.ok) throw await failure(res, 'createJob');
  return (await res.json()) as ScheduledJob;
}

/** ADR 0025 — list the caller's OWN user-owned schedules (profile tab). */
export async function listMyJobs(): Promise<ScheduledJob[]> {
  const res = await fetch(`${base}?owner=me`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) throw await failure(res, 'listMyJobs');
  return ((await res.json()) as { jobs: ScheduledJob[] }).jobs;
}

/** Patch an editable subset of a schedule (cadence, workflow, label, timezone,
 *  enabled). Lets the UI edit in place rather than delete-and-recreate. */
export async function updateJob(
  jobId: string,
  patch: { enabled?: boolean; cronExpr?: string; workflowId?: string; metadata?: Record<string, unknown>; timezone?: string },
): Promise<ScheduledJob> {
  const res = await fetch(`${base}/${encodeURIComponent(jobId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  if (!res.ok) throw await failure(res, 'updateJob');
  return (await res.json()) as ScheduledJob;
}

export async function setJobEnabled(jobId: string, enabled: boolean): Promise<ScheduledJob> {
  return updateJob(jobId, { enabled });
}

export async function deleteJob(jobId: string): Promise<void> {
  const res = await fetch(`${base}/${encodeURIComponent(jobId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw await failure(res, 'deleteJob');
}

export async function triggerJob(jobId: string): Promise<TriggerResult> {
  const res = await fetch(`${base}/${encodeURIComponent(jobId)}/trigger`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: '{}' }));
  if (!res.ok) throw await failure(res, 'triggerJob');
  return (await res.json()) as TriggerResult;
}

/** Map a UI cadence choice to a cron expression. */
export const CADENCE_PRESETS: ReadonlyArray<{ key: string; label: string; cronExpr: string }> = [
  { key: 'hourly', label: 'Hourly', cronExpr: '0 * * * *' },
  { key: 'daily', label: 'Daily (9:00 AM)', cronExpr: '0 9 * * *' },
  { key: 'weekdays', label: 'Weekdays (9:00 AM)', cronExpr: '0 9 * * 1-5' },
  { key: 'weekly', label: 'Weekly (Mon 9:00 AM)', cronExpr: '0 9 * * 1' },
];
