/**
 * The conversations a project's work is discussed in — its group chat and every
 * channel bound to it (ADR 0852 D5) — and the one way host code posts a short
 * SYSTEM notice into them (ADR 0854 handoff cards, ADR 0855 re-sync
 * checkpoints). Only into conversations that already exist: nothing is created
 * to hold a notice.
 */
import { randomUUID } from 'node:crypto';
import { hostExtStorage } from './hostExtPersistence.js';
import { listConversationMetas, subjectConversationId } from './conversationStore.js';
import { publishChatMessageAppended } from './chatMessageBus.js';
import type { ChatMessageRecord } from '../types.js';

export async function projectConversations(tenantId: string, projectId: string): Promise<string[]> {
  const chat = subjectConversationId(tenantId, { kind: 'project', id: projectId });
  const out = new Set<string>();
  for (const m of await listConversationMetas(tenantId)) {
    if (m.conversationId === chat) out.add(chat);
    else if (m.type === 'channel' && !m.channel?.archived && m.channel?.boundProjectId === projectId) out.add(m.conversationId);
  }
  return [...out];
}

export async function postSystemNotice(tenantId: string, conversationId: string, content: string, meta: Record<string, unknown>): Promise<void> {
  const session = await hostExtStorage().getChatSession(tenantId, conversationId);
  if (!session) return;
  const record: ChatMessageRecord = {
    messageId: randomUUID(), sessionId: conversationId, role: 'system', content,
    meta: JSON.stringify(meta), authorSubject: null, createdAt: new Date().toISOString(),
  };
  await hostExtStorage().appendChatMessage(record);
  await hostExtStorage().updateChatSession(tenantId, conversationId, { messageCount: session.messageCount + 1, updatedAt: new Date().toISOString() });
  publishChatMessageAppended(record, tenantId);
}

/** Post one notice into every conversation of the project. */
export async function postProjectNotice(tenantId: string, projectId: string, content: string, meta: Record<string, unknown>): Promise<number> {
  const convs = await projectConversations(tenantId, projectId);
  for (const c of convs) await postSystemNotice(tenantId, c, content, meta);
  return convs.length;
}
