/**
 * `useWorkflowCollabPresence` — builder presence over the Yjs awareness
 * channel (the ADR 0359 D5 pattern, ADR 0481 P3). Publishes THIS client's
 * identity + node selection (trailing-throttled — a drag must not flood the
 * socket) and mirrors the peers' states into React. Ephemeral by design:
 * never persisted, dropped on disconnect.
 *
 * A11y (the useCollabPresence precedent): join/leave changes are COALESCED
 * for 2 s and reported once through `onPeersChanged` — the shell routes them
 * to its polite live region. Peer selection changes are never announced; they
 * render as quiet node markers only.
 *
 * Peer colors come from a FIXED palette of design tokens (never raw hex —
 * the tsx-color-literals gate), indexed by a NAME hash (ux-L1) so a given
 * PERSON keeps one color everywhere: every client computes the same hash
 * locally (same input ⇒ same color), and the color survives reconnects,
 * which mint a fresh clientId.
 */
import { useEffect, useRef, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import type { CollabPeerMarker } from '../store/builderStore.js';

const PEER_COLOR_TOKENS = [
  'var(--color-info-text)',
  'var(--color-success-text)',
  'var(--color-warning-text)',
  'var(--color-ai-text)',
  'var(--color-danger-text)',
] as const;

/** ux-L1 — stable per-person palette index: djb2 over the display name.
 *  Deterministic and locally computed, so every client agrees without any
 *  coordination; a rejoining peer (new clientId) keeps their color. */
export function workflowPeerColor(name: string): string {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  return PEER_COLOR_TOKENS[Math.abs(h) % PEER_COLOR_TOKENS.length]!;
}

const SEL_THROTTLE_MS = 150;
const ANNOUNCE_COALESCE_MS = 2000;

function readPeers(awareness: Awareness): CollabPeerMarker[] {
  const peers: CollabPeerMarker[] = [];
  awareness.getStates().forEach((raw, clientId) => {
    if (clientId === awareness.clientID) return;
    const state = raw as Record<string, unknown>;
    const user = state.user as { name?: unknown } | undefined;
    const name = typeof user?.name === 'string' && user.name ? user.name : null;
    if (!name) return; // not a fully-joined editor client
    const rawSel = state.wfSel;
    const selectedNodeIds = Array.isArray(rawSel)
      ? rawSel.filter((id): id is string => typeof id === 'string')
      : [];
    peers.push({ clientId, name, color: workflowPeerColor(name), selectedNodeIds });
  });
  peers.sort((a, b) => a.clientId - b.clientId); // stable stack order
  return peers;
}

export function useWorkflowCollabPresence({ awareness, selfName, selectedNodeIds, onPeersChanged }: {
  awareness: Awareness | null;
  selfName: string;
  /** This client's selection — published for the peers' node markers. */
  selectedNodeIds: string[];
  /** Coalesced join/leave batch (names). Route to the polite live region. */
  onPeersChanged?: (change: { joined: string[]; left: string[] }) => void;
}): { peers: CollabPeerMarker[] } {
  const [peers, setPeers] = useState<CollabPeerMarker[]>([]);
  const onPeersChangedRef = useRef(onPeersChanged);
  onPeersChangedRef.current = onPeersChanged;

  // Identity — published once per session (and on a name change).
  useEffect(() => {
    if (!awareness) return;
    awareness.setLocalStateField('user', { name: selfName });
  }, [awareness, selfName]);

  // Selection — trailing-throttled (box-select/marquee updates every move).
  const pendingSelRef = useRef(selectedNodeIds);
  pendingSelRef.current = selectedNodeIds;
  useEffect(() => {
    if (!awareness) return;
    const timer = setTimeout(() => {
      awareness.setLocalStateField('wfSel', pendingSelRef.current);
    }, SEL_THROTTLE_MS);
    return () => clearTimeout(timer);
  }, [awareness, selectedNodeIds]);

  // Peer mirror + coalesced join/leave announcements.
  useEffect(() => {
    if (!awareness) {
      setPeers([]);
      return;
    }
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
