/**
 * ADR 0119 Phase 3 — export a conversation AS a Document.
 *
 * Composes existing owners — no new store: the Phase-1 `transcriptToMarkdown`
 * renderer + the ADR 0053 Documents service (`createDocument` + `addVersion`, the
 * single owner of documents) + `hostExtStorage` (the chat source). The transcript
 * lands as an org-scoped `conversation-transcript` document with one version. A
 * one-shot export (no replay obligation).
 *
 * @see docs/adr/0119-conversation-export-import.md
 */
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { transcriptToMarkdown } from './transcriptRenderer.js';
import { createDocument, addVersion } from '../documents/documentsService.js';
import { OpenwopError } from '../../types.js';
import { authorizeConversationRead, refuseUnlessSoleAuthor, refuseUnlessSoleOwner } from './access.js';

export async function exportConversationAsDocument(
  tenantId: string,
  orgId: string,
  actor: string,
  sessionId: string,
  /** Optional deterministic idempotency (the agent-tool path passes a run-scoped
   *  key so an exact re-export reuses the same document + version instead of
   *  minting a duplicate transcript). The agent tool is the only caller today. */
  idempotency?: { documentId: string; idempotencyKey: string },
): Promise<{ documentId: string }> {
  // ADR 0992 D8 — the helper re-checks read access and the sole-owner rule itself,
  // so no future caller can write a Document the tool would have refused.
  const { session, meta } = await authorizeConversationRead(tenantId, sessionId, actor);
  const messages = await hostExtStorage().listChatSessionMessages(sessionId);
  const refusal = refuseUnlessSoleOwner(meta, actor, orgId) ?? refuseUnlessSoleAuthor(messages, actor);
  if (refusal) throw new OpenwopError('forbidden', 'Only a conversation that is yours alone can be saved as a Document.', 403, { reason: refusal });
  const markdown = transcriptToMarkdown(session, [...messages]);

  const doc = await createDocument({
    tenantId, orgId,
    title: (session.title || 'Conversation').slice(0, 200),
    kind: 'conversation-transcript',
    format: 'markdown',
    provenance: { producedBy: { kind: 'user', id: actor } },
    createdBy: actor,
    ...(idempotency ? { documentId: idempotency.documentId } : {}),
  });
  await addVersion(tenantId, orgId, doc.documentId, {
    content: markdown,
    producedBy: { kind: 'user', id: actor },
    ...(idempotency ? { idempotencyKey: idempotency.idempotencyKey } : {}),
  });
  return { documentId: doc.documentId };
}
