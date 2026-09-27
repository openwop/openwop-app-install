/**
 * Navigation-source stamping (ADR 0512) — the CLOSED enum of ways a
 * destination can be reached, recorded (when the `workspace-nav-telemetry`
 * sub-toggle is ON) as counts-only evidence for the DSA-028 IA program.
 *
 * Privacy posture (the ADR's whole point):
 *  - the value recorded is (route PATTERN × source) — never a concrete URL,
 *    never a user id, never free text;
 *  - a nav surface calls `setNavSource(...)` in its click handler, and the
 *    route-change effect CONSUMES it exactly once — an un-consumed stamp
 *    (e.g. a click that didn't navigate) is overwritten by the next one, so
 *    stale attribution cannot leak across navigations;
 *  - first load (no prior in-app navigation) reads as 'deep-link'.
 */

export const NAV_SOURCES = [
  'sidebar', 'palette', 'hub', 'breadcrumb', 'deep-link', 'in-app-link', 'admin-rail',
] as const;
export type NavSource = (typeof NAV_SOURCES)[number];

let pending: NavSource | null = null;
let navigatedBefore = false;

/** Called by a nav surface's click handler just before navigation. */
export function setNavSource(source: NavSource): void {
  pending = source;
}

/** Consume the stamp for the navigation that just happened. */
export function consumeNavSource(): NavSource {
  const source = pending ?? (navigatedBefore ? 'in-app-link' : 'deep-link');
  pending = null;
  navigatedBefore = true;
  return source;
}
