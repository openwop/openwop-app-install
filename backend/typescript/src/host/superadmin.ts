/**
 * Shared superadmin gate — extracted from `routes/featureToggles.ts` (ADR
 * 0028: the governance surface needs the SAME admin posture, and a copied
 * gate is an authorization boundary that drifts).
 *
 * A superadmin is: a wildcard bearer principal (`*` — the conformance/admin
 * API key), OR a caller whose ACTIVE tenant **or own personal tenant** is listed
 * in `OPENWOP_SUPERADMIN_TENANTS` (the authority follows the PERSON across a
 * workspace switch — see {@link isSuperadmin}), OR — explicit
 * dev opt-in only, never inferred from NODE_ENV — every authenticated caller
 * when `OPENWOP_FEATURE_TOGGLES_DEV_OPEN=true` (the historical toggle-admin
 * env, kept as the single dev-open switch so a deploy has one knob to audit).
 */

import type { Request } from 'express';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { isPersonalTenantId, personalTenantOf } from './requestSubject.js';
import { wildcardApiKeyConfigured } from '../middleware/apiKeyTenants.js';

const log = createLogger('host.superadmin');

let warnedDevSuperadmin = false;

export function isSuperadmin(req: Request): boolean {
  // Wildcard bearer (conformance harness / admin tooling / curl).
  if (req.principal?.tenants?.includes('*')) return true;
  const allow = (process.env.OPENWOP_SUPERADMIN_TENANTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (req.tenantId && allow.includes(req.tenantId)) return true;
  // SUPERADMIN FOLLOWS THE PERSON, not the active workspace (owner's decision,
  // 2026-09-23). `req.tenantId` is the ACTIVE workspace (`middleware/auth.ts`):
  // it starts as the caller's own personal tenant and becomes `ws:<uuid>` after
  // a switch. Checking only that meant a listed operator SILENTLY lost
  // superadmin on switching into a shared workspace — reported against rev
  // 00737-vkq, where the allowlisted identity was the human at the keyboard and
  // the host still refused. It protected nothing: the same human switches back
  // and acts. What it produced was an unexplained 403 on host-global surfaces.
  //
  // GUARDED BY SHAPE (USERS-19 / ADR 0617 D2). `personalTenant` is a claim the
  // MINT SITE makes, and the SAML ACS mints `OPENWOP_SAML_TENANT` — ONE
  // host-global value shared by every SAML user. Honouring it unguarded would
  // hand superadmin to every member of that tenant the moment the value was
  // listed. `isPersonalTenantId` admits only the single-principal shapes
  // (`user:` / `anon:`), which is exactly the guard that exists for the
  // implicit-owner short-circuit.
  const personal = personalTenantOf(req);
  if (isPersonalTenantId(personal) && allow.includes(personal)) return true;
  // EXPLICIT dev opt-in only — never inferred from NODE_ENV. Fails closed by
  // default so a misconfigured non-prod deploy isn't world-writable.
  if (process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN === 'true') {
    if (!warnedDevSuperadmin) {
      warnedDevSuperadmin = true;
      log.warn('admin_surface_dev_open', {
        detail: 'OPENWOP_FEATURE_TOGGLES_DEV_OPEN=true — every authenticated caller can administer toggles/governance. Unset it and use OPENWOP_SUPERADMIN_TENANTS for a hardened deploy.',
      });
    }
    return true;
  }
  return false;
}

/**
 * Tenant-only superadmin check (no `req`) — a tenant listed in
 * `OPENWOP_SUPERADMIN_TENANTS`, OR the explicit dev-open switch. Mirrors
 * `isSuperadmin` MINUS the wildcard-bearer branch (which needs the principal).
 * Used where only a tenantId is available — the review projection's visibility
 * gate for host-global `commerce-listing-publish` approvals (a seller must never
 * see an operator-only decide card). The hard authority stays `isSuperadmin` at
 * the HTTP boundary + the feature decide handler; this is a UI-visibility filter.
 */
export function isSuperadminTenant(tenantId: string | undefined): boolean {
  if (process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN === 'true') return true;
  if (!tenantId) return false;
  const allow = (process.env.OPENWOP_SUPERADMIN_TENANTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return allow.includes(tenantId);
}

export function requireSuperadmin(req: Request, surface = 'This administration surface'): void {
  if (!isSuperadmin(req)) {
    throw new OpenwopError('forbidden', `${surface} requires a superadmin principal.`, 403, {
      hint: superadminHint(),
    });
  }
}

/**
 * The doors that ACTUALLY open this gate in THIS deployment.
 *
 * It used to read "…or call with the admin bearer key", and that half was false
 * on the demo deployment: `OPENWOP_ADMIN_TOKEN` bypasses session auth only under
 * the `/v1/host/openwop-app/admin` prefix (`middleware/auth.ts`), so it cannot
 * authenticate any other admin surface, and `isSuperadmin`'s bearer branch needs
 * a principal holding tenant `*`, which no key has unless an operator wrote
 * `<key>:*` (ADR 0561 made scoped the default). MEASURED on rev 00737-vkq by a
 * peer session: admin token → 401 `bearer_rejected_no_session`, each configured
 * key → 403. The only real door there is the tenant allowlist.
 *
 * So the wildcard clause appears only when a wildcard key is configured. A hint
 * is an instruction; one that names an unreachable door is a false claim about
 * the deployment, not a helpful nudge.
 */
export function superadminHint(): string {
  const doors = ['add your tenant id to OPENWOP_SUPERADMIN_TENANTS'];
  if (wildcardApiKeyConfigured()) doors.push('call with a cross-tenant API key (configured as `<key>:*`)');
  return `To reach this surface: ${doors.join(', or ')}.`;
}
