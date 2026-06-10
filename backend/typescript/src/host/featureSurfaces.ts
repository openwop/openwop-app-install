/**
 * Feature surface registry (ADR 0014 Phase 1) — the seam by which a
 * BackendFeature contributes a typed `ctx.features.<id>` host surface for
 * workflow nodes, WITHOUT editing the core `buildHostSurfaceBundle`. A feature
 * declares `surface: { id, build }` (FeatureModule); the composer registers the
 * builder here; `buildHostSurfaceBundle` calls `buildFeatureSurfaces(scope)` once
 * per run and the executor binds the result into `NodeContext.features`.
 *
 * Replay/security model (the seam relies on these, it does not re-implement them):
 *   - Replay-safe: feature surfaces are called from `role: "action"` pack nodes,
 *     whose outputs are recorded in the event log; replay/fork read the recorded
 *     output rather than re-executing (so reads return the same payload and
 *     writes aren't re-issued). The feature node-pack convention (Phase 2)
 *     enforces the action role.
 *   - Tenant isolation (CTI-1): the builder closes over `scope.tenantId`; surface
 *     methods take an explicit `orgId` and the feature SERVICE enforces the
 *     tenant+org key (a cross-tenant id simply isn't found). A run is
 *     tenant-trusted; per-subject RBAC is the deferred authority refinement.
 */

import type { BundleScope, SurfaceFn } from './inMemorySurfaces.js';
import { resolveOne } from './featureToggles/service.js';

/** A feature's workflow surface: method name → async surface fn. */
export type FeatureSurface = Record<string, SurfaceFn>;
/** Builds a feature surface bound to one run's scope (tenant/run). */
export type FeatureSurfaceBuilder = (scope: BundleScope) => FeatureSurface;

const builders = new Map<string, FeatureSurfaceBuilder>();

/** Register (idempotently) a feature's surface builder. Called by the composer
 *  at boot from `FeatureModule.surface`. */
export function registerFeatureSurface(id: string, build: FeatureSurfaceBuilder): void {
  builders.set(id, build);
}

/** Build every registered feature surface for one run scope (called per run by
 *  `buildHostSurfaceBundle`). Each surface is TOGGLE-GATED at the seam (below) —
 *  a node must not read a feature's data for a tenant that disabled it. */
export function buildFeatureSurfaces(scope: BundleScope): Record<string, FeatureSurface> {
  const out: Record<string, FeatureSurface> = {};
  for (const [id, build] of builders) out[id] = gate(id, scope, build(scope));
  return out;
}

/**
 * Wrap every surface method with the feature's toggle gate (ADR 0014 — the
 * enforcement counterpart to the Phase-4 capability advertisement). The surface
 * id IS the toggle id by convention; resolved per call against the RUN's tenant,
 * so a tenant with the feature OFF gets a uniform `host_capability_disabled`
 * refusal on EVERY method (not just the ones that happened to gate internally).
 */
function gate(id: string, scope: BundleScope, surface: FeatureSurface): FeatureSurface {
  const wrapped: FeatureSurface = {};
  for (const [method, fn] of Object.entries(surface)) {
    wrapped[method] = async (args) => {
      const assignment = await resolveOne(id, { tenantId: scope.tenantId });
      if (!assignment || !assignment.enabled) {
        throw Object.assign(
          new Error(`feature '${id}' is not enabled for this tenant — ctx.features.${id} is unavailable`),
          { code: 'host_capability_disabled', capability: `host.sample.${id}` },
        );
      }
      return fn(args);
    };
  }
  return wrapped;
}

/** The ids of currently-registered feature surfaces (for capability discovery). */
export function registeredFeatureSurfaceIds(): string[] {
  return [...builders.keys()].sort();
}

// Shared arg-coercion for feature surfaces (was duplicated per surface).
/** A node-supplied string arg, or '' when absent/non-string. */
export const surfaceStr = (v: unknown): string => (typeof v === 'string' ? v : '');
/** A node-supplied non-empty string arg, or undefined. */
export const surfaceOptStr = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** Test-only: drop all registered surfaces. */
export function __clearFeatureSurfaces(): void {
  builders.clear();
}
