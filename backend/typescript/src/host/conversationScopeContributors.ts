/**
 * ADR 0856 D2 — the seam a feature uses to NARROW the tools agents may use in a
 * conversation (a team ledger's tool policy for its project's chats), without
 * core importing the feature.
 *
 * Narrow-only BY CONSTRUCTION: the one gate (`resolveConversationToolGate`)
 * folds every contribution with `intersectScopes`, which cannot widen (enabled
 * only intersects; disabled and requireApproval only union). A contributor that
 * throws contributes nothing — the gate is not failed by it — and that is safe
 * only because nothing here can grant a tool.
 */
import { createLogger } from '../observability/logger.js';
import type { ConversationCapabilityScope, ConversationMeta } from './conversationStore.js';

const log = createLogger('host.conversationScopeContributors');

export type ConversationScopeContributor = (tenantId: string, meta: ConversationMeta) => Promise<ConversationCapabilityScope | undefined>;
const contributors: Array<{ id: string; fn: ConversationScopeContributor }> = [];

export function registerConversationScopeContributor(id: string, fn: ConversationScopeContributor): void {
  if (contributors.some((c) => c.id === id)) return;
  contributors.push({ id, fn });
}

export async function collectConversationScopes(tenantId: string, meta: ConversationMeta): Promise<ConversationCapabilityScope[]> {
  const out: ConversationCapabilityScope[] = [];
  for (const c of contributors) {
    try {
      const s = await c.fn(tenantId, meta);
      if (s) out.push(s);
    } catch (err) {
      log.warn('conversation_scope_contributor_failed', { id: c.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
