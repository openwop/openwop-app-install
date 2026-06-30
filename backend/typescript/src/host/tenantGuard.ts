/**
 * Shared tenant-isolation helpers (DATA-2).
 *
 * Tenant isolation in this host is per-handler discipline: each route checks
 * that a resource it loads belongs to the caller's tenant before acting (the
 * IDOR guard). That pattern was open-coded — `tenantOf(req)` was duplicated in
 * ~12 route files, and the ownership check was a hand-written
 * `resource.tenantId !== tenantOf(req)` at each site, which is exactly how a
 * regression slips in (a handler that forgets the check — the notifications
 * PR #146 read/archive paths once did). These two primitives centralize it:
 *
 *  - `tenantOf(req)`  — the ONE canonical caller-tenant derivation (always from
 *    the principal-derived `req.tenantId`, never request body).
 *  - `assertTenantOwned(resource, req)` — load-or-404: returns the resource
 *    narrowed non-null when it belongs to the caller's tenant, else throws a
 *    404 (NOT 403 — a 403 would leak that the id exists in another tenant).
 *
 * NOTE: the bearer auth itself is a reference stub (any non-empty token → a
 * synthetic principal); production deployments wire the implemented OIDC/SAML
 * paths (`middleware/oidcVerifier.ts`, `host/auth/samlSso.ts`). These helpers
 * harden the AUTHORIZATION (tenant-scoping) layer above whichever authentication
 * is configured.
 */

import { OpenwopError } from '../types.js';

/** The minimal request shape these guards read — the principal-derived
 *  `tenantId` the auth middleware stamps. An Express `Request` (augmented with
 *  `tenantId`) satisfies this structurally, so callers pass `req` directly and
 *  the functions don't depend on the full `Request` surface. */
export interface TenantScopedRequest {
  tenantId?: string;
}

/** The caller's tenant — principal-derived (`req.tenantId`), never from body. */
export function tenantOf(req: TenantScopedRequest): string {
  return req.tenantId ?? 'default';
}

/**
 * Return `resource` when it exists AND belongs to the caller's tenant; otherwise
 * throw a 404 (no existence leak across tenants). Use as a load-or-404 guard:
 *   const board = assertTenantOwned(await store.get(id), req, 'board');
 */
export function assertTenantOwned<T extends { tenantId?: string }>(
  resource: T | null | undefined,
  req: TenantScopedRequest,
  resourceLabel = 'resource',
): T {
  if (!resource || resource.tenantId !== tenantOf(req)) {
    throw new OpenwopError('not_found', `${resourceLabel} not found`, 404, {});
  }
  return resource;
}
