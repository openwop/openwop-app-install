/**
 * ADR 0856 D2 — the team ledger's tool policy, applied to its project's chats:
 * the project's group chat (owner subject) and every channel bound to it. A
 * forbidden tool is DISABLED; a require-approval tool suspends for a person.
 * The binding keeps applying when the project turns private (P0 finding 3:
 * narrowing must not silently lapse).
 */
import type { ConversationCapabilityScope, ConversationMeta } from '../../host/conversationStore.js';
import { getLedger } from './ledgerStore.js';

export async function teamLedgerScopeContributor(tenantId: string, meta: ConversationMeta): Promise<ConversationCapabilityScope | undefined> {
  const projectId = meta.ownerSubject?.kind === 'project' ? meta.ownerSubject.id : meta.channel?.boundProjectId;
  if (!projectId) return undefined;
  const p = (await getLedger(tenantId, projectId))?.toolPolicy;
  if (!p || (p.forbidden.length === 0 && p.requireApproval.length === 0)) return undefined;
  return {
    mode: 'restricted',
    ...(p.forbidden.length ? { disabled: p.forbidden } : {}),
    ...(p.requireApproval.length ? { requireApproval: p.requireApproval } : {}),
  };
}
