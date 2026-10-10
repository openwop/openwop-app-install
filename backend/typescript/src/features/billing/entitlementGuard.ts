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
import { resolveToggle } from '../../host/featureToggles/service.js';
import type { ToggleSubject } from '../../host/featureToggles/types.js';
import { toggleSubjectOf } from '../featureRoute.js';
import { isListedSuperadmin } from '../../host/superadmin.js';
import { resolveEntitlements } from './billingService.js';
import { notePaywallEvent } from '../../host/paywallFunnel.js';

/** The ONE decision both entrypoints share: resolve the tenant's entitlements
 *  against a toggle SUBJECT and throw if `featureId` is not in the allowlist.
 *  The subject differs (a request buckets on tenant+principal, a daemon on the
 *  tenant alone); the verdict must not. */
async function assertEntitled(subject: ToggleSubject, featureId: string, lane: 'route' | 'lane'): Promise<void> {
  const billing = await resolveToggle('billing', subject);
  const ent = await resolveEntitlements(subject.tenantId, Boolean(billing?.enabled));
  if (ent.allowedFeatures === '*') return; // unrestricted
  if (!ent.allowedFeatures.includes(featureId)) {
    // Strategy §8 — the ONE place a plan refusal is decided, so the ONE place it is
    // counted (an HTTP route's 403 and every `resolveOne` `blockedBy:'plan'` both
    // land here). A buffered Map increment: never awaits, never throws.
    notePaywallEvent({ tenantId: subject.tenantId, metric: 'refusal', featureId, surface: lane });
    throw new OpenwopError('forbidden', `Your plan (${ent.plan}) does not include this feature.`, 403, { feature: featureId, plan: ent.plan });
  }
}

/**
 * Throw `forbidden` if the caller's plan does not entitle `featureId`. No-op when billing
 * is off or the plan allows all features. Opt-in — call it only where plan gating is wanted.
 */
export async function requireEntitledFeature(req: Request, featureId: string): Promise<void> {
  // The operator keeps every feature in ANY workspace they act in: superadmin
  // follows the person, and the tenant-level branch in `resolveEntitlements`
  // only covers their own.
  if (isListedSuperadmin(req)) return;
  await assertEntitled(toggleSubjectOf(req), featureId, 'route');
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
  // ADR 0819 §1 — every `resolveOne` of a sellable feature now lands here, so the
  // unrestricted host must stay free: with no plan allowlist configured every
  // plan is '*' (`planFeatures`), and the verdict cannot be a refusal.
  if (!process.env.OPENWOP_BILLING_PLAN_FEATURES) return;
  await assertEntitled({ tenantId }, featureId, 'lane');
}
