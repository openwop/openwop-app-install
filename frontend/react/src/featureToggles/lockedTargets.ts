/**
 * ADR 0419 R3 + §8 follow-on — where a LOCKED nav item goes, and what its lock says.
 *
 * NOT entry code: the ⌘K palette, the admin rail, the admin overview and the chat
 * `@@` picker use it (all lazily loaded). The entry-chunk Sidebar and Agents row do
 * NOT — they spend no bytes on a lookup and link to `/marketplace/bundles?feature=
 * <id>`, which the store resolves to that feature's bundle and opens its drawer
 * (`?bundle=<id>`).
 *
 * The first render that meets a locked item loads the feature → bundle lookup
 * through the `LockedState` chunk, once per session (the catalog read is cached
 * there). The link then opens `?bundle=<id>` directly and the label names the
 * bundle ("Locked — unlock with {bundle}", lazy `marketplace` namespace). Until it
 * lands, or if it fails, the link is the `?feature=` form and the label is the
 * caller's existing one.
 */
import { useEffect, useRef, useState } from 'react';

interface Targets { href(id?: string): string | undefined; label(id?: string): string | undefined }
let targets: Targets | undefined;
let pending: Promise<void> | undefined;
let wanted = false;

/** `onClick` counts the upgrade click for the paywall funnel (strategy §8); wire
 *  it on the element that follows `to`. */
export interface LockedNav { to: string; label: string; onClick: () => void }

/** Where a lock is shown (strategy §8) — mirrors `paywallBeacon`'s surfaces. */
export type LockedNavSurface = 'palette' | 'admin-rail' | 'admin-overview' | 'chat-picker';
/** The paywall beacon, through a dynamic hop (this module statically imports only react). */
const notePaywall = (metric: 'impression' | 'click', ids: readonly string[], surface: LockedNavSurface): void => {
  void import('./paywallBeacon.js').then((m) => { for (const id of ids) m.notePaywall(metric, id, surface); }, () => undefined);
};

/** The store link for a locked feature before (or without) the bundle lookup. */
export const featureStoreHref = (featureId?: string): string =>
  featureId ? `/marketplace/bundles?feature=${encodeURIComponent(featureId)}` : '/marketplace/bundles';

/**
 * Wrap the caller's `useFeatureLocked()` predicate: `null` when not locked, else
 * where the lock links and what it says (`fallbackLabel` until the lookup lands).
 */
export function useLockedNav(lockedFor: (featureId?: string) => boolean, fallbackLabel: string, surface: LockedNavSurface): (featureId?: string) => LockedNav | null {
  const [, rerender] = useState(0);
  // Strategy §8 — the locks this render showed, reported as impressions after it
  // commits (the beacon dedupes per page view). No deps: every render may show more.
  const shown = useRef(new Set<string>());
  useEffect(() => {
    if (shown.current.size === 0) return;
    const ids = [...shown.current];
    shown.current.clear();
    notePaywall('impression', ids, surface);
  });
  // `lockedFor` is a fresh closure whenever access re-resolves, so this re-checks
  // after the render that first meets a locked item (`wanted` is set in render).
  useEffect(() => {
    if (wanted && !targets) {
      void (pending ??= import('./LockedState.js').then((m) => m.lockedTargets()).then((t) => { targets = t; }, () => {})).then(() => rerender(1));
    }
  }, [lockedFor]);
  return (id) => {
    if (!lockedFor(id)) return null;
    wanted = true;
    if (id) shown.current.add(id);
    return {
      to: targets?.href(id) ?? featureStoreHref(id),
      label: targets?.label(id) ?? fallbackLabel,
      onClick: () => { if (id) notePaywall('click', [id], surface); },
    };
  };
}
