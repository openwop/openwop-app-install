/**
 * Auth routes (host-extension, best-effort).
 *
 * Surface under /v1/host/openwop-app/users/auth:
 *   POST /logout      drop the session cookie
 *   POST /oidc/bind   bind a Firebase OIDC identity to a durable User (Phase 4a)
 *
 * Email/password is **Firebase Authentication** (ADR 0026) — the host owns NO
 * credential store. A Firebase user (social OR email/password) authenticates on
 * the client and presents an OIDC ID token that the bearer middleware verifies;
 * the SPA then calls `/oidc/bind` to mint the durable `user:<userId>`.
 */

import { OpenwopError } from '../../types.js';
import { resolveActiveWorkspace } from '../../host/activeWorkspacePref.js';
import { autoJoinDefaultWorkspaces } from '../../host/workspaceJoinLedger.js';
import { isWorkspaceMember } from '../../host/accessControlService.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { issueUserSession, clearSessionCookie } from '../../middleware/auth.js';
import { upsertFromPrincipal, getUser, sessionEpochOf, bumpSessionEpoch, applyIdpEmail } from './usersService.js';
import { resolveCallerUser } from './usersGuards.js';
import { rekeyMemberSubject } from '../../host/accessControlService.js';

// Graduated off the feature toggle (2026-06-11, feature.ts § Correction) —
// auth routes serve unconditionally; identity is platform plumbing.

export function registerUsersAuthRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // Sign out — expire the session cookie. Unconditional (no toggle/auth gate): a
  // caller must always be able to drop their session, and the cookie is the only
  // server-side state for an OIDC-bound session. Firebase OIDC sign-out
  // additionally happens client-side (the SPA calls `auth.signOut()`).
  app.post('/v1/host/openwop-app/users/auth/logout', (_req, res) => {
    // ADR 0621 — the ONE cookie-clear (shared with the middleware's per-request
    // refusal), so the attribute set can never drift from the cookie it drops.
    clearSessionCookie(res);
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
  app.post('/v1/host/openwop-app/users/auth/oidc/bind', async (req, res, next) => {
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
          // USERS-1 (fail-closed, finding H5): a disabled account must not have
          // its bind re-confirmed either — refuse instead of answering bound.
          if (existing.status !== 'active') {
            throw new OpenwopError('forbidden', 'This account is disabled.', 403, { userId: existing.userId });
          }
          // ADR 0622 D7 / USERS-20 — a row bound BEFORE the IdP email was
          // threaded (or whose address the IdP has since verified) picks the
          // verified claim up here; no-op when it already matches.
          res.json({ user: await applyIdpEmail(existing, req.oidcEmail), bound: true, rekeyed: 0 });
          return;
        }
      }
      const principalId = req.principal?.principalId; // `oidc:<sub>` on the unbound bearer path
      if (!principalId?.startsWith('oidc:')) {
        throw new OpenwopError('unauthenticated', 'OIDC bind requires a verified OIDC bearer.', 401, {});
      }
      // ADR 0622 D7 / USERS-20 — `req.oidcEmail` is set by the middleware ONLY
      // when the ID token carries `email_verified: true`; `upsertFromPrincipal`
      // stamps it `'idp'`. An IdP that does not assert `email_verified` leaves
      // the row address-less (the invitation gates then need an admin-set one).
      const user = await upsertFromPrincipal({
        tenantId: personalTenant, principalId, source: 'oidc',
        ...(req.oidcEmail ? { email: req.oidcEmail } : {}),
      });
      // USERS-1 (fail-closed, finding H5): `upsertFromPrincipal` never flips a
      // disabled status back, so a disabled user's re-login resolves the disabled
      // record here. Refuse BEFORE minting the session — the disable lifecycle is
      // the fail-closed lockout and this lane must honor it, not sidestep it.
      if (user.status !== 'active') {
        throw new OpenwopError('forbidden', 'This account is disabled.', 403, { userId: user.userId });
      }
      // ADR 0684 §7 phase 2 — auto-join every feature-declared default workspace.
      // Placed AFTER the disabled-account refusal above, deliberately: a disabled
      // account must not be joined into anything on its way to its 403.
      // Gated on the join LEDGER (has this action run?), never on membership, so
      // an operator's removal is a real boundary; and toggle-gated per subject,
      // which is askable here because a request exists. Never throws.
      // `user.userId` IS the canonical subject — `userIdFor()` already mints it
      // as `user:<hash>`. Prefixing it again wrote the member row, the join-ledger
      // claim and the active-workspace preference under `user:user:<hash>`, a
      // subject no read path ever resolves (`callerSubject`, `isWorkspaceMember`,
      // `resolveActiveWorkspace` all use the bare `userId`). Measured on
      // kicktodo.com 2026-09-15: auto-join logged success, `/me/workspaces`
      // omitted the workspace, `switch` answered 403. Same spelling as the
      // `rekeyMemberSubject` / `resolveActiveWorkspace` calls below.
      await autoJoinDefaultWorkspaces(
        user.userId, user.displayName ?? user.email ?? user.userId, personalTenant,
      );
      const rekeyed = await rekeyMemberSubject(principalId, user.userId);
      // ADR 0434 Phase 4 — restore the subject's last active workspace instead
      // of always hard-coding the personal tenant, so a user who lives in a
      // shared workspace lands there on a NEW device rather than staring at an
      // empty personal tenant. FAIL-CLOSED: `resolveActiveWorkspace` re-checks
      // membership and falls back to the personal tenant, so a stale preference
      // can never resurrect access that was revoked.
      const activeTenant = await resolveActiveWorkspace(user.userId, personalTenant, isWorkspaceMember);
      issueUserSession(res, {
        userId: user.userId,
        tenantId: activeTenant,
        personalTenant,
        subject: principalId,
        // ADR 0389 P1: persist the bearer's verified-second-factor mark on the
        // upgraded cookie so cookie-only follow-ups keep it.
        mfa: req.mfaVerified,
        // ADR 0621 D2 — a login stamps the row's CURRENT epoch.
        epoch: sessionEpochOf(user),
      });
      res.json({ user, bound: true, rekeyed });
    } catch (err) {
      next(err);
    }
  });

  // ADR 0389 P1 — the Security page's read model. Session-scoped security
  // posture for the CALLER: identity source (an SSO-provisioned account manages
  // MFA at its IdP, not here) + whether THIS session verified a second factor.
  // Enrollment itself is fully client↔Firebase (TotpMultiFactorGenerator); the
  // host only ever reads the resulting ID-token claim — no factor material,
  // no enrollment state, nothing to store or leak.
  app.get('/v1/host/openwop-app/users/me/security', async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      if (user.status !== 'active') {
        throw new OpenwopError('forbidden', 'This account is disabled.', 403, { userId: user.userId });
      }
      res.json({
        source: user.source,
        mfaSessionVerified: req.mfaVerified === true,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * ADR 0389 § Correction (2026-07-19) — the authenticator BIND/UNBIND notice.
   * NIST SP 800-63B-4 §4.1.2.1/§4.2.3 require the subscriber to be notified
   * whenever an authenticator is bound to (or removed from) their account.
   *
   * HONESTY BOUNDARY — read before extending: the host cannot OBSERVE Firebase
   * enrollment (ADR 0026: no host credential store; the factor lives at the
   * IdP). This event is therefore CLIENT-ASSERTED by the SPA after a successful
   * enroll/unenroll. That is acceptable ONLY because it is purely a
   * notification + audit record for the CALLER'S OWN account — a caller can do
   * nothing but notify themselves. NOTHING gates on it: the authorization
   * signal remains the verified `firebase.sign_in_second_factor` ID-token claim
   * read in `middleware/auth.ts`. Do not let this become an authorization
   * input.
   *
   * The notification is in-app + Web Push (the user's other devices), which
   * APPROXIMATES the spec's independent-channel requirement without fully
   * satisfying it — recorded as a known limitation in the ADR.
   */
  app.post('/v1/host/openwop-app/users/me/security/factor-event', async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      if (user.status !== 'active') {
        throw new OpenwopError('forbidden', 'This account is disabled.', 403, { userId: user.userId });
      }
      const body = (req.body ?? {}) as { event?: unknown; factorCount?: unknown };
      const event = body.event === 'bound' || body.event === 'unbound' ? body.event : null;
      if (!event) {
        throw new OpenwopError('validation_error', 'Field `event` must be `bound` or `unbound`.', 422, { field: 'event' });
      }
      const factorCount = typeof body.factorCount === 'number' && Number.isFinite(body.factorCount)
        ? Math.max(0, Math.floor(body.factorCount))
        : undefined;

      // ADR 0621 D2 — removing an authenticator ends the account's OTHER live
      // sessions (NIST 800-63B §5.1.5-style posture: a factor change is a
      // credential change). The epoch bump also kills THIS session's cookie on
      // its next request; the SPA re-authenticates against the IdP token it
      // still holds (the bind re-stamps the new epoch). Ordered BEFORE the
      // best-effort audit/notification so a failed bump is a failed request.
      if (event === 'unbound') await bumpSessionEpoch(user.userId);

      // Tamper-evident record on the ADR 0301 chain (exportable per ADR 0416) —
      // ids only, never factor material.
      const { appendAudit } = await import('../../host/auditChainService.js');
      await appendAudit(user.tenantId, `security.mfa.factor-${event}`, {
        tenantId: user.tenantId,
        userId: user.userId,
        ...(factorCount !== undefined ? { factorCount } : {}),
        assertedBy: 'client',
      }).catch(() => { /* audit is best-effort; never block the user's own security action */ });

      const { getNotificationEmitter } = await import('../../notifications/emitter.js');
      await getNotificationEmitter().emit({
        tenantId: user.tenantId,
        type: `security.mfa.${event}`,
        priority: 'high',
        title: event === 'bound' ? 'New authenticator added' : 'Authenticator removed',
        message: event === 'bound'
          ? 'An authenticator app was added to your account. If this was not you, remove it and contact your administrator.'
          : 'An authenticator app was removed from your account. If this was not you, contact your administrator immediately.',
        actionUrl: '/settings#security',
        metadata: { userId: user.userId, ...(factorCount !== undefined ? { factorCount } : {}) },
      }).catch(() => { /* notification is best-effort */ });

      res.status(202).json({ recorded: true });
    } catch (err) {
      next(err);
    }
  });
}
