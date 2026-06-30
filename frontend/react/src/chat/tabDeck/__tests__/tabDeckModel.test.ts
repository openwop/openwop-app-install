import { describe, it, expect } from 'vitest';
import {
  tabDeckReducer,
  selectEvictionVictim,
  emptyTabDeck,
  MAX_TABS_DEFAULT,
  HARD_MAX_TABS,
  type TabDeckState,
} from '../tabDeckModel.js';

/** Build a deck by replaying `open` actions (so recency/seq are realistic). */
function deckOf(ids: string[], maxTabs = 100): TabDeckState {
  return ids.reduce((s, id) => tabDeckReducer(s, { type: 'open', sessionId: id, maxTabs }), emptyTabDeck);
}
const ids = (s: TabDeckState) => s.tabs.map((t) => t.sessionId);

describe('tabDeckModel — open / dedupe / focus', () => {
  it('open adds a tab and makes it active', () => {
    const s = tabDeckReducer(emptyTabDeck, { type: 'open', sessionId: 'a' });
    expect(ids(s)).toEqual(['a']);
    expect(s.activeSessionId).toBe('a');
  });

  it('open on an already-open id dedupes → focuses, no duplicate', () => {
    const s = deckOf(['a', 'b']);
    const next = tabDeckReducer(s, { type: 'open', sessionId: 'a' });
    expect(ids(next)).toEqual(['a', 'b']); // no second 'a'
    expect(next.activeSessionId).toBe('a');
    expect(next.seq).toBeGreaterThan(s.seq); // recency bumped
  });

  it('focus on an unknown id is a no-op', () => {
    const s = deckOf(['a']);
    expect(tabDeckReducer(s, { type: 'focus', sessionId: 'zzz' })).toBe(s);
  });

  it('focus on the already-active MRU tab is an identity no-op (bailout)', () => {
    const s = deckOf(['a', 'b']); // b active + MRU (lastActiveSeq === seq)
    expect(tabDeckReducer(s, { type: 'focus', sessionId: 'b' })).toBe(s);
  });

  it('focus bumps recency and sets active', () => {
    const s = deckOf(['a', 'b']); // b active, b is MRU
    const next = tabDeckReducer(s, { type: 'focus', sessionId: 'a' });
    expect(next.activeSessionId).toBe('a');
    const a = next.tabs.find((t) => t.sessionId === 'a')!;
    const b = next.tabs.find((t) => t.sessionId === 'b')!;
    expect(a.lastActiveSeq).toBeGreaterThan(b.lastActiveSeq);
  });
});

describe('tabDeckModel — LRU eviction at the soft cap', () => {
  it('opening beyond the soft cap evicts the least-recently-used tab', () => {
    // Fill to the cap, then touch 'a' so the LRU is 'b'.
    let s = deckOf(['a', 'b', 'c'], 3);
    s = tabDeckReducer(s, { type: 'focus', sessionId: 'a' }); // recency: c<...,b oldest? order: a,b,c opened; b less recent than c; then focus a → MRU a
    // LRU is now 'b' (opened 2nd, never re-focused; c opened 3rd).
    const next = tabDeckReducer(s, { type: 'open', sessionId: 'd', maxTabs: 3 });
    expect(ids(next).sort()).toEqual(['a', 'c', 'd']);
    expect(next.activeSessionId).toBe('d');
  });

  it('never evicts the active tab', () => {
    const s = deckOf(['a', 'b', 'c'], 3); // c active
    const next = tabDeckReducer(s, { type: 'open', sessionId: 'd', maxTabs: 3 });
    expect(ids(next)).toContain('c'); // active survives
    expect(next.tabs.length).toBe(3);
  });

  it('never evicts a pinned tab at the soft cap (allows overflow instead)', () => {
    let s = deckOf(['a', 'b', 'c'], 3);
    s = tabDeckReducer(s, { type: 'setPinned', sessionId: 'a', pinned: true });
    s = tabDeckReducer(s, { type: 'setPinned', sessionId: 'b', pinned: true });
    // a,b pinned; c active → no soft-evictable tab → overflow to 4.
    const next = tabDeckReducer(s, { type: 'open', sessionId: 'd', maxTabs: 3 });
    expect(next.tabs.length).toBe(4);
    expect(ids(next).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('never evicts a streaming (protected) tab', () => {
    const s = deckOf(['a', 'b', 'c'], 3); // c active; a is LRU
    const next = tabDeckReducer(s, {
      type: 'open', sessionId: 'd', maxTabs: 3, protectedIds: new Set(['a']),
    });
    expect(ids(next)).toContain('a'); // protected survives; b (next LRU) evicted
    expect(ids(next).sort()).toEqual(['a', 'c', 'd']);
  });
});

describe('tabDeckModel — the hard ceiling', () => {
  it('sacrifices an LRU pinned-idle tab at the hard ceiling', () => {
    // Fill to exactly the hard ceiling WITHOUT eviction (high maxTabs during fill).
    let s = deckOf(Array.from({ length: HARD_MAX_TABS }, (_, i) => `t${i}`), 100);
    // Pin every non-active tab so the soft path can never find a victim.
    for (const t of s.tabs) if (t.sessionId !== s.activeSessionId) s = tabDeckReducer(s, { type: 'setPinned', sessionId: t.sessionId, pinned: true });
    expect(s.tabs.length).toBe(HARD_MAX_TABS);
    const victim = selectEvictionVictim(s, { maxTabs: 4 });
    expect(victim?.kind).toBe('hard');
    const next = tabDeckReducer(s, { type: 'open', sessionId: 'overflow', maxTabs: 4 });
    expect(next.tabs.length).toBe(HARD_MAX_TABS); // held at the ceiling
    expect(ids(next)).toContain('overflow');
  });

  it('does NOT evict a streaming tab even at the hard ceiling (allows growth)', () => {
    let s = deckOf(Array.from({ length: HARD_MAX_TABS }, (_, i) => `t${i}`), 100);
    const allStreaming = new Set(s.tabs.map((t) => t.sessionId));
    const victim = selectEvictionVictim(s, { maxTabs: 4, protectedIds: allStreaming });
    expect(victim).toBeNull(); // degenerate: nothing sacrificable → grow rather than kill a live run
    const next = tabDeckReducer(s, { type: 'open', sessionId: 'overflow', maxTabs: 4, protectedIds: allStreaming });
    expect(next.tabs.length).toBe(HARD_MAX_TABS + 1);
  });
});

describe('tabDeckModel — close + neighbor activation', () => {
  it('closing the active tab activates the RIGHT neighbor', () => {
    let s = deckOf(['a', 'b', 'c']);
    s = tabDeckReducer(s, { type: 'focus', sessionId: 'b' }); // b active (middle)
    const next = tabDeckReducer(s, { type: 'close', sessionId: 'b' });
    expect(ids(next)).toEqual(['a', 'c']);
    expect(next.activeSessionId).toBe('c'); // right neighbor
  });

  it('closing the active RIGHTMOST tab falls back to the LEFT neighbor', () => {
    const s = deckOf(['a', 'b', 'c']); // c active (rightmost)
    const next = tabDeckReducer(s, { type: 'close', sessionId: 'c' });
    expect(ids(next)).toEqual(['a', 'b']);
    expect(next.activeSessionId).toBe('b'); // left neighbor
  });

  it('closing the only tab empties the deck', () => {
    const s = deckOf(['a']);
    const next = tabDeckReducer(s, { type: 'close', sessionId: 'a' });
    expect(next.tabs).toEqual([]);
    expect(next.activeSessionId).toBeNull();
  });

  it('closing a NON-active tab leaves active + recency untouched', () => {
    const s = deckOf(['a', 'b', 'c']); // c active
    const next = tabDeckReducer(s, { type: 'close', sessionId: 'a' });
    expect(ids(next)).toEqual(['b', 'c']);
    expect(next.activeSessionId).toBe('c');
    expect(next.seq).toBe(s.seq); // no activation happened
  });

  it('closing an unknown id is a no-op', () => {
    const s = deckOf(['a']);
    expect(tabDeckReducer(s, { type: 'close', sessionId: 'zzz' })).toBe(s);
  });
});

describe('tabDeckModel — reorder', () => {
  it('moves a tab to index 0', () => {
    const s = deckOf(['a', 'b', 'c']);
    expect(ids(tabDeckReducer(s, { type: 'reorder', fromSessionId: 'c', toIndex: 0 }))).toEqual(['c', 'a', 'b']);
  });

  it('moves a tab to the end (clamped)', () => {
    const s = deckOf(['a', 'b', 'c']);
    expect(ids(tabDeckReducer(s, { type: 'reorder', fromSessionId: 'a', toIndex: 99 }))).toEqual(['b', 'c', 'a']);
  });

  it('moves right past its original position correctly (post-removal index)', () => {
    const s = deckOf(['a', 'b', 'c', 'd']);
    // Move 'a' to index 2 in the post-removal array [b,c,d] → b,c,a,d
    expect(ids(tabDeckReducer(s, { type: 'reorder', fromSessionId: 'a', toIndex: 2 }))).toEqual(['b', 'c', 'a', 'd']);
  });

  it('reorder of an unknown id is a no-op', () => {
    const s = deckOf(['a', 'b']);
    expect(tabDeckReducer(s, { type: 'reorder', fromSessionId: 'zzz', toIndex: 0 })).toBe(s);
  });

  it('reorder with length 1 is a no-op', () => {
    const s = deckOf(['a']);
    expect(tabDeckReducer(s, { type: 'reorder', fromSessionId: 'a', toIndex: 0 })).toBe(s);
  });

  it('reorder to the SAME slot preserves identity (no churn)', () => {
    const s = deckOf(['a', 'b', 'c']); // 'b' is at index 1
    expect(tabDeckReducer(s, { type: 'reorder', fromSessionId: 'b', toIndex: 1 })).toBe(s);
  });
});

describe('tabDeckModel — pinned', () => {
  it('setPinned toggles and protects from soft eviction; unknown id no-op', () => {
    let s = deckOf(['a', 'b']);
    s = tabDeckReducer(s, { type: 'setPinned', sessionId: 'a', pinned: true });
    expect(s.tabs.find((t) => t.sessionId === 'a')!.pinned).toBe(true);
    expect(tabDeckReducer(s, { type: 'setPinned', sessionId: 'zzz', pinned: true })).toBe(s);
    // Unchanged value preserves identity (no churn for memoized children).
    expect(tabDeckReducer(s, { type: 'setPinned', sessionId: 'a', pinned: true })).toBe(s);
  });

  it('selectEvictionVictim returns null when there is room', () => {
    expect(selectEvictionVictim(deckOf(['a']), { maxTabs: MAX_TABS_DEFAULT })).toBeNull();
  });
});

describe('tabDeckModel — rekey (in-place id swap on /clear)', () => {
  it('replaces the id in place, preserving slot + active', () => {
    let s = deckOf(['a', 'b', 'c']);
    s = tabDeckReducer(s, { type: 'focus', sessionId: 'b' }); // b active, slot 1
    const next = tabDeckReducer(s, { type: 'rekey', fromSessionId: 'b', toSessionId: 'b2' });
    expect(ids(next)).toEqual(['a', 'b2', 'c']); // same slot
    expect(next.activeSessionId).toBe('b2'); // active carried
  });

  it('no-ops on unknown from, collision, or identity', () => {
    const s = deckOf(['a', 'b']);
    expect(tabDeckReducer(s, { type: 'rekey', fromSessionId: 'zzz', toSessionId: 'q' })).toBe(s);
    expect(tabDeckReducer(s, { type: 'rekey', fromSessionId: 'a', toSessionId: 'b' })).toBe(s); // collision
    expect(tabDeckReducer(s, { type: 'rekey', fromSessionId: 'a', toSessionId: 'a' })).toBe(s); // identity
  });

  it('rekey carries the cached lastTitle to the new id (G4)', () => {
    let s = deckOf(['a']);
    s = tabDeckReducer(s, { type: 'setTitle', sessionId: 'a', title: 'Plan' });
    const next = tabDeckReducer(s, { type: 'rekey', fromSessionId: 'a', toSessionId: 'a2' });
    expect(next.tabs[0]!.lastTitle).toBe('Plan');
  });
});

describe('tabDeckModel — setTitle (G4 title cache)', () => {
  it('caches a title; no-op on unknown / unchanged / empty (identity-preserved)', () => {
    let s = deckOf(['a']);
    s = tabDeckReducer(s, { type: 'setTitle', sessionId: 'a', title: 'My chat' });
    expect(s.tabs[0]!.lastTitle).toBe('My chat');
    expect(tabDeckReducer(s, { type: 'setTitle', sessionId: 'a', title: 'My chat' })).toBe(s); // unchanged
    expect(tabDeckReducer(s, { type: 'setTitle', sessionId: 'a', title: '' })).toBe(s); // empty
    expect(tabDeckReducer(s, { type: 'setTitle', sessionId: 'zzz', title: 'x' })).toBe(s); // unknown
  });
});
