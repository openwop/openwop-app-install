/**
 * ADR 1019 D1 — entity-named chats keep their entity's name.
 *
 *  - `refreshEntityChatTitle` follows a `'given'` (and legacy `'default'`) row to the
 *    entity's new name, and never touches a person's rename (`'user'`) or a spent
 *    auto-title claim (`'claimed'`).
 *  - An `'auto'` title on an ENTITY-bound room (meta `boardId` / `ownerSubject`) is the
 *    ADR 0151 autotitler's damage: the next open puts the entity's name back. An `'auto'`
 *    title on a plain chat is the auto-title working as intended and is left alone.
 *  - Stamping a legacy row whose title already matches changes only `title_source`, so
 *    opening a room never reorders the rail.
 *  - Every `createChatSession({…})` call in src names its title source as `'given'`,
 *    except the ONE placeholder creator (`POST /chat/sessions`). A new creator that
 *    forgets it would be autotitled on its first exchange — this census reds instead.
 *
 * RED witness (2026-10-31, against `caabea6cf`): the board `'auto'` repair and the
 * `'given'` follow both failed (the helper only followed `'default'`). The rename-race
 * case reds when the write is a blind `updateChatSession` instead of the source CAS.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { deleteConversationMeta, ensureConversationMeta, refreshEntityChatTitle } from '../src/host/conversationStore.js';
import type { ChatSessionRecord } from '../src/types.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const storage = openSqliteStorage(':memory:');
const T = 't1';
const SID = 'room-1';
const CREATED = '2026-10-01T00:00:00.000Z';

async function seed(over: Partial<ChatSessionRecord>): Promise<void> {
  await storage.createChatSession({ sessionId: SID, tenantId: T, title: 'Q3 · board', createdAt: CREATED, updatedAt: CREATED, messageCount: 4, ...over });
}

describe('ADR 1019 D1 — refreshEntityChatTitle', () => {
  beforeEach(async () => {
    initHostExtPersistence(storage);
    await storage.deleteChatSession(T, SID);
    await deleteConversationMeta(T, SID);
  });
  afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });

  it("follows a 'given' room to the entity's new name", async () => {
    await seed({ titleSource: 'given' });
    await refreshEntityChatTitle(storage, T, SID, 'Q4 · board');
    expect(await storage.getChatSession(T, SID)).toMatchObject({ title: 'Q4 · board', titleSource: 'given' });
  });

  it("repairs an entity-bound room the autotitler renamed ('auto' + boardId)", async () => {
    await seed({ title: 'Revenue Forecast Talk', titleSource: 'auto' });
    await ensureConversationMeta(T, SID, { type: 'group', boardId: 'b1', participants: [] });
    await refreshEntityChatTitle(storage, T, SID, 'Q3 · board');
    expect(await storage.getChatSession(T, SID)).toMatchObject({ title: 'Q3 · board', titleSource: 'given' });
  });

  it("repairs a project/notebook room ('auto' + ownerSubject)", async () => {
    await seed({ title: 'Model Guess', titleSource: 'auto' });
    await ensureConversationMeta(T, SID, { type: 'group', participants: [], ownerSubject: { kind: 'project', id: 'p1' } });
    await refreshEntityChatTitle(storage, T, SID, 'Launch · project');
    expect(await storage.getChatSession(T, SID)).toMatchObject({ title: 'Launch · project', titleSource: 'given' });
  });

  it("leaves an 'auto' title on a plain chat alone", async () => {
    await seed({ title: 'Plain Auto Title', titleSource: 'auto' });
    await ensureConversationMeta(T, SID, { type: 'agent', participants: [] });
    await refreshEntityChatTitle(storage, T, SID, 'Q3 · board');
    expect(await storage.getChatSession(T, SID)).toMatchObject({ title: 'Plain Auto Title', titleSource: 'auto' });
  });

  for (const source of ['user', 'claimed'] as const) {
    it(`never touches a '${source}' title`, async () => {
      await seed({ title: 'Kept', titleSource: source });
      await ensureConversationMeta(T, SID, { type: 'group', boardId: 'b1', participants: [] });
      await refreshEntityChatTitle(storage, T, SID, 'Q3 · board');
      expect(await storage.getChatSession(T, SID)).toMatchObject({ title: 'Kept', titleSource: source });
    });
  }

  it("a person's rename landing between the read and the write keeps its title AND 'user'", async () => {
    await seed({ titleSource: 'given' });
    const racing: typeof storage = {
      ...storage,
      getChatSession: async (t: string, id: string) => {
        const rec = await storage.getChatSession(t, id);
        await storage.updateChatSession(t, id, { title: 'My Name', titleSource: 'user' });
        return rec;
      },
    };
    await refreshEntityChatTitle(racing, T, SID, 'Q4 · board');
    expect(await storage.getChatSession(T, SID)).toMatchObject({ title: 'My Name', titleSource: 'user' });
  });

  it('stamps a legacy same-name row without reordering the rail', async () => {
    await seed({});
    await refreshEntityChatTitle(storage, T, SID, 'Q3 · board');
    expect(await storage.getChatSession(T, SID)).toMatchObject({ title: 'Q3 · board', titleSource: 'given', updatedAt: CREATED });
  });
});

/** Every src file, recursively. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** The only creator that makes a PLACEHOLDER title: the main chat's POST, whose client
 *  sends the substring of the first message. Shrink-only. */
const PLACEHOLDER_CREATORS: ReadonlyMap<string, number> = new Map([['routes/chatSessions.ts', 1]]);

describe('ADR 1019 D1 — createChatSession census', () => {
  it("every creator but the placeholder POST writes titleSource 'given'", () => {
    const src = join(__dirname, '../src');
    const missing = new Map<string, number>();
    let total = 0;
    for (const file of walk(src)) {
      const rel = relative(src, file);
      if (rel.startsWith('storage/')) continue;
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/createChatSession\(\{/g)) {
        total += 1;
        const call = text.slice(m.index!, text.indexOf('})', m.index!) + 2);
        if (!call.includes("titleSource: 'given'")) missing.set(rel, (missing.get(rel) ?? 0) + 1);
      }
    }
    expect(total, 'the census must actually see the creators').toBeGreaterThanOrEqual(11);
    expect(Object.fromEntries(missing)).toEqual(Object.fromEntries(PLACEHOLDER_CREATORS));
  });
});
