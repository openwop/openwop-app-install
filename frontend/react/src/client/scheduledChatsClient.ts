/**
 * ADR 0125 Phase 3a — scheduled-agent-chats FE client. The data layer for the
 * scheduled-chats admin OVERSIGHT panel: list / pause-resume / delete recurring agent
 * chats. Org-scoped. Creation is chat-first (the `openwop:tasks.schedule-recurring`
 * agent tool, chat-first-port A3) — the admin page is management-only, so there is no
 * create client here.
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
    throw new Error(`${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`);
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
