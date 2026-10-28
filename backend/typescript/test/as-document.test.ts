/**
 * ADR 0119 Phase 3 — export a conversation as a Document (`exportConversationAsDocument`).
 *
 * Guards the SERVICE contract: one `conversation-transcript` markdown document whose
 * persisted title is the conversation's, with exactly one version carrying the rendered
 * transcript, attributed to the exporting actor; and a typed `not_found` for a missing
 * conversation. The tool lane (`chat-export-agent-tools.test.ts`) checks the session
 * before calling here and reports its OWN payload title, so the persisted title and the
 * service's not_found are asserted only in this file.
 *
 * Sabotage-witnessed (grade-tests w14): a constant title, a wrong kind, dropped
 * transcript content, a wrong producer, or a non-not_found error code each turns a case red.
 *
 * ADR 0992 D8 (architect B1): the service itself now refuses a conversation that is not
 * the actor's alone, because a Document is readable by the whole org. The fixture is
 * therefore production-shaped: an owned 1:1 agent chat whose user turn the owner wrote.
 * It used to have NO meta, which is the legacy owner-less, tenant-visible shape. That
 * shape is now pinned as REFUSED, so dropping the owner check turns the last case red.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence, hostExtStorage } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { exportConversationAsDocument } from '../src/features/chat-export/asDocumentService.js';
import { getDocument, listVersions } from '../src/features/documents/documentsService.js';
import { ensureConversationMeta } from '../src/host/conversationStore.js';

const T = 'asdoc-tenant';
const ORG = 'org-asdoc';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-asdoc-')) });
  initHostExtPersistence(await openStorage('memory://'));
  const now = new Date().toISOString();
  await hostExtStorage().createChatSession({ sessionId: 'conv-x', tenantId: T, title: 'Roadmap', createdAt: now, updatedAt: now, messageCount: 0 });
  await ensureConversationMeta(T, 'conv-x', { type: 'agent', ownerUserId: 'user:alice' });
  await hostExtStorage().appendChatMessage({ messageId: 'm0', sessionId: 'conv-x', role: 'user', content: 'what is the plan', meta: null, authorSubject: 'user:user:alice', createdAt: now });
  await hostExtStorage().appendChatMessage({ messageId: 'm1', sessionId: 'conv-x', role: 'assistant', content: 'the plan is bold', meta: null, authorSubject: null, createdAt: now });
  // The legacy shape: a session with no meta (owner-less, so tenant-visible).
  await hostExtStorage().createChatSession({ sessionId: 'conv-legacy', tenantId: T, title: 'Legacy', createdAt: now, updatedAt: now, messageCount: 0 });
  await hostExtStorage().appendChatMessage({ messageId: 'l0', sessionId: 'conv-legacy', role: 'user', content: 'anyone in the tenant can read this', meta: null, authorSubject: null, createdAt: now });
  // …and a meta that records no owner (the same tenant-visible posture).
  await hostExtStorage().createChatSession({ sessionId: 'conv-unowned', tenantId: T, title: 'Unowned', createdAt: now, updatedAt: now, messageCount: 0 });
  await ensureConversationMeta(T, 'conv-unowned', { type: 'agent' });
});

describe('exportConversationAsDocument', () => {
  it('creates a transcript document whose version carries the rendered transcript', async () => {
    const { documentId } = await exportConversationAsDocument(T, ORG, 'user:alice', 'conv-x');
    const doc = await getDocument(T, ORG, documentId);
    expect(doc!.title).toBe('Roadmap');
    expect(doc!.kind).toBe('conversation-transcript');
    expect(doc!.format).toBe('markdown');
    expect(doc!.createdBy).toBe('user:alice');
    expect(doc!.provenance.producedBy).toEqual({ kind: 'user', id: 'user:alice' });
    const versions = await listVersions(T, ORG, documentId);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.content).toContain('what is the plan');
    expect(versions[0]!.content).toContain('the plan is bold');
    expect(versions[0]!.producedBy).toEqual({ kind: 'user', id: 'user:alice' });
  });

  it('refuses an owner-less legacy conversation: it is not the actor\'s alone (ADR 0992 B1)', async () => {
    for (const id of ['conv-legacy', 'conv-unowned']) {
      await expect(exportConversationAsDocument(T, ORG, 'user:alice', id))
        .rejects.toMatchObject({ code: 'forbidden', httpStatus: 403, details: { reason: 'shared_conversation' } });
    }
  });

  it('404s a non-existent conversation', async () => {
    await expect(exportConversationAsDocument(T, ORG, 'user:alice', 'nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});
