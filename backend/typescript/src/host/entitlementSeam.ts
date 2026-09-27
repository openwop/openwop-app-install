/**
 * Entitlement seam (ADR 0419) — the host-level indirection that lets the core
 * route gate (`features/featureRoute.ts:requireFeatureEnabled`) consult a
 * tenant's plan/bundle entitlement WITHOUT importing the billing feature (that
 * would be a core→feature up-dependency, ADR 0001). The `billing` feature
 * REGISTERS its check here at boot (the same inversion as `registerRetentionPurger`
 * / `registerFeatureAgentTool`); when nothing is registered (billing absent /
 * disabled), `checkEntitlement` is a no-op — the reference host is unrestricted.
 *
 * The gate calls this ONLY for a sellable-bundle feature on an AUTHENTICATED
 * request (see `requireFeatureEnabled`), so it never 403s a public/anon caller
 * (the ADR 0176 shopper exemption) and never touches core features.
 */
import type { Request } from 'express';

/** Throws a `forbidden` (ADR 0176) when the caller's plan/bundles don't entitle
 *  `featureId`; a no-op when billing is off / the plan is unrestricted. */
export type EntitlementCheck = (req: Request, featureId: string) => Promise<void>;

/**
 * The same check for a caller that has no `Request` — a DAEMON.
 *
 * WF-KB-4 / ADR 0583 § D5 correction. `requireFeatureEnabled` gates a route on
 * BOTH halves (the toggle AND, for a sellable-bundle feature, the plan
 * entitlement). A recurring daemon aligned to that write path must gate on both
 * halves too, or it keeps spending on a tenant whose plan stopped covering the
 * feature: every route 404/403s while the scheduled egress + embedding spend
 * runs on. The toggle half alone is only half the gate.
 *
 * Deliberately tenant-scoped rather than request-scoped: a daemon has a tenant
 * id and nothing else. It cannot reuse `EntitlementCheck` (which reads
 * `req.principal` for the ADR 0176 shopper exemption, and a daemon has no
 * principal to exempt).
 */
export type TenantEntitlementCheck = (tenantId: string, featureId: string) => Promise<void>;

let registered: EntitlementCheck | null = null;
let registeredForTenant: TenantEntitlementCheck | null = null;

/** Register the host's entitlement check (billing does this at boot). Last wins. */
export function registerEntitlementCheck(fn: EntitlementCheck): void {
  registered = fn;
}

/** Register the host's TENANT-scoped entitlement check (billing, at boot). Last wins. */
export function registerTenantEntitlementCheck(fn: TenantEntitlementCheck): void {
  registeredForTenant = fn;
}

/** Consult the registered entitlement check; no-op when none is registered. */
export async function checkEntitlement(req: Request, featureId: string): Promise<void> {
  if (registered) await registered(req, featureId);
}

/** Consult the registered TENANT-scoped entitlement check; no-op when none is
 *  registered (billing absent/disabled ⇒ the reference host is unrestricted,
 *  same posture as `checkEntitlement`). THROWS when the plan does not entitle
 *  the feature — callers that must fail closed should let it propagate into
 *  their own catch. */
export async function checkTenantEntitlement(tenantId: string, featureId: string): Promise<void> {
  if (registeredForTenant) await registeredForTenant(tenantId, featureId);
}

