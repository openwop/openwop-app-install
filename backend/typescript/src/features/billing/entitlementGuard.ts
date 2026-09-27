/**
 * Entitlement guard (ADR 0176 Phase 3) — the ONE opt-in guard a feature/route consults
 * to check a tenant's plan entitlement, so plan gating is NEVER fanned into every feature
 * (the blast-radius anti-pattern). A feature that wants plan gating calls
 * `requireEntitledFeature(req, '<featureId>')`; everyone else is unaffected.
 *
 * Fail-open by design when billing is OFF (unrestricted reference host) or a plan allows
 * everything (`allowedFeatures: '*'`). Only an explicit narrowed allowlist blocks.
 */
import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import type { ToggleSubject } from '../../host/featureToggles/types.js';
import { toggleSubjectOf } from '../featureRoute.js';
import { resolveEntitlements } from './billingService.js';

/** The ONE decision both entrypoints share: resolve the tenant's entitlements
 *  against a toggle SUBJECT and throw if `featureId` is not in the allowlist.
 *  The subject differs (a request buckets on tenant+principal, a daemon on the
 *  tenant alone); the verdict must not. */
async function assertEntitled(subject: ToggleSubject, featureId: string): Promise<void> {
  const billing = await resolveOne('billing', subject);
  const ent = await resolveEntitlements(subject.tenantId, Boolean(billing?.enabled));
  if (ent.allowedFeatures === '*') return; // unrestricted
  if (!ent.allowedFeatures.includes(featureId)) {
    throw new OpenwopError('forbidden', `Your plan (${ent.plan}) does not include this feature.`, 403, { feature: featureId, plan: ent.plan });
  }
}

/**
 * Throw `forbidden` if the caller's plan does not entitle `featureId`. No-op when billing
 * is off or the plan allows all features. Opt-in — call it only where plan gating is wanted.
 */
export async function requireEntitledFeature(req: Request, featureId: string): Promise<void> {
  await assertEntitled(toggleSubjectOf(req), featureId);
}

/**
 * The same verdict for a caller with no `Request` — a recurring DAEMON.
 *
 * WF-KB-4 / ADR 0583. A daemon aligned to a `requireFeatureEnabled`-gated write
 * path must gate on BOTH halves the route gates on, or a tenant whose plan
 * stopped covering the feature gets 403s on every route while the scheduled
 * spend continues. Registered into `host/entitlementSeam.ts` at boot so the
 * daemon never imports billing (ADR 0001 — no core/feature→feature edge).
 */
export async function requireEntitledFeatureForTenant(tenantId: string, featureId: string): Promise<void> {
  await assertEntitled({ tenantId }, featureId);
}
