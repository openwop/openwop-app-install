/**
 * tabDeckPersistence — persist & restore the multi-tab chat working set (ADR 0140 P6).
 *
 * The descriptor is the pure {@link TabDeckState} (ids + order + pinned + active + the
 * monotonic `seq`). Versioned envelope, namespaced PER USER (localStorage is per-origin,
 * so the key carries the authenticated subject — user A's tabs must not surface for user
 * B). `sanitizeTabDeck` is pure + testable: it drops version/subject mismatches and
 * corrupt payloads, clamps to HARD_MAX_TABS (pinned first, then most-recent), de-dupes
 * ids, and repairs the `seq` invariant so a tampered payload can't corrupt LRU order.
 */

import { tabDeckKey, LS_TABDECK_VERSION } from '../lib/storageKeys.js';
import { HARD_MAX_TABS, emptyTabDeck, type DeckTab, type TabDeckState } from './tabDeckModel.js';

interface Envelope {
  v: number;
  subject: string;
  state: TabDeckState;
}

function isDeckTab(x: unknown): x is DeckTab {
  if (typeof x !== 'object' || x === null) return false;
  const t = x as Record<string, unknown>;
  return typeof t.sessionId === 'string' && t.sessionId.length > 0
    && typeof t.pinned === 'boolean'
    && typeof t.lastActiveSeq === 'number' && Number.isFinite(t.lastActiveSeq) && t.lastActiveSeq >= 0
    && (t.lastTitle === undefined || typeof t.lastTitle === 'string');
}

/**
 * Validate + repair a raw persisted envelope for `subject`. Returns null on
 * version/subject mismatch or unrecoverable corruption (caller falls back to empty →
 * the deck bootstraps one tab).
 */
export function sanitizeTabDeck(raw: unknown, subject: string): TabDeckState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const env = raw as Partial<Envelope>;
  if (env.v !== LS_TABDECK_VERSION) return null; // shape may have drifted
  if (env.subject !== subject) return null; // different user on this browser — never restore
  const s = env.state;
  if (typeof s !== 'object' || s === null || !Array.isArray(s.tabs)) return null;

  // De-dupe by id; drop malformed tabs.
  const seen = new Set<string>();
  let tabs: DeckTab[] = [];
  for (const t of s.tabs) {
    if (!isDeckTab(t) || seen.has(t.sessionId)) continue;
    seen.add(t.sessionId);
    tabs.push({ sessionId: t.sessionId, pinned: t.pinned, lastActiveSeq: t.lastActiveSeq, ...(t.lastTitle !== undefined ? { lastTitle: t.lastTitle } : {}) });
  }
  // Clamp to the hard ceiling: keep pinned first, then most-recent by seq. Loud (no
  // silent truncation) — outside React, a dev console.warn is the parallel to the
  // hook's log().
  if (tabs.length > HARD_MAX_TABS) {
    const kept = [...tabs]
      .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.lastActiveSeq - a.lastActiveSeq))
      .slice(0, HARD_MAX_TABS);
    const keptIds = new Set(kept.map((t) => t.sessionId));
    if (import.meta.env?.DEV) {
      // eslint-disable-next-line no-console
      console.warn(`[tabDeck] restored ${tabs.length} tabs > HARD_MAX_TABS (${HARD_MAX_TABS}); dropping ${tabs.length - HARD_MAX_TABS} (kept pinned + most-recent).`);
    }
    tabs = tabs.filter((t) => keptIds.has(t.sessionId)); // preserve display order among the kept
  }
  if (tabs.length === 0) return emptyTabDeck;

  // active must be one of the tabs; if the persisted active is missing/ghost, default to
  // the most-recent tab (not null) so a restored deck always paints an active panel —
  // mirroring the bootstrap "always has an active conversation" invariant. (`tabs` is
  // non-empty here — the empty case returned above.)
  const activeSessionId = (typeof s.activeSessionId === 'string' && seen.has(s.activeSessionId))
    ? s.activeSessionId
    : tabs.reduce((best, t) => (t.lastActiveSeq > best.lastActiveSeq ? t : best), tabs[0]!).sessionId;

  // Repair the seq invariant: seq must be >= every lastActiveSeq, else LRU recency is
  // corrupt (a stale lastActiveSeq could exceed a reset seq). See tabDeckModel header.
  const maxSeq = tabs.reduce((m, t) => Math.max(m, t.lastActiveSeq), 0);
  const seq = (typeof s.seq === 'number' && Number.isFinite(s.seq) && s.seq >= maxSeq) ? s.seq : maxSeq;

  return { tabs, activeSessionId, seq };
}

/** Load the persisted working set for `subject` (or null if absent/corrupt/foreign). */
export function loadTabDeck(subject: string): TabDeckState | null {
  if (!subject || typeof localStorage === 'undefined') return null;
  try {
    const rawStr = localStorage.getItem(tabDeckKey(subject));
    if (!rawStr) return null;
    return sanitizeTabDeck(JSON.parse(rawStr), subject);
  } catch {
    return null; // corrupt JSON / quota / disabled storage
  }
}

/** Persist the working set for `subject`. No-op when logged out (subject falsy). */
export function saveTabDeck(state: TabDeckState, subject: string | null): void {
  if (!subject || typeof localStorage === 'undefined') return;
  try {
    const env: Envelope = { v: LS_TABDECK_VERSION, subject, state };
    localStorage.setItem(tabDeckKey(subject), JSON.stringify(env));
  } catch {
    /* over-quota / disabled — best-effort, drop silently */
  }
}
