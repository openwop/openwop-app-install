/**
 * `useCollabPresence` — chassis presence over the Yjs awareness channel
 * (ADR 0359 Phase 4 / D5). Publishes THIS client's identity + positional
 * selection (throttled — a drag must not flood the socket) and mirrors the
 * peers' states into React. Awareness is ephemeral by design (ADR 0335): never
 * persisted, dropped on disconnect, and the server clears a connection's
 * client ids on close so ghosts vanish immediately.
 *
 * A11y (the ADR 0335 HIGH risk, budgeted here): join/leave changes are
 * COALESCED for 2 s and reported once through `onPeersChanged` — the chassis
 * routes them to its polite live region. Peer selection changes are never
 * announced (a remote drag would be an aria-live firehose); they render as
 * quiet visual markers only.
 */
import { useEffect, useRef, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import { hueOf } from '../ui/Avatar.js';
import type { CollabState } from './useCollab.js';

/** The identity hue (Avatar's `hueOf`) as a HEX color for y-prosemirror's
 *  remote-caret decorations (ADR 0359 grade pass UX-B1) and the scene-outline
 *  flags. Hex, not hsl(): the default selection builder suffixes an alpha
 *  nibble onto the string (`${color}70`), which only composes with hex.
 *
 *  Grade pass 3 (UX finding 1): the relative LUMINANCE is clamped into
 *  [0.08, 0.15] — dark enough that the theme-STABLE near-white flag/caret
 *  text (`--collab-flag-text`, luminance ≈0.87) always clears WCAG AA 4.5:1
 *  in BOTH themes (worst case 0.92/0.20 ≈ 4.6:1), light enough that the pill
 *  never reads as black. A fixed 47% HSL lightness failed a hue band per
 *  theme (luminous yellows in light; deep blues in dark) because the old text
 *  token flipped with the theme while the fill didn't. Hue stays identity-true
 *  (matches the avatar wash). */
export function collabUserColor(hueKey: string): string {
  const h = hueOf(hueKey) / 360;
  const s = 0.65;
  const rgbAt = (l: number): [number, number, number] => {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (t: number): number => {
      let x = t;
      if (x < 0) x += 1;
      if (x > 1) x -= 1;
      if (x < 1 / 6) return p + (q - p) * 6 * x;
      if (x < 1 / 2) return q;
      if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
      return p;
    };
    return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
  };
  const luminance = ([r, g, b]: [number, number, number]): number => {
    const lin = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  let l = 0.47;
  let rgb = rgbAt(l);
  for (let i = 0; i < 14 && luminance(rgb) > 0.15; i++) { l -= 0.03; rgb = rgbAt(l); }
  for (let i = 0; i < 14 && luminance(rgb) < 0.08; i++) { l += 0.02; rgb = rgbAt(l); }
  const hex = (v: number): string => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${hex(rgb[0])}${hex(rgb[1])}${hex(rgb[2])}`;
}

/**
 * Short suffix giving an anonymous peer a distinct display name — and, since
 * the presence hue is hashed from the name, a distinct color. crypto.randomUUID
 * exists only in secure contexts (https/localhost); plain-http dev falls back.
 */
export function collabGuestSuffix(): string {
  // Digits only — a screen reader speaks "Guest 3729" as a clean number,
  // where a hex suffix ("3f2a") verbalizes as a garbled token.
  const seed = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? parseInt(crypto.randomUUID().slice(0, 8), 16)
    : Math.floor(Math.random() * 1_0000_0000);
  return String(seed % 10_000).padStart(4, '0');
}

/**
 * RTCC-4 — the presence display name published to Yjs awareness `user.name`,
 * which is relayed VERBATIM to every room peer (and, via SLC-1, to a same-tenant
 * non-member of a private-project room). It MUST NOT fall back to the user's
 * EMAIL: a user with no displayName would otherwise leak their email address to
 * all co-editors. The only fallbacks are the real displayName or the caller's
 * non-PII guest label (which also drives a distinct presence hue).
 */
export function presenceSelfName(
  user: { displayName?: string | null; email?: string | null } | null | undefined,
  guestLabel: string,
): string {
  const displayName = user?.displayName;
  return typeof displayName === 'string' && displayName.trim() ? displayName.trim() : guestLabel;
}

/**
 * RTCU-1 — which announcement, if any, a collab connection-state change warrants.
 *
 * The Live<->Reconnecting chip is a visual-only signal; this decides what a screen
 * reader hears. Pure so the TRANSITION RULE is testable apart from the component
 * that wires it: the first observed value is silent (it is the expected state on
 * open, and announcing it would chatter every time an editor mounts), a repeat is
 * silent, and only a real change speaks.
 *
 * `null` for `now` means collab is off — nothing to say, and the caller resets its
 * memory so a later enable is treated as a fresh first observation.
 */
export function collabConnectionAnnouncement(
  was: boolean | null,
  now: boolean | null,
): 'dropped' | 'reconnected' | null {
  if (now === null || was === null || was === now) return null;
  return now ? 'reconnected' : 'dropped';
}

export interface CollabPeer {
  clientId: number;
  name: string;
  /** The peer's element selection (positional, eventually-consistent). */
  sel: { col: string; idx: number } | null;
  /** The peer's active frame index (frames-trait types). */
  frame: number | null;
}

const SEL_THROTTLE_MS = 150;
const ANNOUNCE_COALESCE_MS = 2000;

function readPeers(awareness: Awareness): CollabPeer[] {
  const peers: CollabPeer[] = [];
  awareness.getStates().forEach((raw, clientId) => {
    if (clientId === awareness.clientID) return;
    const state = raw as Record<string, unknown>;
    const user = state.user as { name?: unknown } | undefined;
    const name = typeof user?.name === 'string' && user.name ? user.name : null;
    if (!name) return; // not a fully-joined editor client
    const rawSel = state.sel as { col?: unknown; idx?: unknown } | null | undefined;
    const sel = rawSel && typeof rawSel.col === 'string' && typeof rawSel.idx === 'number'
      ? { col: rawSel.col, idx: rawSel.idx } : null;
    const frame = typeof state.frame === 'number' ? state.frame : null;
    peers.push({ clientId, name, sel, frame });
  });
  peers.sort((a, b) => a.clientId - b.clientId); // stable stack order
  return peers;
}

export function useCollabPresence({ collab, selfName, sel, frame, onPeersChanged }: {
  collab: CollabState;
  selfName: string;
  sel: { col: string; idx: number } | null;
  frame: number | null;
  /** Coalesced join/leave batch (names). Route to the polite live region. */
  onPeersChanged?: (change: { joined: string[]; left: string[] }) => void;
}): { peers: CollabPeer[] } {
  const [peers, setPeers] = useState<CollabPeer[]>([]);
  const awareness: Awareness | null = collab.enabled ? collab.awareness : null;
  const onPeersChangedRef = useRef(onPeersChanged);
  onPeersChangedRef.current = onPeersChanged;

  // Identity — published once per session (and on a name change). `color`
  // drives y-prosemirror's remote-caret/selection decorations (UX-B1) and is
  // derived from the SAME hue as the peer's toolbar avatar.
  useEffect(() => {
    if (!awareness) return;
    awareness.setLocalStateField('user', { name: selfName, color: collabUserColor(selfName) });
  }, [awareness, selfName]);

  // Selection/frame — trailing-throttled (drags update every pointermove).
  const pendingRef = useRef<{ sel: typeof sel; frame: typeof frame }>({ sel, frame });
  pendingRef.current = { sel, frame };
  useEffect(() => {
    if (!awareness) return;
    const timer = setTimeout(() => {
      awareness.setLocalStateField('sel', pendingRef.current.sel);
      awareness.setLocalStateField('frame', pendingRef.current.frame);
    }, SEL_THROTTLE_MS);
    return () => clearTimeout(timer);
  }, [awareness, sel, frame]);

  // Peer mirror + coalesced join/leave announcements.
  useEffect(() => {
    if (!awareness) { setPeers([]); return; }
    let known = new Map<number, string>();
    let joined = new Map<number, string>();
    let left = new Map<number, string>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      flushTimer = null;
      // A quick rejoin within the window cancels out (no churn announcements).
      for (const id of [...joined.keys()]) if (left.has(id)) { joined.delete(id); left.delete(id); }
      if (joined.size > 0 || left.size > 0) {
        onPeersChangedRef.current?.({ joined: [...joined.values()], left: [...left.values()] });
      }
      joined = new Map(); left = new Map();
    };
    const onChange = (): void => {
      const next = readPeers(awareness);
      setPeers(next);
      const nextIds = new Map(next.map((p) => [p.clientId, p.name] as const));
      for (const [id, name] of nextIds) if (!known.has(id)) joined.set(id, name);
      for (const [id, name] of known) if (!nextIds.has(id)) left.set(id, name);
      known = nextIds;
      if ((joined.size > 0 || left.size > 0) && !flushTimer) flushTimer = setTimeout(flush, ANNOUNCE_COALESCE_MS);
    };
    awareness.on('change', onChange);
    onChange(); // initial mirror (peers may already be in the room)
    // The initial snapshot is context, not an event — don't announce it.
    joined = new Map(); left = new Map();
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    return () => {
      awareness.off('change', onChange);
      if (flushTimer) clearTimeout(flushTimer);
      setPeers([]);
    };
  }, [awareness]);

  return { peers };
}
