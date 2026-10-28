/**
 * ADR 0873 D1/D4 — a declared offline navigation must be a path the declaring
 * feature owns.
 *
 * The build cannot evaluate React route modules, so this half of the check runs
 * in the vitest lane (`src/sw/__tests__/offlineDeclarations.test.ts`), which the
 * `npm run ci` merge gate runs. The data-only checks (D4 never-cache, D9
 * start_url, shape) fail the build itself (`scripts/gen-service-worker.mjs`).
 */
import type { FrontendFeature } from '../features/registry.js';
import type { FeatureOffline } from './offlineTypes.js';

/** The literal part of a react-router path: the segments before the first `:param` or `*`. */
export function staticPrefix(routePath: string): string {
  const out: string[] = [];
  for (const seg of routePath.split('/').slice(1)) {
    if (seg.startsWith(':') || seg.includes('*')) break;
    out.push(seg);
  }
  return `/${out.join('/')}`;
}

/** Error strings for every navigation `feature` declares but does not own. A
 *  navigation is owned when it equals, or is below, the static prefix of one of
 *  the feature's own `routes[].path` (never `/`), or when one of its
 *  `publicRoutes[].match` accepts it. */
export function navigationOwnershipErrors(feature: Pick<FrontendFeature, 'id' | 'routes' | 'publicRoutes' | 'offline'>): string[] {
  const prefixes = feature.routes.map((r) => staticPrefix(r.path)).filter((p) => p !== '/');
  const errors: string[] = [];
  for (const nav of feature.offline?.navigations ?? []) {
    const owned = prefixes.some((p) => nav === p || nav.startsWith(`${p}/`))
      || (feature.publicRoutes ?? []).some((r) => r.match(nav));
    if (!owned) errors.push(`${feature.id}: navigation ${nav} is not under one of its own routes`);
  }
  return errors;
}

/** ADR 0873 D1 + P24 — error strings where the build's `offline.ts` declarations
 *  (`fromFiles`) and the runtime `FrontendFeature.offline` values (`fromRuntime`)
 *  disagree. A runtime value needs its file and must be that file's value. A file
 *  may stay build-only (runtime unset) unless it sets `entitlement`, the only part
 *  the runtime reads (`registry.ts` `featureRoutes`, `lastKnownEntitlementFeatureIds`). */
export function declarationParityErrors(
  fromFiles: ReadonlyMap<string, FeatureOffline>,
  fromRuntime: ReadonlyMap<string, FeatureOffline>,
): string[] {
  const errors: string[] = [];
  for (const id of fromRuntime.keys()) if (!fromFiles.has(id)) errors.push(`${id}: offline is set but the build reads no offline.ts`);
  for (const [id, offline] of fromFiles) {
    const runtime = fromRuntime.get(id);
    if (runtime === undefined) {
      if (offline.entitlement !== undefined) errors.push(`${id}: offline.ts sets entitlement, so FrontendFeature.offline must be set`);
    } else if (runtime !== offline) {
      errors.push(`${id}: FrontendFeature.offline is not the offline.ts value`);
    }
  }
  return errors;
}
