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

export function useTabBadges(activeSessionId: string | null, openIds: readonly string[]): UseTabBadgesResult {
  const [status, setStatus] = useState<Record<string, TabBadge>>({});
  const lastInbound = useRef(new Map<string, string | null>());
  const lastBlocked = useRef(new Map<string, boolean>());
  const seenInbound = useRef(new Map<string, string | null>());
  const activeRef = useRef(activeSessionId);
  activeRef.current = activeSessionId;
  const prevActiveRef = useRef<string | null>(null);
  const prevOpenRef = useRef<readonly string[]>([]);

  const setBadge = useCallback((sid: string, badge: TabBadge) => {
    setStatus((prev) => {
      const cur = prev[sid] ?? NO_BADGE;
      if (cur.unread === badge.unread && cur.blocked === badge.blocked) return prev; // no churn
      return { ...prev, [sid]: badge };
    });
  }, []);

  const reportActivity = useCallback((sid: string, lastInboundId: string | null, blocked: boolean) => {
    lastInbound.current.set(sid, lastInboundId);
    lastBlocked.current.set(sid, blocked);
    const active = sid === activeRef.current;
    if (active) seenInbound.current.set(sid, lastInboundId);
    setBadge(sid, computeTabBadge(active, lastInboundId, seenInbound.current.get(sid) ?? null, blocked));
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
    for (const map of [lastInbound, lastBlocked, seenInbound]) {
      for (const k of map.current.keys()) if (!open.has(k)) map.current.delete(k);
    }
    for (const sid of openIds) {
      if (!prevOpen.has(sid)) { // newly opened — clean slate
        lastInbound.current.delete(sid); lastBlocked.current.delete(sid); seenInbound.current.delete(sid);
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
