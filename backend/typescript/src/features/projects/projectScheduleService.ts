/**
 * Project schedule service (ADR 0046 follow-on / ADR 0045) — a project's cron
 * schedules, riding the EXISTING scheduler (`host/schedulingService.ts`) via the
 * generic `ownerSubject` the board already uses. A project schedule is just a
 * `ScheduledJob` whose owner Subject is `project:<id>` — no parallel scheduler.
 *
 *   - rows        → `schedulingService` jobs (the one scheduler; the daemon fires them)
 *   - owner       → `ownerSubject = projectSubject(id)` (the additive generic owner)
 *   - listing     → the shared `listJobsForSubject` (the canonical owner query)
 *
 * No authority of its own (ADR 0045): the route gates on the caller's org scope.
 * Tenant isolation: every call threads `tenantId`; `listJobsForSubject` is
 * tenant-scoped, and mutations re-verify the job's owner+tenant (IDOR fail-closed).
 *
 * @see docs/adr/0046-project-subject.md
 */

import { randomUUID } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { cleanString } from '../../host/boundedStrings.js';
import {
  registerJob, listJobsForSubject, getJob, deleteJob, updateJob, scheduleSubject,
  type ScheduledJob,
} from '../../host/schedulingService.js';
import { projectSubject } from './projectsService.js';

/** Soft per-project guard (read-then-write, not CAS) — a workspace limit, not a
 *  security boundary. */
const SCHEDULE_CAP = 50;

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

/** Project the durable job onto the safe, project-facing view (no tenant/owner
 *  internals, no free-form metadata). */
function toView(j: ScheduledJob): ProjectSchedule {
  return {
    jobId: j.jobId,
    cronExpr: j.cronExpr,
    enabled: j.enabled,
    ...(j.workflowId !== undefined ? { workflowId: j.workflowId } : {}),
    ...(j.timezone !== undefined ? { timezone: j.timezone } : {}),
    ...(j.lastRunAt !== undefined ? { lastRunAt: j.lastRunAt } : {}),
    ...(j.nextFireAt !== undefined ? { nextFireAt: j.nextFireAt } : {}),
    ...(j.createdAt !== undefined ? { createdAt: j.createdAt } : {}),
  };
}

export async function listProjectSchedules(tenantId: string, projectId: string): Promise<ProjectSchedule[]> {
  return (await listJobsForSubject(tenantId, projectSubject(projectId))).map(toView);
}

export async function createProjectSchedule(
  tenantId: string,
  projectId: string,
  input: { cronExpr?: unknown; workflowId?: unknown; timezone?: unknown },
): Promise<ProjectSchedule> {
  const cronExpr = cleanString(input.cronExpr, 120);
  if (!cronExpr) throw new OpenwopError('validation_error', 'Field `cronExpr` is required.', 400, { field: 'cronExpr' });
  // `workflowId` is intentionally NOT validated against `project.workflows` —
  // consistent with the profile/agent scheduler routes (which only type-check it).
  // An unresolvable id no-ops gracefully in the daemon ("workflow did not resolve");
  // a `workspace:write` member can already create runs, so this is no escalation.
  const workflowId = input.workflowId !== undefined ? cleanString(input.workflowId, 200) : undefined;
  const timezone = input.timezone !== undefined ? cleanString(input.timezone, 64) : undefined;
  // Best-effort cap (read-then-write, not CAS) — concurrent creates could briefly exceed it.
  if ((await listJobsForSubject(tenantId, projectSubject(projectId))).length >= SCHEDULE_CAP) {
    throw new OpenwopError('validation_error', `This project already has the maximum ${SCHEDULE_CAP} schedules.`, 400, { cap: SCHEDULE_CAP });
  }
  const res = await registerJob({
    jobId: `job-project-${randomUUID().slice(0, 12)}`,
    tenantId,
    cronExpr,
    ownerSubject: projectSubject(projectId),
    ...(workflowId ? { workflowId } : {}),
    ...(timezone ? { timezone } : {}),
  });
  if (!res.ok) throw new OpenwopError('validation_error', res.error.message, 400, { code: res.error.code });
  return toView(res.job);
}

/** Resolve a job that is owned by THIS project in THIS tenant, or fail closed
 *  (uniform 404 — no cross-project / cross-tenant IDOR, no existence leak). */
async function ownedJob(tenantId: string, projectId: string, jobId: string): Promise<ScheduledJob> {
  const job = await getJob(jobId);
  const subject = job ? scheduleSubject(job) : null;
  if (!job || job.tenantId !== tenantId || !subject || subject.kind !== 'project' || subject.id !== projectId) {
    throw new OpenwopError('not_found', 'Schedule not found.', 404, { jobId });
  }
  return job;
}

export async function updateProjectSchedule(
  tenantId: string,
  projectId: string,
  jobId: string,
  patch: { enabled?: unknown; cronExpr?: unknown; workflowId?: unknown; timezone?: unknown },
): Promise<ProjectSchedule> {
  await ownedJob(tenantId, projectId, jobId);
  const clean: { enabled?: boolean; cronExpr?: string; workflowId?: string; timezone?: string } = {};
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw new OpenwopError('validation_error', 'Field `enabled` must be a boolean.', 400, { field: 'enabled' });
    clean.enabled = patch.enabled;
  }
  if (patch.cronExpr !== undefined) {
    const cronExpr = cleanString(patch.cronExpr, 120);
    if (!cronExpr) throw new OpenwopError('validation_error', 'Field `cronExpr` must be a non-empty string.', 400, { field: 'cronExpr' });
    clean.cronExpr = cronExpr;
  }
  if (patch.workflowId !== undefined) {
    const workflowId = cleanString(patch.workflowId, 200);
    if (workflowId) clean.workflowId = workflowId;
  }
  if (patch.timezone !== undefined) {
    const timezone = cleanString(patch.timezone, 64);
    if (timezone) clean.timezone = timezone;
  }
  const updated = await updateJob(jobId, clean);
  if (!updated) throw new OpenwopError('not_found', 'Schedule not found.', 404, { jobId });
  return toView(updated);
}

export async function deleteProjectSchedule(tenantId: string, projectId: string, jobId: string): Promise<void> {
  await ownedJob(tenantId, projectId, jobId);
  await deleteJob(jobId);
}
// NOTE: the delete-project CASCADE lives in `projectsService.deleteProject`, which
// clears owned jobs via host scheduler functions directly (avoids a feature→feature
// import cycle with this module, which imports `projectSubject` from there).
