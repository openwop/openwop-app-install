/**
 * ADR 0391 (b) — the public `/pricing` route matcher. A single fixed path (no
 * params), so this is a trivial predicate kept alongside `blogRoute` /
 * `publicPageRoute` for the App.tsx public-dispatch symmetry (every public
 * surface is a pure `match*` function). A trailing slash is tolerated.
 */
export function matchPricingRoute(pathname: string): boolean {
  return pathname === '/pricing' || pathname === '/pricing/';
}
