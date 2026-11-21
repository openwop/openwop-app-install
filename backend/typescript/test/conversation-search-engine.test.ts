/**
 * ADR 0112 / ADR 0997 — conversation-search engine unit tests: scoping, facets,
 * title hits, query semantics (every word, substring, Unicode) and the candidate
 * cap, against a `memory://` chat store. Search reads the message rows at request
 * time (ADR 0997 D1); there is no index to seed or reset.
 *
 * Scoping is pinned at BOTH layers: the engine's visible-set post-filter
 * (`searchConversations`) and the ADR 0043 visibility resolution in
 * `searchVisibleConversations` — the ONE helper the route and the
 * `openwop:conversations.search` agent tool share (XCH-HOLE-5).
 *
 * The visible-set scope is a DOUBLE guard: `Storage.searchChatMessages` receives only
 * the visible ids (a SQL `IN` prefilter) and the engine re-checks each row. A probe on
 * either half alone stays green by design, so it is witnessed by one edit that widens
 * the storage call AND drops the re-check (`w118g2-eng-scope-both`). The every-word
 * rule is doubled the same way (one `LIKE` per needle, then `scoreText`).
 *
 * Breaks if: the scope (both halves), the visibility predicate (lax or strict), the
 * role facet, the title-hit loop, the empty-query guard, the jump anchor / snippet,
 * a stale result cache, the Unicode tokenizer (case, de-dup, the 8-token cap), the
 * all-words rule (both halves), the tombstone check, or the `truncated` boundary
 * regresses (probes w24g1-eng-* / -r2, re-probed at ADR 0997 as `w118g2-eng-*`).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { ensureConversationMeta } from '../src/host/conversationStore.js';
import type { Storage } from '../src/storage/storage.js';
import type { ChatMessageRecord } from '../src/types.js';
import {
  searchConversations,
  searchVisibleConversations,
  queryTokens,
  CANDIDATE_LIMIT,
  type SearchScope,
} from '../src/features/conversation-search/searchEngine.js';

const TENANT = 't-search';

let storage: Storage;

async function seedConversation(
  conversationId: string,
  title: string,
  msgs: Array<{ role: ChatMessageRecord['role']; content: string }>,
): Promise<void> {
  const now = new Date().toISOString();
  await storage.createChatSession({ sessionId: conversationId, tenantId: TENANT, title, createdAt: now, updatedAt: now, messageCount: 0 });
  let i = 0;
  for (const m of msgs) {
    await storage.appendChatMessage({
      messageId: `${conversationId}-m${i}`,
      sessionId: conversationId,
      role: m.role,
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
  initHostExtPersistence(storage); // conversation metas (ADR 0043) live in host-ext persistence
});

describe('searchConversations', () => {
  it('finds a message by content and returns conversation + snippet + jump anchor', async () => {
    // Only the SECOND message says "forecast", so the jump anchor has one right answer.
    const seededAt = Date.now();
    await seedConversation('c-quarterly', 'Quarterly planning', [
      { role: 'user', content: 'What is our pipeline outlook?' },
      { role: 'assistant', content: 'The forecast shows a strong Q3 with growing revenue.' },
    ]);
    const { hits } = await searchConversations(storage, scope({
      visibleConversationIds: ['c-quarterly'],
      titleById: new Map([['c-quarterly', 'Quarterly planning']]),
    }), 'forecast');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.conversationId).toBe('c-quarterly');
    expect(hits[0]!.title).toBe('Quarterly planning');
    expect(hits[0]!.messageId, 'the jump anchor is the matching message').toBe('c-quarterly-m1');
    expect(hits[0]!.role).toBe('assistant');
    expect(hits[0]!.snippet).toBe('The forecast shows a strong Q3 with growing revenue.');
    // m1 is stamped one second after the seed started (the seed spaces rows 1 s apart).
    expect(Date.parse(hits[0]!.matchedAt ?? '')).toBeGreaterThanOrEqual(seededAt + 1000);
  });

  it('NEVER returns a conversation outside the visible set (scoping / no existence leak)', async () => {
    await seedConversation('c-private', 'Secret', [{ role: 'user', content: 'the codeword is platypus' }]);
    // Positive control: c-private IS findable by a caller who may see it, so the
    // empty result below is the scope at work, not a missing row (wave-24 lesson).
    expect((await searchConversations(storage, scope({ visibleConversationIds: ['c-private'] }), 'platypus')).hits).toHaveLength(1);
    // The row matches "platypus", but c-private is not in this caller's visible set.
    const { hits } = await searchConversations(storage, scope({ visibleConversationIds: ['c-other'] }), 'platypus');
    expect(hits).toHaveLength(0);
  });

  it('searchVisibleConversations hides a SAME-tenant non-participant conversation (ADR 0043)', async () => {
    await seedConversation('c-owned', 'Owned', [{ role: 'user', content: 'the quokka plan' }]);
    await ensureConversationMeta(TENANT, 'c-owned', { type: 'group', ownerUserId: 'u-owner' });
    // Owner sees it (positive control) …
    const { hits: own } = await searchVisibleConversations(storage, TENANT, 'u-owner', 'quokka');
    expect(own.map((h) => h.conversationId)).toEqual(['c-owned']);
    // … a same-tenant user who is neither owner nor participant does not.
    expect((await searchVisibleConversations(storage, TENANT, 'u-stranger', 'quokka')).hits).toEqual([]);
  });

  it('applies the role facet', async () => {
    await seedConversation('c-roles', 'Roles', [
      { role: 'user', content: 'unicorn question from the user' },
      { role: 'assistant', content: 'unicorn answer from the assistant' },
    ]);
    const visible = { visibleConversationIds: ['c-roles'] };
    const { hits: all } = await searchConversations(storage, scope(visible), 'unicorn');
    expect(all).toHaveLength(1); // best hit per conversation
    const { hits: assistantOnly } = await searchConversations(storage, scope({ ...visible, role: 'assistant' }), 'unicorn');
    expect(assistantOnly[0]!.role).toBe('assistant');
    const { hits: userOnly } = await searchConversations(storage, scope({ ...visible, role: 'user' }), 'unicorn');
    expect(userOnly[0]!.role).toBe('user');
  });

  it('returns a title-only hit when the query matches the title but no message', async () => {
    await seedConversation('c-budget', 'Budget review 2026', [{ role: 'user', content: 'unrelated chatter' }]);
    const { hits } = await searchConversations(storage, scope({
      visibleConversationIds: ['c-budget'],
      titleById: new Map([['c-budget', 'Budget review 2026']]),
    }), 'budget');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.messageId).toBeUndefined();
    expect(hits[0]!.title).toBe('Budget review 2026');
  });

  it('returns [] for an empty query', async () => {
    // A title map is supplied so the guard is load-bearing: every title `includes('')`,
    // so without the early return the title loop would emit a hit.
    await seedConversation('c-empty-q', 'Empty query probe', [{ role: 'user', content: 'anything' }]);
    const { hits } = await searchConversations(storage, scope({
      visibleConversationIds: ['c-empty-q'],
      titleById: new Map([['c-empty-q', 'Empty query probe']]),
    }), '   ');
    expect(hits).toHaveLength(0);
  });

  it('a newly appended message is searchable on the next query', async () => {
    await seedConversation('c-heal', 'Heal', [{ role: 'user', content: 'initial message' }]);
    const visible = { visibleConversationIds: ['c-heal'] };
    expect((await searchConversations(storage, scope(visible), 'pterodactyl')).hits).toHaveLength(0);
    await storage.appendChatMessage({
      messageId: 'c-heal-m9', sessionId: 'c-heal', role: 'assistant',
      content: 'now mentioning a pterodactyl', meta: null, authorSubject: null,
      createdAt: new Date().toISOString(),
    });
    const { hits } = await searchConversations(storage, scope(visible), 'pterodactyl');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet.toLowerCase()).toContain('pterodactyl');
  });
});

describe('ADR 0997 D3 — query semantics', () => {
  it('tokenises Unicode letters and numbers, lower-cased and de-duplicated', () => {
    expect(queryTokens('Café  crème, CAFÉ 42!')).toEqual(['café', 'crème', '42']);
    expect(queryTokens('  ,,  ')).toEqual([]);
    expect(queryTokens('a b c d e f g h i j')).toHaveLength(8);
  });

  it('every word must match, as a substring, within one message', async () => {
    await seedConversation('c-and', 'And semantics', [
      { role: 'user', content: 'the deployment window is friday' },
      { role: 'assistant', content: 'rollback plan attached' },
    ]);
    const visible = { visibleConversationIds: ['c-and'] };
    // Substring: "deploy" finds "deployment".
    expect((await searchConversations(storage, scope(visible), 'deploy friday')).hits).toHaveLength(1);
    // AND, per message: "deployment" and "rollback" are in DIFFERENT messages.
    expect((await searchConversations(storage, scope(visible), 'deployment rollback')).hits).toHaveLength(0);
  });

  it('matches non-ASCII text', async () => {
    await seedConversation('c-cafe', 'Notes', [{ role: 'user', content: JSON.stringify({ role: 'user', content: 'Réunion au café demain' }) }]);
    // A decoy that an ASCII-only tokenizer would match: it splits "café" into "caf".
    await seedConversation('c-caf', 'Decoy', [{ role: 'user', content: 'the caf menu is up' }]);
    const { hits } = await searchConversations(storage, scope({ visibleConversationIds: ['c-cafe', 'c-caf'] }), 'café');
    expect(hits.map((h) => h.conversationId)).toEqual(['c-cafe']);
    expect(hits[0]!.snippet).toContain('café');
  });

  it('a row tombstoned by meta alone is not searchable', async () => {
    await seedConversation('c-meta-del', 'Meta delete', [{ role: 'user', content: 'ocelot sighting' }]);
    await storage.updateChatMessageContent('c-meta-del', 'c-meta-del-m0', 'ocelot sighting', JSON.stringify({ deletedAt: new Date().toISOString() }));
    expect((await searchConversations(storage, scope({ visibleConversationIds: ['c-meta-del'] }), 'ocelot')).hits).toEqual([]);
    // …and messageView's placeholder ("_(message deleted)_") is not searchable text:
    // a row whose own words also say "message deleted" must not surface by it.
    await seedConversation('c-meta-del2', 'Meta delete 2', [{ role: 'user', content: 'that message deleted itself' }]);
    await storage.updateChatMessageContent('c-meta-del2', 'c-meta-del2-m0', 'that message deleted itself', JSON.stringify({ deletedAt: new Date().toISOString() }));
    expect((await searchConversations(storage, scope({ visibleConversationIds: ['c-meta-del2'] }), 'message deleted')).hits).toEqual([]);
  });

  it('reports truncated when the candidate cap is reached, and not below it', async () => {
    const many = Array.from({ length: CANDIDATE_LIMIT }, () => ({ role: 'user' as const, content: 'heron' }));
    await seedConversation('c-cap', 'Cap', many);
    const visible = { visibleConversationIds: ['c-cap'] };
    expect((await searchConversations(storage, scope(visible), 'heron')).truncated).toBe(true);
    await seedConversation('c-under', 'Under', [{ role: 'user', content: 'kestrel' }]);
    expect((await searchConversations(storage, scope({ visibleConversationIds: ['c-under'] }), 'kestrel')).truncated).toBe(false);
  });
});
