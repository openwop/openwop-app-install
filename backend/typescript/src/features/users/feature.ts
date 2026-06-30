/**
 * Users & Authentication — the identity foundation of the MyndHyve->openwop-app
 * port (ADR 0002). Backend half: durable user CRUD + lifecycle routes; no packs
 * yet.
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
import { getUserByPrincipal } from './usersService.js';
import { registerSubjectToUserIdResolver } from '../../host/approverResolution.js';

export const usersFeature: BackendFeature = {
  id: 'users',
  registerRoutes: (deps) => {
    registerUsersRoutes(deps);
    registerUsersAuthRoutes(deps);
    // ADR 0075 §D6 — map an approver's principal subject (e.g. `oidc:<sub>` from a
    // group/role expansion) to its durable `userId` for addressed HITL delivery.
    // Core declares the seam; the users feature owns the identity store, so it
    // registers the mapping here (feature→core; core never imports the feature).
    registerSubjectToUserIdResolver(async (tenantId, subject) => {
      const user = await getUserByPrincipal(tenantId, subject);
      return user?.userId ?? null;
    });
  },
};
