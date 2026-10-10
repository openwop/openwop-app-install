/**
 * ADR 0820 §7 / strategy G10 — the per-tenant feature check for DAEMONS and
 * OBSERVERS (lanes that run with no request and no acting user).
 *
 * A background sweep that does a feature's work for every tenant must skip the
 * tenants that may not use that feature (toggle off, or the plan excludes it), so
 * a lapsed plan stops the compute and the side effects, not only the reads.
 *
 * `tenantFeatureCheck(featureId)` returns a checker MEMOIZED for one sweep: a
 * sweep over N rows of one tenant pays one toggle + entitlement read. Semantics:
 *   - enabled ⇒ true;
 *   - no toggle registered for the id (`resolveOne` → null) ⇒ true: an always-on
 *     feature has no toggle, and a sellable one always has one (ADR 0820 §1);
 *   - disabled, plan-refused, or a resolver THROW ⇒ false (fail-closed).
 * A skip is SILENT (debug-level only): a lapsed tenant is the expected steady
 * state, not an error, and logging it every tick would be spam.
 */

import { resolveOne } from './featureToggles/service.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.tenantFeatureGate');

export type TenantFeatureCheck = (tenantId: string) => Promise<boolean>;

/** One-shot check (no memo) — for an observer that sees one event at a time. */
export async function tenantMayUseFeature(featureId: string, tenantId: string): Promise<boolean> {
  try {
    const resolved = await resolveOne(featureId, { tenantId });
    return resolved === null || resolved.enabled;
  } catch (err) {
    log.debug('tenant_feature_check_unresolved', { featureId, tenantId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** A checker memoized per tenant for the life of the returned function (one sweep). */
export function tenantFeatureCheck(featureId: string): TenantFeatureCheck {
  const memo = new Map<string, Promise<boolean>>();
  return (tenantId: string) => {
    let hit = memo.get(tenantId);
    if (!hit) {
      hit = tenantMayUseFeature(featureId, tenantId);
      memo.set(tenantId, hit);
    }
    return hit;
  };
}
