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
 *     tenant+org key (a cross-tenant id simply isn't found).
 *   - Org membership (ADR 0832): CORRECTED. This bullet used to end "A run is
 *     tenant-trusted; per-subject RBAC is the deferred authority refinement",
 *     and 30 surfaces took that at its word: a run acting for a member of org A
 *     read and wrote org B by naming it in `args.orgId`, while the HTTP door
 *     for the same rows answered 403. `gate()` now applies a membership FLOOR to
 *     every method of every surface (toggled and always-on) that receives an
 *     `orgId`: the run's person must hold `workspace:read` in that org (or the
 *     method's declared scope). A run with no person at all (a webhook, a
 *     system job) is still tenant-trusted. The floor is membership, NOT write
 *     authority, and it cannot see an org the method derives from a row id —
 *     both are ADR 0832 residue.
 */

import type { BundleScope, SurfaceArgs, SurfaceFn } from './inMemorySurfaces.js';
import { resolveOne } from './featureToggles/service.js';
import { assertRunScopeOrg, assertTenantScope, type Scope } from './accessControlService.js';
import { createLogger } from '../observability/logger.js';
import { getToggleDefault } from './featureToggles/registry.js';
import { OpenwopError } from '../types.js';

/** A feature's workflow surface: method name → async surface fn. */
export type FeatureSurface = Record<string, SurfaceFn>;
/** Builds a feature surface bound to one run's scope (tenant/run). */
export type FeatureSurfaceBuilder = (scope: BundleScope) => FeatureSurface;

/** ADR 0832 — what a surface declares to the seam's org floor. Both fields
 *  NARROW what the default floor would do or name an exception explicitly;
 *  neither is inferred (an org with no row is never "allowed"). */
export interface FeatureSurfaceOrgPolicy {
  /** Ids that are tenant-level namespaces on THIS surface, not orgs: they have
   *  no org row and no members, so the floor passes them by name. Only `kb`
   *  declares any (`_team`, `_kickbot`); on every other surface they are an
   *  unknown org like any other. */
  tenantScopedOrgs?: ReadonlySet<string>;
  /** Methods whose HTTP door needs more than membership, by method name. The
   *  floor asks this scope instead of `workspace:read`. */
  methodScopes?: Readonly<Record<string, Scope>>;
  /** ADR 0837 D2 / A4 — methods that write TENANT-level state and take no
   *  `orgId` (CRM contacts are the tenant-wide rolodex), so the org floor never
   *  fires for them. For a listed method the seam asks `assertTenantScope` of
   *  the run's person — the actor, else the causing member — with the run's
   *  `personalTenant`: the predicate the HTTP door (`requireTenantScope`) and
   *  the chat tools already share. No person ⇒ no check, as for the org floor. */
  tenantMethodScopes?: Readonly<Record<string, Scope>>;
}

const builders = new Map<string, { build: FeatureSurfaceBuilder; policy: FeatureSurfaceOrgPolicy }>();

/** Register (idempotently) a feature's surface builder. Called by the composer
 *  at boot from `FeatureModule.surface`. */
export function registerFeatureSurface(id: string, build: FeatureSurfaceBuilder, policy: FeatureSurfaceOrgPolicy = {}): void {
  builders.set(id, { build, policy });
}

/** ADR 0917 — of `ids`, the feature surfaces that are OFF for `tenantId`, by
 *  the same resolver the seam's TOGGLE gate uses at run time (an always-on
 *  feature with no toggle is never off). Lets the authoring catalog say what
 *  the run would refuse with `host_capability_disabled`, before the run. */
export async function disabledFeatureSurfacesFor(tenantId: string, ids: Iterable<string>, userId?: string): Promise<Set<string>> {
  const off = new Set<string>();
  for (const id of new Set(ids)) {
    if (!getToggleDefault(id)) continue;
    const a = await resolveOne(id, { tenantId, ...(userId ? { userId } : {}) });
    if (!a || !a.enabled) off.add(id);
  }
  return off;
}

/** Build every registered feature surface for one run scope (called per run by
 *  `buildHostSurfaceBundle`). Each surface is gated at the seam (below): the
 *  feature toggle, so a node cannot read a feature its tenant disabled, and the
 *  org floor, so it cannot reach an org its person is not in. */
export function buildFeatureSurfaces(scope: BundleScope): Record<string, FeatureSurface> {
  const out: Record<string, FeatureSurface> = {};
  const passed = new Set<string>(); // the org floor's memo, shared by every surface in the bundle
  for (const [id, { build, policy }] of builders) out[id] = gate(id, scope, build(scope), policy, passed);
  return out;
}

const log = createLogger('host.featureSurfaces');

/**
 * Wrap every surface method with the seam's two gates.
 *
 * TOGGLE (ADR 0014 — the enforcement counterpart to the Phase-4 capability
 * advertisement). The surface id IS the toggle id by convention; resolved per
 * call against the RUN's tenant, so a tenant with the feature OFF gets a uniform
 * `host_capability_disabled` refusal on EVERY method (not just the ones that
 * happened to gate internally). ALWAYS-ON exception (ADR 0027): a feature that
 * graduated to always-on substrate has NO registered toggle default (e.g. `cms`),
 * so there is no toggle to be OFF and this check is skipped. (Without it,
 * `resolveOne` returns null for a retired toggle and every call is denied.)
 *
 * ORG FLOOR (ADR 0832 D1) — on EVERY surface, always-on included. This used to
 * return an always-on surface unwrapped, which is how `cms` and `kb` stood
 * outside any seam check at all. See {@link orgFloor}.
 */
function gate(id: string, scope: BundleScope, surface: FeatureSurface, policy: FeatureSurfaceOrgPolicy, passed: Set<string>): FeatureSurface {
  const toggled = !!getToggleDefault(id);
  const floor = orgFloor(id, scope, policy, passed);
  const tenantFloor = tenantScopeFloor(id, scope, policy, passed);
  const wrapped: FeatureSurface = {};
  for (const [method, fn] of Object.entries(surface)) {
    wrapped[method] = async (raw) => {
      if (toggled) {
        // ADR 0819 §1 — `resolveOne` is the ACCESS resolver (toggle + plan), so a
        // node is refused a sellable feature the tenant's plan does not include,
        // exactly as the HTTP route is. The acting user rides along (TGWF-4) so a
        // user-listed closed-beta member resolves here as on the route. NOT
        // `orgScopeSubject` (ADR 0832 D3): the causing member is not the actor,
        // and a closed-beta listing is a grant.
        const assignment = await resolveOne(id, { tenantId: scope.tenantId, ...(scope.actingUserId ? { userId: scope.actingUserId } : {}) });
        if (!assignment || !assignment.enabled) {
          throw Object.assign(
            new Error(`feature '${id}' is not enabled for this tenant — ctx.features.${id} is unavailable`),
            { code: 'host_capability_disabled', capability: `host.sample.${id}` },
          );
        }
      }
      // One read of the args: the floor and the method see the same `orgId`
      // (an accessor could otherwise answer the floor with one org and the
      // method with another).
      const args: SurfaceArgs = { ...(raw ?? {}) };
      await floor(method, args);
      await tenantFloor(method);
      return fn(args);
    };
  }
  return wrapped;
}

/**
 * ADR 0832 D1 — the org-membership floor for one bundle.
 *
 * When the run has a person (its acting user, else the member who caused an
 * actorless run) and the method names an org, that person must pass
 * `assertRunScopeOrg` for it: the same predicate as the KB and media surfaces
 * and, through `assertOrgScope`, the HTTP doors. So an absent org is a uniform
 * `not_found`, a missing scope is `forbidden_scope`, and the single-principal
 * root shortcut (`user:`/`anon:`, and `default` in demo mode) behaves exactly as
 * there. A causing member is answered by membership only (no personal-owner
 * short-circuit; see `assertRunOrgScope`).
 *
 * - No person ⇒ no check: a webhook or system job stays tenant-trusted.
 * - `orgId` absent — `undefined`, `null` or `''` — ⇒ no check: the call names no
 *   org. All three mean "none" to the surfaces (`surfaceStr`/`optStr` coerce
 *   them alike), and a chain launched with no trigger payload legitimately
 *   passes `''` to a node whose own "not found" branch is the honest answer
 *   (forms-intake WF-FORM-2). A method that then lists the WHOLE tenant is ADR
 *   0832 residue S-A, pinned by `adr0830-kb-ratchets.test.ts`.
 * - `orgId` present but not a string (an array, a number, an object) ⇒
 *   `validation_error`: `campaign-intel` runs `String(args.orgId ?? '')`, so
 *   `['B']` would reach the service as `'B'` without ever meeting the floor.
 * - A declared tenant-scoped namespace passes by NAME on its own surface only.
 *
 * Passes are memoised per (scope, org) for the bundle, which the executor builds
 * per node: each resolve scans the member stores, and a node that loops over one
 * org should pay once. Only a pass is cached, so a transient storage error is
 * retried rather than remembered. A membership removed while one node runs is
 * therefore seen from the NEXT node on. Every refusal is logged, because this
 * floor changes what existing scheduled, triggered and channel runs may do and
 * an operator needs to see which ones it stops.
 */
function orgFloor(id: string, scope: BundleScope, policy: FeatureSurfaceOrgPolicy, passed: Set<string>): (method: string, args: SurfaceArgs) => Promise<void> {
  const lane = scope.actingUserId ? 'actor' : scope.orgScopeSubject ? 'cause' : undefined;
  return async (method, args) => {
    const orgId = args.orgId;
    if (!lane || orgId === undefined || orgId === null || orgId === '') return;
    try {
      if (typeof orgId !== 'string') {
        throw new OpenwopError('validation_error', '`orgId` must be a string.', 400, { field: 'orgId' });
      }
      if (policy.tenantScopedOrgs?.has(orgId)) return;
      const needed: Scope = policy.methodScopes?.[method] ?? 'workspace:read';
      const key = `${needed}\u0000${orgId}`;
      if (passed.has(key)) return;
      await assertRunScopeOrg(scope, orgId, needed);
      passed.add(key);
    } catch (err) {
      if (err instanceof OpenwopError) {
        log.info('surface_org_floor_refused', { surface: id, method, lane, code: err.code, tenantId: scope.tenantId, ...(scope.runId ? { runId: scope.runId } : {}) });
      }
      throw err;
    }
  };
}

/**
 * ADR 0837 D2 / A4 — the tenant-level twin of {@link orgFloor}, for the methods a
 * surface lists in `tenantMethodScopes`. The run's person (actor, else causing
 * member) must hold the scope in the TENANT, exactly as the HTTP door asks via
 * `requireTenantScope`. Same memo, same refusal log, same "no person ⇒ no check".
 */
function tenantScopeFloor(id: string, scope: BundleScope, policy: FeatureSurfaceOrgPolicy, passed: Set<string>): (method: string) => Promise<void> {
  const subject = scope.actingUserId ?? scope.orgScopeSubject;
  const lane = scope.actingUserId ? 'actor' : scope.orgScopeSubject ? 'cause' : undefined;
  return async (method) => {
    const needed = policy.tenantMethodScopes?.[method];
    if (!needed || !subject) return;
    const key = `tenant:${needed}`;
    if (passed.has(key)) return;
    try {
      await assertTenantScope(scope.tenantId, subject, needed, scope.personalTenant ? { personalTenant: scope.personalTenant } : {});
      passed.add(key);
    } catch (err) {
      if (err instanceof OpenwopError) {
        log.info('surface_tenant_floor_refused', { surface: id, method, lane, code: err.code, tenantId: scope.tenantId, ...(scope.runId ? { runId: scope.runId } : {}) });
      }
      throw err;
    }
  };
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
