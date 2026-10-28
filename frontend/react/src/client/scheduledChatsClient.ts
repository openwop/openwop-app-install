/**
 * ADR 0125 Phase 3a — scheduled-agent-chats FE client. The data layer for the
 * Scheduled chats page: list / pause-resume / delete. Two lists (ADR 0985 D6): the
 * workspace's org-scoped schedules, and the caller's own schedules created FROM CHAT
 * (`/mine`). Creation is chat-first (the `openwop:tasks.schedule-recurring` agent
 * tool, chat-first-port A3) — the page is management-only, so there is no create
 * client here.
 */
import { authedHeaders, config, fetchOpts } from './config.js';

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...fetchOpts(init),
    headers: { ...(init.headers ?? {}), ...authedHeaders({ 'content-type': 'application/json' }) },
  });
  if (res.status === 204) return { ok: true } as T;
  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = body as { error?: string; message?: string };
    // `status` + `body` let `writeErrorMessage` show the server's own sentence for a
    // refusal it explained (a 409 `creator_erased`, a 403) instead of one generic toast.
    throw Object.assign(new Error(`${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`), { status: res.status, body });
  }
  return body as T;
}

export interface Org { orgId: string; name: string }

export async function listOrgs(): Promise<Org[]> {
  return (await http<{ orgs: Org[] }>('/host/openwop-app/orgs')).orgs ?? [];
}

export interface ScheduledChat {
  chatId: string;
  agentId: string;
  prompt: string;
  conversationId: string;
  cronExpr: string;
  workflowId?: string;
  enabled: boolean;
  /** ADR 0125 Phase 3c — the scheduler's next/last fire time (ISO). */
  nextRunAt?: string;
  lastRunAt?: string;
  /** ADR 0879 D7 — the last fire failed; `conversation_write_refused` = its reply
   *  could not be posted (the owner must see why, not a silent drop). */
  lastError?: { code: string; message: string };
  /** ADR 0985 D4 — the latest slot was skipped (no run) and nothing ran since.
   *  A wire string, so a newer reason still renders. */
  lastSkip?: { reason: string; at: string };
  /** ADR 0985 D4 — its scheduler job is gone: nothing fires. */
  unscheduled?: true;
  /** ADR 0985 D4 — the agent's display name, when it has one. */
  agentName?: string;
  timezone?: string;
  /** A one-shot whose only slot is used: it will never fire again. */
  spent?: true;
  /** Who created it; `erased:subject` once that person was erased (D5: not resumable). */
  createdBy?: string;
}

/** ADR 0985 D6 — a schedule the caller created from chat (a recurring chat or a
 *  one-off follow-up), owned by them rather than by an org. */
export interface ChatSchedule extends Omit<ScheduledChat, 'chatId' | 'workflowId'> {
  jobId: string;
  kind: 'recurring' | 'followup';
  /** ADR 0815 D4 — paused when its person left the workspace; terminal. */
  pausedReason?: 'acting_member_removed';
}

const MINE = '/host/openwop-app/scheduled-chats/mine';

export async function listMyChatSchedules(): Promise<ChatSchedule[]> {
  return (await http<{ schedules: ChatSchedule[] }>(MINE)).schedules ?? [];
}

export async function setMyChatScheduleEnabled(jobId: string, enabled: boolean): Promise<ChatSchedule> {
  return (await http<{ schedule: ChatSchedule }>(`${MINE}/${encodeURIComponent(jobId)}/pause`, { method: 'POST', body: JSON.stringify({ enabled }) })).schedule;
}

export async function deleteMyChatSchedule(jobId: string): Promise<void> {
  await http<{ ok: boolean }>(`${MINE}/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
}

const BASE = (orgId: string): string => `/host/openwop-app/scheduled-chats/orgs/${encodeURIComponent(orgId)}/chats`;

export async function listScheduledChats(orgId: string): Promise<ScheduledChat[]> {
  return (await http<{ chats: ScheduledChat[] }>(BASE(orgId))).chats ?? [];
}

/** Pause (`enabled:false`) or resume (`enabled:true`) a scheduled chat — the row
 *  survives, its scheduler job's `enabled` flips (mirrors the backend pause route). */
export async function setScheduledChatEnabled(orgId: string, chatId: string, enabled: boolean): Promise<ScheduledChat> {
  return (await http<{ chat: ScheduledChat }>(`${BASE(orgId)}/${encodeURIComponent(chatId)}/pause`, { method: 'POST', body: JSON.stringify({ enabled }) })).chat;
}

export async function deleteScheduledChat(orgId: string, chatId: string): Promise<void> {
  await http<{ ok: boolean }>(`${BASE(orgId)}/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
}
