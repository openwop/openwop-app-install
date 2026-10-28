/**
 * Recurring / scheduled agent chats (ADR 0125 Phase 1; ADR 0202 D3 — scope descriptor).
 *
 * A `ScheduledChat` config binds an agent + a cadence + a prompt to a conversation.
 * On create it registers ONE `ScheduledJob` on the EXISTING scheduler (ADR 0025 /
 * the RFC 0052 daemon) — no parallel scheduler. Pause flips the job's `enabled`;
 * delete deregisters it. The tick → chat-turn dispatch fires the built-in
 * turn-workflow (ADR 0125 Phase 2b) whose agent-runner posts the reply into the
 * bound `conversationId`.
 *
 * ADR 0202 D3 generalizes the org-only binding to a **scope descriptor** so a
 * channel (a conversation with membership but no org) can bind a scheduled post
 * through the SAME service + scheduler + workflow — never a parallel job. The
 * store key stays back-compatible: an org row keeps `${tenantId}:${orgId}:${chatId}`;
 * a channel row is namespaced `${tenantId}:chan:${channelId}:${chatId}`.
 *
 * @see docs/adr/0125-recurring-scheduled-agent-chats.md
 * @see docs/adr/0202-agent-native-channels.md (D3)
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection, hostExtStorage } from '../../host/hostExtPersistence.js';
import { onWorkflowForked } from '../../host/workflowsRegistry.js';
import { casRepoint } from '../../host/forkRepoint.js';
import { OpenwopError } from '../../types.js';
import { registerJob, setJobEnabled, deleteJob, getJob, updateJob, isErasedJob, ONE_SHOT_CRON, type ScheduledJob, type ScheduleSkipReason } from '../../host/schedulingService.js';
import { registerSubjectEraser, type SubjectEraseReport } from '../../host/subjectErasure.js';
import { subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import { parseCron, computeNextFire } from '../../host/cronSchedule.js';
import { getConversationMeta } from '../../host/conversationStore.js';
import { isVisibleToAsync } from '../../host/conversationVisibility.js';
import { registerScheduledJobReadGate } from '../../host/scheduledJobReadGates.js';
import { registerScheduledJobFireGate } from '../../host/scheduledJobFireGates.js';
import { authorizeRunConversationWrite } from '../../host/runConversationWrite.js';
import { hasWorkflowScope } from '../../host/workflowWriteAuthority.js';
import { resolveAgentForTenant } from '../../host/agentVisibility.js';
import { createLogger } from '../../observability/logger.js';
import { SCHEDULED_CHAT_TURN_WORKFLOW_ID, SCHEDULED_CHAT_CREDENTIAL_REF } from './scheduledChatTurnWorkflow.js';

/** The owner a scheduled chat is scoped + authorized under. Exactly one arm:
 *  an ORG (RBAC `workspace:write`) or a CHANNEL (membership-gated, ADR 0202 D3). */
export type ScheduledChatScope = { orgId: string } | { channelId: string };

export interface ScheduledChat {
  chatId: string;
  tenantId: string;
  /** Org scope (RBAC). Set iff the chat is org-scoped; mutually exclusive with `channelId`. */
  orgId?: string;
  /** Channel scope (membership-gated, ADR 0202 D3). Set iff channel-scoped. */
  channelId?: string;
  agentId: string;
  prompt: string;
  conversationId: string;
  cronExpr: string;
  /** The turn-workflow the tick fires with `configurable:{agentId,task,conversationId,...}`.
   *  Defaults to the built-in `openwop-app.scheduled-chat.turn` (ADR 0125 Phase 2b) so
   *  the chat fires out-of-the-box; an operator MAY override with a custom workflowId. */
  workflowId?: string;
  timezone?: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// The store key namespaces channel rows under `chan:` so they never collide with
// org rows; an org row's key is UNCHANGED from ADR 0125 (back-compat — no migration).
const chats = new DurableCollection<ScheduledChat>('schedchat:config', (c) =>
  c.channelId ? `${c.tenantId}:chan:${c.channelId}:${c.chatId}` : `${c.tenantId}:${c.orgId}:${c.chatId}`);
const jobIdOf = (chatId: string): string => `schedchat-${chatId}`;
/** The feature's toggle id (ADR 0820 §8.2). Stamped as `featureId` on every
 *  scheduler job this feature registers, so the daemon's per-tenant fire-time gate
 *  (ADR 0599 §6, `scheduleDaemon.ts`) skips its fires while the feature is refused —
 *  by the toggle OR the plan. Non-destructive: the row survives and resumes. */
export const SCHEDULED_AGENT_CHATS_TOGGLE = 'scheduled-agent-chats';
/** Sentinel the erased actor is re-attributed to (mirrors memory-auto-extract's
 *  `grantService`; a schedchat row's key is scope-derived, never the actor, so this
 *  scrub updates in place without a re-key). */
const ERASED_SUBJECT = 'erased:subject';
const log = createLogger('features.scheduled-agent-chats.service');

/** ADR 0985 D2 — the tightest cadence a scheduled chat may have: hourly, the
 *  product's offered cadences (hourly / daily / weekdays / weekly). Finer is an
 *  autonomous-cost runaway on the host's managed key. */
export const MIN_SCHEDULED_CHAT_INTERVAL_MS = 3_600_000;
export const CADENCE_TOO_FREQUENT_MESSAGE = 'Scheduled chats can run at most once an hour — use a coarser schedule (hourly, daily, weekly).';

/**
 * ADR 0985 D2 — the ONE cadence floor every door shares: create (org + channel),
 * the recurring chat tool, the scheduler route's PATCH and the fire gate. Walks
 * 25 adjacent fires (more than a day) so an intra-day cluster (`0,30 9 * * *`)
 * cannot hide behind a wide first gap. A one-shot or an unparseable cron is not
 * this function's question (`null`); the caller that needs a parse refuses that.
 */
export function cadenceRefusal(cronExpr: string, timezone: string | undefined, now: number): string | null {
  if (cronExpr === ONE_SHOT_CRON || parseCron(cronExpr) === null) return null;
  let prev = computeNextFire(cronExpr, now, timezone);
  if (prev === null) return null;
  for (let i = 0; i < 25; i++) {
    const next = computeNextFire(cronExpr, prev, timezone);
    if (next === null) break;
    if (next - prev < MIN_SCHEDULED_CHAT_INTERVAL_MS) return CADENCE_TOO_FREQUENT_MESSAGE;
    prev = next;
  }
  return null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/**
 * ADR 0985 D1 — asked by the scheduler BEFORE a scheduled chat's run starts (and
 * so before the model is paid), for every job this feature owns: `schedchat-*`,
 * and the chat tools' `recurring:*` / `followup:*`. The agent-runner still asks
 * the write gate at write time; this removes the spend, not that check.
 *  1. the cadence floor (D2);
 *  2. the person behind the job may still write in the workspace (the authority
 *     arming it took, ADR 0985 D6) — a creator who left stays "visible" to their own
 *     conversation, so (3) alone keeps firing; a member demoted to Viewer is
 *     skipped too, and restoring the role resumes it (grade-code SC2CD-5);
 *  3. the reply could land: `authorizeRunConversationWrite` on the inputs the
 *     write will use.
 * A refusal is a skip: non-destructive, recorded on the job, resumed by restoring access.
 */
export async function scheduledChatFireRefusal(job: ScheduledJob, now: number): Promise<ScheduleSkipReason | null> {
  if (cadenceRefusal(job.cronExpr, job.timezone, now) !== null) return 'cadence-too-frequent';
  const cfg = job.configurable ?? {};
  const conversationId = str(cfg['conversationId']);
  const agentId = str(cfg['agentId']) ?? job.agentId;
  const actingUserId = str(job.metadata?.['actingUserId']);
  const orgScopeSubject = str(job.metadata?.['orgScopeSubject']);
  const personalTenant = str(job.metadata?.['personalTenant']);
  const human = actingUserId ?? orgScopeSubject;
  if (human && !(await hasWorkflowScope({ tenantId: job.tenantId, actingUserId: human, personalTenant }, 'workspace:write'))) {
    log.info('scheduled_chat_fire_refused', { jobId: job.jobId, tenantId: job.tenantId, reason: 'person_not_member' });
    return 'target-refused';
  }
  if (!conversationId) {
    log.info('scheduled_chat_fire_refused', { jobId: job.jobId, tenantId: job.tenantId, reason: 'no_conversation' });
    return 'target-refused';
  }
  const verdict = await authorizeRunConversationWrite(hostExtStorage(), { tenantId: job.tenantId, conversationId, agentId, actingUserId, orgScopeSubject, personalTenant });
  if (verdict.ok) return null;
  log.info('scheduled_chat_fire_refused', { jobId: job.jobId, tenantId: job.tenantId, reason: verdict.reason });
  return 'target-refused';
}

registerScheduledJobFireGate('scheduled-agent-chats', {
  // `featureId` is server-stamped (the scheduler route never reads it from a body).
  owns: (job) => job.featureId === SCHEDULED_AGENT_CHATS_TOGGLE,
  gate: scheduledChatFireRefusal,
  refusal: 'dispatch-error',
  // ADR 0985 D3 — the feature owns its config-bound jobs: the generic route may only
  // disable them, so the page and the job cannot disagree. The chat tools' jobs are
  // NOT reserved: their owner manages them from the Profile Schedules tab too.
  reservedJobIdPrefix: 'schedchat-',
  managedBy: { id: 'scheduled-chat', message: 'This schedule is a scheduled chat. Pause, resume or delete it from the Scheduled chats page.' },
  cadenceRefusal,
});

const scopeSeg = (scope: ScheduledChatScope): string => ('orgId' in scope ? scope.orgId : `chan:${scope.channelId}`);
const keyOf = (tenantId: string, scope: ScheduledChatScope, chatId: string): string => `${tenantId}:${scopeSeg(scope)}:${chatId}`;
const matchesScope = (c: ScheduledChat, scope: ScheduledChatScope): boolean =>
  'orgId' in scope ? c.orgId === scope.orgId && !c.channelId : c.channelId === scope.channelId;

function req(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim().length === 0) throw new OpenwopError('validation_error', `\`${field}\` is required.`, 400, { field });
  return v.trim();
}

export interface ScheduledChatInput { agentId?: unknown; prompt?: unknown; conversationId?: unknown; cronExpr?: unknown; timezone?: unknown; workflowId?: unknown }

/** `firesFor` (ADR 0879 D7) — the creator in the SAME spelling the conversation
 *  gate compares (`req.userId ?? principalId`); defaults to `actor`. Never from the body. */
export async function createScheduledChat(tenantId: string, scope: ScheduledChatScope, actor: string, input: ScheduledChatInput, firesFor: string = actor, firesForPersonalTenant?: string): Promise<ScheduledChat> {
  const agentId = req(input.agentId, 'agentId');
  const prompt = req(input.prompt, 'prompt');
  const conversationId = req(input.conversationId, 'conversationId');
  const cronExpr = req(input.cronExpr, 'cronExpr');
  // ADR 0202 OQ-4 — reject a malformed cron up front. Without this, registerJob just
  // omits `nextFireAt` and the job is stored but NEVER fires — a silent dead schedule
  // (a 201 to the caller, a row the daemon skips). Fail closed with a clear error.
  if (parseCron(cronExpr) === null) {
    throw new OpenwopError('validation_error', 'Invalid schedule (cron expression could not be parsed).', 400, { field: 'cronExpr' });
  }
  // ADR 0985 D2 — the one cadence floor, at the moment the caller asks.
  const tooFrequent = cadenceRefusal(cronExpr, typeof input.timezone === 'string' ? input.timezone : undefined, Date.now());
  if (tooFrequent !== null) throw new OpenwopError('validation_error', tooFrequent, 400, { field: 'cronExpr', code: 'cadence_too_frequent' });
  // ADR 0125 Phase 2b — default to the built-in turn-workflow so the chat FIRES
  // out-of-the-box (an explicit operator workflowId still overrides). This supersedes
  // Phase 1's inert-until-wired stance now that the turn-workflow exists.
  const workflowId = typeof input.workflowId === 'string' && input.workflowId.trim().length > 0 ? input.workflowId.trim() : SCHEDULED_CHAT_TURN_WORKFLOW_ID;
  const now = new Date().toISOString();
  const chat: ScheduledChat = {
    chatId: randomUUID(), tenantId,
    ...('orgId' in scope ? { orgId: scope.orgId } : { channelId: scope.channelId }),
    agentId, prompt, conversationId, cronExpr,
    ...(workflowId ? { workflowId } : {}),
    ...(typeof input.timezone === 'string' ? { timezone: input.timezone } : {}),
    enabled: true, createdBy: actor, createdAt: now, updatedAt: now,
  };
  await chats.put(chat);
  // Bind ONE scheduler job. `workflowId` is always set now (defaulted above), so the
  // job is enabled and fires the turn-workflow each tick. Roll the config back if the
  // scheduler refuses (horizon).
  const reg = await registerJob({
    jobId: jobIdOf(chat.chatId), tenantId, cronExpr, agentId, enabled: true,
    featureId: SCHEDULED_AGENT_CHATS_TOGGLE, // ADR 0820 §8.2 — the daemon gates the fire
    ...(workflowId ? { workflowId } : {}),
    ...(chat.timezone ? { timezone: chat.timezone } : {}),
    // The agent-runner node reads `task` (the prompt) + `credentialRef`; the autonomous
    // tick has no user/BYOK, so it dispatches on the HOST-OWNED managed key. `prompt`
    // + `conversationId` are retained for the conversation-surfacing projection (2c/3).
    configurable: { agentId, task: prompt, prompt, conversationId, credentialRef: SCHEDULED_CHAT_CREDENTIAL_REF },
    // ADR 0879 D7 (architect C2) — the creator is the human this schedule fires for,
    // so a user-chosen `workflowId` that posts into a conversation is checked against
    // THEM at write time, not waved through as a system run.
    metadata: { kind: 'scheduled-agent-chat', chatId: chat.chatId, orgScopeSubject: firesFor, ...(firesForPersonalTenant ? { personalTenant: firesForPersonalTenant } : {}) },
  });
  if (!reg.ok) {
    await chats.delete(keyOf(tenantId, scope, chat.chatId));
    throw new OpenwopError('validation_error', reg.error.message, 400, { code: reg.error.code });
  }
  return chat;
}

/** ADR 0879 D7 (grade-code CH2CD-2) — a schedule created before ADR 0879 has no
 *  `orgScopeSubject` on its job, so its turn has no person behind it and the run-lane
 *  write gate refuses the reply. Stamp the recorded creator once, inside the job CAS
 *  (a job that already names one is untouched; an erased creator is never re-stamped).
 *  Idempotent; runs at feature boot. Returns how many jobs it stamped. */
export async function backfillScheduledChatSubjects(): Promise<number> {
  let stamped = 0;
  for (const chat of await chats.listByPrefix('')) {
    if (!chat.createdBy || chat.createdBy === ERASED_SUBJECT) continue;
    const next = await updateJob(jobIdOf(chat.chatId), (job) =>
      typeof job.metadata?.orgScopeSubject === 'string' ? null : { mergeMetadata: { orgScopeSubject: chat.createdBy } });
    if (next && next.metadata?.orgScopeSubject === chat.createdBy) stamped++;
  }
  return stamped;
}

export async function listScheduledChats(tenantId: string, scope: ScheduledChatScope): Promise<ScheduledChat[]> {
  // SCHED-3 — a SCOPED prefix scan (`${tenant}:${orgId|chan:channelId}:`) instead of a
  // full cross-tenant `list()`. The key prefix IS the scope, so a channel-scope read
  // touches only that channel's rows (org rows carry no `chan:` segment → never match).
  const rows = await chats.listByPrefix(`${tenantId}:${scopeSeg(scope)}:`);
  return rows.filter((c) => matchesScope(c, scope)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** A scheduled chat + its live scheduler status (ADR 0125 Phase 3c; ADR 0985 D4). */
export interface ScheduledChatWithStatus extends ScheduledChat {
  nextRunAt?: string;
  lastRunAt?: string;
  /** ADR 0879 D7 — the LAST fire failed (e.g. `conversation_write_refused`: the
   *  reply could not be posted). Shown to the owner so a schedule never fails
   *  silently. */
  lastError?: { code: string; message: string };
  /** ADR 0985 D4 — the latest slot was SKIPPED (no run) and nothing ran since. */
  lastSkip?: { reason: ScheduleSkipReason; at: string };
  /** ADR 0985 D4 — the scheduler job is gone (deleted by another door): nothing fires. */
  unscheduled?: true;
  /** ADR 0985 D4 — the agent's display name (its persona), else absent. */
  agentName?: string;
  /** A one-shot follow-up whose only slot is used: it will never fire again. */
  spent?: true;
}

/** ADR 0985 D4 — the status a schedule's JOB reports: the scheduler row is the one
 *  truth for whether, when and how it fires (the config keeps no copy that can drift). */
export async function jobStatus(tenantId: string, job: ScheduledJob | null, agentId: string): Promise<Pick<ScheduledChatWithStatus, 'enabled' | 'nextRunAt' | 'lastRunAt' | 'lastError' | 'lastSkip' | 'unscheduled' | 'agentName' | 'timezone' | 'spent'>> {
  const agent = await resolveAgentForTenant(agentId, tenantId).catch(() => null);
  const agentName = agent?.persona && agent.persona !== agentId ? { agentName: agent.persona } : {};
  if (!job) return { enabled: false, unscheduled: true, ...agentName };
  const lastRun = job.lastRunId ? await hostExtStorage().getRun(job.lastRunId).catch(() => null) : null;
  const lastError = lastRun && lastRun.tenantId === tenantId && lastRun.status === 'failed'
    ? { code: String(lastRun.error?.code ?? 'failed'), message: String(lastRun.error?.message ?? 'The last run failed.') }
    : undefined;
  // `no-next-fire` records that the cadence has no further slot, not a slot that did
  // not run (the Profile panel renders it as its own chip); a spent one-shot says so
  // through `spent` below.
  const skippedSinceRun = job.lastSkippedAt !== undefined && job.lastSkipReason !== undefined && job.lastSkipReason !== 'no-next-fire'
    && (job.lastRunAt === undefined || Date.parse(job.lastSkippedAt) > Date.parse(job.lastRunAt));
  return {
    enabled: job.enabled,
    ...(job.nextFireAt != null ? { nextRunAt: new Date(job.nextFireAt).toISOString() } : {}),
    ...(job.lastRunAt ? { lastRunAt: job.lastRunAt } : {}),
    ...(lastError ? { lastError } : {}),
    ...(skippedSinceRun ? { lastSkip: { reason: job.lastSkipReason!, at: job.lastSkippedAt! } } : {}),
    ...(job.timezone ? { timezone: job.timezone } : {}),
    // A one-shot whose only slot is used (it ran or was skipped) can never fire
    // again, though the row still says `enabled` (review M3).
    ...(job.cronExpr === ONE_SHOT_CRON && job.nextFireAt == null ? { spent: true as const } : {}),
    ...agentName,
  };
}

/** The list enriched with each job's live status (joined from the scheduler — the
 *  single owner of fire timing and of `enabled`; ADR 0985 D4). */
export async function listScheduledChatsWithStatus(tenantId: string, scope: ScheduledChatScope): Promise<ScheduledChatWithStatus[]> {
  const list = await listScheduledChats(tenantId, scope);
  return Promise.all(list.map(async (c) => ({ ...c, ...(await jobStatus(tenantId, await getJob(jobIdOf(c.chatId)), c.agentId)) })));
}

export async function getScheduledChat(tenantId: string, scope: ScheduledChatScope, chatId: string): Promise<ScheduledChat | null> {
  return (await chats.get(keyOf(tenantId, scope, chatId))) ?? null;
}

/** ADR 0846 D1 — may this caller SEE (and therefore read or manage) a scheduled chat?
 *  The schedule's prompt and its target are the conversation's business, so the gate is
 *  the conversation's own read predicate — the one CREATE checks before binding. The
 *  caller is `req.userId ?? principalId`, the spelling the chat routes hand this same
 *  predicate (`routes/chatSessions.ts` `actingUserOf`) and the one `ownerUserId` is
 *  stamped in; the canonical `resolveCallerUser` id is a different key on a
 *  personal-tenant bearer lane and would hide an owner's own schedules. */
export async function canSeeScheduledChat(tenantId: string, chat: Pick<ScheduledChat, 'conversationId'>, actingUser: string | undefined): Promise<boolean> {
  return isVisibleToAsync(await getConversationMeta(tenantId, chat.conversationId), tenantId, actingUser);
}

// ADR 0846 D1b — the generic scheduler routes reach this feature's job too (it
// carries `metadata.kind` and the conversation in `configurable`); hold them to
// the same predicate, or they list, pause, delete and fire what the feature's own
// routes refuse.
registerScheduledJobReadGate('scheduled-agent-chat', async (job, actingUser) => {
  const conversationId = job.configurable?.['conversationId'];
  return canSeeScheduledChat(job.tenantId, { conversationId: typeof conversationId === 'string' ? conversationId : '' }, actingUser);
});

async function mustGet(tenantId: string, scope: ScheduledChatScope, chatId: string): Promise<ScheduledChat> {
  const c = await getScheduledChat(tenantId, scope, chatId);
  if (!c) throw new OpenwopError('not_found', 'Scheduled chat not found.', 404, { chatId });
  return c;
}

/**
 * Pause (`false`) or resume (`true`). ADR 0985 D5 — the config row goes through a
 * compare-and-swap FIRST, with the erased-creator check inside it, and only then is
 * the job flipped: flipping the job first armed it before a concurrent erasure
 * could be seen. A resume is refused for an erased creator (nobody to post for)
 * and for a row whose job is gone (it would arm nothing). The host refuses to
 * re-enable an erased job at the job too (`isErasedJob`).
 */
/** ADR 0985 (grade-code SC2CD-6) — every writer of a config row re-reads it inside a
 *  compare-and-swap, so a stale copy can never write back what a concurrent writer
 *  (the subject eraser) removed. `rewrite` returns the next row, or `null` to stop. */
async function casChat(key: string, rewrite: (row: ScheduledChat) => ScheduledChat | null): Promise<ScheduledChat | null> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await chats.get(key);
    if (!current) return null;
    const next = rewrite(current);
    if (!next) return null;
    if (await chats.compareAndSwap(current, next)) return next;
  }
  throw new OpenwopError('conflict', 'The scheduled chat changed while it was being updated — try again.', 409, { code: 'write_contention' });
}
const keyOfRow = (c: ScheduledChat): string => (c.channelId ? `${c.tenantId}:chan:${c.channelId}:${c.chatId}` : `${c.tenantId}:${c.orgId}:${c.chatId}`);

const creatorErased = (chatId: string): OpenwopError => new OpenwopError('conflict',
  'The person who created this scheduled chat was removed, so it has nobody to post for — delete it and create a new one.', 409, { chatId, code: 'creator_erased' });

export async function setScheduledChatEnabled(tenantId: string, scope: ScheduledChatScope, chatId: string, enabled: boolean): Promise<ScheduledChat> {
  await mustGet(tenantId, scope, chatId);
  const job = enabled ? await getJob(jobIdOf(chatId)) : null;
  if (enabled && !job) {
    throw new OpenwopError('conflict', 'This scheduled chat is no longer scheduled — delete it and create it again.', 409, { chatId, code: 'unscheduled' });
  }
  if (job && isErasedJob(job)) throw creatorErased(chatId);
  const next = await casChat(keyOf(tenantId, scope, chatId), (current) => {
    if (enabled && current.createdBy === ERASED_SUBJECT) throw creatorErased(chatId);
    return { ...current, enabled, updatedAt: new Date().toISOString() };
  });
  if (!next) throw new OpenwopError('not_found', 'Scheduled chat not found.', 404, { chatId });
  await setJobEnabled(jobIdOf(chatId), enabled);
  return next;
}

/**
 * ADR 0288 roster-lifecycle consumer (grade-data AGT-1) — DISABLE (never delete)
 * every scheduled chat bound to a deleted roster member, across all scopes: the
 * authored prompt/cadence survives visibly paused (its scheduler job disabled)
 * and re-assigning an agent is a resume. Configs may store either id form, so
 * both are matched. Idempotent; bounded tenant-prefixed scan.
 */
export async function pauseScheduledChatsForDeletedAgent(tenantId: string, ids: { rosterId: string; agentId?: string }): Promise<number> {
  let paused = 0;
  for (const c of await chats.listByPrefix(`${tenantId}:`)) {
    if (!c.enabled) continue;
    if (c.agentId !== ids.rosterId && c.agentId !== ids.agentId) continue;
    await setJobEnabled(jobIdOf(c.chatId), false);
    if (await casChat(keyOfRow(c), (row) => (row.enabled ? { ...row, enabled: false, updatedAt: new Date().toISOString() } : null))) paused += 1;
  }
  return paused;
}

/**
 * SCC-1 (grade-code, ordinal 207) — subject-erasure eraser for scheduled agent chats.
 * A scheduled chat is authored by a person (`createdBy`) and runs on their behalf, so
 * on that subject's erasure we DISABLE the schedule (and its firing job) and scrub the
 * actor to a sentinel — never hard-delete, so the authored prompt/cadence survives
 * visibly paused (mirrors `pauseScheduledChatsForDeletedAgent` + memory-auto-extract's
 * actor branch; the recorded ADR decision is "erasure disables, not deletes",
 * `subject-erasure-feature-stores.test.ts`). This eraser owns ONLY the
 * config-created `schedchat-*` job (which carries no `ownerSubject`, so no other eraser
 * touches it). The feature's agent-tool jobs (`followup:`/`recurring:`) carry
 * `ownerSubject:{user}` and their OWNER-attribution is disabled + anonymized by the host
 * `eraseSubjectSchedules` — but NOTE (SCC-4, pre-existing HOST gap, NOT closed here):
 * that host eraser scrubs only `ownerSubject`/`ownerUserId`, never `metadata`, so those
 * jobs' `metadata.actingUserId` (a raw user id) survives DSAR. Fixing that is a one-line
 * change in `host/schedulingService.ts` `eraseSubjectSchedules`, filed as SCC-4 — this
 * feature-level eraser cannot reach a host store. Named (manifest-checked, WF-CONS-2),
 * idempotent, bounded tenant-prefixed scan; invoked once per linked subject-key.
 */
export async function eraseScheduledChatsSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  let rowsTouched = 0;
  if (!tenantId || !subjectKey) return { rowsTouched };
  const { forms } = subjectKeyForms(subjectKey);
  for (const c of await chats.listByPrefix(`${tenantId}:`)) {
    if (c.tenantId !== tenantId) continue;      // defensive: a foreign-tenant prefix collision
    if (!forms.has(c.createdBy)) continue;      // only rows this subject authored
    await setJobEnabled(jobIdOf(c.chatId), false);   // stop it firing (idempotent)
    await casChat(keyOfRow(c), (row) => (forms.has(row.createdBy) ? { ...row, enabled: false, createdBy: ERASED_SUBJECT, updatedAt: new Date().toISOString() } : null));
    rowsTouched += 1;
  }
  return { rowsTouched };
}
registerSubjectEraser(eraseScheduledChatsSubject);

export async function deleteScheduledChat(tenantId: string, scope: ScheduledChatScope, chatId: string): Promise<void> {
  await mustGet(tenantId, scope, chatId);
  await deleteJob(jobIdOf(chatId));
  await chats.delete(keyOf(tenantId, scope, chatId));
}

/** ADR 0202 OQ-3 — delete every schedule a given agent has in a channel (invoked when
 *  the agent is removed from that channel, so its posts stop firing instead of running
 *  on forever). Composes the existing list + delete; returns how many were removed. */
export async function deleteScheduledChatsForAgent(tenantId: string, channelId: string, agentId: string): Promise<number> {
  const scope: ScheduledChatScope = { channelId };
  const matches = (await listScheduledChats(tenantId, scope)).filter((c) => c.agentId === agentId);
  let removed = 0;
  for (const c of matches) {
    // Drop the FIRING job FIRST (idempotent): the tick fires purely from the job, never
    // the config, so if the config delete below fails the leftover is a harmless
    // config-with-no-job that reconcile-on-read re-reaps — NOT a job-with-no-config that
    // would fire forever and is invisible to the (config-only) reconcile path.
    await deleteJob(jobIdOf(c.chatId));
    // SCHED-4 — count the ACTUAL config deletion via `chats.delete`'s boolean, so a
    // broadcast double-delivery / concurrent FE delete can't inflate the count: only the
    // racer that truly removed the row counts it; a loser sees `false` and skips.
    if (await chats.delete(keyOf(tenantId, scope, c.chatId))) removed++;
  }
  return removed;
}

// ADR 0789 — a scheduled chat whose turn-workflow override is a SHARED workflow
// follows this tenant's fork. Its scheduler job (`schedchat-<chatId>`) carries the
// same id and is re-pointed by the scheduler's own hook.
onWorkflowForked('schedchat:config', async (tenantId, from, to) => {
  let n = 0;
  for (const c of await chats.listByPrefix(`${tenantId}:`)) {
    if (c.workflowId !== from) continue;
    const key = c.channelId ? `${c.tenantId}:chan:${c.channelId}:${c.chatId}` : `${c.tenantId}:${c.orgId}:${c.chatId}`;
    if (await casRepoint(chats, key, (r) => (r.workflowId === from && r.tenantId === tenantId ? { ...r, workflowId: to } : null))) n += 1;
  }
  return n;
});
