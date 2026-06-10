/**
 * TOTP MFA routes (host-extension, sample-grade — ADR 0002, Phase 5).
 *
 * Surface under /v1/host/sample/users/mfa (toggle-gated on `users`):
 *   GET  /status     is MFA active for the caller?
 *   POST /enroll     begin enrollment -> otpauth URI + secret + recovery codes (ONCE)
 *   POST /activate   { token }   confirm a live TOTP -> active
 *   POST /verify     { token }   verify a second factor (TOTP or recovery code)
 *   POST /disable    turn MFA off
 *
 * Each route operates on the CALLER'S OWN durable user (resolved + upserted from
 * the principal the existing auth paths mint). The enrollment secret + recovery
 * codes are returned only to that authenticated owner, exactly once (finding C3).
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import type { ToggleSubject } from '../../host/featureToggles/types.js';
import { activate, beginEnrollment, disableMfa, isMfaActive, verify } from './mfaService.js';
import { resolveCallerUser } from './usersGuards.js';

const TOGGLE_ID = 'users';

function tenantOf(req: Request): string {
  return req.tenantId ?? 'default';
}
function subjectOf(req: Request): ToggleSubject {
  const subject: ToggleSubject = { tenantId: tenantOf(req) };
  if (req.principal?.principalId) subject.userId = req.principal.principalId;
  return subject;
}

async function requireEnabled(req: Request): Promise<void> {
  const a = await resolveOne(TOGGLE_ID, subjectOf(req));
  if (!a || !a.enabled) throw new OpenwopError('not_found', 'Users is not enabled for this tenant.', 404, { feature: TOGGLE_ID });
}

/** The caller's ONE canonical durable user (ADR 0003) — bound session resolves
 *  by `req.userId`, so MFA keys on the same user `/login` checks. */
const callerUser = resolveCallerUser;

function requireToken(req: Request): string {
  const token = (req.body as { token?: unknown })?.token;
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new OpenwopError('validation_error', 'Field `token` is required.', 400, { field: 'token' });
  }
  return token.trim();
}

export function registerUsersMfaRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get('/v1/host/sample/users/mfa/status', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const user = await callerUser(req);
      res.json({ active: await isMfaActive(user.userId) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/sample/users/mfa/enroll', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const user = await callerUser(req);
      const result = await beginEnrollment({
        tenantId: tenantOf(req),
        userId: user.userId,
        accountLabel: user.email ?? user.principalId,
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/sample/users/mfa/activate', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const user = await callerUser(req);
      const token = requireToken(req);
      if (!(await activate({ userId: user.userId, token }))) {
        throw new OpenwopError('unauthenticated', 'Invalid MFA code.', 401, {});
      }
      res.json({ active: true });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/sample/users/mfa/verify', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const user = await callerUser(req);
      const token = requireToken(req);
      const verified = await verify({ userId: user.userId, token });
      if (!verified) {
        throw new OpenwopError('unauthenticated', 'Invalid MFA code.', 401, {});
      }
      res.json({ verified: true });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/sample/users/mfa/disable', async (req, res, next) => {
    try {
      await requireEnabled(req);
      const user = await callerUser(req);
      await disableMfa(user.userId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });
}
