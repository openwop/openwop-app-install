/**
 * Backend feature registry (ADR 0001 §2.2).
 *
 * The single list the base app composes alongside the core route modules. A
 * separately-distributed feature is wired by appending its BackendFeature here
 * — no edits to registerAllRoutes' core list. `registerBackendFeatures` is
 * called once, after the core modules are mounted, from registerAllRoutes.ts.
 *
 * Each feature, at registration: (1) declares its toggle default into the
 * toggle registry, (2) mounts its routes. Pack installation (requiredPacks) is
 * driven separately at boot from the union of features (Phase 3/4) so packs
 * stay present regardless of toggle state.
 */

import { createLogger } from '../observability/logger.js';
import { registerToggleDefault } from '../host/featureToggles/registry.js';
import { registerFeatureSurface } from '../host/featureSurfaces.js';
import type { RouteDeps } from '../routes/registerAllRoutes.js';
import type { BackendFeature, PackRef } from './types.js';
import { widgetsFeature } from './widgets.js';
import { crmFeature } from './crm/feature.js';
import { csmFeature } from './csm/feature.js';
import { usersFeature } from './users/feature.js';
import { orgsFeature } from './orgs/feature.js';
import { profilesFeature } from './profiles/feature.js';
import { mediaFeature } from './media/feature.js';
import { cmsFeature } from './cms/feature.js';
import { notificationsFeature } from './notifications/feature.js';
import { kbFeature } from './kb/feature.js';
import { publishingFeature } from './publishing/feature.js';
import { sharingFeature } from './sharing/feature.js';

const log = createLogger('features');

/** Every backend feature the app composes. Append a new feature here. */
export const BACKEND_FEATURES: BackendFeature[] = [widgetsFeature, crmFeature, csmFeature, usersFeature, orgsFeature, profilesFeature, mediaFeature, cmsFeature, notificationsFeature, kbFeature, publishingFeature, sharingFeature];

/** Declare toggle defaults + mount routes + register workflow surfaces for every
 *  backend feature (ADR 0014 — the composer wires all faces in one pass). */
export function registerBackendFeatures(deps: RouteDeps): void {
  for (const feature of BACKEND_FEATURES) {
    if (feature.toggleDefault) registerToggleDefault(feature.toggleDefault);
    feature.registerRoutes(deps);
    // Face 2 (ADR 0014 Phase 1): the feature's ctx.features.<id> workflow surface.
    if (feature.surface) registerFeatureSurface(feature.surface.id, feature.surface.build);
    log.debug('feature_registered', { id: feature.id, packs: feature.requiredPacks?.length ?? 0, surface: feature.surface?.id ?? null });
  }
}

/** The union of all features' required packs (Phase 3/4: boot install set). */
export function featurePackRefs(): PackRef[] {
  const seen = new Set<string>();
  const out: PackRef[] = [];
  for (const feature of BACKEND_FEATURES) {
    for (const ref of feature.requiredPacks ?? []) {
      const key = `${ref.name}@${ref.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ref);
    }
  }
  return out;
}
