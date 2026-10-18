/**
 * Bundle activation (ADR 0892 Phase B) — turning a feature bundle ON or OFF for
 * ONE workspace, through the existing toggle seams.
 *
 * A bundle (`distributions/bundles.json`) used to be a unit of SALE only: buying
 * one granted an entitlement and never flipped a toggle, so a tenant could pay for
 * a bundle it could not see. This module is the one place that turns a bundle into
 * per-tenant toggle overrides. Both callers use it: the workspace-admin store routes
 * (`features/marketplace/routes.ts`) and billing's verified `grant-started`
 * transition (`features/billing/billingService.ts`).
 *
 * The rules, in the order they are checked:
 *  - the closure is the bundle's features plus the transitive `dependsOn` of each
 *    (enabling `commerce` enables `crm`); ids with no toggle are always-on and
 *    skipped (D4);
 *  - a killed toggle anywhere in the closure refuses the whole enable; no override
 *    is ever written over a kill (D3, ADR 0819 §3);
 *  - the tenant must be ENTITLED to every sellable feature of the closure, asked
 *    through the same `checkTenantEntitlement` seam `resolveOne` uses, so
 *    "entitled" here means exactly "the plan half of `resolveOne` will not refuse
 *    it". Turning a toggle on never bypasses the plan (D2, ADR 0419 priced ⟹ gated);
 *  - disable turns off the bundle's OWN features, never its dependencies (another
 *    bundle may need them), behind the ADR 0194 disable-lock for this tenant (D5).
 *    It deletes no data.
 *
 * Every refusal is a typed `refused` on the result, never a thrown string and never
 * an empty success. One audit row per changed id (D6).
 *
 * Host-level: imports no feature (ADR 0001). Billing reaches the plan through the
 * entitlement seam it registers at boot.
 */
import { OpenwopError } from '../types.js';
import { bundleFeatureIds, bundleOfFeature, isSellableBundleFeature, knownBundleIds } from './featureBundles.js';
import { checkTenantEntitlement } from './entitlementSeam.js';
import { getFeatureDependencies, getToggleDefault } from './featureToggles/registry.js';
import {
  disableTenantOverride, enableTenantOverride, getStoredConfig, resolveToggle, tenantDisableBlockers,
} from './featureToggles/service.js';
import { recordToggleChange } from './featureToggles/audit.js';

export type BundleRefusal =
  | { reason: 'unknown_bundle' }
  /** `missing` = closure features the plan does not cover; `bundles` = the bundles
   *  that sell them (what a checkout would need). */
  | { reason: 'bundle_not_entitled'; missing: string[]; bundles: string[] }
  | { reason: 'feature_killed'; ids: string[] }
  /** Features outside the bundle, enabled for this tenant, that need one of its features. */
  | { reason: 'disable_blocked'; dependents: string[] };

export interface BundleEnableResult {
  bundleId: string;
  /** Ids newly enabled for the tenant by this call. */
  enabled: string[];
  /** Ids already enabled for the tenant (no write). */
  alreadyOn: string[];
  /** Ids in the closure with no toggle (always-on substrate, or not in this build). */
  skipped: string[];
  refused?: BundleRefusal;
}

export interface BundleDisableResult {
  bundleId: string;
  /** Ids newly turned off for the tenant by this call. */
  disabled: string[];
  /** Ids already off for the tenant (no write). */
  alreadyOff: string[];
  skipped: string[];
  refused?: BundleRefusal;
}

/** Where a bundle stands for one workspace (the store card state, D9/D10). */
export interface BundleActivationState {
  /** `enabled`: every toggled feature of the bundle is on for the tenant and it is
   *  entitled. `available`: entitled and not killed, so Enable will succeed.
   *  `locked`: a closure feature is killed or not covered by the plan. */
  status: 'enabled' | 'available' | 'locked';
  /** Closure features the plan does not cover (present only when non-empty). */
  missing?: string[];
  /** Closure features under the kill switch (present only when non-empty). */
  killed?: string[];
}

/** The bundle's features plus the transitive `dependsOn` closure, dependencies
 *  FIRST (post-order), so a write that stops part-way never leaves a dependent on
 *  without what it needs. */
export function bundleClosure(bundleId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dep of getFeatureDependencies(id)) visit(dep);
    out.push(id);
  };
  for (const id of bundleFeatureIds(bundleId)) visit(id);
  return out;
}

function isToggled(id: string): boolean {
  return getToggleDefault(id) !== undefined;
}

/** The sellable closure features the tenant's plan does not cover. A refusal is the
 *  seam's 403; any other fault propagates (fail closed — an outage is not "not entitled"). */
async function unentitled(ids: readonly string[], tenantId: string): Promise<string[]> {
  const missing: string[] = [];
  for (const id of ids) {
    if (!isSellableBundleFeature(id)) continue;
    try {
      await checkTenantEntitlement(tenantId, id);
    } catch (err) {
      if (err instanceof OpenwopError && err.httpStatus === 403) missing.push(id);
      else throw err;
    }
  }
  return missing;
}

async function killedIds(ids: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) if ((await getStoredConfig(id))?.killed) out.push(id);
  return out;
}

function sellersOf(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => bundleOfFeature(id)).filter((b): b is string => Boolean(b)))];
}

/** Whether `bundleId` is declared in this deployment's catalog. */
export function isKnownBundle(bundleId: string): boolean {
  return knownBundleIds().includes(bundleId);
}

/**
 * The store state of one bundle for one workspace. Reads only: the toggle half via
 * `resolveToggle` (visibility), the plan half via the entitlement seam.
 */
export async function bundleActivationState(bundleId: string, tenantId: string): Promise<BundleActivationState> {
  const closure = bundleClosure(bundleId).filter(isToggled);
  const killed = await killedIds(closure);
  const missing = await unentitled(closure, tenantId);
  if (killed.length || missing.length) {
    return { status: 'locked', ...(missing.length ? { missing } : {}), ...(killed.length ? { killed } : {}) };
  }
  const own = bundleFeatureIds(bundleId).filter(isToggled);
  for (const id of own) {
    if (!(await resolveToggle(id, { tenantId }))?.enabled) return { status: 'available' };
  }
  return { status: 'enabled' };
}

/**
 * Turn a bundle ON for one tenant (D2–D6). Idempotent: an id already on is left
 * alone. `actor` is the acting principal (the audit `principalId` and the row's
 * `updatedBy`); billing passes `billing:bundle-grant`.
 */
export async function enableBundleForTenant(bundleId: string, tenantId: string, actor: string): Promise<BundleEnableResult> {
  const result: BundleEnableResult = { bundleId, enabled: [], alreadyOn: [], skipped: [] };
  if (!isKnownBundle(bundleId)) return { ...result, refused: { reason: 'unknown_bundle' } };
  const closure = bundleClosure(bundleId);
  const toggled = closure.filter(isToggled);
  result.skipped = closure.filter((id) => !isToggled(id));

  const killed = await killedIds(toggled);
  if (killed.length) return { ...result, refused: { reason: 'feature_killed', ids: killed } };
  const missing = await unentitled(toggled, tenantId);
  if (missing.length) return { ...result, refused: { reason: 'bundle_not_entitled', missing, bundles: sellersOf(missing) } };

  for (const id of toggled) {
    const before = await getStoredConfig(id);
    const outcome = await enableTenantOverride(id, tenantId, actor);
    if (outcome === 'enabled') {
      result.enabled.push(id);
      await recordToggleChange({
        action: 'feature-toggle.tenant-enabled', id, principalId: actor, actingTenantId: tenantId,
        before, after: await getStoredConfig(id), reason: `bundle:${bundleId}`,
      });
    } else if (outcome === 'already-on') result.alreadyOn.push(id);
    else if (outcome === 'unknown') result.skipped.push(id);
    else {
      // A kill landed between the check and this write. Stop: what was enabled so
      // far is reported, and the rest is not written over the kill.
      return { ...result, refused: { reason: 'feature_killed', ids: [id] } };
    }
  }
  return result;
}

/**
 * Turn a bundle OFF for one tenant (D5/D6): its own features only, refused while a
 * feature outside the bundle that needs one of them is still on for this tenant.
 * No data is deleted; enabling again restores the surfaces.
 */
export async function disableBundleForTenant(bundleId: string, tenantId: string, actor: string): Promise<BundleDisableResult> {
  const result: BundleDisableResult = { bundleId, disabled: [], alreadyOff: [], skipped: [] };
  if (!isKnownBundle(bundleId)) return { ...result, refused: { reason: 'unknown_bundle' } };
  // The bundle's own features in closure order (dependencies first), so the
  // reverse below turns a dependent off before what it depends on.
  const ownSet = new Set(bundleFeatureIds(bundleId));
  const own = bundleClosure(bundleId).filter((id) => ownSet.has(id));
  const toggled = own.filter(isToggled);
  result.skipped = own.filter((id) => !isToggled(id));

  const blockers = await tenantDisableBlockers(toggled, tenantId);
  if (blockers.length) return { ...result, refused: { reason: 'disable_blocked', dependents: blockers.map((b) => b.dependentId) } };

  for (const id of [...toggled].reverse()) {
    const before = await getStoredConfig(id);
    const outcome = await disableTenantOverride(id, tenantId, actor);
    if (outcome === 'disabled') {
      result.disabled.push(id);
      await recordToggleChange({
        action: 'feature-toggle.tenant-disabled', id, principalId: actor, actingTenantId: tenantId,
        before, after: await getStoredConfig(id), reason: `bundle:${bundleId}`,
      });
    } else if (outcome === 'already-off') result.alreadyOff.push(id);
    else result.skipped.push(id);
  }
  return result;
}
