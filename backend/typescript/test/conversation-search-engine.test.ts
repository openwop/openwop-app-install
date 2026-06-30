/**
 * ADR 0112 Phase 1 — conversation-search engine unit tests.
 * Tokenization parity + scoping + facets + drift-free self-heal, against the
 * in-memory `db.search` surface + a `memory://` chat store.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import {
  searchConversations,
  extractText,
  __resetSearchEngine,
  type SearchScope,
} from '../src/features/conversation-search/searchEngine.js';

const TENANT = 't-search';

let storage: Storage;

async function seedConversation(
  conversationId: string,
  title: string,
  msgs: Array<{ role: string; content: string }>,
): Promise<void> {
  const now = new Date().toISOString();
  await storage.createChatSession({ sessionId: conversationId, tenantId: TENANT, title, createdAt: now, updatedAt: now, messageCount: 0 });
  let i = 0;
  for (const m of msgs) {
    await storage.appendChatMessage({
      messageId: `${conversationId}-m${i}`,
      sessionId: conversationId,
      role: m.role as 'user' | 'assistant' | 'system' | 'workflow_run',
      content: m.content,
      meta: null,
      authorSubject: null,
      createdAt: new Date(Date.now() + i * 1000).toISOString(),
    });
    i++;
  }
}

function scope(extra: Partial<SearchScope> & Pick<SearchScope, 'visibleConversationIds'>): SearchScope {
  return { tenantId: TENANT, ...extra };
}

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-convsearch-')) });
  storage = await openStorage('memory://');
});

beforeEach(() => {
  __resetSearchEngine();
});

describe('extractText', () => {
  it('passes through a plain string', () => {
    expect(extractText('hello world')).toBe('hello world');
  });
  it('extracts {content: "..."}', () => {
    expect(extractText(JSON.stringify({ role: 'user', content: 'find the invoice' }))).toBe('find the invoice');
  });
  it('joins a content parts array', () => {
    const c = JSON.stringify({ content: [{ type: 'text', text: 'alpha' }, { type: 'text', text: 'beta' }] });
    expect(extractText(c)).toContain('alpha');
    expect(extractText(c)).toContain('beta');
  });
  it('falls back to the raw string on malformed JSON', () => {
    expect(extractText('{not json')).toBe('{not json');
  });
  it('returns empty for empty', () => {
    expect(extractText('')).toBe('');
  });
});

describe('searchConversations', () => {
  it('finds a message by content and returns conversation + snippet + jump anchor', async () => {
    await seedConversation('c-quarterly', 'Quarterly planning', [
      { role: 'user', content: 'What is our pipeline forecast?' },
      { role: 'assistant', content: 'The forecast shows a strong Q3 with growing revenue.' },
    ]);
    const hits = await searchConversations(storage, scope({
      visibleConversationIds: ['c-quarterly'],
      titleById: new Map([['c-quarterly', 'Quarterly planning']]),
    }), 'forecast');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.conversationId).toBe('c-quarterly');
    expect(hits[0]!.messageId).toBeTruthy();
    expect(hits[0]!.snippet.toLowerCase()).toContain('forecast');
    expect(hits[0]!.matchedAt).toBeTruthy();
  });

  it('NEVER returns a conversation outside the visible set (scoping / no existence leak)', async () => {
    await seedConversation('c-private', 'Secret', [{ role: 'user', content: 'the codeword is platypus' }]);
    // platypus exists, but the conversation is not in the caller's visible set.
    const hits = await searchConversations(storage, scope({ visibleConversationIds: ['c-other'] }), 'platypus');
    expect(hits).toHaveLength(0);
  });

  it('applies the role facet', async () => {
    await seedConversation('c-roles', 'Roles', [
      { role: 'user', content: 'unicorn question from the user' },
      { role: 'assistant', content: 'unicorn answer from the assistant' },
    ]);
    const visible = { visibleConversationIds: ['c-roles'] };
    const all = await searchConversations(storage, scope(visible), 'unicorn');
    expect(all).toHaveLength(1); // best hit per conversation
    const assistantOnly = await searchConversations(storage, scope({ ...visible, role: 'assistant' }), 'unicorn');
    expect(assistantOnly[0]!.role).toBe('assistant');
    const userOnly = await searchConversations(storage, scope({ ...visible, role: 'user' }), 'unicorn');
    expect(userOnly[0]!.role).toBe('user');
  });

  it('returns a title-only hit when the query matches the title but no message', async () => {
    await seedConversation('c-budget', 'Budget review 2026', [{ role: 'user', content: 'unrelated chatter' }]);
    const hits = await searchConversations(storage, scope({
      visibleConversationIds: ['c-budget'],
      titleById: new Map([['c-budget', 'Budget review 2026']]),
    }), 'budget');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.messageId).toBeUndefined();
    expect(hits[0]!.title).toBe('Budget review 2026');
  });

  it('returns [] for an empty query', async () => {
    const hits = await searchConversations(storage, scope({ visibleConversationIds: ['c-quarterly'] }), '   ');
    expect(hits).toHaveLength(0);
  });

  it('self-heals: a newly appended message becomes searchable (watermark rebuild)', async () => {
    await seedConversation('c-heal', 'Heal', [{ role: 'user', content: 'initial message' }]);
    const visible = { visibleConversationIds: ['c-heal'] };
    expect(await searchConversations(storage, scope(visible), 'pterodactyl')).toHaveLength(0);
    await storage.appendChatMessage({
      messageId: 'c-heal-m9', sessionId: 'c-heal', role: 'assistant',
      content: 'now mentioning a pterodactyl', meta: null, authorSubject: null,
      createdAt: new Date().toISOString(),
    });
    const hits = await searchConversations(storage, scope(visible), 'pterodactyl');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet.toLowerCase()).toContain('pterodactyl');
  });
});
