/**
 * Entities feature-package (ADR 0386) — headless content-modeling: user-defined
 * content types, taxonomies (Phase 2), generic entity CRUD/query, and (later
 * phases) the entityApi + `ctx.entities` workflow surface + node pack.
 *
 * Phase 1: types + entity CRUD behind the `entities` toggle (default OFF).
 *
 * @see docs/adr/0386-entities-headless-content-modeling.md
 */
import type { BackendFeature } from '../types.js';
import { registerToggleDefault } from '../../host/featureToggles/registry.js';
import { registerEntitiesRoutes } from './routes.js';
import { registerEntitiesAgentTools } from './agentTools.js';
import { registerEntitiesErasure } from './erasure.js';
import { registerEntityContentResolvers } from './publicRead.js';
import { buildEntitiesSurface } from './surface.js';

export const entitiesFeature: BackendFeature = {
  id: 'entities',
  registerRoutes: (deps) => {
    registerEntitiesRoutes(deps);
    registerEntitiesAgentTools(); // chat-time read tools (ADR 0308 seam)
    // ENT2-M1 — attribution erasure (createdBy/updatedBy; values untouched by
    // design). Registered HERE so a test can assert it was WIRED.
    registerEntitiesErasure();
    // ADR 0407 D3 — register the entityList/entityDetail server-side resolvers
    // into the core content-section registry so the publishing prerenderer can
    // emit crawler HTML + JSON-LD for referenced entity content (features never
    // import each other; the registry mediates).
    registerEntityContentResolvers();
    // ADR 0406 D7 — entity localization is its OWN opt-in (never riding the
    // cms-named toggle; the two features gate independently and compose the
    // same core helpers). OFF ⇒ overlay writes reject, delivery serves base
    // values only — byte-identical to the pre-localization engine.
    registerToggleDefault({
      id: 'entities-localization',
      label: 'Entity localization',
      description: 'Per-locale value overlays on localizable entity fields + locale-negotiated public delivery (ADR 0406).',
      category: 'Platform',
      status: 'off',
      bucketUnit: 'tenant',
      salt: 'entities-localization-v1',
    });
  },
  surface: { id: 'entities', build: buildEntitiesSurface },
  requiredPacks: [{ name: 'feature.entities.nodes', version: '1.1.0' }],
  toggleDefault: {
    id: 'entities',
    label: 'Entities',
    description: 'Headless content-modeling — user-defined content types, fields, and queryable records (ADR 0386).',
    category: 'Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'entities',
  },
};
