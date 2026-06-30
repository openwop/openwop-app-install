/**
 * tabDeckModel — the PURE working-set state machine for the multi-tab chat deck
 * (ADR 0140 P2). No React, no I/O, no streaming knowledge. It owns ONLY the
 * transient working set: which conversation ids are open, their order, which is
 * active, and a per-tab `pinned` flag. The conversation CONTENT (titles,
 * participants, history) stays in the existing `sessionsCollection` — this model
 * never becomes a second index.
 *
 * `pinned` is intentionally TAB-scoped (it dies when the tab closes), matching the
 * dominant prior art — browser and VS Code tabs pin the *tab*, not the document, so
 * closing a pinned tab drops the pin. This keeps P2 pure (no session-record
 * coupling); see ADR 0140 §Decision 4 note.
 *
 * Recency uses a monotonic `seq` counter, NOT Date.now — deterministic + testable,
 * and monotonic under clock skew. At ~1000 focus events/min it would take ~17,000
 * years to reach Number.MAX_SAFE_INTEGER, so no reset/modulo is needed (and adding
 * one would corrupt LRU ordering). Persist `seq` across reload (P6) so restored
 * recency is stable.
 */

export interface DeckTab {
  sessionId: string;
  /** Eviction protection (tab-scoped, ephemeral). Pinned-idle tabs are sacrificed
   *  only at the HARD ceiling; never auto-evicted by the soft cap. */
  pinned: boolean;
  /** The `seq` value at this tab's last activation. Lowest = least-recently-used. */
  lastActiveSeq: number;
  /** Last-known conversation title (ADR 0140 G4) — persisted so a restored tab shows its
   *  real label at first paint, before the backend conversation list loads (vs flashing
   *  "New chat"). Undefined for a never-titled / brand-new tab. */
  lastTitle?: string;
}

export interface TabDeckState {
  /** Display order (insertion / manual-reorder order — never re-sorted by recency,
   *  so the strip + the keep-alive mount list don't jump under the user mid-stream). */
  tabs: DeckTab[];
  activeSessionId: string | null;
  /** Monotonic activation counter. Bumped on every open/focus/neighbor-activation. */
  seq: number;
}

/** Soft cap: opening beyond this evicts the LRU soft-evictable tab. Tunable per call. */
export const MAX_TABS_DEFAULT = 8;
/** Hard ceiling: the soft cap may be exceeded ONLY by pinned/streaming/active tabs,
 *  and only up to here. At the hard wall an LRU pinned-idle tab is sacrificed
 *  (pinned is protection, not immortality); streaming/active tabs are never evicted. */
export const HARD_MAX_TABS = 24;

export const emptyTabDeck: TabDeckState = { tabs: [], activeSessionId: null, seq: 0 };

const NO_PROTECTED: ReadonlySet<string> = new Set<string>();

export type TabDeckAction =
  | { type: 'open'; sessionId: string; protectedIds?: ReadonlySet<string>; maxTabs?: number }
  | { type: 'close'; sessionId: string }
  | { type: 'focus'; sessionId: string }
  | { type: 'reorder'; fromSessionId: string; toIndex: number }
  | { type: 'setPinned'; sessionId: string; pinned: boolean }
  /** Cache a tab's last-known title (ADR 0140 G4) so it persists + restores. */
  | { type: 'setTitle'; sessionId: string; title: string }
  /** Replace a tab's id IN PLACE (same slot/pin/recency/active) — when a session
   *  mints a new id (`/clear` in a tab; ADR 0140), so the working set doesn't
   *  strand the old id. No-op if `from` is absent or `to` already open. */
  | { type: 'rekey'; fromSessionId: string; toSessionId: string };

/** What `open` would evict to make room (for the hook to `log()` — no silent
 *  truncation). `null` when nothing is evicted (room available, or soft overflow
 *  allowed). `kind` distinguishes a normal soft eviction from a hard-ceiling
 *  sacrifice of a pinned-idle tab. Pure — `open` uses this same selection. */
export function selectEvictionVictim(
  state: TabDeckState,
  opts: { maxTabs?: number; protectedIds?: ReadonlySet<string> } = {},
): { sessionId: string; kind: 'soft' | 'hard' } | null {
  const maxTabs = opts.maxTabs ?? MAX_TABS_DEFAULT;
  const protectedIds = opts.protectedIds ?? NO_PROTECTED;
  if (state.tabs.length < maxTabs) return null;
  const lru = (cands: readonly DeckTab[]): DeckTab | null =>
    cands.length === 0 ? null : cands.reduce((m, t) => (t.lastActiveSeq < m.lastActiveSeq ? t : m));
  const softVictim = lru(
    state.tabs.filter((t) => !t.pinned && t.sessionId !== state.activeSessionId && !protectedIds.has(t.sessionId)),
  );
  if (softVictim) return { sessionId: softVictim.sessionId, kind: 'soft' };
  // No soft victim: pinned/streaming/active fill the soft cap. Allow overflow up to
  // the hard ceiling rather than dropping a user-initiated open.
  if (state.tabs.length < HARD_MAX_TABS) return null;
  // At the hard wall: sacrifice the LRU tab that is neither active nor streaming
  // (pinned-idle is fair game here). If every tab is active/streaming it's a
  // degenerate state — allow growth (the hook warns) rather than evict a live run.
  const hardVictim = lru(
    state.tabs.filter((t) => t.sessionId !== state.activeSessionId && !protectedIds.has(t.sessionId)),
  );
  return hardVictim ? { sessionId: hardVictim.sessionId, kind: 'hard' } : null;
}

function focusTab(state: TabDeckState, sessionId: string): TabDeckState {
  const idx = state.tabs.findIndex((t) => t.sessionId === sessionId);
  const current = idx < 0 ? undefined : state.tabs[idx];
  if (!current) return state; // not open — `open` is the add path
  if (state.activeSessionId === sessionId && current.lastActiveSeq === state.seq) return state;
  const nextSeq = state.seq + 1;
  return {
    tabs: state.tabs.map((t, i) => (i === idx ? { ...t, lastActiveSeq: nextSeq } : t)),
    activeSessionId: sessionId,
    seq: nextSeq,
  };
}

function openTab(
  state: TabDeckState,
  sessionId: string,
  protectedIds: ReadonlySet<string>,
  maxTabs: number,
): TabDeckState {
  if (state.tabs.some((t) => t.sessionId === sessionId)) return focusTab(state, sessionId); // dedupe
  const victim = selectEvictionVictim(state, { maxTabs, protectedIds });
  const base = victim ? closeTab(state, victim.sessionId) : state;
  const nextSeq = base.seq + 1;
  return {
    tabs: [...base.tabs, { sessionId, pinned: false, lastActiveSeq: nextSeq }],
    activeSessionId: sessionId,
    seq: nextSeq,
  };
}

function closeTab(state: TabDeckState, sessionId: string): TabDeckState {
  const idx = state.tabs.findIndex((t) => t.sessionId === sessionId);
  if (idx < 0) return state; // not open — no-op
  const tabs = state.tabs.filter((t) => t.sessionId !== sessionId);
  if (state.activeSessionId !== sessionId) {
    return { ...state, tabs }; // closing a background tab leaves active + recency untouched
  }
  // Closing the active tab: activate a neighbor — prefer the tab to the right (the
  // element that shifted into `idx`), else the left (`idx-1`), else empty.
  const neighbor = tabs[idx] ?? tabs[idx - 1] ?? null;
  if (!neighbor) return { tabs, activeSessionId: null, seq: state.seq };
  const nextSeq = state.seq + 1;
  return {
    tabs: tabs.map((t) => (t.sessionId === neighbor.sessionId ? { ...t, lastActiveSeq: nextSeq } : t)),
    activeSessionId: neighbor.sessionId,
    seq: nextSeq,
  };
}

function reorderTab(state: TabDeckState, fromSessionId: string, toIndex: number): TabDeckState {
  const idx = state.tabs.findIndex((t) => t.sessionId === fromSessionId);
  const moved = idx < 0 ? undefined : state.tabs[idx];
  if (!moved || state.tabs.length <= 1) return state; // unknown / nothing to reorder
  const without = state.tabs.filter((_, i) => i !== idx);
  // `toIndex` is the FINAL index in the post-removal array; clamp to [0, n] (n appends
  // at the end, where n = without.length).
  const clamped = Math.max(0, Math.min(toIndex, without.length));
  if (clamped === idx) return state; // already at that slot — preserve identity (no churn)
  const tabs = [...without.slice(0, clamped), moved, ...without.slice(clamped)];
  return { ...state, tabs };
}

function rekeyTab(state: TabDeckState, fromSessionId: string, toSessionId: string): TabDeckState {
  if (fromSessionId === toSessionId) return state;
  if (!state.tabs.some((t) => t.sessionId === fromSessionId)) return state; // unknown
  if (state.tabs.some((t) => t.sessionId === toSessionId)) return state; // collision
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.sessionId === fromSessionId ? { ...t, sessionId: toSessionId } : t)),
    activeSessionId: state.activeSessionId === fromSessionId ? toSessionId : state.activeSessionId,
  };
}

function setPinned(state: TabDeckState, sessionId: string, pinned: boolean): TabDeckState {
  const tab = state.tabs.find((t) => t.sessionId === sessionId);
  if (!tab || tab.pinned === pinned) return state; // unknown / unchanged — preserve identity
  return { ...state, tabs: state.tabs.map((t) => (t.sessionId === sessionId ? { ...t, pinned } : t)) };
}

function setTitle(state: TabDeckState, sessionId: string, title: string): TabDeckState {
  const tab = state.tabs.find((t) => t.sessionId === sessionId);
  if (!tab || tab.lastTitle === title || !title) return state; // unknown / unchanged / empty — preserve identity
  return { ...state, tabs: state.tabs.map((t) => (t.sessionId === sessionId ? { ...t, lastTitle: title } : t)) };
}

export function tabDeckReducer(state: TabDeckState, action: TabDeckAction): TabDeckState {
  switch (action.type) {
    case 'open':
      return openTab(state, action.sessionId, action.protectedIds ?? NO_PROTECTED, action.maxTabs ?? MAX_TABS_DEFAULT);
    case 'focus':
      return focusTab(state, action.sessionId);
    case 'close':
      return closeTab(state, action.sessionId);
    case 'reorder':
      return reorderTab(state, action.fromSessionId, action.toIndex);
    case 'setPinned':
      return setPinned(state, action.sessionId, action.pinned);
    case 'setTitle':
      return setTitle(state, action.sessionId, action.title);
    case 'rekey':
      return rekeyTab(state, action.fromSessionId, action.toSessionId);
    default:
      return state;
  }
}
