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
import type { FeatureSurfaceBuilder, FeatureSurfaceOrgPolicy } from '../host/featureSurfaces.js';
import type { Storage } from '../storage/storage.js';
import type { HostAdapterSuite } from '../host/index.js';
import type { ExampleDataSeeder } from '../host/exampleDataSeeders.js';
import type { ChainBackedRoleMap } from '../host/chainBackedWorkflows.js';
import type { FeatureHostContributions } from '../host/featureContributions.js';

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
  /** ADR 0832 — exceptions to the seam's org floor, stated by name (tenant-level
   *  namespaces; methods whose HTTP door needs more than membership). */
  orgPolicy?: FeatureSurfaceOrgPolicy;
}

/**
 * ADR 1031 — what a feature's `onStart` receives: the same handles `main()`
 * passes the host's own daemons, so a feature daemon needs no import of
 * `src/index.ts` and `src/index.ts` needs no import of the feature.
 */
export interface FeatureStartContext {
  storage: Storage;
  hostSuite: HostAdapterSuite;
  /** The tenants a sweep should visit (`host/rosterService.listRosterTenants`). */
  listRosterTenants: () => Promise<string[]>;
}

/** ADR 1031 — a started feature daemon; `stop()` runs on SIGTERM/SIGINT. */
export interface FeatureDaemonHandle {
  stop(): void;
}

/**
 * ADR 1031 — a feature's contribution to the demo / example-data program, so a
 * feature (first-party or adopter) can join it without editing the host's lists.
 */
export interface FeatureDemoContribution {
  /** Seeders appended AFTER the host's own in the example-data registry (seed
   *  order). Ids must not collide with a host seeder's (a boot error). */
  seeders?: readonly ExampleDataSeeder[];
  /** Toggle ids the demo provisioner enables for a demo tenant so the seeders
   *  above run instead of skipping (joins `DEMO_FEATURE_TOGGLE_IDS`). */
  enableToggles?: readonly string[];
  /** Why this feature deliberately ships NO demo data (joins
   *  `ACKNOWLEDGED_UNSEEDED` for the seed-coverage gate, keyed by its toggle). */
  unseededReason?: string;
}

/**
 * The backend half of a feature (the "FeatureModule", ADR 0014). One object
 * declares every face: REST routes, toggle, packs, AND the workflow surface.
 * `surface` is additive — features without one are unchanged.
 */
export interface BackendFeature {
  /** Feature id — matches the toggle id and the `feature.<id>.*` pack namespace. */
  id: string;
  /**
   * ADR 0915 — paths this feature serves WITHOUT a session (a capability-token
   * surface: the token in the request is the credential). Each must sit
   * strictly below `/host/openwop-app/<id>/`; anything else throws at boot.
   * The owning routes authenticate the token themselves and answer a uniform
   * 404 for an unknown or revoked one. Example (Book AI beta readers):
   * `['/host/openwop-app/bookai-author-suite/reader']`.
   */
  publicPaths?: readonly string[];
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
    /**
     * ADR 0975 D12 — the agent a NEW chat in this workspace opens scoped to, when
     * nothing else names one (no `?agent=` link, no `@mention`). The SPA reads it
     * from `/me/workspaces` and scopes the conversation exactly as `?agent=` does,
     * so the start carries `metadata.agentScope`. It grants nothing: whether a
     * member may chat with this agent is the feature's own run-start grant
     * (KickTodo: `kickbotChatGrant.ts`, D11). The user can still switch agents.
     */
    chatAgent?: string;
  };
  /** Packs this feature ships, installed via the existing pipeline (ADR §2.4).
   *  NAMES only: each one's version lives in `features/packPins.ts` (ADR 0919),
   *  so a pin bump does not edit this descriptor, which every boot references.
   *  Resolve with `featureRequiredPacks(feature)`. */
  requiredPacks?: readonly string[];
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
  /**
   * ADR 1031 — start the feature's background work once the server is up.
   * Called from `main()` only (via `startFeatureDaemons`), after the host's own
   * daemons, so a `createApp()` test boot starts none — exactly as before. Return
   * the handle shutdown stops, or `null` when the feature decides not to start
   * (an env flag, missing config). Keep the decision inside the feature: core
   * never names a product daemon.
   */
  onStart?: (ctx: FeatureStartContext) => FeatureDaemonHandle | null;
  /** ADR 1031 — demo/example-data contributions (see `FeatureDemoContribution`). */
  demo?: FeatureDemoContribution;
  /**
   * ADR 1031 P2 — the feature's in-tree legacy workflow sources that ride as
   * CHAIN-BACKED workflows (ADR 0472 P4): each entry's id + output-role map is
   * registered through `registerLegacyDefsChainBacked` at boot, after the host's
   * own legacy lists and before `validateChainBackedSubChainBinds`. Declared here
   * so a feature (first-party or adopter) owns its list and `features/index.ts`
   * names none of it.
   */
  chainBackedWorkflows?: readonly ChainBackedRoleMap[];
  /** ADR 1031 P2 (security) — the RBAC / auth / logging surface this feature adds
   *  (see `FeatureSecurityDeclaration`). Recorded and SEALED by the composer. */
  security?: FeatureSecurityDeclaration;
  /** ADR 1031 P2 — rows this feature contributes to small host tables (run-notice
   *  audience, enforced plan limits, eraser manifest); see `host/featureContributions.ts`. */
  hostContributions?: FeatureHostContributions;
}

/**
 * ADR 1031 P2 (security) — the security surface a feature may ADD, declared on its
 * definition so only a feature COMPOSED into the build (first-party or adopter,
 * through the registry) can add it. `features/featureSecurity.ts` records every
 * composed feature's declaration right after composition and seals the stores:
 * a registration after that throws. Every entry is listed with its owner in the
 * security census (`test/feature-security-census.test.ts`) against the owning
 * package's committed `security.census.json`, so widening the surface is a
 * reviewed baseline diff, never a side effect.
 */
export interface FeatureSecurityDeclaration {
  /** ADMIN-TIER management scopes (`host:<ns>:<verb>`): granted to the built-in
   *  admin/owner roles, mintable on a key, never carryable by a custom role. */
  scopes?: ReadonlyArray<{ scope: string; reason: string }>;
  /** ADR 0910 activation-only roles over THIS feature's declared default workspace
   *  (`defaultOrg.id`): their scopes join a member's union only during a live
   *  operator activation. Scopes must be management scopes (host or registered). */
  activationRoles?: ReadonlyArray<{ id: string; name: string; description: string; scopes: readonly string[] }>;
  /** Public, unauthenticated routes (`/public/<seg>/<seg>…`): capability-token
   *  surfaces that authenticate their own token and answer a uniform 404. */
  publicRoutes?: ReadonlyArray<{ route: string; reason: string }>;
  /** `reasonCode` log values (ADR 0900 D2) — literals in the same format as the
   *  host vocabulary; trusted past the PII mask only once registered. */
  logReasonCodes?: readonly string[];
}

/**
 * ADR 1031 P2 — a feature package's own entries in the repo's exception-table
 * ratchets (test-only; nothing at runtime reads it).
 *
 * Several ratchets keep a hand-written table of reviewed exceptions — a tool's
 * schema-carrying decision, a daemon allowed to take the fire-once mutex, a
 * store's teardown bucket. A table in an upstream-owned test cannot be edited by
 * an adopter, so an adopter feature that adds a tool or a store could only turn
 * the ratchet red with no adopter-side fix. Instead, a feature package MAY export
 * `ratchetDeclarations: FeatureRatchetDeclarations` from
 * `<feature dir>/ratchetDeclarations.ts`; each ratchet merges the declarations it
 * finds under every feature root (`src/features/*`, `src/adopter/features/*` —
 * `test/helpers/featureRatchetDeclarations.ts`) with its own host table and
 * applies the SAME assertions to the union. An entry here is reviewed exactly
 * like a row in the host table: it carries its reason, and a stale one fails the
 * ratchet's own no-ghost check.
 */
export interface FeatureRatchetDeclarations {
  /** `schema-read-exemption-completeness` — `[toolId, schemaCarrying]` for every
   *  agent tool this feature registers. */
  agentToolSchemaClassification?: ReadonlyArray<readonly [string, boolean]>;
  /** `schema-read-exemption-completeness` — recorded adjudications (TOCC-2a leads)
   *  for this feature's tools; each `why` states the mechanism. */
  agentToolSchemaAdjudications?: Readonly<Record<string, { schemaCarrying: boolean; why: string }>>;
  /** `agent-tool-reach-ratchet` — tools offered to a model through a lane this
   *  feature COMPOSES in host code (not a pack manifest), e.g. a feature-owned
   *  agent's allowlist. Import the live constant; never copy it. */
  composedLaneToolAllowlist?: readonly string[];
  /** `idempotency-lane-tripwire` — files (relative to this feature's directory)
   *  allowed to call the fire-once mutex. Each key must be machine-generated. */
  fireOnceMutexCallers?: readonly string[];
  /** `teardown-reachability-coverage` — this feature's residual stores (neither
   *  `tenantOf` nor a key-derived tenant) with their bucket and cited reason. */
  teardownResidualClassification?: Readonly<Record<string, { bucket: 'REACHABLE_ROW_TENANTID' | 'REACHABLE_PURGE_HOOK' | 'EXEMPT' | 'RECORDED_DEBT'; reason: string }>>;
  /** `subject-erasure-feature-stores` COS-1 — stores whose eraser coverage must be
   *  witnessed in source, not inferred from the directory: the store namespace,
   *  the file (relative to this feature's directory) and the registration it
   *  must contain. */
  subjectErasureWitnesses?: ReadonlyArray<{ store: string; file: string; registration: RegExp }>;
  /** `subject-erasure-feature-stores` CHAN-F6 — stores in THIS feature's directory
   *  that were read and hold no subject data: namespace → what the row holds. The
   *  same assertions as the host `SIGNAL_FREE_REVIEWED` table apply to each entry
   *  (live, a reason, no person-naming field, not PII-declared), and a namespace
   *  in both fails (ADR 0464 §9 D1). */
  subjectErasureSignalFreeReviewed?: Readonly<Record<string, string>>;
  /** `adr0821-displayed-limits-ratchet` — for each plan-limit key this feature
   *  enforces: [file relative to this feature's directory, the token proving it
   *  reads THAT key]. */
  enforcedPlanLimitSites?: Readonly<Record<string, readonly [string, string]>>;
}
