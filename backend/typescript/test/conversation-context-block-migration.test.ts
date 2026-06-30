/**
 * ADR 0080 §Follow-on — the core `ConversationMeta` snapshot field was renamed
 * from the feature-named `strategyContext` to the generic `injectedContextBlock`
 * (so the board-context resolver seam isn't strategy-flavored). The field is
 * PERSISTED in the `chat:conversation` DurableCollection, so a pure rename would
 * silently drop the snapshot on board conversations created before the rename.
 * `getConversationMeta` normalizes the legacy key on read; these tests lock that
 * migration safety in.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence, __resetHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { getConversationMeta, type ConversationMeta } from '../src/host/conversationStore.js';

const TS = '2026-01-01T00:00:00.000Z';
const key = (m: { tenantId: string; conversationId: string }) => `${m.tenantId}:${m.conversationId}`;

describe('ConversationMeta injected-context-block migration', () => {
  beforeEach(() => {
    __resetHostExtPersistence();
    initHostExtPersistence(openSqliteStorage(':memory:'));
  });

  it('reads a legacy `strategyContext` snapshot back as `injectedContextBlock`', async () => {
    // Write a record shaped as it was persisted BEFORE the rename.
    const legacy = new DurableCollection<ConversationMeta & { strategyContext?: string }>('chat:conversation', key);
    await legacy.put({
      conversationId: 'conv-legacy', tenantId: 't1', type: 'group', boardId: 'host:advisory:founders',
      participants: [], createdAt: TS, updatedAt: TS, strategyContext: 'STRATEGIC CONTEXT (legacy snapshot)',
    });

    const read = await getConversationMeta('t1', 'conv-legacy');
    expect(read?.injectedContextBlock).toBe('STRATEGIC CONTEXT (legacy snapshot)');
  });

  it('reads a current `injectedContextBlock` snapshot unchanged', async () => {
    const current = new DurableCollection<ConversationMeta>('chat:conversation', key);
    await current.put({
      conversationId: 'conv-new', tenantId: 't1', type: 'group', boardId: 'host:advisory:founders',
      participants: [], createdAt: TS, updatedAt: TS, injectedContextBlock: 'NEW BLOCK',
    });

    const read = await getConversationMeta('t1', 'conv-new');
    expect(read?.injectedContextBlock).toBe('NEW BLOCK');
  });
});
