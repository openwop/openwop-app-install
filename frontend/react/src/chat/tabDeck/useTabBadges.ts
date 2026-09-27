/**
 * useTabBadges — per-tab background-activity badges for the multi-tab chat deck
 * (ADR 0140 P5). A projection over per-tab activity (NOT working-set membership, so it
 * lives outside useTabDeck): a background tab shows an UNREAD dot when a new reply has
 * landed since you last looked, and a higher-urgency BLOCKED indicator when it is
 * waiting on a HITL interrupt. The active tab never badges (its content is visible
 * inline). Blocked outranks unread (ADR: "a blocked agent waiting on you outranks a new
 * message").
 *
 * Unread is keyed on the id of the last FINALIZED inbound message (not a message-count
 * high-water mark — counts are non-monotonic across the optimistic-send → wire-reconcile
 * rebuild). Each TabSession reports `(lastInboundId, blocked)`; "seen" records that id
 * when the tab is active. The active check reads a synchronous ref so a self-send in the
 * active tab can never raise a badge, and a focus/report race resolves correctly.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types.js';

export interface TabBadge { unread: boolean; blocked: boolean; }
export const NO_BADGE: TabBadge = { unread: false, blocked: false };

/**
 * Derive a tab's activity signal from its message list (pure). `lastInboundId` is the
 * id of the last FINALIZED inbound (assistant/workflow_run) message — the in-flight
 * streaming bubble (the trailing message while `isSending`) is EXCLUDED so a reply
 * badges a background tab when it COMPLETES, not when it starts. `blocked` = any
 * message carries an open HITL interrupt. Keyed by the caller on these two scalars so
 * the O(messages) scan stays off the per-token path (streaming mutates content, not the
 * message list).
 */
export function deriveActivity(
  messages: readonly ChatMessage[],
  isSending: boolean,
): { lastInboundId: string | null; blocked: boolean } {
  let lastInboundId: string | null = null;
  let blocked = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const inbound = m.role !== 'user' && m.role !== 'system';
    const inFlight = isSending && i === messages.length - 1; // the streaming bubble
    if (inbound && !inFlight) lastInboundId = m.id;
    if ((m.activeInterrupts?.length ?? 0) > 0) blocked = true;
  }
  return { lastInboundId, blocked };
}

/** Pure badge computation — active short-circuits first, blocked outranks unread. */
export function computeTabBadge(
  active: boolean,
  lastInboundId: string | null,
  seenInboundId: string | null,
  blocked: boolean,
): TabBadge {
  if (active) return NO_BADGE; // visible inline — never badge the active tab
  if (blocked) return { unread: false, blocked: true };
  return { unread: lastInboundId !== null && lastInboundId !== seenInboundId, blocked: false };
}

export interface UseTabBadgesResult {
  statusFor: (sessionId: string) => TabBadge;
  /** Stable — a TabSession reports its latest finalized inbound message id + blocked. */
  reportActivity: (sessionId: string, lastInboundId: string | null, blocked: boolean) => void;
}

/**
 * `onRaise` (ADR 0140 / MTCU-201) fires ONCE on the RISING edge of a BACKGROUND tab's
 * badge — a new reply lands (`'unread'`) or a HITL interrupt opens (`'blocked'`) — so
 * the deck can route it through the imperative `announce()` (`ui/announce.tsx`) and a
 * screen reader actually hears it. The visible dot alone was silent: a conditionally
 * mounted `role="status"` never announces (the live-region-mounted-with-content class).
 * It fires ONLY from `reportActivity` (a genuine background arrival) — never from
 * focus-change/prune — and only on the rising edge (no re-announce of the same reply),
 * tracked against the last-shown badge.
 */
export function useTabBadges(
  activeSessionId: string | null,
  openIds: readonly string[],
  onRaise?: (sessionId: string, kind: 'unread' | 'blocked') => void,
): UseTabBadgesResult {
  const [status, setStatus] = useState<Record<string, TabBadge>>({});
  const lastInbound = useRef(new Map<string, string | null>());
  const lastBlocked = useRef(new Map<string, boolean>());
  const seenInbound = useRef(new Map<string, string | null>());
  const shownBadge = useRef(new Map<string, TabBadge>()); // last badge set per sid (blocked rising-edge basis)
  const announcedInbound = useRef(new Map<string, string | null>()); // last inbound id baselined/announced per sid
  const activeRef = useRef(activeSessionId);
  activeRef.current = activeSessionId;
  const onRaiseRef = useRef(onRaise); // latest, so reportActivity stays referentially stable
  onRaiseRef.current = onRaise;
  const prevActiveRef = useRef<string | null>(null);
  const prevOpenRef = useRef<readonly string[]>([]);

  const setBadge = useCallback((sid: string, badge: TabBadge) => {
    shownBadge.current.set(sid, badge);
    setStatus((prev) => {
      const cur = prev[sid] ?? NO_BADGE;
      if (cur.unread === badge.unread && cur.blocked === badge.blocked) return prev; // no churn
      return { ...prev, [sid]: badge };
    });
  }, []);

  const reportActivity = useCallback((sid: string, lastInboundId: string | null, blocked: boolean) => {
    // The FIRST report for a sid establishes the baseline (the on-load snapshot of a
    // restored tab's history) — announcing it would spam "new reply" for every already-
    // unread background tab on page load. Only IN-SESSION transitions announce (mirrors
    // the coalesced-presence initial-snapshot suppression).
    const firstReport = !announcedInbound.current.has(sid);
    const lastAnnounced = announcedInbound.current.get(sid) ?? null;
    lastInbound.current.set(sid, lastInboundId);
    lastBlocked.current.set(sid, blocked);
    const active = sid === activeRef.current;
    if (active) seenInbound.current.set(sid, lastInboundId);
    const next = computeTabBadge(active, lastInboundId, seenInbound.current.get(sid) ?? null, blocked);
    const prev = shownBadge.current.get(sid) ?? NO_BADGE;
    setBadge(sid, next);
    announcedInbound.current.set(sid, lastInboundId); // advance the baseline
    // Announce only a genuine BACKGROUND arrival, never the baseline snapshot. Blocked
    // outranks (boolean rising edge); unread keys on the inbound ID ADVANCING to a new
    // value (NOT the badge boolean — a tab restored already-unread must still announce its
    // FIRST live reply after reload; the boolean would stay `true` and swallow it).
    if (!active && !firstReport) {
      if (next.blocked && !prev.blocked) onRaiseRef.current?.(sid, 'blocked');
      else if (next.unread && lastInboundId !== null && lastInboundId !== lastAnnounced) onRaiseRef.current?.(sid, 'unread');
    }
  }, [setBadge]);

  // Focus change: mark the new active tab seen + clear; recompute the tab you LEFT (its
  // unread clears since it was just seen, but a blocked tab keeps its blocked badge).
  useEffect(() => {
    const prev = prevActiveRef.current;
    prevActiveRef.current = activeSessionId;
    if (activeSessionId) {
      seenInbound.current.set(activeSessionId, lastInbound.current.get(activeSessionId) ?? null);
      setBadge(activeSessionId, NO_BADGE);
    }
    if (prev && prev !== activeSessionId) {
      setBadge(prev, computeTabBadge(false, lastInbound.current.get(prev) ?? null, seenInbound.current.get(prev) ?? null, lastBlocked.current.get(prev) ?? false));
    }
  }, [activeSessionId, setBadge]);

  // Prune closed tabs; reset a newly-(re)opened sid to a clean slate (no stale badge
  // from a previous mount / a reused id after /clear).
  useEffect(() => {
    const open = new Set(openIds);
    const prevOpen = new Set(prevOpenRef.current);
    prevOpenRef.current = openIds;
    for (const map of [lastInbound, lastBlocked, seenInbound, shownBadge, announcedInbound]) {
      for (const k of map.current.keys()) if (!open.has(k)) map.current.delete(k);
    }
    for (const sid of openIds) {
      if (!prevOpen.has(sid)) { // newly opened — clean slate
        lastInbound.current.delete(sid); lastBlocked.current.delete(sid); seenInbound.current.delete(sid);
        shownBadge.current.delete(sid); announcedInbound.current.delete(sid);
      }
    }
    setStatus((prev) => {
      let changed = false;
      const next: Record<string, TabBadge> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (open.has(k) && prevOpen.has(k)) { next[k] = v; } else { changed = true; }
      }
      return changed ? next : prev;
    });
  }, [openIds]);

  const statusFor = useCallback((sid: string) => status[sid] ?? NO_BADGE, [status]);
  return { statusFor, reportActivity };
}
