/**
 * KickBot Plus tier gate (ADR 0420 P2) — "expressed in operator tier config,
 * enforced at an existing choke point" (the ADR 0176 Phase-3 posture): the
 * kicktodo-core enroll-guard seam consumes the billing tier's
 * `kicktodo.maxActiveEnrollments` limit. Absent limit ⇒ unlimited (the
 * fail-open billing default — nothing blocks before an operator narrows it);
 * Plus tiers simply carry a higher (or no) limit.
 */

import { resolveOne } from '../../host/featureToggles/service.js';
import { resolveEntitlements } from '../billing/billingService.js';
import { listEnrollmentsFor } from '../kicktodo-core/enrollmentService.js';

export const MAX_ACTIVE_ENROLLMENTS_LIMIT = 'kicktodo.maxActiveEnrollments';

export type TierLimitResolver = (tenantId: string) => Promise<number | null>;

/** The production resolver: billing tier limits (null = unlimited). */
export const billingTierLimitResolver: TierLimitResolver = async (tenantId) => {
  const billing = await resolveOne('billing', { tenantId });
  const ent = await resolveEntitlements(tenantId, Boolean(billing?.enabled));
  const raw = (ent.limits as Record<string, unknown>)[MAX_ACTIVE_ENROLLMENTS_LIMIT];
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
};

/** The enroll-guard predicate (registered at boot; resolver injectable for tests). */
export async function enrollTierVerdict(
  args: { tenantId: string; ownerSubject: string },
  resolveLimit: TierLimitResolver = billingTierLimitResolver,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const limit = await resolveLimit(args.tenantId);
  if (limit === null) return { ok: true }; // unlimited (fail-open default)
  const active = (await listEnrollmentsFor(args.tenantId, args.ownerSubject)).filter((e) => e.state === 'active' || e.state === 'snoozed');
  if (active.length < limit) return { ok: true };
  return {
    ok: false,
    reason: `Your plan allows ${limit} active challenge${limit === 1 ? '' : 's'} at a time. Complete or abandon one, or upgrade to KickBot Plus.`,
  };
}
