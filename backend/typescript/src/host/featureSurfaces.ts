/**
 * Feature surface registry (ADR 0014 Phase 1) — the seam by which a
 * BackendFeature contributes a typed `ctx.features.<id>` host surface for
 * workflow nodes, WITHOUT editing the core `buildHostSurfaceBundle`. A feature
 * declares `surface: { id, build }` (FeatureModule); the composer registers the
 * builder here; `buildHostSurfaceBundle` calls `buildFeatureSurfaces(scope)` once
 * per run and the executor binds the result into `NodeContext.features`.
 *
 * Replay/security model (the seam relies on these, it does not re-implement them):
 *   - Replay-safe: CORRECTED (CSMCD-13 / ADR 0645 D3, 2026-09-09). This bullet
 *     used to read: "feature surfaces are called from `role: "action"` pack
 *     nodes, whose outputs are recorded in the event log; replay/fork read the
 *     recorded output rather than re-executing (so reads return the same payload
 *     and writes aren't re-issued). The feature node-pack convention (Phase 2)
 *     enforces the action role."
 *
 *     THAT WAS FALSE, and this seam is the UPSTREAM of the defect ADR 0645 D3
 *     fixed in `feature.csm.nodes`: nothing in the executor compares `role` to
 *     the string `"action"` — MEASURED, and `executor/sideEffects.ts` states it
 *     verbatim. What actually earns replay-serving is `role: "side-effect"` (or
 *     the `side-effectful` capability), which places a typeId in the derived
 *     floor AND the fast-path served set; membership in the floor alone is
 *     UNDISCHARGED (ADR 0572).
 *
 *     So: a surface method that WRITES must be reached from a node declaring
 *     `side-effect` + `side-effectful`. A surface method that only READS may
 *     stay `action`. Leaving the old sentence in place prescribed the wrong role
 *     for the next feature that writes through a surface, which is precisely how
 *     CSM's `health-set` came to be classified like a read.
 *   - Tenant isolation (CTI-1): the builder closes over `scope.tenantId`; surface
 *     methods take an explicit `orgId` and the feature SERVICE enforces the
 *     tenant+org key (a cross-tenant id simply isn't found). A run is
 *     tenant-trusted; per-subject RBAC is the deferred authority refinement.
 */

import type { BundleScope, SurfaceFn } from './inMemorySurfaces.js';
import { resolveOne } from './featureToggles/service.js';
import { getToggleDefault } from './featureToggles/registry.js';
import { OpenwopError } from '../types.js';

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
 *
 * ALWAYS-ON exception (ADR 0027): a feature that graduated to always-on
 * substrate has NO registered toggle default (e.g. `cms`). Such a surface is
 * unconditionally available — there is no toggle to be OFF — so the gate is
 * skipped. (Without this, `resolveOne` returns null for a retired toggle and the
 * surface would be wrongly denied on every call.)
 */
function gate(id: string, scope: BundleScope, surface: FeatureSurface): FeatureSurface {
  const alwaysOn = !getToggleDefault(id);
  if (alwaysOn) return surface;
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
/**
 * A node-supplied optional POSITIVE COUNT arg (`topK`, `limit`, `maxResults`…).
 * ABSENT ⇒ `undefined` ("use the callee's default"). PRESENT AND UNUSABLE ⇒ a
 * typed `validation_error`, never a silent fallback.
 *
 * ADR 0602 / `NBWF-1`: the one shared rule for the numeric-fan-out class, added
 * because two sibling methods of ONE surface disagreed about it —
 * `notebooks.searchNotebook` ran `topK` through `surfaceOptStr`, which returns
 * `string | undefined`, so a perfectly valid `topK: 5` became `undefined` and the
 * search silently ran at the host default while REPORTING SUCCESS;
 * `notebooks.ask` hand-wrote the correct check two dozen lines away.
 *
 * ── ADR 0602 § Correction log, item C (`M6`/`L4`) ─────────────────────────────
 *
 * The first version returned `undefined` for an unusable value, and its stated
 * reason was a NON-SEQUITUR: "coercing would hide the type drift from
 * `mcp-projection-param-type-parity.test.ts`". That gate reads STATIC PACK JSON.
 * It never sees a runtime value, so nothing this function does at runtime can
 * hide or reveal anything from it. What the fallback actually produced is the
 * defect the whole item is about — a wrong-sized result set returned with
 * `status: 'success'` — merely reached from a different input. Worse, the test
 * added alongside it PINNED that behaviour
 * (`expect(stringy.hits.length).toBe(unbounded.hits.length)`), which is worse
 * than no test: it makes the honest fix look like a regression.
 *
 * A present-but-unusable count is now a typed failure, per the repo's
 * non-negotiable ("invalid input is a typed failure, never
 * success-with-empty-or-wrong"). The caller learns its launch contract is wrong
 * instead of quietly receiving someone else's default.
 *
 * `L4` folded in: the old predicate was `v > 0 ? Math.floor(v) : undefined`, so
 * `0.5` passed the guard and returned **0** — a "positive count" of zero, and a
 * latent slice-index hazard. The usable set is now stated once, as what it
 * actually is: a finite number whose floor is at least 1.
 */
export const surfaceOptCount = (v: unknown): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isFinite(v) && Math.floor(v) >= 1) return Math.floor(v);
  throw new OpenwopError(
    'validation_error',
    `expected a positive whole count, received ${typeof v === 'number' ? String(v) : `${typeof v} ${JSON.stringify(v)}`} `
    + '— a count arg is not coerced, because a wrong-sized result returned as a success is the defect ADR 0602 closes.',
    400,
  );
};

/** Test-only: drop all registered surfaces. */
export function __clearFeatureSurfaces(): void {
  builders.clear();
}
