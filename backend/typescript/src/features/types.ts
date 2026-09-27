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
  /**
   * SUB-toggles this feature owns beyond its primary `toggleDefault` (ADR 0404
   * §P4) — a nested capability gated independently of (and AND-ed with) the parent.
   * Registered at boot exactly like `toggleDefault`, but NOT projected into the
   * demo seed-coverage gate (a sub-capability of an already-covered feature needs
   * no separate ACK). A route/verb gating on one MUST also resolve the parent.
   */
  extraToggleDefaults?: readonly ToggleConfig[];
  /**
   * ADR 0684 phase 1 — a DEFAULT ORG + WORKSPACE this feature wants provisioned
   * at boot, so a fresh deployment is usable without a per-deployment browser
   * runbook.
   *
   * The feature declares; core does not learn a product name. Adding
   * `host-<product>` beside `host-site` in `accessControlService` would be one
   * line cheaper and would make core a registry of products — the ADR 0001
   * boundary. So the id lives here, with the feature that means it.
   *
   * ID FORMS ARE NOT INTERCHANGEABLE. `orgId` takes the HYPHEN form and
   * `tenantId` the COLON form, exactly as `systemSite.ts:30-31` does
   * (`host-site` / `host:site`). A colon in an org id ends up in a URL path
   * segment — `/public/host:x/challenges` — needing percent-encoding and handing
   * `resolvePublicTenant` an encode/decode mismatch to get wrong.
   *
   * The declared tenant IS the workspace participants share (ADR 0684 §2), so
   * catalog, enrollment and group surfaces are same-tenant reads and nothing
   * crosses a tenant boundary.
   */
  defaultOrg?: {
    /**
     * The workspace id, used as BOTH the org id and the tenant id.
     *
     * ONE FIELD, DELIBERATELY. This was a PAIR — `orgId: 'host-kicktodo'` plus
     * `tenantId: 'host:kicktodo'` — and the pair is what broke ADR 0684: this
     * host defines a workspace as an org whose id EQUALS its tenant
     * (`accessControlService.isWorkspaceOrg`), so a declaration that forced them
     * apart could never produce an enterable workspace. Auto-join wrote member
     * rows no predicate could match. Collapsing to one field makes the mismatch
     * unrepresentable rather than merely asserted — the assertion existed and
     * enforced the WRONG side of it.
     *
     * Hyphen form, e.g. `host-kicktodo`. It appears in a public URL path segment
     * (`/public/:orgId/…`), so it stays URL-plain; nothing in this codebase
     * parses a colon out of a tenant id (measured, ADR 0684 correction §3a).
     */
    id: string;
    /** Human label for the org row. */
    name: string;
  };
  /** Packs this feature ships, installed via the existing pipeline (ADR §2.4). */
  requiredPacks?: PackRef[];
  /**
   * Hard feature dependencies (ADR 0194) — ids of OTHER features this one needs to
   * function. Enforced as a DISABLE-LOCK: a depended-on feature cannot be turned
   * OFF while this (enabled) feature declares it here, which would orphan this
   * feature. Declare only genuinely-breaking deps (e.g. `email` → `crm`: a campaign
   * has no audience without CRM contacts). A dep that is always-on substrate (no
   * `toggleDefault`) is always satisfied and never blocks. Registered into the
   * feature-toggle dependency graph at boot (`registerFeatureDependencies`).
   */
  dependsOn?: string[];
  /**
   * Soft dependencies (ADR 0194) — ids of features this one works BETTER with but
   * does not require. Advisory only: surfaced as install/enable suggestions, never
   * a lock. Reserved for a later phase; declaring it today records the relationship
   * without changing behavior.
   */
  recommends?: string[];
  /** The feature's `ctx.features.<id>` workflow surface (ADR 0014 Phase 1). */
  surface?: FeatureSurfaceDef;
}
