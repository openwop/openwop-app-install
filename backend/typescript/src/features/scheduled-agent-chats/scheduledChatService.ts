/**
 * Recurring / scheduled agent chats (ADR 0125 Phase 1).
 *
 * A `ScheduledChat` config binds an agent + a cadence + a prompt to a conversation.
 * On create it registers ONE `ScheduledJob` on the EXISTING scheduler (ADR 0025 /
 * the RFC 0052 daemon) — no parallel scheduler. Pause flips the job's `enabled`;
 * delete deregisters it. The tick → chat-turn dispatch is Phase 2; this phase owns
 * the config + the scheduler binding only.
 *
 * @see docs/adr/0125-recurring-scheduled-agent-chats.md
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { registerJob, setJobEnabled, deleteJob, getJob } from '../../host/schedulingService.js';
import { SCHEDULED_CHAT_TURN_WORKFLOW_ID, SCHEDULED_CHAT_CREDENTIAL_REF } from './scheduledChatTurnWorkflow.js';

export interface ScheduledChat {
  chatId: string;
  tenantId: string;
  orgId: string;
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

const chats = new DurableCollection<ScheduledChat>('schedchat:config', (c) => `${c.tenantId}:${c.orgId}:${c.chatId}`);
const jobIdOf = (chatId: string): string => `schedchat-${chatId}`;

function req(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim().length === 0) throw new OpenwopError('validation_error', `\`${field}\` is required.`, 400, { field });
  return v.trim();
}

export interface ScheduledChatInput { agentId?: unknown; prompt?: unknown; conversationId?: unknown; cronExpr?: unknown; timezone?: unknown; workflowId?: unknown }

export async function createScheduledChat(tenantId: string, orgId: string, actor: string, input: ScheduledChatInput): Promise<ScheduledChat> {
  const agentId = req(input.agentId, 'agentId');
  const prompt = req(input.prompt, 'prompt');
  const conversationId = req(input.conversationId, 'conversationId');
  const cronExpr = req(input.cronExpr, 'cronExpr');
  // ADR 0125 Phase 2b — default to the built-in turn-workflow so the chat FIRES
  // out-of-the-box (an explicit operator workflowId still overrides). This supersedes
  // Phase 1's inert-until-wired stance now that the turn-workflow exists.
  const workflowId = typeof input.workflowId === 'string' && input.workflowId.trim().length > 0 ? input.workflowId.trim() : SCHEDULED_CHAT_TURN_WORKFLOW_ID;
  const now = new Date().toISOString();
  const chat: ScheduledChat = {
    chatId: randomUUID(), tenantId, orgId, agentId, prompt, conversationId, cronExpr,
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
    await chats.delete(`${tenantId}:${orgId}:${chat.chatId}`);
    throw new OpenwopError('validation_error', reg.error.message, 400, { code: reg.error.code });
  }
  return chat;
}

export async function listScheduledChats(tenantId: string, orgId: string): Promise<ScheduledChat[]> {
  return (await chats.list()).filter((c) => c.tenantId === tenantId && c.orgId === orgId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** A scheduled chat + its live scheduler status (ADR 0125 Phase 3c). */
export interface ScheduledChatWithStatus extends ScheduledChat { nextRunAt?: string; lastRunAt?: string }

/** The list enriched with each job's next/last fire time (joined from the scheduler —
 *  the single owner of fire timing; no parallel schedule state). */
export async function listScheduledChatsWithStatus(tenantId: string, orgId: string): Promise<ScheduledChatWithStatus[]> {
  const list = await listScheduledChats(tenantId, orgId);
  return Promise.all(list.map(async (c) => {
    const job = await getJob(jobIdOf(c.chatId));
    return {
      ...c,
      ...(job?.nextFireAt != null ? { nextRunAt: new Date(job.nextFireAt).toISOString() } : {}),
      ...(job?.lastRunAt ? { lastRunAt: job.lastRunAt } : {}),
    };
  }));
}

export async function getScheduledChat(tenantId: string, orgId: string, chatId: string): Promise<ScheduledChat | null> {
  return (await chats.get(`${tenantId}:${orgId}:${chatId}`)) ?? null;
}

async function mustGet(tenantId: string, orgId: string, chatId: string): Promise<ScheduledChat> {
  const c = await getScheduledChat(tenantId, orgId, chatId);
  if (!c) throw new OpenwopError('not_found', 'Scheduled chat not found.', 404, { chatId });
  return c;
}

export async function setScheduledChatEnabled(tenantId: string, orgId: string, chatId: string, enabled: boolean): Promise<ScheduledChat> {
  const c = await mustGet(tenantId, orgId, chatId);
  await setJobEnabled(jobIdOf(chatId), enabled);
  c.enabled = enabled;
  c.updatedAt = new Date().toISOString();
  await chats.put(c);
  return c;
}

export async function deleteScheduledChat(tenantId: string, orgId: string, chatId: string): Promise<void> {
  await mustGet(tenantId, orgId, chatId);
  await deleteJob(jobIdOf(chatId));
  await chats.delete(`${tenantId}:${orgId}:${chatId}`);
}
