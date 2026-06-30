/**
 * Hub tab projection (ADR 0144, generalized to many consoles by ADR 0145).
 *
 * A pure function so the gating + scope-filter + ordering logic is unit-testable
 * without rendering a console page (the page just maps the result to <Tabs>).
 * Mirrors how the nav rail is built: same `useFeatureVisible` predicate, applied
 * to the same `FEATURES` manifest.
 *
 * Lives in `chrome/` (core), NOT in a feature directory, so that EVERY console
 * (`features/access-hub`, `features/models`, `features/chat-deployment`) can
 * import it without a feature→feature edge (forbidden by ARCHITECTURE.md).
 */
import type { HubScope } from './hubContext.js';
import type { FeatureHubTab, FeatureRoute, HubId } from './featureTypes.js';

export type HubRoute = FeatureRoute & { hubTab: FeatureHubTab };

/** A tab whose `hub` discriminator (default `'access'`) names the given console. */
function inHub(route: HubRoute, hub: HubId): boolean {
  return (route.hubTab.hub ?? 'access') === hub;
}

/** Stable tab id = the route path's last segment (`/keys` → `keys`). */
export function tabIdOf(route: FeatureRoute): string {
  return route.path.split('/').filter(Boolean).pop() ?? route.path;
}

/** Which scope-pill positions a route appears under (default Workspace-only). */
export function scopesOf(route: HubRoute): HubScope[] {
  return route.hubTab.scopes ?? ['workspace'];
}

/**
 * Every tab for ONE console the caller may see — filtered by the `hub`
 * discriminator, gated by `isVisible` (the toggle gate the rail uses), ordered by
 * `groupOrder` then `hubTab.order`. Scope is applied separately by the caller so
 * a page can also ask "is there any Personal surface?".
 *
 * @param groupOrder display order of `hubTab.group` values; tabs without a group
 *   (flat consoles) sort purely by `order`.
 */
export function visibleHubRoutes(
  features: readonly FeatureRoute[],
  isVisible: (featureId?: string) => boolean,
  hub: HubId,
  groupOrder: readonly string[] = [],
): HubRoute[] {
  const groupRank = (g?: string): number => {
    const i = g === undefined ? -1 : groupOrder.indexOf(g);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return features
    .filter((r): r is HubRoute => Boolean(r.hubTab))
    .filter((r) => inHub(r, hub))
    .filter((r) => isVisible(r.hubTab.featureId))
    .sort((a, b) => {
      const g = groupRank(a.hubTab.group) - groupRank(b.hubTab.group);
      if (g !== 0) return g;
      return (a.hubTab.order ?? Number.MAX_SAFE_INTEGER) - (b.hubTab.order ?? Number.MAX_SAFE_INTEGER);
    });
}
