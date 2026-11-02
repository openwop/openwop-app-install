/**
 * ADR 0151 Phase 2 + ADR 1019 — the first-exchange auto-title binding, with the
 * dispatch resolver and the generator INJECTED (no provider coupling), on real sqlite
 * storage so `titleSource` round-trips for real.
 *
 * What it pins (each gate witnessed by COUNTING model calls — fail-closed means no call,
 * not just no write):
 *  - toggle OFF, no session id, not the first exchange (ADR 1019 D1), a renamed /
 *    source-given / already-titled / claimed session, an entity-bound legacy session
 *    (board, channel, DM, notebook/project ownerSubject, branch), and a conversation
 *    whose credential gives no dispatch (D3) ⇒ no call and no claim;
 *  - the claim (D2) moves ONLY title_source to 'claimed' before the call — the title
 *    and updatedAt are untouched while the model runs;
 *  - a failed call leaves 'claimed' + the placeholder, and a later first exchange of a
 *    fresh run for the same chat makes NO second call;
 *  - a rename during the call wins and is never announced (the 'claimed'-gated CAS).
 * Sabotage (2026-10-31, each reds a case): drop the `firstExchange` gate; drop the
 * `isPlainChat` guard; claim with casChatSessionTitle (title rewritten mid-call); move
 * the claim after the call; CAS on 'default' instead of 'claimed'; announce on a lost CAS.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { ensureConversationMeta, deleteConversationMeta } from '../src/host/conversationStore.js';
import type { ChatSessionRecord } from '../src/types.js';
import type { HeadlessDispatch } from '../src/host/headlessAi.js';
import { autotitleOnFirstExchange, type AutotitleParams } from '../src/features/chat-autotitle/binding.js';
import { chatAutotitleFeature } from '../src/features/chat-autotitle/feature.js';

const storage = openSqliteStorage(':memory:');
const TENANT = 't1';
const USER = 'u1';
const SID = 's1';
const PLACEHOLDER = 'hello there, can you help me with...';
const CREATED = '2026-10-01T00:00:00.000Z';

async function seedSession(over: Partial<ChatSessionRecord> = {}): Promise<void> {
  await storage.createChatSession({
    sessionId: SID, tenantId: TENANT, title: PLACEHOLDER,
    createdAt: CREATED, updatedAt: CREATED, messageCount: 1, ...over,
  });
}

async function toggleOff(): Promise<void> {
  await saveConfig({ id: 'chat-autotitle', status: 'off', bucketUnit: 'user', salt: 'chat-autotitle' }, 'test');
}

/** A distinct dispatch object per test, so an assertion can tell WHICH dispatch the
 *  generator got. */
const fakeDispatch = (): HeadlessDispatch => async () => 'unused';

/** Records every model call (the generator) and every resolve. */
function harness(out: string | null | (() => Promise<string | null>), over: Partial<AutotitleParams> = {}) {
  const calls: string[] = [];
  const resolves: unknown[] = [];
  const titles: string[] = [];
  const dispatch = fakeDispatch();
  const params: AutotitleParams = {
    tenantId: TENANT, userId: USER, chatSessionId: SID, firstExchange: true,
    credentialRef: 'managed:openwop-free', served: { provider: 'openwop-free', model: 'openwop-free', managed: true },
    userText: 'refactor auth', replyText: 'sure', storage,
    onTitled: (t) => titles.push(t),
    resolveDispatch: async (conv) => { resolves.push(conv); return dispatch; },
    generate: async (d, u) => {
      expect(d, 'the generator runs on the resolved dispatch').toBe(dispatch);
      calls.push(u);
      return typeof out === 'function' ? out() : out;
    },
    ...over,
  };
  return { params, calls, resolves, titles };
}

describe('ADR 0151 / 1019 — autotitleOnFirstExchange', () => {
  beforeAll(() => { registerToggleDefault(chatAutotitleFeature.toggleDefault!); });
  beforeEach(async () => {
    initHostExtPersistence(storage);
    await __clearToggleStore();
    await storage.deleteChatSession(TENANT, SID);
    await deleteConversationMeta(TENANT, SID);
  });
  afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });

  it('titles a placeholder chat on its first exchange and announces it', async () => {
    await seedSession();
    const h = harness('Refactor Auth Middleware');
    await autotitleOnFirstExchange(h.params);
    expect(h.calls).toEqual(['refactor auth']);
    expect(h.titles).toEqual(['Refactor Auth Middleware']);
    const s = await storage.getChatSession(TENANT, SID);
    expect(s?.title).toBe('Refactor Auth Middleware');
    expect(s?.titleSource).toBe('auto');
  });

  it('resolves the dispatch from the conversation credential and the acting person', async () => {
    await seedSession();
    const h = harness('T', { credentialRef: 'anthropic', served: { provider: 'anthropic', model: 'claude-x' } });
    await autotitleOnFirstExchange(h.params);
    expect(h.resolves).toEqual([{ tenantId: TENANT, credentialRef: 'anthropic', served: { provider: 'anthropic', model: 'claude-x' }, actingSubject: USER }]);
  });

  it('D1 — a later exchange is never titled, even on a placeholder', async () => {
    await seedSession();
    const h = harness('Late Title', { firstExchange: false });
    await autotitleOnFirstExchange(h.params);
    expect(h.calls).toEqual([]);
    expect((await storage.getChatSession(TENANT, SID))?.titleSource).toBeUndefined();
  });

  it('is a no-op when the toggle is OFF (fail-closed)', async () => {
    await toggleOff();
    await seedSession();
    const h = harness('Should Not Apply');
    await autotitleOnFirstExchange(h.params);
    expect(h.calls).toEqual([]);
    expect(h.resolves).toEqual([]);
    expect((await storage.getChatSession(TENANT, SID))?.titleSource).toBeUndefined();
  });

  it('is a no-op without a chat session id (conformance / older clients)', async () => {
    const h = harness('Nope', { chatSessionId: undefined });
    await autotitleOnFirstExchange(h.params);
    expect(h.calls).toEqual([]);
  });

  for (const source of ['user', 'given', 'auto', 'claimed'] as const) {
    it(`never calls the model for a '${source}' title`, async () => {
      await seedSession({ title: 'Named Already', titleSource: source });
      const h = harness('Override');
      await autotitleOnFirstExchange(h.params);
      expect(h.calls).toEqual([]);
      const s = await storage.getChatSession(TENANT, SID);
      expect(s?.title).toBe('Named Already');
      expect(s?.titleSource).toBe(source);
    });
  }

  const legacyEntityMetas: Array<[string, Parameters<typeof ensureConversationMeta>[2]]> = [
    ['an advisory-board room', { type: 'group', boardId: 'b1', participants: [] }],
    ['a channel', { type: 'channel', participants: [] }],
    ['a person DM', { type: 'person', participants: ['user:u2'], dmKey: 'user:u1|user:u2' }],
    ['an agent DM', { type: 'agent', participants: ['agent:iris'], dmKey: 'agent:iris|user:u1' }],
    ['a project/notebook room', { type: 'group', participants: [], ownerSubject: { kind: 'project', id: 'p1' } }],
    ['a branch', { type: 'agent', participants: [], branchedFrom: { conversationId: 'parent', fromSeq: 3 } }],
  ];
  for (const [label, meta] of legacyEntityMetas) {
    it(`D1 legacy guard — never renames ${label} created before 'given' (NULL title_source)`, async () => {
      await seedSession({ title: 'Q3 Planning · board' });
      await ensureConversationMeta(TENANT, SID, meta);
      const h = harness('Model Guess');
      await autotitleOnFirstExchange(h.params);
      expect(h.calls).toEqual([]);
      const s = await storage.getChatSession(TENANT, SID);
      expect(s?.title).toBe('Q3 Planning · board');
      expect(s?.titleSource).toBeUndefined();
    });
  }

  it('D1 legacy guard — a plain agent chat with a meta row is still titled', async () => {
    await seedSession();
    await ensureConversationMeta(TENANT, SID, { type: 'agent', ownerUserId: USER, participants: [] });
    const h = harness('Plain Chat Title');
    await autotitleOnFirstExchange(h.params);
    expect(h.titles).toEqual(['Plain Chat Title']);
  });

  it('D3 — no dispatch for this credential ⇒ no call and NO claim (still titleable later)', async () => {
    await seedSession();
    const h = harness('Never', { resolveDispatch: async () => null });
    await autotitleOnFirstExchange(h.params);
    expect(h.calls).toEqual([]);
    expect((await storage.getChatSession(TENANT, SID))?.titleSource).toBeUndefined();
  });

  it('D2 — claims before the call: during the call only title_source moved', async () => {
    await seedSession();
    let during: ChatSessionRecord | null = null;
    const h = harness(async () => { during = await storage.getChatSession(TENANT, SID); return 'After Claim'; });
    await autotitleOnFirstExchange(h.params);
    expect(during).toMatchObject({ title: PLACEHOLDER, titleSource: 'claimed', updatedAt: CREATED });
    expect((await storage.getChatSession(TENANT, SID))?.titleSource).toBe('auto');
  });

  it('D2 — a failed call keeps the placeholder, stays claimed, and is never repeated', async () => {
    await seedSession();
    const first = harness(null);
    await autotitleOnFirstExchange(first.params);
    expect(first.calls).toHaveLength(1);
    expect(first.titles).toEqual([]);
    const s = await storage.getChatSession(TENANT, SID);
    expect(s).toMatchObject({ title: PLACEHOLDER, titleSource: 'claimed' });
    // A fresh conversation run for the same chat (the client's dead-run self-heal)
    // has its own "first" exchange — it must not buy a second call.
    const again = harness('Second Try');
    await autotitleOnFirstExchange(again.params);
    expect(again.calls).toEqual([]);
  });

  it('D2 — two concurrent first exchanges make ONE model call', async () => {
    await seedSession();
    const a = harness('Title A');
    const b = harness('Title B');
    await Promise.all([autotitleOnFirstExchange(a.params), autotitleOnFirstExchange(b.params)]);
    expect(a.calls.length + b.calls.length).toBe(1);
    expect([...a.titles, ...b.titles]).toHaveLength(1);
  });

  it('a rename landing DURING the call wins and is never announced', async () => {
    await seedSession();
    const h = harness(async () => {
      await storage.updateChatSession(TENANT, SID, { title: 'User Won The Race', titleSource: 'user' });
      return 'Auto Lost The Race';
    });
    await autotitleOnFirstExchange(h.params);
    expect(h.titles).toEqual([]);
    const s = await storage.getChatSession(TENANT, SID);
    expect(s).toMatchObject({ title: 'User Won The Race', titleSource: 'user' });
  });
});

/**
 * ATC-3/4 — the auto-title write is now a `title_source`-gated CAS at the STORE layer,
 * so the sub-ms window between the binding's re-read and its write (and a concurrent
 * second autotitle pass) cannot clobber a manual rename. Tested directly against real
 * sqlite so the atomicity is real, not mocked.
 */
describe('ATC-3/4 — casChatSessionTitle (atomic, title_source-gated)', () => {
  const store = openSqliteStorage(':memory:'); // own instance — the block above closes `storage`
  const seed = async (over: Partial<ChatSessionRecord> = {}): Promise<void> => {
    const now = new Date().toISOString();
    await store.createChatSession({ sessionId: SID, tenantId: TENANT, title: 'placeholder', createdAt: now, updatedAt: now, messageCount: 1, ...over });
  };
  beforeEach(async () => { await store.deleteChatSession(TENANT, SID); });
  afterAll(async () => { await store.close(); });

  it('WINS on a fresh session (title_source NULL matches the default precondition)', async () => {
    await seed(); // no titleSource → stored NULL, read as "default"
    const won = await store.casChatSessionTitle(
      TENANT, SID, { title: 'Auto Title', titleSource: 'auto', updatedAt: new Date().toISOString() }, 'default',
    );
    expect(won).toBe(true);
    const s = await store.getChatSession(TENANT, SID);
    expect(s?.title).toBe('Auto Title');
    expect(s?.titleSource).toBe('auto');
  });

  it('is REFUSED (false, no clobber) when a manual rename already flipped title_source to user', async () => {
    await seed({ title: 'User Renamed', titleSource: 'user' });
    const won = await store.casChatSessionTitle(
      TENANT, SID, { title: 'Auto Title', titleSource: 'auto', updatedAt: new Date().toISOString() }, 'default',
    );
    expect(won).toBe(false); // precondition failed
    const s = await store.getChatSession(TENANT, SID);
    expect(s?.title).toBe('User Renamed'); // untouched
    expect(s?.titleSource).toBe('user');
  });

  it('returns false for an absent session', async () => {
    const won = await store.casChatSessionTitle(
      TENANT, SID, { title: 'X', titleSource: 'auto', updatedAt: new Date().toISOString() }, 'default',
    );
    expect(won).toBe(false);
  });
});

describe('ADR 1019 D2 — claimChatSessionTitleSource (title_source only)', () => {
  const store = openSqliteStorage(':memory:');
  beforeEach(async () => { await store.deleteChatSession(TENANT, SID); });
  afterAll(async () => { await store.close(); });

  it('moves NULL ("default") to claimed without touching title or updatedAt', async () => {
    await store.createChatSession({ sessionId: SID, tenantId: TENANT, title: 'placeholder', createdAt: CREATED, updatedAt: CREATED, messageCount: 1 });
    expect(await store.claimChatSessionTitleSource(TENANT, SID, 'default', 'claimed')).toBe(true);
    expect(await store.getChatSession(TENANT, SID)).toMatchObject({ title: 'placeholder', titleSource: 'claimed', updatedAt: CREATED });
  });

  it('refuses when title_source is not the expected value, and for an absent session', async () => {
    await store.createChatSession({ sessionId: SID, tenantId: TENANT, title: 'mine', createdAt: CREATED, updatedAt: CREATED, messageCount: 1, titleSource: 'user' });
    expect(await store.claimChatSessionTitleSource(TENANT, SID, 'default', 'claimed')).toBe(false);
    expect((await store.getChatSession(TENANT, SID))?.titleSource).toBe('user');
    expect(await store.claimChatSessionTitleSource(TENANT, 'absent', 'default', 'claimed')).toBe(false);
  });
});
