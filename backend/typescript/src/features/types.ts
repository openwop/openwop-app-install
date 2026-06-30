/**
 * The backend half of the feature-extension contract (ADR 0001 §2.2).
 *
 * A feature package contributes its backend surface through ONE object: its
 * route registrar, its toggle default, and the packs it requires. The base app
 * composes these alongside the core ROUTE_MODULES (registerAllRoutes.ts) — a
 * separately-distributed feature ships its own BackendFeature and is wired by
 * appending it to BACKEND_FEATURES (features/index.ts), never by editing core.
 *
 * Activation is gated by toggle STATE at request time (a feature reads its own
 * resolved assignment); registration here is unconditional so the route table
 * is stable for replay/audit and so packs stay loaded regardless of on/off
 * (ADR §2.4 — pack presence is decoupled from toggle state).
 */

import type { RouteDeps } from '../routes/registerAllRoutes.js';
import type { ToggleConfig } from '../host/featureToggles/types.js';
import type { FeatureSurfaceBuilder } from '../host/featureSurfaces.js';
import type { WorkflowDefinition } from '../executor/types.js';

/** A pack a feature requires, pinned for replay determinism (RFC 0076). */
export interface PackRef {
  name: string;
  version: string;
}

/**
 * A feature's WORKFLOW surface (ADR 0014 Phase 1) — the typed `ctx.features.<id>`
 * a workflow node calls. `build(scope)` returns the surface bound to one run's
 * tenant; methods MUST enforce tenant isolation (CTI-1) via the feature service
 * and are intended to be called from `role:action` nodes (recorded → replay-safe).
 */
export interface FeatureSurfaceDef {
  /** Surface id — `ctx.features.<id>`; matches the feature id by convention. */
  id: string;
  /** Builds the surface for one run scope. */
  build: FeatureSurfaceBuilder;
}

/**
 * The backend half of a feature (the "FeatureModule", ADR 0014). One object
 * declares every face: REST routes, toggle, packs, AND the workflow surface.
 * `surface` is additive — features without one are unchanged.
 */
export interface BackendFeature {
  /** Feature id — matches the toggle id and the `feature.<id>.*` pack namespace. */
  id: string;
  /** Mount the feature's HTTP routes. Mirrors a core `register*Routes(deps)`. */
  registerRoutes: (deps: RouteDeps) => void;
  /** The toggle's default config, registered into the toggle registry at boot. */
  toggleDefault?: ToggleConfig;
  /** Packs this feature ships, installed via the existing pipeline (ADR §2.4). */
  requiredPacks?: PackRef[];
  /** The feature's `ctx.features.<id>` workflow surface (ADR 0014 Phase 1). */
  surface?: FeatureSurfaceDef;
  /**
   * Always-present BUILT-IN workflow definitions this feature contributes to the
   * hard-coded catalog (resolved restart-safe + cross-instance via
   * `host/builtinWorkflows.ts`, NOT the in-memory builder registry). Use for a
   * feature's own infrastructure workflows (e.g. a meta-workflow), not demo data.
   */
  builtinWorkflows?: readonly WorkflowDefinition[];
}
