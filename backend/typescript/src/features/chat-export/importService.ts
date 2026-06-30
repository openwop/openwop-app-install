/**
 * ADR 0119 Phase 4b — conversation IMPORT write.
 *
 * Composes the Phase-4a parsers' normalized `{ title, turns }` into a NEW
 * conversation: a fresh chat session + an owned `ConversationMeta`, then each turn
 * appended. SECURITY: every imported message is stamped `contentTrust:'untrusted'`
 * (+ `source:'import'`) in its meta — the content came from outside, so a hostile
 * import (prompt-injection in a message) is fenced as untrusted on recall/render,
 * never silently trusted. Idempotency-keyed by the caller; payload caps applied.
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
  ownerUserId: string | undefined,
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
  await ensureConversationMeta(tenantId, sessionId, { type: 'agent', ...(ownerUserId ? { ownerUserId } : {}) });

  let imported = 0;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    const role = t.role === 'assistant' || t.role === 'system' ? t.role : 'user';
    await hostExtStorage().appendChatMessage({
      messageId: `${sessionId}-i${i}`,
      sessionId,
      role,
      content: String(t.content).slice(0, MAX_CONTENT),
      // SECURITY: imported content is UNTRUSTED — fenced on recall/render.
      meta: JSON.stringify({ contentTrust: 'untrusted', source: 'import' }),
      authorSubject: null,
      createdAt: t.createdAt && typeof t.createdAt === 'string' ? t.createdAt : new Date(Date.now() + i).toISOString(),
    });
    imported++;
  }
  return { sessionId, imported };
}
