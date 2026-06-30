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

export async function exportConversationAsDocument(
  tenantId: string,
  orgId: string,
  actor: string,
  sessionId: string,
): Promise<{ documentId: string }> {
  const session = await hostExtStorage().getChatSession(tenantId, sessionId);
  if (!session) throw new OpenwopError('not_found', 'Conversation not found.', 404, { sessionId });
  const messages = await hostExtStorage().listChatSessionMessages(sessionId);
  const markdown = transcriptToMarkdown(session, [...messages]);

  const doc = await createDocument({
    tenantId, orgId,
    title: (session.title || 'Conversation').slice(0, 200),
    kind: 'conversation-transcript',
    format: 'markdown',
    provenance: { producedBy: { kind: 'user', id: actor } },
    createdBy: actor,
  });
  await addVersion(tenantId, orgId, doc.documentId, {
    content: markdown,
    producedBy: { kind: 'user', id: actor },
  });
  return { documentId: doc.documentId };
}
