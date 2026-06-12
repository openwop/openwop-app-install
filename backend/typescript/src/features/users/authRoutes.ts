/**
 * Auth routes (host-extension, sample-grade).
 *
 * Surface under /v1/host/sample/users/auth:
 *   POST /logout      drop the session cookie
 *   POST /oidc/bind   bind a Firebase OIDC identity to a durable User (Phase 4a)
 *
 * Email/password is **Firebase Authentication** (ADR 0026) — the host owns NO
 * credential store. A Firebase user (social OR email/password) authenticates on
 * the client and presents an OIDC ID token that the bearer middleware verifies;
 * the SPA then calls `/oidc/bind` to mint the durable `user:<userId>`.
 */

import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { issueUserSession } from '../../middleware/auth.js';
import { upsertFromPrincipal, getUser } from './usersService.js';
import { rekeyMemberSubject } from '../../host/accessControlService.js';

// Mirror middleware/auth.ts — Firebase Hosting forwards only `__session`.
const COOKIE_NAME = process.env.OPENWOP_SESSION_COOKIE_NAME || '__session';

// Graduated off the feature toggle (2026-06-11, feature.ts § Correction) —
// auth routes serve unconditionally; identity is platform plumbing.

export function registerUsersAuthRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // Sign out — expire the session cookie. Unconditional (no toggle/auth gate): a
  // caller must always be able to drop their session, and the cookie is the only
  // server-side state for an OIDC-bound session. Firebase OIDC sign-out
  // additionally happens client-side (the SPA calls `auth.signOut()`).
  app.post('/v1/host/sample/users/auth/logout', (_req, res) => {
    res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    res.json({ loggedOut: true });
  });

  // ADR 0003 Phase 4a — OIDC bind. The SPA calls this once after Firebase login
  // (social OR email/password): it find-or-creates the durable User for the
  // verified `oidc:<sub>` and re-keys any memberships seeded under that subject to
  // the canonical `user:<userId>`, then issues a user-tier cookie carrying BOTH
  // the userId and the subject so every subsequent bearer request resolves the
  // stable `user:<userId>` principal (the middleware reads it from the cookie — no
  // per-request store touch, ADR 0015 §0). Idempotent; opt-in (unbound OIDC
  // callers keep the backward-compatible `oidc:<sub>` principal).
  app.post('/v1/host/sample/users/auth/oidc/bind', async (req, res, next) => {
    try {
      const personalTenant = req.personalTenant; // `user:<sha256(iss:sub)>`
      if (!personalTenant?.startsWith('user:')) {
        throw new OpenwopError('unauthenticated', 'OIDC bind requires a verified OIDC bearer.', 401, {});
      }
      // Already bound: a prior bind's cookie carries the durable userId, so the
      // middleware resolved `user:<userId>` (not `oidc:<sub>`). No-op refresh —
      // nothing to upsert or re-key. Makes repeat calls idempotent.
      if (req.userId) {
        const existing = await getUser(req.userId);
        if (existing) {
          res.json({ user: existing, bound: true, rekeyed: 0 });
          return;
        }
      }
      const principalId = req.principal?.principalId; // `oidc:<sub>` on the unbound bearer path
      if (!principalId?.startsWith('oidc:')) {
        throw new OpenwopError('unauthenticated', 'OIDC bind requires a verified OIDC bearer.', 401, {});
      }
      const user = await upsertFromPrincipal({ tenantId: personalTenant, principalId, source: 'oidc' });
      const rekeyed = await rekeyMemberSubject(principalId, user.userId);
      issueUserSession(res, {
        userId: user.userId,
        tenantId: personalTenant,
        personalTenant,
        subject: principalId,
      });
      res.json({ user, bound: true, rekeyed });
    } catch (err) {
      next(err);
    }
  });
}
