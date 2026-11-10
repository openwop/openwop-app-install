/**
 * ADR 1031 P2 (security) — public, unauthenticated ROUTES a composed feature
 * registers (`BackendFeature.security.publicRoutes`): capability-token surfaces
 * outside the vendor tree (KickTodo's `/public/kicktodo/feed`, its wearable
 * webhook), which moved here off `auth.ts`'s `PUBLIC_PATH_PREFIXES`.
 *
 * A LEAF (no imports), so the composer's seal can write it whatever the module
 * evaluation order is. `auth.ts` matches these exactly as it matches its host list
 * (segment-boundary prefix) and hands its host prefixes over when it finishes
 * loading; the overlap check runs as soon as both sides are known, at load.
 *
 * Controls: written only by the seal (`features/featureSecurity.ts`), every write
 * after it throws; each route is `/public/<seg>/<seg>…` (lowercase segments, at
 * least two, no wildcard, no trailing slash, no dot segment, no escape); it may
 * not equal, contain or sit inside a host public prefix or another feature's
 * route; and it is listed with its owner in the security census
 * (`test/feature-security-census.test.ts`). The owning route authenticates its own
 * capability and answers a uniform 404, as every public route does.
 */
const routes = new Map<string, string>(); // route → owning feature
const SHAPE = /^\/public(?:\/[a-z0-9][a-z0-9-]{0,63}){2,6}$/;
let sealed = false;
let hostPrefixes: readonly string[] | null = null;

const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');

function checkHostOverlap(route: string, featureId: string): void {
  const host = hostPrefixes?.find((p) => p !== '/' && overlaps(route, p));
  if (host) throw new Error(`feature '${featureId}': public route ${route} overlaps the host public prefix ${host} (ADR 1031 P2)`);
}

export function recordFeaturePublicRoute(featureId: string, route: string): void {
  if (sealed) throw new Error(`feature security registration is closed (ADR 1031 P2): public route ${JSON.stringify(route)} (feature '${featureId}') was registered after the seal`);
  if (!SHAPE.test(route)) throw new Error(`feature '${featureId}': public route ${JSON.stringify(route)} must be /public/<seg>/<seg>… (lowercase segments, no wildcard, no trailing slash)`);
  for (const [r, owner] of routes) if (overlaps(route, r)) throw new Error(`feature '${featureId}': public route ${route} overlaps ${r} (feature '${owner}')`);
  checkHostOverlap(route, featureId);
  routes.set(route, featureId);
}

export function sealFeaturePublicRoutes(): void { sealed = true; }

/** `auth.ts` hands over its host list when it finishes loading. */
export function setHostPublicPrefixes(prefixes: readonly string[]): void {
  hostPrefixes = prefixes;
  for (const [route, featureId] of routes) checkHostOverlap(route, featureId);
}

/** Segment-boundary prefix match, identical to the host list's. */
export function isFeaturePublicRoute(path: string): boolean {
  for (const p of routes.keys()) if (path === p || path.startsWith(p + '/')) return true;
  return false;
}

/** Every registered public route with its owner (census). */
export function featurePublicRoutes(): Array<{ featureId: string; route: string }> {
  return [...routes].map(([route, featureId]) => ({ featureId, route }));
}
