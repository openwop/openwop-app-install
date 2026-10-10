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

/**
 * ADR 0773 G-01d — FREE-TEXT command sources: given what the person typed, a
 * surface may offer one command built from it (the builder's "Ask the
 * Architect: …"). Evaluated by the palette per query; never cached into the
 * static snapshot above.
 */
type QuerySource = (query: string) => ContributedCommand | null;
const querySources = new Map<string, QuerySource>();
const queryListeners = new Set<() => void>();
let querySnapshot: QuerySource[] = [];

export function registerQueryCommandSource(key: string, source: QuerySource): () => void {
  querySources.set(key, source);
  querySnapshot = [...querySources.values()];
  queryListeners.forEach((l) => l());
  return () => {
    if (querySources.get(key) === source) {
      querySources.delete(key);
      querySnapshot = [...querySources.values()];
      queryListeners.forEach((l) => l());
    }
  };
}
export function getQueryCommandSources(): QuerySource[] { return querySnapshot; }
export function subscribeQueryCommandSources(fn: () => void): () => void {
  queryListeners.add(fn);
  return () => { queryListeners.delete(fn); };
}

// ── Route-aware sources (ADR 0785 P2) ───────────────────────────────────────
// A plain source is evaluated when it REGISTERS, so it cannot know which page
// the palette opens over. A route source is evaluated by the palette at render,
// against the current pathname — how an excludable feature offers "do X with
// THIS workflow/run" without the page importing the feature. It returns a LINK
// (`to`), never an in-place action: it is not mounted with the page.

export interface RouteCommand {
  id: string;
  label: string;
  hint: string;
  group: string;
  icon: IconCmp;
  to: string;
  /** Hidden unless this toggle resolves enabled (the palette's nav predicate). */
  featureId?: string;
}

type RouteSource = (pathname: string) => RouteCommand[];
const routeSources = new Map<string, RouteSource>();

/** Idempotent by key (import-time registration re-runs under test isolation). */
export function registerRouteCommandSource(key: string, source: RouteSource): void {
  routeSources.set(key, source);
}

export function routeCommandsFor(pathname: string): RouteCommand[] {
  const out: RouteCommand[] = [];
  for (const src of routeSources.values()) {
    try { out.push(...src(pathname)); } catch { /* a broken source never breaks the palette */ }
  }
  return out;
}


