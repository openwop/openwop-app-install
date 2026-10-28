/**
 * useTabDeck — the thin React wrapper over the pure {@link tabDeckReducer}
 * (ADR 0140 P2). It owns the working-set state machine and nothing else: the
 * conversation content comes from `sessionsCollection`, and streaming knowledge
 * (`protectedIds`) is supplied per `openTab` call by the keep-alive container (P3).
 *
 * Eviction is `log()`-loud (ADR 0140 "no silent truncation"): before an `open`
 * that would evict, we ask the pure selector who the victim is and warn in dev.
 */

import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  tabDeckReducer,
  selectEvictionVictim,
  canOpenTab,
  emptyTabDeck,
  MAX_TABS_DEFAULT,
  type TabDeckState,
} from './tabDeckModel.js';
import { loadWorkspaceTabDeck, saveTabDeck } from './tabDeckPersistence.js';

export interface UseTabDeckResult {
  tabs: TabDeckState['tabs'];
  activeSessionId: string | null;
  /** Open (or focus, if already open) a conversation as a tab. `protectedIds` =
   *  the sessions that must not be evicted (running or waiting on the user, ADR 0978
   *  D1). Returns false when the open was REFUSED at the hard ceiling (D2). */
  openTab: (sessionId: string, protectedIds?: ReadonlySet<string>, kind?: string) => boolean;
  /** Whether `openTab` would take effect — checked by callers BEFORE their own side
   *  effects (a kind seed, a deep-link scope), so a refusal leaves nothing behind. */
  canOpen: (sessionId: string, protectedIds?: ReadonlySet<string>) => boolean;
  closeTab: (sessionId: string) => void;
  focusTab: (sessionId: string) => void;
  /** Move `fromSessionId` to `toIndex` (final index in the post-removal order). */
  reorderTab: (fromSessionId: string, toIndex: number) => void;
  setPinned: (sessionId: string, pinned: boolean) => void;
  /** Re-key a tab in place when its session mints a new id (`/clear`). */
  rekeyTab: (fromSessionId: string, toSessionId: string) => void;
  /** Cache a tab's last-known title so it persists + restores (ADR 0140 G4). */
  setTitle: (sessionId: string, title: string) => void;
  /** The CONVERSATION tab ids present at restore (from persistence), for the deck's
   *  dead-tab prune and mount gate. Kind tabs are excluded — they name no conversation.
   *  Empty when not persisted / fresh. */
  restoredSessionIds: readonly string[];
  /** ADR 0978 D4 — the restore adopted the legacy uid-only descriptor. */
  adoptedLegacy: boolean;
}

export function useTabDeck(
  opts: {
    maxTabs?: number;
    initial?: TabDeckState;
    persistSubject?: string | null;
    /** ADR 0978 D4 — the pre-workspace uid-only subject, adopted when
     *  `persistSubject` has no descriptor yet. */
    legacySubject?: string | null;
    /** Notified when an `open` evicts a tab from the working set (LRU soft cap / hard
     *  ceiling). The deck surfaces this to the user (no silent truncation, ADR 0140);
     *  read via a ref so it doesn't destabilise `openTab`. */
    onEvict?: (sessionId: string, kind: 'soft' | 'hard') => void;
    /** Notified when an `open` is refused at the hard ceiling (ADR 0978 D2). */
    onRefuse?: () => void;
  } = {},
): UseTabDeckResult {
  const maxTabs = opts.maxTabs ?? MAX_TABS_DEFAULT;
  const persistSubject = opts.persistSubject ?? null;
  const onEvictRef = useRef(opts.onEvict);
  onEvictRef.current = opts.onEvict;
  const onRefuseRef = useRef(opts.onRefuse);
  onRefuseRef.current = opts.onRefuse;
  // Lazy init: restore the per-user working set when persisting (ADR 0140 P6), else the
  // provided initial / empty.
  const adoptedLegacyRef = useRef(false);
  const [state, dispatch] = useReducer(
    tabDeckReducer,
    opts.initial ?? emptyTabDeck,
    (init) => {
      if (!persistSubject) return init;
      const loaded = loadWorkspaceTabDeck(persistSubject, opts.legacySubject ?? null);
      adoptedLegacyRef.current = loaded.adoptedLegacy;
      return loaded.state ?? init;
    },
  );
  // Mirror the latest state so the stable `openTab` can read it for the eviction
  // log without depending on `state` (which would re-create every callback per tick).
  const stateRef = useRef(state);
  stateRef.current = state;
  // The restored id set is captured once (first render holds the restored state).
  // CONVERSATION tabs only: the deck gates their mount on, and prunes them against,
  // the conversation list. A kind tab (ADR 0785 D5, e.g. `claude-code`) is never in
  // that list, so counting it here closed every restored Claude Code tab on the next
  // visit to the chat — and the close ran the kind's `onClose`, which STOPS the
  // session on the user's machine (observed 2026-10-05, the first prod session).
  const restoredIdsRef = useRef<readonly string[]>(state.tabs.filter((t) => !t.kind).map((t) => t.sessionId));

  // Persist (ADR 0140 P6): debounced trailing save (~400ms) so a focus/open burst writes
  // once; flush immediately on pagehide (reload/close) and on unmount (toggle off / nav).
  useEffect(() => {
    if (!persistSubject) return;
    const id = setTimeout(() => saveTabDeck(stateRef.current, persistSubject), 400);
    return () => clearTimeout(id);
  }, [state, persistSubject]);
  useEffect(() => {
    if (!persistSubject) return;
    const flush = (): void => saveTabDeck(stateRef.current, persistSubject);
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, [persistSubject]);

  const canOpen = useCallback((sessionId: string, protectedIds?: ReadonlySet<string>) =>
    canOpenTab(stateRef.current, sessionId, { maxTabs, ...(protectedIds ? { protectedIds } : {}) }), [maxTabs]);

  const openTab = useCallback((sessionId: string, protectedIds?: ReadonlySet<string>, kind?: string): boolean => {
    if (stateRef.current.tabs.some((t) => t.sessionId === sessionId)) {
      dispatch({ type: 'focus', sessionId });
      return true;
    }
    const victim = selectEvictionVictim(stateRef.current, { maxTabs, ...(protectedIds ? { protectedIds } : {}) });
    if (victim?.kind === 'refuse') {
      onRefuseRef.current?.();
      return false;
    }
    if (victim) {
      // No silent truncation (ADR 0140): tell the deck so it can surface a toast in prod,
      // not just a DEV console.warn (a tab vanishing unannounced is disorienting).
      onEvictRef.current?.(victim.sessionId, victim.kind);
      if (import.meta.env?.DEV) {
        console.warn(
          `[tabDeck] working set at capacity (${stateRef.current.tabs.length}/${maxTabs}); evicting ${victim.kind} tab ${victim.sessionId} to open ${sessionId}. It stays in the sidebar and reopens from the backend.`,
        );
      }
    }
    dispatch({ type: 'open', sessionId, ...(protectedIds ? { protectedIds } : {}), maxTabs, ...(kind ? { kind } : {}) });
    return true;
  }, [maxTabs]);

  const closeTab = useCallback((sessionId: string) => dispatch({ type: 'close', sessionId }), []);
  const focusTab = useCallback((sessionId: string) => dispatch({ type: 'focus', sessionId }), []);
  const reorderTab = useCallback((fromSessionId: string, toIndex: number) => dispatch({ type: 'reorder', fromSessionId, toIndex }), []);
  const setPinned = useCallback((sessionId: string, pinned: boolean) => dispatch({ type: 'setPinned', sessionId, pinned }), []);
  const rekeyTab = useCallback((fromSessionId: string, toSessionId: string) => dispatch({ type: 'rekey', fromSessionId, toSessionId }), []);
  const setTitle = useCallback((sessionId: string, title: string) => dispatch({ type: 'setTitle', sessionId, title }), []);

  return { tabs: state.tabs, activeSessionId: state.activeSessionId, openTab, canOpen, closeTab, focusTab, reorderTab, setPinned, rekeyTab, setTitle, restoredSessionIds: restoredIdsRef.current, adoptedLegacy: adoptedLegacyRef.current };
}
