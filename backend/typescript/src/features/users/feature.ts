/**
 * Users & Authentication — the identity foundation of the MyndHyve->openwop-app
 * port (ADR 0002). Backend half: durable user CRUD + lifecycle routes, the four
 * ids-only lifecycle host events (`emit.ts`, ADR 0617 D1) and the
 * `ctx.features.users` workflow surface (`surface.ts`, ADR 0617 D2) behind the
 * `feature.users.nodes` pack — this header used to say "no packs yet".
 *
 * § Correction (2026-06-11): graduated OFF the feature toggle to a permanent,
 * always-on admin surface (the Connections/Notifications graduation pattern —
 * ADR 0024/0010 § Correction). Identity is platform plumbing, not an optional
 * product surface to A/B: the SignInButton's `/me` signed-in check, OIDC
 * binding, and every feature that keys on durable `User.userId` need it
 * unconditionally — a toggle-OFF deploy made `/users/me` 404 under every
 * sign-in. No `toggleDefault`; routes serve unconditionally.
 *
 * Phase 1 (this commit) is durable accounts on the EXISTING auth paths — no new
 * advertised capability. The enterprise-SSO phases (SAML `openwop-auth-saml`,
 * SCIM `openwop-auth-scim`) ship `feature.users.*` packs and flip
 * `capabilities.auth.profiles[]` ONLY once their gated conformance legs pass
 * non-vacuously (finding C1) — so this descriptor declares no `requiredPacks`
 * and no auth-profile advertisement yet.
 */

import type { BackendFeature } from '../types.js';
import { registerUsersRoutes } from './routes.js';
import { registerUsersAuthRoutes } from './authRoutes.js';
import { getUser, getUserByPrincipal, resolveCanonicalUserReadOnly, sessionEpochOf } from './usersService.js';
import { setUserDisplayResolver } from '../../host/subjectDisplay.js';
import { registerSubjectToUserIdResolver } from '../../host/approverResolution.js';
import { registerPersonalTenantSessionAuthority, registerSessionAuthority, type PersonalTenantSessionAuthority, type SessionAuthority } from '../../host/sessionAuthority.js';
import { buildUsersSurface } from './surface.js';

/**
 * ADR 0621 § Boundaries — the users feature IS the session authority: a keyed
 * point read of the durable row (`getUser` = one `kvGet`, uncached — D3),
 * projected to exactly what the middleware decides on. `null` ⇒ no row (erased).
 * Exported so a test can restore it after injecting a throwing authority (D6).
 */
export const usersSessionAuthority: SessionAuthority = async (userId) => {
  const user = await getUser(userId);
  if (!user) return null;
  return { status: user.status === 'active' ? 'active' : 'disabled', sessionEpoch: sessionEpochOf(user) };
};

/**
 * ADR 0621 D1 rev. 2 (review BLOCKER-1) — the UNBOUND-lane authority: an
 * `oidc:<sub>` session / bearer in a `user:`-shaped personal tenant resolves
 * its canonical row READ-ONLY (`resolveCanonicalUserReadOnly` — never the
 * creating fold). A dangling canonical pointer is the erase tombstone.
 */
export const usersPersonalTenantSessionAuthority: PersonalTenantSessionAuthority = async (personalTenant, subject) => {
  const hit = await resolveCanonicalUserReadOnly(personalTenant, subject);
  if (!hit) return null;
  if ('erased' in hit) return { status: 'erased', userId: hit.userId, sessionEpoch: 0 };
  return {
    status: hit.user.status === 'active' ? 'active' : 'disabled',
    sessionEpoch: sessionEpochOf(hit.user),
    userId: hit.user.userId,
  };
};

export const usersFeature: BackendFeature = {
  id: 'users',
  registerRoutes: (deps) => {
    registerUsersRoutes(deps);
    registerUsersAuthRoutes(deps);
    // ADR 0621 P1 — the per-request live-session read core cannot import
    // (feature→core only). NO permissive default exists on the seam: until this
    // line runs, a `userId`-bearing cookie is refused 503, and `createApp`
    // asserts the registration at boot.
    registerSessionAuthority(usersSessionAuthority);
    registerPersonalTenantSessionAuthority(usersPersonalTenantSessionAuthority);
    // ADR 0075 §D6 — map an approver's principal subject (e.g. `oidc:<sub>` from a
    // group/role expansion) to its durable `userId` for addressed HITL delivery.
    // Core declares the seam; the users feature owns the identity store, so it
    // registers the mapping here (feature→core; core never imports the feature).
    registerSubjectToUserIdResolver(async (tenantId, subject) => {
      const user = await getUserByPrincipal(tenantId, subject);
      return user?.userId ?? null;
    });
    // ADR 0192 D2 — the users feature is the `user:*` display-identity owner
    // (User.displayName, ADR 0002/0003). POINT lookups by the durable userId
    // (the id `user:<id>` refs carry), tenant-guarded; ids that don't resolve
    // (e.g. an api-key principal tail) fall back at the seam, never here.
    setUserDisplayResolver(async (tenantId, userIds) => {
      const out = new Map<string, string>();
      await Promise.all(userIds.map(async (id) => {
        const user = await getUser(id);
        if (user && user.tenantId === tenantId && user.displayName) out.set(id, user.displayName);
      }));
      return out;
    });
  },
  // ADR 0617 D2 — `ctx.features.users.{deactivate,reactivate}` for the
  // `feature.users.nodes` pack. Always-on feature ⇒ the surface seam applies no
  // toggle gate; the surface's OWN gate is `assertTenantScope(host:members:manage)`
  // on the run's acting user (fail-closed without one).
  surface: { id: 'users', build: buildUsersSurface },
  requiredPacks: [{ name: 'feature.users.nodes', version: '1.0.1' }],
};
