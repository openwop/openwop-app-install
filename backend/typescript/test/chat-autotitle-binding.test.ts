/**
 * ADR 0151 Phase 2 — the first-exchange auto-title binding. Covers the security-
 * relevant wiring with the generator INJECTED (no provider coupling): the toggle gate
 * (fail-closed), the never-clobber-a-rename guard, title-once idempotency, the no-op
 * paths (no session / empty title), and the TOCTOU re-check (a rename mid-generation is
 * never overwritten). Uses real sqlite storage so the `titleSource` round-trip is real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import type { ChatSessionRecord } from '../src/types.js';
import { autotitleOnFirstExchange } from '../src/features/chat-autotitle/binding.js';
import { chatAutotitleFeature } from '../src/features/chat-autotitle/feature.js';

const storage = openSqliteStorage(':memory:');
const TENANT = 't1';
const USER = 'u1';
const SID = 's1';

async function seedSession(over: Partial<ChatSessionRecord> = {}): Promise<void> {
  const now = new Date().toISOString();
  await storage.createChatSession({
    sessionId: SID, tenantId: TENANT, title: 'hello there, can you help me with...',
    createdAt: now, updatedAt: now, messageCount: 1, ...over,
  });
}

/** The registered default is `status:'on'`, so an empty store ⇒ enabled. An OFF case
 *  layers a stored override; clearing the store reverts to the ON default. */
async function enableToggle(status: 'on' | 'off' = 'on'): Promise<void> {
  if (status === 'off') {
    await saveConfig({ id: 'chat-autotitle', status: 'off', bucketUnit: 'user', salt: 'chat-autotitle' }, 'test');
  }
}

const collectTitled = (): { titles: string[]; onTitled: (t: string) => void } => {
  const titles: string[] = [];
  return { titles, onTitled: (t) => titles.push(t) };
};

describe('ADR 0151 — autotitleOnFirstExchange', () => {
  beforeAll(() => { registerToggleDefault(chatAutotitleFeature.toggleDefault!); });
  beforeEach(async () => {
    initHostExtPersistence(storage);
    await __clearToggleStore();
    await storage.deleteChatSession(TENANT, SID);
  });
  afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });

  it('titles a default-placeholder session and emits the event (toggle ON)', async () => {
    await enableToggle('on');
    await seedSession();
    const { titles, onTitled } = collectTitled();
    await autotitleOnFirstExchange({
      tenantId: TENANT, userId: USER, chatSessionId: SID, userText: 'refactor auth', replyText: 'sure',
      storage, onTitled, generate: async () => 'Refactor Auth Middleware',
    });
    expect(titles).toEqual(['Refactor Auth Middleware']);
    const s = await storage.getChatSession(TENANT, SID);
    expect(s?.title).toBe('Refactor Auth Middleware');
    expect(s?.titleSource).toBe('auto');
  });

  it('is a no-op when the toggle is OFF (fail-closed)', async () => {
    await enableToggle('off');
    await seedSession();
    const { titles, onTitled } = collectTitled();
    await autotitleOnFirstExchange({
      tenantId: TENANT, userId: USER, chatSessionId: SID, userText: 'x', replyText: 'y',
      storage, onTitled, generate: async () => 'Should Not Apply',
    });
    expect(titles).toEqual([]);
    expect((await storage.getChatSession(TENANT, SID))?.titleSource).toBeUndefined();
  });

  it('never clobbers a manual rename (titleSource=user)', async () => {
    await enableToggle('on');
    await seedSession({ title: 'My Renamed Chat', titleSource: 'user' });
    const { titles, onTitled } = collectTitled();
    await autotitleOnFirstExchange({
      tenantId: TENANT, userId: USER, chatSessionId: SID, userText: 'x', replyText: 'y',
      storage, onTitled, generate: async () => 'Auto Override',
    });
    expect(titles).toEqual([]);
    expect((await storage.getChatSession(TENANT, SID))?.title).toBe('My Renamed Chat');
  });

  it('is idempotent — does not re-title an already auto-titled session', async () => {
    await enableToggle('on');
    await seedSession({ title: 'Existing Auto Title', titleSource: 'auto' });
    const { titles, onTitled } = collectTitled();
    await autotitleOnFirstExchange({
      tenantId: TENANT, userId: USER, chatSessionId: SID, userText: 'x', replyText: 'y',
      storage, onTitled, generate: async () => 'Second Title',
    });
    expect(titles).toEqual([]);
    expect((await storage.getChatSession(TENANT, SID))?.title).toBe('Existing Auto Title');
  });

  it('is a no-op without a chat session id (conformance / older clients)', async () => {
    await enableToggle('on');
    const { titles, onTitled } = collectTitled();
    await autotitleOnFirstExchange({
      tenantId: TENANT, userId: USER, chatSessionId: undefined, userText: 'x', replyText: 'y',
      storage, onTitled, generate: async () => 'Nope',
    });
    expect(titles).toEqual([]);
  });

  it('leaves the placeholder when the generator returns null (degrade, never worse)', async () => {
    await enableToggle('on');
    await seedSession();
    const { titles, onTitled } = collectTitled();
    await autotitleOnFirstExchange({
      tenantId: TENANT, userId: USER, chatSessionId: SID, userText: 'x', replyText: 'y',
      storage, onTitled, generate: async () => null,
    });
    expect(titles).toEqual([]);
    expect((await storage.getChatSession(TENANT, SID))?.titleSource).toBeUndefined();
  });

  it('TOCTOU — a rename landing DURING generation is never overwritten', async () => {
    await enableToggle('on');
    await seedSession();
    const { titles, onTitled } = collectTitled();
    await autotitleOnFirstExchange({
      tenantId: TENANT, userId: USER, chatSessionId: SID, userText: 'x', replyText: 'y',
      storage, onTitled,
      // Simulate a manual rename committing while the LLM call is in flight.
      generate: async () => {
        await storage.updateChatSession(TENANT, SID, { title: 'User Won The Race', titleSource: 'user' });
        return 'Auto Lost The Race';
      },
    });
    expect(titles).toEqual([]);
    expect((await storage.getChatSession(TENANT, SID))?.title).toBe('User Won The Race');
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
