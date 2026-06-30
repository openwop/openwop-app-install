/**
 * ADR 0119 Phase 3 — export a conversation as a Document.
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

const T = 'asdoc-tenant';
const ORG = 'org-asdoc';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-asdoc-')) });
  initHostExtPersistence(await openStorage('memory://'));
  const now = new Date().toISOString();
  await hostExtStorage().createChatSession({ sessionId: 'conv-x', tenantId: T, title: 'Roadmap', createdAt: now, updatedAt: now, messageCount: 0 });
  await hostExtStorage().appendChatMessage({ messageId: 'm0', sessionId: 'conv-x', role: 'user', content: 'what is the plan', meta: null, authorSubject: null, createdAt: now });
  await hostExtStorage().appendChatMessage({ messageId: 'm1', sessionId: 'conv-x', role: 'assistant', content: 'the plan is bold', meta: null, authorSubject: null, createdAt: now });
});

describe('exportConversationAsDocument', () => {
  it('creates a transcript document whose version carries the rendered transcript', async () => {
    const { documentId } = await exportConversationAsDocument(T, ORG, 'user:alice', 'conv-x');
    const doc = await getDocument(T, ORG, documentId);
    expect(doc!.title).toBe('Roadmap');
    expect(doc!.kind).toBe('conversation-transcript');
    const versions = await listVersions(T, ORG, documentId);
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(versions[versions.length - 1]!.content).toContain('the plan is bold');
  });

  it('404s a non-existent conversation', async () => {
    await expect(exportConversationAsDocument(T, ORG, 'user:alice', 'nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});
