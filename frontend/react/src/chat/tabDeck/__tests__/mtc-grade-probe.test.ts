/**
 * GRADING PROBE — "Multi-tab chat" (FEATURES.md ordinal 236, ADR 0140). Evidence
 * only. GREEN + CI-safe (pure reducer — no React, no I/O, no streaming).
 *
 * Witnesses Headline #1 — the working set is a HARD-BOUNDED, protection-aware
 * state machine, so N background tabs cannot grow SSE connections unboundedly and
 * an in-flight (streaming/active) stream is never the eviction victim:
 *   - opening beyond the soft cap EVICTS the LRU soft-evictable tab (bounded);
 *   - `selectEvictionVictim` never returns the ACTIVE tab nor a PROTECTED
 *     (streaming) id — the invariant that keeps eviction from dropping a live SSE.
 *
 * `tabDeckModel` is pure (no streaming knowledge), so this witnesses the SET-SIZE
 * bound the deck enforces before it ever opens a connection — the mechanism behind
 * the "bounded working set" claim (the connection-budget hazard the /grade-code
 * pass probed at the source).
 */
import { describe, it, expect } from 'vitest';
import {
  tabDeckReducer, emptyTabDeck, selectEvictionVictim, MAX_TABS_DEFAULT,
  type TabDeckState,
} from '../tabDeckModel.js';

const openN = (n: number, maxTabs = MAX_TABS_DEFAULT): TabDeckState => {
  let s = emptyTabDeck;
  for (let i = 1; i <= n; i++) s = tabDeckReducer(s, { type: 'open', sessionId: `s${i}`, maxTabs });
  return s;
};

describe('Multi-tab chat — bounded working set + protection (by execution)', () => {
  it('MTCP-1: opening beyond the soft cap stays bounded, evicting the LRU', () => {
    const s = openN(MAX_TABS_DEFAULT + 1); // open 9 with cap 8
    expect(s.tabs.length).toBe(MAX_TABS_DEFAULT); // bounded at 8, not 9
    expect(s.tabs.some((t) => t.sessionId === 's1')).toBe(false); // s1 (LRU) evicted
    expect(s.activeSessionId).toBe('s9'); // the just-opened tab is active
  });

  it('MTCP-2: the eviction victim is never the ACTIVE tab nor a PROTECTED (streaming) id', () => {
    const s = openN(MAX_TABS_DEFAULT); // 8 tabs, s8 active, s1 the LRU
    // s1 is "streaming" ⇒ protected. Victim must be the next-LRU (s2), never s1 or the active s8.
    const v = selectEvictionVictim(s, { protectedIds: new Set(['s1']) });
    expect(v).not.toBeNull();
    expect(v?.sessionId).not.toBe('s1'); // protected/streaming tab spared
    expect(v?.sessionId).not.toBe(s.activeSessionId); // active tab spared
    expect(v?.sessionId).toBe('s2'); // the LRU among evictable
  });

  it('MTCP-3 (control): below the cap nothing is evicted', () => {
    expect(selectEvictionVictim(openN(3))).toBeNull();
  });
});
