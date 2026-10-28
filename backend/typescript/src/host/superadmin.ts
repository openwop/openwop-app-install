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
import { isNarrowingDeclaration, keyAuthorityRefuses } from './delegatedSubject.js';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { isPersonalTenantId, personalTenantOf } from './requestSubject.js';
import { wildcardApiKeyConfigured } from '../middleware/apiKeyTenants.js';
import { recordSuperadminWithoutFactor } from './profileCensus.js';

const log = createLogger('host.superadmin');

let warnedDevSuperadmin = false;

/**
 * ADR 0969 — when `OPENWOP_SUPERADMIN_REQUIRE_MFA=true`, a PERSON acting as
 * superadmin must hold a verified second factor on THIS session. Default off:
 * a deployment whose identity provider has MFA disabled would otherwise lock
 * out every superadmin it has.
 *
 * `req.mfaVerified` is the host's own decision, read from the verified ID
 * token's `firebase.sign_in_second_factor` claim (bearer) or the session's
 * `mfa` mark stamped from that claim (cookie) — never from a client header.
 *
 * Applies to person sessions only (`auth.kind === 'subject'`). Keys and the
 * wildcard bearer are tooling, governed by their own scopes. Break-glass is
 * exempt: it is the emergency door for when sign-in itself is unavailable, and
 * it is already single-use, ten-minute, audited and allowlist-bound.
 */
export function superadminMfaRequired(): boolean {
  return process.env.OPENWOP_SUPERADMIN_REQUIRE_MFA === 'true';
}

/** A person session (not a key, not break-glass) with no verified second factor. */
function lacksSecondFactor(req: Request): boolean {
  if (req.principal?.auth?.kind !== 'subject') return false;
  if ((req.principal.principalId ?? '').startsWith('breakglass:')) return false;
  return req.mfaVerified !== true;
}

function refusesForMissingMfa(req: Request): boolean {
  return superadminMfaRequired() && lacksSecondFactor(req);
}

/** True when this caller WOULD be a superadmin but is refused only for want of
 *  a second factor — so the refusal can say how to fix it, not just "no". */
export function superadminNeedsMfa(req: Request): boolean {
  return refusesForMissingMfa(req) && isSuperadminIgnoringMfa(req);
}

export function isSuperadmin(req: Request): boolean {
  if (!isSuperadminIgnoringMfa(req)) return false;
  if (refusesForMissingMfa(req)) return false;
  // ADR 0981 P2 — with the requirement OFF, count the person sessions it WOULD
  // refuse (the census records only under the strict profile).
  if (!superadminMfaRequired() && lacksSecondFactor(req)) recordSuperadminWithoutFactor(req.principal?.principalId ?? '');
  return true;
}

function isSuperadminIgnoringMfa(req: Request): boolean {
  // Wildcard bearer (conformance harness / admin tooling / curl).
  if (req.principal?.tenants?.includes('*')) return true;
  // ADR 0795 D1 — superadmin is keyed on the TENANT below, so a key minted in a
  // superadmin tenant would inherit it whatever it declared. A key that
  // narrowed itself (a `workspace:read` key handed to an AI client) asked for
  // less than its issuer holds; host-global administration is not in "less".
  const auth = req.principal?.auth;
  if (auth?.kind === 'api-key' && isNarrowingDeclaration(auth.scopes)
    && keyAuthorityRefuses('superadmin', (req.principal?.principalId ?? '').replace(/^apikey:/, ''))) {
    return false;
  }
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

/** The explicit `OPENWOP_SUPERADMIN_TENANTS` allowlist, parsed. Exported for the
 *  operator's weekly funnel notice (billing), which addresses these workspaces. */
export function listedSuperadminTenants(): string[] {
  return (process.env.OPENWOP_SUPERADMIN_TENANTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * A superadmin BY THE ALLOWLIST ONLY — the operator of this host, named in
 * `OPENWOP_SUPERADMIN_TENANTS`. Deliberately narrower than `isSuperadmin`:
 * no wildcard bearer and no `OPENWOP_FEATURE_TOGGLES_DEV_OPEN`.
 *
 * It exists for the PLAN paywall (ADR 0419): the operator has every feature on
 * their own host. The dev-open switch must not grant that — it makes EVERY
 * caller a superadmin, so under it nothing would ever be paywalled and no
 * entitlement test could fail. A wildcard bearer is tooling, not a person with
 * a plan.
 *
 * Follows the PERSON like `isSuperadmin` does (a listed personal tenant keeps it
 * after switching into a shared workspace), under the same shape guard, and a
 * key that narrowed itself does not inherit it (ADR 0795 D1).
 */
export function isListedSuperadmin(req: Request): boolean {
  const auth = req.principal?.auth;
  if (auth?.kind === 'api-key' && isNarrowingDeclaration(auth.scopes)
    && keyAuthorityRefuses('superadmin', (req.principal?.principalId ?? '').replace(/^apikey:/, ''))) {
    return false;
  }
  const allow = listedSuperadminTenants();
  if (req.tenantId && allow.includes(req.tenantId)) return true;
  const personal = personalTenantOf(req);
  return isPersonalTenantId(personal) && allow.includes(personal);
}

/** The same, for a caller with only a tenant id (a daemon, a tier limit). */
export function isListedSuperadminTenant(tenantId: string | undefined): boolean {
  return Boolean(tenantId) && listedSuperadminTenants().includes(tenantId as string);
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
  if (superadminNeedsMfa(req)) {
    throw new OpenwopError('forbidden', `${surface} requires two-factor authentication on this session.`, 403, {
      code: 'mfa_required',
      settingsUrl: '/settings#security',
      hint: 'Turn on two-factor authentication in Settings → Security, then sign in again.',
    });
  }
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
