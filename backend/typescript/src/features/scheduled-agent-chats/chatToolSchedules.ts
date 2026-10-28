/**
 * ADR 0985 D6 — the schedules a person created FROM CHAT (the
 * `openwop:tasks.schedule-recurring` / `schedule-followup` tools), listed and managed
 * by this feature beside the workspace's config-bound schedules.
 *
 * They are scheduler rows owned by the person (no config row), so the Scheduled
 * chats page never showed them, and the Profile Schedules tab (`?owner=me`) reads
 * only the personal tenant, so one created in a shared workspace appeared in no UI.
 *
 * Whose rows: in the ACTIVE tenant only `callerSubject(req)` — the exact spelling the
 * tools stamp as `scope.actingUserId`. Principal ids carry no issuer, so the extra
 * spellings of `callerOwnerSpellings` are matched in the PERSONAL tenant only, as its
 * own contract says (architect H1). Ownership is the read predicate, the one
 * `?owner=me` uses: these are the person's own instructions.
 */
import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import { deleteJob, getJob, isPausedForRemovedMember, listJobsForSubject, setJobEnabled, type ScheduledJob } from '../../host/schedulingService.js';
import { callerSubject, isDurableCaller, isPersonalTenantId, personalTenantOf } from '../../host/requestSubject.js';
import { keyDeclarationPermits } from '../../host/protocolAuthorization.js';
import { hasWorkflowScope } from '../../host/workflowWriteAuthority.js';
import { callerOwnerSpellings } from '../featureRoute.js';
import { jobStatus, SCHEDULED_AGENT_CHATS_TOGGLE, type ScheduledChatWithStatus } from './scheduledChatService.js';

export interface ChatToolSchedule extends Pick<ScheduledChatWithStatus, 'enabled' | 'nextRunAt' | 'lastRunAt' | 'lastError' | 'lastSkip' | 'unscheduled' | 'agentName' | 'timezone' | 'spent'> {
  jobId: string;
  kind: 'recurring' | 'followup';
  agentId: string;
  prompt: string;
  conversationId: string;
  cronExpr: string;
  /** ADR 0815 D4 — paused because its person left the workspace. Terminal for a
   *  feature job (architect M1): delete it and ask again in chat. */
  pausedReason?: 'acting_member_removed';
}

/** The tools mint `recurring:` / `followup:` ids (server-side, content-hashed), and
 *  `featureId` is server-stamped; neither is client-writable, unlike `metadata`. */
const isFollowup = (job: ScheduledJob): boolean => job.jobId.startsWith('followup:');
function isChatToolJob(job: ScheduledJob): boolean {
  return job.featureId === SCHEDULED_AGENT_CHATS_TOGGLE && (job.jobId.startsWith('recurring:') || isFollowup(job));
}

/** A follow-up that RAN is done and leaves the list; one whose only slot was
 *  skipped stays, with its skip, so the miss is visible (architect M3). */
function stillRelevant(job: ScheduledJob): boolean {
  if (!isFollowup(job)) return true;
  return job.nextFireAt != null || (job.lastRunAt === undefined && job.lastSkippedAt !== undefined);
}

/** The (tenant, spellings) pairs this caller owns schedules under. */
async function ownerScopes(req: Request): Promise<Array<[string, string[]]>> {
  const subject = callerSubject(req);
  if (!subject || !isDurableCaller(req)) return [];
  const active = (req as { tenantId?: string }).tenantId;
  const personal = personalTenantOf(req);
  const asks: Array<[string, string[]]> = [];
  if (active) asks.push([active, [subject]]);
  if (isPersonalTenantId(personal)) asks.push([personal, [...new Set(await callerOwnerSpellings(req))]]);
  return asks;
}

const ownedUnder = (job: ScheduledJob, scopes: Array<[string, string[]]>): boolean =>
  job.ownerSubject?.kind === 'user' && scopes.some(([tenantId, ids]) => job.tenantId === tenantId && ids.includes(job.ownerSubject!.id));

async function myChatToolJobs(req: Request): Promise<ScheduledJob[]> {
  const seen = new Map<string, ScheduledJob>();
  for (const [tenantId, spellings] of await ownerScopes(req)) {
    for (const id of spellings) {
      for (const job of await listJobsForSubject(tenantId, { kind: 'user', id })) {
        if (isChatToolJob(job) && stillRelevant(job)) seen.set(job.jobId, job);
      }
    }
  }
  return [...seen.values()].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
}

async function project(job: ScheduledJob): Promise<ChatToolSchedule> {
  const cfg = job.configurable ?? {};
  const agentId = typeof cfg['agentId'] === 'string' ? cfg['agentId'] : (job.agentId ?? '');
  return {
    jobId: job.jobId,
    kind: isFollowup(job) ? 'followup' : 'recurring',
    agentId,
    prompt: typeof cfg['task'] === 'string' ? cfg['task'] : '',
    conversationId: typeof cfg['conversationId'] === 'string' ? cfg['conversationId'] : '',
    cronExpr: job.cronExpr,
    ...(await jobStatus(job.tenantId, job, agentId)),
    ...(isPausedForRemovedMember(job) ? { pausedReason: 'acting_member_removed' as const } : {}),
  };
}

export async function listMyChatSchedules(req: Request): Promise<ChatToolSchedule[]> {
  return Promise.all((await myChatToolJobs(req)).map(project));
}

/** The caller's own chat schedule, else the same 404 as a missing one (no existence
 *  oracle). A narrowed `owk_` key that did not declare `workspace:write` changes
 *  nothing (architect L7). */
async function myJob(req: Request, jobId: string): Promise<ScheduledJob> {
  // One point read, then the same ownership rule the list applies (grade-code SC2CD-10).
  const job = await getJob(jobId);
  if (!job || !isChatToolJob(job) || !ownedUnder(job, await ownerScopes(req))) throw new OpenwopError('not_found', 'Scheduled chat not found.', 404, { jobId });
  const auth = req.principal?.auth;
  if (auth?.kind === 'api-key' && !keyDeclarationPermits(auth.scopes, 'workspace:write')) {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write' });
  }
  return job;
}

/** Pause (always the owner's to do: it only removes authority) or resume (re-arms
 *  standing work, so it needs `workspace:write` in the job's workspace). */
export async function setMyChatScheduleEnabled(req: Request, jobId: string, enabled: boolean): Promise<ChatToolSchedule> {
  const job = await myJob(req, jobId);
  if (enabled) {
    if (isPausedForRemovedMember(job)) {
      throw new OpenwopError('conflict', 'This schedule was paused when you left the workspace and cannot be resumed — delete it and ask again in chat.', 409, { jobId, code: 'acting_member_removed' });
    }
    const personalTenant = personalTenantOf(req);
    if (!(await hasWorkflowScope({ tenantId: job.tenantId, actingUserId: callerSubject(req), personalTenant }, 'workspace:write'))) {
      throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write' });
    }
  }
  await setJobEnabled(jobId, enabled);
  const updated = await getJob(jobId);
  if (!updated) throw new OpenwopError('not_found', 'Scheduled chat not found.', 404, { jobId });
  return project(updated);
}

export async function deleteMyChatSchedule(req: Request, jobId: string): Promise<void> {
  await myJob(req, jobId);
  await deleteJob(jobId);
}
