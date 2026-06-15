/**
 * Shared feature-route helpers (ADR 0001). Every feature package gates its
 * host-extension routes on toggle STATE at request time and scopes data to the
 * caller's tenant; these three helpers were copy-pasted into `users`, `orgs`,
 * and `profiles` routes. One definition so toggle/tenant semantics can't drift
 * between features.
 */
import type { Request } from 'express';
import { OpenwopError } from '../types.js';
import { requestOrigin } from '../host/requestOrigin.js';
import { resolveOne } from '../host/featureToggles/service.js';
import type { ResolvedAssignment, ToggleSubject } from '../host/featureToggles/types.js';
import { getOrg, resolveEffectiveAccess, type Scope } from '../host/accessControlService.js';
import { resolveCallerUser } from './users/usersGuards.js';
import type { User } from './users/usersService.js';

/** The caller's tenant ('default' for the single-principal demo). */
export function tenantOf(req: Request): string {
  return req.tenantId ?? 'default';
}

/** The toggle-bucketing subject: tenant + (when present) the principal id. */
export function toggleSubjectOf(req: Request): ToggleSubject {
  const subject: ToggleSubject = { tenantId: tenantOf(req) };
  if (req.principal?.principalId) subject.userId = req.principal.principalId;
  return subject;
}

/**
 * Resolve the caller's assignment for `toggleId`; throw a 404 (the surface does
 * not exist for them) when off — backend authority, ADR 0001 §3.4. `label` names
 * the feature in the error message.
 */
export async function requireFeatureEnabled(req: Request, toggleId: string, label: string): Promise<ResolvedAssignment> {
  const assignment = await resolveOne(toggleId, toggleSubjectOf(req));
  if (!assignment || !assignment.enabled) {
    throw new OpenwopError('not_found', `${label} is not enabled for this tenant.`, 404, { feature: toggleId });
  }
  return assignment;
}

/** A required non-empty string body field (the validation every feature route
 *  repeats). Throws the canonical `validation_error` envelope on a miss. */
export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OpenwopError('validation_error', `Field \`${field}\` is required and MUST be a non-empty string.`, 400, { field });
  }
  return value;
}

/** An optional string field: the trimmed value, or undefined when absent/blank. */
export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * The externally-visible base URL for building ABSOLUTE public URLs (sitemap/RSS,
 * OG/social-card images, share links). Prefer a CONFIGURED origin
 * (`OPENWOP_PUBLIC_BASE_URL`) — the trustworthy source of truth. The request
 * `Host`/`X-Forwarded-Host` is client/proxy-influenceable, so the fallback is
 * sanitized to a valid host token (strips CR/LF + anything outside the host
 * charset, defeating header-injection) and the scheme constrained to http(s). A
 * deployment behind a proxy SHOULD set the env var. Shared by every public
 * surface (ADR 0012 publishing, ADR 0013 sharing) so the policy can't drift.
 */
export function publicBaseUrl(req: Request): string {
  const configured = process.env.OPENWOP_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  // Forwarded-aware request origin, sanitized — the shared derivation in
  // host/requestOrigin.ts (one place, so the host-token/scheme policy can't drift).
  return requestOrigin(req);
}

/**
 * The org-scoped RBAC core (NO toggle gate) shared by org-native features. Gates
 * on the caller's RFC 0049 `scope` IN THE PATH org (`req.params.orgId`): resolves
 * the caller, verifies the org is in their tenant (404 / IDOR guard), and
 * requires `scope` (403, fail-closed). Returns the caller + orgId for the handler.
 * One definition so the cross-tenant guard can't drift between features
 * (ADR 0006/0007/0008). Always-on features (cms/media/publishing — ADR 0027) call
 * this directly; toggle-gated features go through `authorizeOrgScope` (below),
 * which is this guard preceded by the toggle check.
 */
export async function requireOrgScope(req: Request, scope: Scope): Promise<{ user: User; orgId: string }> {
  const user = await resolveCallerUser(req);
  const orgId = req.params.orgId;
  const org = await getOrg(orgId);
  if (!org || org.tenantId !== user.tenantId) {
    throw new OpenwopError('not_found', 'Organization not found.', 404, { orgId });
  }
  const access = await resolveEffectiveAccess(user.tenantId, { subject: user.userId, orgId });
  if (!access.scopes.includes(scope)) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope });
  }
  return { user, orgId };
}

/**
 * The toggle-gated org-scoped RBAC gate (the common case): assert the feature
 * toggle is on for the caller, THEN apply `requireOrgScope`. Composed from the
 * two halves so the cross-tenant guard lives in exactly one place.
 */
export async function authorizeOrgScope(req: Request, feature: { toggleId: string; label: string }, scope: Scope): Promise<{ user: User; orgId: string }> {
  await requireFeatureEnabled(req, feature.toggleId, feature.label);
  return requireOrgScope(req, scope);
}
