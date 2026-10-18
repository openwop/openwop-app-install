/**
 * ADR 0140 P6 (security) — persisted multi-tab working set. Per-user isolation is
 * two layers: the storage key carries the subject (`openwop-app.chat.tabdeck:<uid>`)
 * AND the envelope's `subject` must match the reader. Plus tamper repair: version
 * gate, malformed/duplicate tabs dropped, ghost active → most-recent, `seq` repaired,
 * clamp to HARD_MAX_TABS keeping pinned + most-recent in display order. Breaks if
 * either isolation layer, a repair, or the logged-out no-op is lost.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sanitizeTabDeck, loadTabDeck, saveTabDeck } from '../tabDeckPersistence.js';
import { HARD_MAX_TABS, type TabDeckState } from '../tabDeckModel.js';
import { LS_TABDECK_VERSION } from '../../lib/storageKeys.js';

const SUBJECT = 'user-1';
const tab = (id: string, pinned = false, seq = 1) => ({ sessionId: id, pinned, lastActiveSeq: seq });
const env = (state: unknown, v = LS_TABDECK_VERSION, subject = SUBJECT) => ({ v, subject, state });

beforeEach(() => localStorage.clear());

describe('sanitizeTabDeck — validation + repair', () => {
  it('round-trips a valid descriptor', () => {
    const state: TabDeckState = { tabs: [tab('a', true, 3), tab('b', false, 5)], activeSessionId: 'b', seq: 5 };
    expect(sanitizeTabDeck(env(state), SUBJECT)).toEqual(state);
  });

  it('carries lastTitle through (G4) and rejects a non-string title', () => {
    const withTitle = { ...tab('a', false, 1), lastTitle: 'Plan the launch' };
    const out = sanitizeTabDeck(env({ tabs: [withTitle], activeSessionId: 'a', seq: 1 }), SUBJECT)!;
    expect(out.tabs[0]!.lastTitle).toBe('Plan the launch');
    // A corrupt non-string lastTitle drops that tab (isDeckTab fails) → empty deck.
    const bad = sanitizeTabDeck(env({ tabs: [{ ...tab('a'), lastTitle: 42 }], activeSessionId: 'a', seq: 1 }), SUBJECT);
    expect(bad?.tabs).toEqual([]); // malformed tab dropped → empty working set
  });

  it('rejects a version mismatch', () => {
    expect(sanitizeTabDeck(env({ tabs: [tab('a')], activeSessionId: 'a', seq: 1 }, 999), SUBJECT)).toBeNull();
  });

  it('rejects a DIFFERENT user (per-user isolation)', () => {
    const state = { tabs: [tab('a')], activeSessionId: 'a', seq: 1 };
    expect(sanitizeTabDeck(env(state, LS_TABDECK_VERSION, 'someone-else'), SUBJECT)).toBeNull();
  });

  it('drops malformed tabs and de-dupes ids', () => {
    const raw = env({ tabs: [tab('a'), { sessionId: '' }, { nope: 1 }, tab('a'), tab('b')], activeSessionId: 'a', seq: 2 });
    const out = sanitizeTabDeck(raw, SUBJECT)!;
    expect(out.tabs.map((t) => t.sessionId)).toEqual(['a', 'b']);
  });

  it('defaults activeSessionId to the most-recent tab when the persisted one is a ghost', () => {
    const out = sanitizeTabDeck(env({ tabs: [tab('a', false, 1), tab('b', false, 9)], activeSessionId: 'ghost', seq: 9 }), SUBJECT)!;
    expect(out.activeSessionId).toBe('b'); // highest lastActiveSeq, not null
  });

  it('repairs the seq invariant (seq >= max lastActiveSeq)', () => {
    // A tampered payload where a tab seq exceeds the deck seq would corrupt LRU.
    const out = sanitizeTabDeck(env({ tabs: [tab('a', false, 50)], activeSessionId: 'a', seq: 0 }), SUBJECT)!;
    expect(out.seq).toBe(50);
  });

  it('clamps to HARD_MAX_TABS, keeping pinned + most-recent', () => {
    const tabs = Array.from({ length: HARD_MAX_TABS + 5 }, (_, i) => tab(`t${i}`, false, i));
    tabs[0] = tab('pinned-old', true, 0); // pinned but oldest — must survive the clamp
    const out = sanitizeTabDeck(env({ tabs, activeSessionId: 't1', seq: 100 }), SUBJECT)!;
    expect(out.tabs.length).toBe(HARD_MAX_TABS);
    // Kept: the pinned (oldest) tab + the 23 most-recent (t6..t28); t1..t5 dropped.
    // Display order is preserved among the kept.
    expect(out.tabs.map((t) => t.sessionId)).toEqual(
      ['pinned-old', ...Array.from({ length: HARD_MAX_TABS - 1 }, (_, i) => `t${i + 6}`)],
    );
  });

  it('treats corrupt / non-object payloads as null', () => {
    expect(sanitizeTabDeck(null, SUBJECT)).toBeNull();
    expect(sanitizeTabDeck('nope', SUBJECT)).toBeNull();
    expect(sanitizeTabDeck(env({ tabs: 'not-array' }), SUBJECT)).toBeNull();
  });
});

describe('load / save round-trip', () => {
  it('saves under the per-user key and loads it back', () => {
    const state: TabDeckState = { tabs: [tab('a', false, 1)], activeSessionId: 'a', seq: 1 };
    saveTabDeck(state, SUBJECT);
    // Literal key (never computed with tabDeckKey, which is under test).
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem('openwop-app.chat.tabdeck:user-1')).not.toBeNull();
    expect(loadTabDeck(SUBJECT)).toEqual(state);
    // A different user reads nothing from the same browser.
    expect(loadTabDeck('user-2')).toBeNull();
  });

  it('a second user saves under their OWN key and neither overwrites the other', () => {
    const one: TabDeckState = { tabs: [tab('a', false, 1)], activeSessionId: 'a', seq: 1 };
    const two: TabDeckState = { tabs: [tab('z', false, 1)], activeSessionId: 'z', seq: 1 };
    saveTabDeck(one, SUBJECT);
    saveTabDeck(two, 'user-2');
    expect(localStorage.length).toBe(2);
    expect(localStorage.getItem('openwop-app.chat.tabdeck:user-2')).not.toBeNull();
    expect(loadTabDeck(SUBJECT)).toEqual(one);
    expect(loadTabDeck('user-2')).toEqual(two);
  });

  it('save is a no-op when logged out (subject null)', () => {
    saveTabDeck({ tabs: [tab('a')], activeSessionId: 'a', seq: 1 }, null);
    expect(localStorage.length).toBe(0);
  });
});
