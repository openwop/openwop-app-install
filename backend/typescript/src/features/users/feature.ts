/**
 * Users & Authentication — the identity foundation of the MyndHyve->openwop-app
 * port (ADR 0002). Backend half: durable user CRUD + lifecycle routes, a `users`
 * toggle default (off; tenant-bucketed — identity is a tenant-wide surface, like
 * CRM/CSM), no packs yet.
 *
 * Phase 1 (this commit) is durable accounts on the EXISTING auth paths — no new
 * advertised capability. The enterprise-SSO phases (SAML `openwop-auth-saml`,
 * SCIM `openwop-auth-scim`) ship `feature.users.*` packs and flip
 * `capabilities.auth.profiles[]` ONLY once their gated conformance legs pass
 * non-vacuously (finding C1) — so this descriptor declares no `requiredPacks`
 * and no auth-profile advertisement yet. Off by default; a superadmin turns it
 * on per tenant (ADR 0001 §6).
 */

import type { BackendFeature } from '../types.js';
import { registerUsersRoutes } from './routes.js';
import { registerUsersAuthRoutes } from './authRoutes.js';
import { registerUsersMfaRoutes } from './mfaRoutes.js';

export const usersFeature: BackendFeature = {
  id: 'users',
  registerRoutes: (deps) => {
    registerUsersRoutes(deps);
    registerUsersAuthRoutes(deps);
    registerUsersMfaRoutes(deps);
  },
  toggleDefault: {
    id: 'users',
    label: 'Users & Authentication',
    description: 'Durable, tenant-scoped user accounts + lifecycle on the existing auth paths — identity foundation (ADR 0002, Phase 1). Enterprise SSO (SAML/SCIM) lands in later phases.',
    category: 'Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'users',
  },
};
