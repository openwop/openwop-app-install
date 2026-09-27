/**
 * Command-palette contribution seam (ADR 0334 3b-3).
 *
 * The app has ONE ⌘K command palette (`ui/CommandPalette.tsx`) — a surface must
 * NOT stand up a second one. This registry lets a mounted surface contribute
 * *action* commands (verbs that run in place, not navigation) into that single
 * palette while it is on screen, then withdraw them on unmount. The palette reads
 * the live set each time it opens; `subscribeCommandSources` lets it re-render
 * when the set changes (a surface mounts/unmounts).
 *
 * This is a leaf module (no React, no imports back into the palette) so both
 * `ui/CommandPalette.tsx` and any feature surface can depend on it without a cycle.
 */
import type { IconCmp } from '../chrome/navItems.js';

export interface ContributedCommand {
  id: string;
  label: string;
  hint: string;
  group: string;
  icon: IconCmp;
  /** Runs in place (the palette closes first, then invokes this). */
  run: () => void;
}

type Source = () => ContributedCommand[];

const sources = new Map<string, Source>();
const listeners = new Set<() => void>();
// A CACHED snapshot recomputed only on change, so `getContributedCommands` (the
// `useSyncExternalStore` getSnapshot) returns a STABLE reference between changes
// — React requires that or it warns/loops.
let snapshot: ContributedCommand[] = [];

function recompute(): void {
  const out: ContributedCommand[] = [];
  for (const source of sources.values()) {
    try { out.push(...source()); } catch { /* a broken source never breaks the palette */ }
  }
  snapshot = out;
  listeners.forEach((l) => l());
}

/** Register a contribution source under a stable key; returns an unregister fn.
 *  Re-registering the same key replaces it (idempotent for React strict-mode). */
export function registerCommandSource(key: string, source: Source): () => void {
  sources.set(key, source);
  recompute();
  return () => {
    if (sources.get(key) === source) {
      sources.delete(key);
      recompute();
    }
  };
}

/** getSnapshot for `useSyncExternalStore` — a stable array reference that only
 *  changes identity when a source is added/removed. */
export function getContributedCommands(): ContributedCommand[] {
  return snapshot;
}

/** Subscribe to source add/remove (for `useSyncExternalStore`). */
export function subscribeCommandSources(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Test-only: clear all sources. */
export function __resetCommandSources(): void {
  sources.clear();
  listeners.clear();
  snapshot = [];
}
