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
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { registerJob, setJobEnabled, deleteJob, getJob } from '../../host/schedulingService.js';
import { registerSubjectEraser, type SubjectEraseReport } from '../../host/subjectErasure.js';
import { subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import { parseCron } from '../../host/cronSchedule.js';
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
/** Sentinel the erased actor is re-attributed to (mirrors memory-auto-extract's
 *  `grantService`; a schedchat row's key is scope-derived, never the actor, so this
 *  scrub updates in place without a re-key). */
const ERASED_SUBJECT = 'erased:subject';

const scopeSeg = (scope: ScheduledChatScope): string => ('orgId' in scope ? scope.orgId : `chan:${scope.channelId}`);
const keyOf = (tenantId: string, scope: ScheduledChatScope, chatId: string): string => `${tenantId}:${scopeSeg(scope)}:${chatId}`;
const matchesScope = (c: ScheduledChat, scope: ScheduledChatScope): boolean =>
  'orgId' in scope ? c.orgId === scope.orgId && !c.channelId : c.channelId === scope.channelId;

function req(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim().length === 0) throw new OpenwopError('validation_error', `\`${field}\` is required.`, 400, { field });
  return v.trim();
}

export interface ScheduledChatInput { agentId?: unknown; prompt?: unknown; conversationId?: unknown; cronExpr?: unknown; timezone?: unknown; workflowId?: unknown }

export async function createScheduledChat(tenantId: string, scope: ScheduledChatScope, actor: string, input: ScheduledChatInput): Promise<ScheduledChat> {
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
    ...(workflowId ? { workflowId } : {}),
    ...(chat.timezone ? { timezone: chat.timezone } : {}),
    // The agent-runner node reads `task` (the prompt) + `credentialRef`; the autonomous
    // tick has no user/BYOK, so it dispatches on the HOST-OWNED managed key. `prompt`
    // + `conversationId` are retained for the conversation-surfacing projection (2c/3).
    configurable: { agentId, task: prompt, prompt, conversationId, credentialRef: SCHEDULED_CHAT_CREDENTIAL_REF },
    metadata: { kind: 'scheduled-agent-chat', chatId: chat.chatId },
  });
  if (!reg.ok) {
    await chats.delete(keyOf(tenantId, scope, chat.chatId));
    throw new OpenwopError('validation_error', reg.error.message, 400, { code: reg.error.code });
  }
  return chat;
}

export async function listScheduledChats(tenantId: string, scope: ScheduledChatScope): Promise<ScheduledChat[]> {
  // SCHED-3 — a SCOPED prefix scan (`${tenant}:${orgId|chan:channelId}:`) instead of a
  // full cross-tenant `list()`. The key prefix IS the scope, so a channel-scope read
  // touches only that channel's rows (org rows carry no `chan:` segment → never match).
  const rows = await chats.listByPrefix(`${tenantId}:${scopeSeg(scope)}:`);
  return rows.filter((c) => matchesScope(c, scope)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** A scheduled chat + its live scheduler status (ADR 0125 Phase 3c). */
export interface ScheduledChatWithStatus extends ScheduledChat { nextRunAt?: string; lastRunAt?: string }

/** The list enriched with each job's next/last fire time (joined from the scheduler —
 *  the single owner of fire timing; no parallel schedule state). */
export async function listScheduledChatsWithStatus(tenantId: string, scope: ScheduledChatScope): Promise<ScheduledChatWithStatus[]> {
  const list = await listScheduledChats(tenantId, scope);
  return Promise.all(list.map(async (c) => {
    const job = await getJob(jobIdOf(c.chatId));
    return {
      ...c,
      ...(job?.nextFireAt != null ? { nextRunAt: new Date(job.nextFireAt).toISOString() } : {}),
      ...(job?.lastRunAt ? { lastRunAt: job.lastRunAt } : {}),
    };
  }));
}

export async function getScheduledChat(tenantId: string, scope: ScheduledChatScope, chatId: string): Promise<ScheduledChat | null> {
  return (await chats.get(keyOf(tenantId, scope, chatId))) ?? null;
}

async function mustGet(tenantId: string, scope: ScheduledChatScope, chatId: string): Promise<ScheduledChat> {
  const c = await getScheduledChat(tenantId, scope, chatId);
  if (!c) throw new OpenwopError('not_found', 'Scheduled chat not found.', 404, { chatId });
  return c;
}

export async function setScheduledChatEnabled(tenantId: string, scope: ScheduledChatScope, chatId: string, enabled: boolean): Promise<ScheduledChat> {
  const c = await mustGet(tenantId, scope, chatId);
  await setJobEnabled(jobIdOf(chatId), enabled);
  c.enabled = enabled;
  c.updatedAt = new Date().toISOString();
  await chats.put(c);
  return c;
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
    c.enabled = false;
    c.updatedAt = new Date().toISOString();
    await chats.put(c);
    paused += 1;
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
    await chats.put({ ...c, enabled: false, createdBy: ERASED_SUBJECT, updatedAt: new Date().toISOString() });
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
