/**
 * ADR 0119 Phase 4b — conversation IMPORT write.
 *
 * Composes the Phase-4a parsers' normalized `{ title, turns }` into a NEW
 * conversation: a fresh chat session + an owned `ConversationMeta`, then each turn
 * appended. Idempotency-keyed by the caller; payload caps applied.
 *
 * PROVENANCE, NOT A FENCE (CORRECTED — ADR 0698 D1). Each imported message carries
 * `meta: {contentTrust:'untrusted', source:'import'}`. This used to be described as
 * the reason "a hostile import is fenced as untrusted on recall/render, never
 * silently trusted". **That was false: NOTHING reads a chat message's
 * `meta.contentTrust`.** Every consumer in the tree is in the RFC 0021
 * envelope/run-event path (`envelopeAcceptor`, `envelopeProjection`,
 * `promptInjectionGuard`, `promptCompose`) or the KB-chunk path
 * (`agentKnowledgeComposition`) — none of which reads this store.
 *
 * What ACTUALLY fences imported content on the one model-facing path over these
 * rows is the TOOL, not the row: `features/conversation-search/agentTools.ts:22`
 * declares `contentTrust:'untrusted'` on the search tool, and
 * `host/toModelToolResult.ts:101` fences the result of any builtin that declares
 * it. The effect is right; the cause named here was not.
 *
 * The stamp is KEPT because `source:'import'` is genuine provenance and is what a
 * future trust-aware consumer would key off. Do not re-describe it as a fence
 * unless a consumer actually exists — an inert field that reads as a protection is
 * worse than no field, because the next author will rely on it.
 *
 * @see docs/adr/0119-conversation-export-import.md
 */
import { randomUUID } from 'node:crypto';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { ensureConversationMeta } from '../../host/conversationStore.js';
import { OpenwopError } from '../../types.js';
import type { ImportedConversation } from './importParser.js';

const MAX_TURNS = 2000;
const MAX_CONTENT = 100_000;

export async function importConversation(
  tenantId: string,
  // CXC-1: REQUIRED — an import always yields an OWNED conversation. A falsy owner
  // would create a tenant-visible conversation (conversationVisibility treats an
  // owner-less meta as legacy/tenant-visible); the route enforces this before the
  // call, and the required type keeps any future caller from re-opening the hole.
  ownerUserId: string,
  parsed: ImportedConversation,
): Promise<{ sessionId: string; imported: number }> {
  if (!parsed || !Array.isArray(parsed.turns)) {
    throw new OpenwopError('validation_error', 'nothing to import.', 400, {});
  }
  const turns = parsed.turns.slice(0, MAX_TURNS);
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  await hostExtStorage().createChatSession({
    sessionId, tenantId,
    title: (parsed.title || 'Imported conversation').slice(0, 200),
    createdAt: now, updatedAt: now, messageCount: 0,
  });
  await ensureConversationMeta(tenantId, sessionId, { type: 'agent', ownerUserId });

  let imported = 0;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    const role = t.role === 'assistant' || t.role === 'system' ? t.role : 'user';
    await hostExtStorage().appendChatMessage({
      messageId: `${sessionId}-i${i}`,
      sessionId,
      role,
      content: String(t.content).slice(0, MAX_CONTENT),
      // PROVENANCE (ADR 0698 D1) — `source:'import'` records where this came from.
      // It is NOT read by any trust-aware consumer; see the docblock above before
      // citing this stamp as a security control.
      meta: JSON.stringify({ contentTrust: 'untrusted', source: 'import' }),
      authorSubject: null,
      createdAt: t.createdAt && typeof t.createdAt === 'string' ? t.createdAt : new Date(Date.now() + i).toISOString(),
    });
    imported++;
  }
  return { sessionId, imported };
}
