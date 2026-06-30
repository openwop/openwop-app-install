import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTabDeck } from '../useTabDeck.js';
import { saveTabDeck, loadTabDeck } from '../tabDeckPersistence.js';

/** Thin wiring tests — the state-machine logic itself is pinned by tabDeckModel.test.ts. */
describe('useTabDeck — hook wiring', () => {
  it('openTab adds + activates; focusTab/closeTab dispatch through', () => {
    const { result } = renderHook(() => useTabDeck({ maxTabs: 3 }));
    act(() => { result.current.openTab('a'); });
    act(() => { result.current.openTab('b'); });
    expect(result.current.tabs.map((t) => t.sessionId)).toEqual(['a', 'b']);
    expect(result.current.activeSessionId).toBe('b');

    act(() => { result.current.focusTab('a'); });
    expect(result.current.activeSessionId).toBe('a');

    act(() => { result.current.closeTab('a'); });
    expect(result.current.tabs.map((t) => t.sessionId)).toEqual(['b']);
    expect(result.current.activeSessionId).toBe('b');
  });

  it('respects the maxTabs cap with LRU eviction via the hook', () => {
    const { result } = renderHook(() => useTabDeck({ maxTabs: 2 }));
    act(() => { result.current.openTab('a'); });
    act(() => { result.current.openTab('b'); });
    act(() => { result.current.openTab('c'); }); // evicts LRU 'a'
    expect(result.current.tabs.map((t) => t.sessionId).sort()).toEqual(['b', 'c']);
  });

  it('protectedIds (streaming) survives eviction through the hook', () => {
    const { result } = renderHook(() => useTabDeck({ maxTabs: 3 }));
    act(() => { result.current.openTab('a'); }); // 'a' is LRU
    act(() => { result.current.openTab('b'); });
    act(() => { result.current.openTab('c'); }); // 'c' active
    // Open 'd': 'a' is LRU but protected → next LRU 'b' is evicted, 'a' survives.
    act(() => { result.current.openTab('d', new Set(['a'])); });
    expect(result.current.tabs.map((t) => t.sessionId).sort()).toEqual(['a', 'c', 'd']);
  });
});

describe('useTabDeck — persistence (ADR 0140 P6)', () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('restores a saved working set on init and exposes restoredSessionIds', () => {
    saveTabDeck({ tabs: [{ sessionId: 'x', pinned: false, lastActiveSeq: 1 }, { sessionId: 'y', pinned: true, lastActiveSeq: 2 }], activeSessionId: 'y', seq: 2 }, 'u1');
    const { result } = renderHook(() => useTabDeck({ persistSubject: 'u1' }));
    expect(result.current.tabs.map((t) => t.sessionId)).toEqual(['x', 'y']);
    expect(result.current.activeSessionId).toBe('y');
    expect(result.current.restoredSessionIds).toEqual(['x', 'y']);
  });

  it('persists changes (debounced) under the user key', () => {
    const { result } = renderHook(() => useTabDeck({ persistSubject: 'u1' }));
    act(() => { result.current.openTab('a'); });
    act(() => { vi.advanceTimersByTime(500); }); // flush the debounce
    expect(loadTabDeck('u1')?.tabs.map((t) => t.sessionId)).toEqual(['a']);
  });

  it('does NOT persist when there is no subject (logged out)', () => {
    const { result } = renderHook(() => useTabDeck({ persistSubject: null }));
    act(() => { result.current.openTab('a'); });
    act(() => { vi.advanceTimersByTime(500); });
    expect(localStorage.length).toBe(0);
  });
});
