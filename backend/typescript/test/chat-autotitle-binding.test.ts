/**
 * ADR 0151 Phase 2 — the first-exchange auto-title binding. Covers the security-
 * relevant wiring with the generator INJECTED (no provider coupling): the toggle gate
 * (fail-closed), the never-clobber-a-rename guard, title-once idempotency, the no-op
 * paths (no session / empty title), and the TOCTOU re-check (a rename mid-generation is
 * never overwritten). Uses real sqlite storage so the `titleSource` round-trip is real.
 *
 * The no-op gates are witnessed by COUNTING generator calls (fail-closed = no LLM call, not
 * just no write). The never-clobber logic is a triple guard (first `titleSource` gate →
 * post-generation re-read → the store CAS); the forced-window case puts a rename BETWEEN the
 * re-read and the CAS so the CAS + `if (won)` are witnessed through the binding.
 * Sabotage: drop the toggle / `titleSource` gates → a generator call is counted; announce on a
 * lost CAS (`if (won)` removed) or drop the CAS where-clause → the forced-window case reds.
 * Honest double guards (grade-tests w28): dropping the re-read alone is masked by the CAS (an
 * extra refused write is unobservable); dropping the `!chatSessionId` early return alone is
 * masked by `getChatSession(undefined)` → null.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import type { ChatSessionRecord } from '../src/types.js';
import type { Storage } from '../src/storage/storage.js';
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

/** A generator that records each call, so "no LLM call" is assertable. */
const countingGen = (out: string | null): { calls: string[]; generate: (t: string, u: string, r: string) => Promise<string | null> } => {
  const calls: string[] = [];
  return { calls, generate: async (_t, u) => { calls.push(u); return out; } };
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
    const gen = countingGen('Should Not Apply');
    await autotitleOnFirstExchange({
      tenantId: TENANT, userId: USER, chatSessionId: SID, userText: 'x', replyText: 'y',
      storage, onTitled, generate: gen.generate,
    });
    expect(gen.calls).toEqual([]); // fail-closed: no LLM call
    expect(titles).toEqual([]);
    expect((await storage.getChatSession(TENANT, SID))?.titleSource).toBeUndefined();
  });

  it('never clobbers a manual rename (titleSource=user)', async () => {
    await enableToggle('on');
    await seedSession({ title: 'My Renamed Chat', titleSource: 'user' });
    const { titles, onTitled } = collectTitled();
    const gen = countingGen('Auto Override');
    await autotitleOnFirstExchange({
      tenantId: TENANT, userId: USER, chatSessionId: SID, userText: 'x', replyText: 'y',
      storage, onTitled, generate: gen.generate,
    });
    expect(gen.calls).toEqual([]); // gated before the LLM call
    expect(titles).toEqual([]);
    expect((await storage.getChatSession(TENANT, SID))?.title).toBe('My Renamed Chat');
  });

  it('is idempotent — does not re-title an already auto-titled session', async () => {
    await enableToggle('on');
    await seedSession({ title: 'Existing Auto Title', titleSource: 'auto' });
    const { titles, onTitled } = collectTitled();
    const gen = countingGen('Second Title');
    await autotitleOnFirstExchange({
      tenantId: TENANT, userId: USER, chatSessionId: SID, userText: 'x', replyText: 'y',
      storage, onTitled, generate: gen.generate,
    });
    expect(gen.calls).toEqual([]); // gated before the LLM call
    expect(titles).toEqual([]);
    expect((await storage.getChatSession(TENANT, SID))?.title).toBe('Existing Auto Title');
  });

  it('is a no-op without a chat session id (conformance / older clients)', async () => {
    await enableToggle('on');
    const { titles, onTitled } = collectTitled();
    const gen = countingGen('Nope');
    await autotitleOnFirstExchange({
      tenantId: TENANT, userId: USER, chatSessionId: undefined, userText: 'x', replyText: 'y',
      storage, onTitled, generate: gen.generate,
    });
    expect(gen.calls).toEqual([]); // gated before the LLM call
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

  it('ATC-3/4 forced window — a rename landing BETWEEN the re-read and the write is never overwritten nor announced', async () => {
    await enableToggle('on');
    await seedSession();
    const { titles, onTitled } = collectTitled();
    // The binding reads the session twice (first gate, post-generation re-read). On the
    // SECOND read, return the still-default record and THEN commit a manual rename — so the
    // re-read passes and only the store CAS stands between the auto title and the rename.
    let reads = 0;
    const racing: Storage = {
      ...storage,
      getChatSession: async (tenantId, sessionId) => {
        const rec = await storage.getChatSession(tenantId, sessionId);
        reads += 1;
        if (reads === 2) await storage.updateChatSession(tenantId, sessionId, { title: 'User Won The Window', titleSource: 'user' });
        return rec;
      },
    };
    await autotitleOnFirstExchange({
      tenantId: TENANT, userId: USER, chatSessionId: SID, userText: 'x', replyText: 'y',
      storage: racing, onTitled, generate: async () => 'Auto Lost The Window',
    });
    expect(reads).toBe(2); // the window was actually forced (re-read happened, then the rename)
    expect(titles).toEqual([]); // a lost CAS is never announced
    const s = await storage.getChatSession(TENANT, SID);
    expect(s?.title).toBe('User Won The Window');
    expect(s?.titleSource).toBe('user');
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
