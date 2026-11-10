/**
 * ADR 0997 — the hermetic half of the conversation-search storage contract:
 * - D1 `Storage.searchChatMessages` on the SQLite adapter (`memory://` is SQLite):
 *   AND of needles, only the given sessions, tombstones excluded, literal LIKE
 *   metacharacters, newest first, the limit. The Postgres SQL is pinned by
 *   `adr0997-chat-search-postgres-live.test.ts` (live-infra lane). SQLite folds
 *   ASCII case only; the engine's re-check covers other scripts.
 * - D6 the legacy-row purge: removes `hostsurf:search:<t>:chat-search:*` and
 *   nothing else, and is safe to run with no durable store wired WITHOUT
 *   latching: a call made before boot wires the store must not stop the purge
 *   from running once it is wired.
 *
 * Red when (wave 79 probes): newest-first order flipped; the needles OR'd; the
 * session filter dropped; tombstones returned; `_` or `%` left unescaped; the
 * limit ignored; empty needles not short-circuited; the key test matching a
 * prefix of the index segment or any surface; the purge deleting nothing or
 * every `hostsurf:search:` row; the no-store call latching the once-per-process
 * promise.
 * Double guard on the latch (both in `legacyIndexPurge.ts`): the no-store early
 * return, AND the purge's `.catch`, which resets `done = null` when the scan
 * throws for want of a store (`requireDurableStorage`). Removing either one
 * alone is an equivalent mutant (wave 79 r2: `lp-nostore` vacuous). One edit
 * that breaks both reds the no-store case (r3 `lp-nostore-both`).
 * Equivalent mutant (recorded, not a gap): dropping the empty-`sessionIds`
 * early return changes nothing, because `json_each('[]')` selects no session.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { setDurableStorage } from '../src/host/durable/durableStore.js';
import {
  isLegacyChatSearchKey,
  purgeLegacySearchIndexOnce,
  __resetLegacyPurge,
} from '../src/features/conversation-search/legacyIndexPurge.js';

let storage: Storage;
const T = 't-adr0997';

beforeAll(async () => {
  storage = await openStorage('memory://');
  const base = Date.parse('2026-10-28T00:00:00Z');
  for (const sid of ['s1', 's2', 's3']) {
    const at = new Date(base).toISOString();
    await storage.createChatSession({ sessionId: sid, tenantId: T, title: sid, createdAt: at, updatedAt: at, messageCount: 0 });
  }
  const rows: Array<[string, string, string]> = [
    ['s1', 'm1', 'Lunch at the Harbour cafe'],
    ['s1', 'm2', 'the 100% plan_b is ready'],
    ['s1', 'm3', '{"deleted":true}'],
    ['s2', 'm4', 'harbour closed for the cafe renovation'],
    ['s3', 'm5', 'harbour in a session nobody asked about'],
  ];
  let i = 0;
  for (const [sessionId, messageId, content] of rows) {
    await storage.appendChatMessage({
      messageId, sessionId, role: 'user', content, meta: null, authorSubject: null,
      createdAt: new Date(base + ++i * 1000).toISOString(),
    });
  }
});

describe('ADR 0997 D1 — searchChatMessages (SQLite)', () => {
  const ids = (rows: readonly { messageId: string }[]): string[] => rows.map((r) => r.messageId);

  it('matches every needle (ASCII case-insensitive), only in the given sessions, newest first', async () => {
    expect(ids(await storage.searchChatMessages(['s1', 's2'], ['harbour'], { limit: 10 }))).toEqual(['m4', 'm1']);
    expect(ids(await storage.searchChatMessages(['s1', 's2'], ['harbour', 'lunch'], { limit: 10 }))).toEqual(['m1']);
  });

  it('treats LIKE metacharacters literally and never returns a tombstone', async () => {
    expect(ids(await storage.searchChatMessages(['s1'], ['100%'], { limit: 10 }))).toEqual(['m2']);
    expect(ids(await storage.searchChatMessages(['s1'], ['1_0'], { limit: 10 }))).toEqual([]); // unescaped, `_` would match "100"
    expect(ids(await storage.searchChatMessages(['s1'], ['h%r'], { limit: 10 }))).toEqual([]); // unescaped, `%` would match "Harbour" and "the … ready"
    expect(ids(await storage.searchChatMessages(['s1'], ['plan_b'], { limit: 10 }))).toEqual(['m2']);
    expect(ids(await storage.searchChatMessages(['s1'], ['deleted'], { limit: 10 }))).toEqual([]);
  });

  it('honours the limit and empty inputs', async () => {
    expect(ids(await storage.searchChatMessages(['s1', 's2', 's3'], ['harbour'], { limit: 1 }))).toEqual(['m5']);
    expect(await storage.searchChatMessages([], ['harbour'], { limit: 10 })).toEqual([]);
    expect(await storage.searchChatMessages(['s1'], [], { limit: 10 })).toEqual([]);
  });
});

describe('ADR 0997 D6 — legacy chat-search rows are purged', () => {
  it('recognises exactly the retired index segment', () => {
    expect(isLegacyChatSearchKey('hostsurf:search:t%3Aa:chat-search:c%00m')).toBe(true);
    expect(isLegacyChatSearchKey('hostsurf:search:t:chat-search-2:x')).toBe(false);
    expect(isLegacyChatSearchKey('hostsurf:search:t:default:chat-search')).toBe(false);
    expect(isLegacyChatSearchKey('hostsurf:vector:t:chat-search:x')).toBe(false);
  });

  it('is a no-op with no durable store wired, and does not latch: a later call with a store still purges', async () => {
    setDurableStorage(null);
    __resetLegacyPurge();
    await expect(purgeLegacySearchIndexOnce()).resolves.toBeUndefined();
    const k = 'hostsurf:search:t9:chat-search:c9%00m9';
    await storage.kvSet(k, '{"id":"x","fields":{"text":"private"}}');
    // No reset here: the earlier no-store call must not have used up the once-per-process purge.
    setDurableStorage(storage);
    try {
      await purgeLegacySearchIndexOnce();
      expect(await storage.kvGet(k)).toBeNull();
    } finally {
      setDurableStorage(null);
    }
  });

  it('deletes the legacy rows and keeps every other key', async () => {
    const legacy = ['hostsurf:search:t1:chat-search:c1%00m1', 'hostsurf:search:t2:chat-search:c2%00m2'];
    const kept = ['hostsurf:search:t1:default:doc1', 'hostsurf:kv:t1:chat-search', 'hostext:other'];
    for (const k of [...legacy, ...kept]) await storage.kvSet(k, '{"id":"x","fields":{"text":"private"}}');
    setDurableStorage(storage);
    try {
      __resetLegacyPurge();
      await purgeLegacySearchIndexOnce();
      for (const k of legacy) expect(await storage.kvGet(k), k).toBeNull();
      for (const k of kept) expect(await storage.kvGet(k), k).not.toBeNull();
    } finally {
      setDurableStorage(null);
    }
  });
});
