/**
 * Password-auth routes (host-extension, sample-grade — ADR 0002, Phase 2).
 *
 * Surface under /v1/host/sample/users/auth:
 *   POST /signup                  create a local account (user + credential)
 *   POST /login                   verify email+password -> the durable user
 *   POST /password/reset-request  mint a single-use reset token
 *   POST /password/reset          consume the token, set a new password
 *   POST /email/verify-request    mint an email-verification token
 *   POST /email/verify            consume the token, mark email verified
 *
 * TOGGLE-GATED (backend authority): every route resolves the caller's `users`
 * assignment server-side; off => 404.
 *
 * FAIL-CLOSED (finding H5): `login` verifies the secret AND the User lifecycle —
 * a disabled account is denied (403) even with the correct password.
 *
 * SECRET HANDLING (finding C3): single-use tokens are returned to the caller
 * ONCE (a real host emails them). They are echoed in the response body ONLY
 * outside production (`NODE_ENV !== 'production'`) so the demo is exercisable;
 * production returns 202/204 with no token. Passwords/hashes/tokens are never
 * logged.
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { issueUserSession } from '../../middleware/auth.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import type { ToggleSubject } from '../../host/featureToggles/types.js';
import {
  CredentialError,
  login,
  requestEmailVerification,
  requestPasswordReset,
  resetPassword,
  signup,
  verifyEmail,
} from './credentialsService.js';
import { isMfaActive, verify as verifyMfa } from './mfaService.js';

const TOGGLE_ID = 'users';
const EXPOSE_TOKENS = process.env.NODE_ENV !== 'production';

function tenantOf(req: Request): string {
  return req.tenantId ?? 'default';
}

function subjectOf(req: Request): ToggleSubject {
  const subject: ToggleSubject = { tenantId: tenantOf(req) };
  if (req.principal?.principalId) subject.userId = req.principal.principalId;
  return subject;
}

async function requireEnabled(req: Request): Promise<void> {
  const assignment = await resolveOne(TOGGLE_ID, subjectOf(req));
  if (!assignment || !assignment.enabled) {
    throw new OpenwopError('not_found', 'Users is not enabled for this tenant.', 404, { feature: TOGGLE_ID });
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OpenwopError('validation_error', `Field \`${field}\` is required and MUST be a non-empty string.`, 400, { field });
  }
  return value;
}

/** Map a CredentialError to the canonical envelope. */
function asHttp(err: unknown): never {
  if (err instanceof CredentialError) {
    switch (err.code) {
      case 'invalid_credentials':
        throw new OpenwopError('unauthenticated', err.message, 401, { code: err.code });
      case 'email_taken':
        throw new OpenwopError('conflict', err.message, 409, { code: err.code });
      case 'weak_password':
      case 'invalid_token':
        throw new OpenwopError('validation_error', err.message, 400, { code: err.code });
    }
  }
  throw err;
}

export function registerUsersAuthRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.post('/v1/host/sample/users/auth/signup', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { user, verifyToken } = await signup({
        tenantId: tenantOf(req),
        email: requireString(body.email, 'email'),
        password: requireString(body.password, 'password'),
        ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
      }).catch(asHttp);
      // Bind the session to the new durable user (ADR 0003) so the SPA is signed
      // in and every subsequent request resolves to this one canonical identity.
      issueUserSession(res, { userId: user.userId, tenantId: user.tenantId });
      res.status(201).json({ user, ...(EXPOSE_TOKENS ? { verifyToken } : {}) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/sample/users/auth/login', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const user = await login({
        tenantId: tenantOf(req),
        email: requireString(body.email, 'email'),
        password: requireString(body.password, 'password'),
      }).catch(asHttp);
      // Fail-closed: the secret is valid, but a disabled account is denied.
      if (user.status !== 'active') {
        throw new OpenwopError('forbidden', 'This account is disabled.', 403, { userId: user.userId });
      }
      // Second factor (Phase 5): when MFA is active, the password alone is not
      // enough — require a valid TOTP / recovery code. Missing code => 401 with
      // an `mfaRequired` flag so the client can prompt; bad code => 401.
      if (await isMfaActive(user.userId)) {
        const mfaToken = typeof body.mfaToken === 'string' ? body.mfaToken : '';
        if (!mfaToken) {
          res.status(401).json({ authenticated: false, mfaRequired: true });
          return;
        }
        if (!(await verifyMfa({ userId: user.userId, token: mfaToken }))) {
          throw new OpenwopError('unauthenticated', 'Invalid MFA code.', 401, {});
        }
      }
      // Bind the session to the durable user (ADR 0003): the SPA is now signed in
      // AS this user, so `/me` and the session-based `/mfa/*` routes key on the
      // SAME `userId` the gate above just checked — no parallel password-auth path.
      issueUserSession(res, { userId: user.userId, tenantId: user.tenantId });
      res.json({ user });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/sample/users/auth/password/reset-request', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { token } = await requestPasswordReset({ tenantId: tenantOf(req), email: requireString(body.email, 'email') });
      // Always 202 regardless of whether the email exists (no enumeration).
      res.status(202).json(EXPOSE_TOKENS && token ? { resetToken: token } : {});
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/sample/users/auth/password/reset', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      await resetPassword({
        tenantId: tenantOf(req),
        email: requireString(body.email, 'email'),
        token: requireString(body.token, 'token'),
        newPassword: requireString(body.newPassword, 'newPassword'),
      }).catch(asHttp);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/sample/users/auth/email/verify-request', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { token } = await requestEmailVerification({ tenantId: tenantOf(req), email: requireString(body.email, 'email') });
      res.status(202).json(EXPOSE_TOKENS && token ? { verifyToken: token } : {});
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/sample/users/auth/email/verify', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      await verifyEmail({
        tenantId: tenantOf(req),
        email: requireString(body.email, 'email'),
        token: requireString(body.token, 'token'),
      }).catch(asHttp);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // NOTE (ADR 0003): the parallel password-authenticated /auth/mfa/{enroll,
  // activate} routes were REMOVED. They existed only because MFA was keyed two
  // ways (password user vs session principal). Now that /login binds the session
  // to the durable `userId`, the session-based /v1/host/sample/users/mfa/* routes
  // resolve the SAME user the /login gate checks — one keying, no duplication.
}
