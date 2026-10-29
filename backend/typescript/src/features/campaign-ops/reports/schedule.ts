/**
 * ADR 0957 D2 — scheduled client reports: one scheduler job per definition,
 * through the ONE scheduler (`registerJob` + the daemon), never a second timer.
 *
 * - The job's `inputs` pin the definition version it was armed with. Every edit
 *   re-arms the job (moving the pin) or removes it when the schedule is cleared,
 *   so a scheduled run computes against the version it started with.
 * - The fire gate refuses a slot, before any run, budget or approval, when the
 *   campaign-ops toggle or the client-reports sub-toggle is off, when the
 *   client is paused, archived or gone, or when the definition is gone or no
 *   longer at the pinned version.
 * - The job id is under a prefix only this feature mints (ADR 0908 D2), so the
 *   generic scheduler routes cannot retarget or rewrite it.
 * - The run acts for the person who set the schedule (`orgScopeSubject`), and
 *   is bound to the client by the surface's `bindRunToClient`.
 */
import { deleteJob, getJob, registerJob, type ScheduledJob, type ScheduleSkipReason } from '../../../host/schedulingService.js';
import { OpenwopError } from '../../../types.js';
import { getClient } from '../clientService.js';
import { getDefinition } from './reportService.js';
import { CAMPAIGN_OPS_RUN_STAMP } from '../surface.js';
import type { ReportDefinition } from './types.js';
import { CLIENT_REPORT_CHAIN_ID } from './types.js';
import { getChainBackedWorkflow } from '../../../host/chainBackedWorkflows.js';

export const REPORT_JOB_PREFIX = 'campaign-ops-report:';
export const REPORT_JOB_PURPOSE = 'campaign-ops.client-report';
/** The chain a scheduled slot starts (ADR 0957 D2). */
export { CLIENT_REPORT_CHAIN_ID } from './types.js';

export function reportJobId(tenantId: string, orgId: string, definitionId: string): string {
  return `${REPORT_JOB_PREFIX}${tenantId}:${orgId}:${definitionId}`;
}

/** Arm, re-arm or remove the definition's job to match its schedule. */
export async function syncReportSchedule(def: ReportDefinition, actor: string): Promise<void> {
  const jobId = reportJobId(def.tenantId, def.orgId, def.definitionId);
  if (!def.schedule) {
    const prior = await getJob(jobId);
    if (prior && prior.tenantId === def.tenantId) await deleteJob(jobId);
    return;
  }
  const res = await registerJob({
    jobId,
    tenantId: def.tenantId,
    cronExpr: def.schedule.cron,
    workflowId: CLIENT_REPORT_CHAIN_ID,
    enabled: true,
    featureId: 'campaign-ops',
    timezone: def.period.timezone,
    metadata: { purpose: REPORT_JOB_PURPOSE, orgId: def.orgId, definitionId: def.definitionId, orgScopeSubject: actor, [CAMPAIGN_OPS_RUN_STAMP]: { orgId: def.orgId, definitionId: def.definitionId, definitionVersion: def.version } },
    inputs: { orgId: def.orgId, definitionId: def.definitionId, definitionVersion: def.version },
  });
  if (!res.ok) {
    throw new OpenwopError('validation_error', `The report schedule was refused: ${res.error.message}`, 400, { reason: 'report_schedule_invalid', field: 'schedule.cron' });
  }
}

export function ownsReportJob(job: ScheduledJob): boolean {
  const md = job.metadata ?? {};
  return md.purpose === REPORT_JOB_PURPOSE && typeof md.orgId === 'string' && typeof md.definitionId === 'string'
    && job.jobId === reportJobId(job.tenantId, md.orgId, md.definitionId);
}

export async function reportFireGate(job: ScheduledJob): Promise<ScheduleSkipReason | null> {
  const { resolveOne } = await import('../../../host/featureToggles/service.js');
  for (const id of ['campaign-ops', 'campaign-ops.client-reports']) {
    const t = await resolveOne(id, { tenantId: job.tenantId });
    if (!t?.enabled) return 'feature-disabled';
  }
  const orgId = String(job.metadata?.orgId ?? '');
  const definitionId = String(job.metadata?.definitionId ?? '');
  const client = await getClient(job.tenantId, orgId);
  if (!client || client.status !== 'active') return 'client-inactive';
  const def = await getDefinition(job.tenantId, orgId, definitionId);
  if (!def || !def.schedule) return 'client-inactive';
  // A job left pinned to an older version (a failed re-arm) never runs the
  // definition as it is now under the old pin.
  if (job.inputs?.definitionVersion !== def.version) return 'dispatch-error';
  if (!getChainBackedWorkflow(CLIENT_REPORT_CHAIN_ID)) return 'workflow-unresolved';
  return null;
}
