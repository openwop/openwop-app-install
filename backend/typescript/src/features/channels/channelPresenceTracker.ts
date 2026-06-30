/**
 * ADR 0126 Phase 4 / RFC 0110 — EPHEMERAL channel presence (online + typing).
 *
 * Pure in-memory, per-instance live state. It is NEVER persisted (not to the event log /
 * transcript — the load-bearing RFC 0110 rule, so presence can't corrupt replay/:fork) and
 * is broadcast over the dedicated presence SSE, NOT the durable run-event stream.
 *
 * Correctness over completeness (RFC 0110's MUSTs): every ref reported is an actually-
 * connected member (a per-ref connection count → present iff ≥1 live connection, so
 * multi-tab is handled); on multi-instance deployments a ref present on another instance is
 * simply not seen — a valid best-effort subset, never a false positive. Membership-gating
 * is the caller's responsibility (the route admits only members before `join`), so a ref
 * here is always a current participant.
 */

export interface PresenceSnapshot {
  conversationId: string;
  present: string[];
  typing: string[];
}

interface RefState { conns: number; typing: boolean }
interface ChannelState {
  refs: Map<string, RefState>;
  subscribers: Set<(snap: PresenceSnapshot) => void>;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEBOUNCE_MS = 200;
const channels = new Map<string, ChannelState>();

function stateFor(channelId: string): ChannelState {
  let st = channels.get(channelId);
  if (!st) { st = { refs: new Map(), subscribers: new Set(), timer: null }; channels.set(channelId, st); }
  return st;
}

export function snapshotOf(channelId: string): PresenceSnapshot {
  const st = channels.get(channelId);
  const present: string[] = [];
  const typing: string[] = [];
  if (st) {
    for (const [ref, rs] of st.refs) {
      if (rs.conns > 0) {
        present.push(ref);
        if (rs.typing) typing.push(ref);
      }
    }
  }
  present.sort(); typing.sort(); // deterministic frame ordering
  return { conversationId: channelId, present, ...(typing.length ? { typing } : { typing: [] }) };
}

/** SHOULD debounce/coalesce (RFC 0110) — presence churn is high; collapse a burst of
 *  join/leave/typing into one broadcast tick. */
function scheduleBroadcast(channelId: string): void {
  const st = channels.get(channelId);
  if (!st || st.timer) return;
  st.timer = setTimeout(() => {
    st.timer = null;
    const snap = snapshotOf(channelId);
    for (const sub of st.subscribers) {
      try { sub(snap); } catch { /* a dead subscriber must not break the others */ }
    }
    if (st.refs.size === 0 && st.subscribers.size === 0) channels.delete(channelId);
  }, DEBOUNCE_MS);
}

/** A member joins presence (one live connection). Returns a `leave` fn (idempotent). The
 *  `ref` MUST already be authorized as a channel participant (the route gates that). */
export function joinPresence(channelId: string, ref: string, onSnapshot: (snap: PresenceSnapshot) => void): () => void {
  const st = stateFor(channelId);
  const rs = st.refs.get(ref) ?? { conns: 0, typing: false };
  rs.conns += 1;
  st.refs.set(ref, rs);
  st.subscribers.add(onSnapshot);
  scheduleBroadcast(channelId);
  let left = false;
  return () => {
    if (left) return;
    left = true;
    st.subscribers.delete(onSnapshot);
    const cur = st.refs.get(ref);
    if (cur) {
      cur.conns -= 1;
      if (cur.conns <= 0) st.refs.delete(ref);
    }
    scheduleBroadcast(channelId);
  };
}

/** Set a member's typing flag (no-op if not present). */
export function setTyping(channelId: string, ref: string, typing: boolean): void {
  const st = channels.get(channelId);
  const rs = st?.refs.get(ref);
  if (!rs || rs.typing === typing) return;
  rs.typing = typing;
  scheduleBroadcast(channelId);
}

/** Test-only reset. */
export function __resetPresence(): void {
  for (const st of channels.values()) { if (st.timer) clearTimeout(st.timer); }
  channels.clear();
}
