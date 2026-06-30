/**
 * ADR 0125 Phase 3a — scheduled-agent-chats FE client. The data layer for the
 * scheduled-chats admin panel: list/create/delete recurring agent chats. Org-scoped.
 * A chat fires only when a turn-workflow is wired (ADR 0125 Phase 2).
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
  return (await http<{ orgs: Org[] }>('/v1/host/openwop-app/orgs')).orgs ?? [];
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

const BASE = (orgId: string): string => `/v1/host/openwop-app/scheduled-chats/orgs/${encodeURIComponent(orgId)}/chats`;

export async function listScheduledChats(orgId: string): Promise<ScheduledChat[]> {
  return (await http<{ chats: ScheduledChat[] }>(BASE(orgId))).chats ?? [];
}

export async function createScheduledChat(orgId: string, input: { agentId: string; prompt: string; conversationId: string; cronExpr: string; workflowId?: string }): Promise<ScheduledChat> {
  return (await http<{ chat: ScheduledChat }>(BASE(orgId), { method: 'POST', body: JSON.stringify(input) })).chat;
}

export async function deleteScheduledChat(orgId: string, chatId: string): Promise<void> {
  await http<{ ok: boolean }>(`${BASE(orgId)}/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
}
