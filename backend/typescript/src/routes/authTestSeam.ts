/**
 * Test-only auth seam (env-gated `OPENWOP_TEST_AUTH_ENABLED=true`).
 *
 * Mints a user-tier session for a synthetic durable `User`. This REPLACES the
 * removed host password signup (ADR 0026) as the way ROUTE TESTS create an
 * authenticated caller — real sign-in is now Firebase OIDC, which a hermetic
 * test can't drive, and (crucially) every Firebase user lands in its OWN
 * deterministic personal tenant, so OIDC can't reproduce the co-tenant users the
 * org-RBAC suites need. This seam takes an explicit `tenantId`, so a test can
 * mint two users in the SAME tenant (owner + member) for `authorizeOrgScope`.
 *
 * OFF by default (404 when the flag is unset) — like the other `OPENWOP_TEST_*`
 * seams, it MUST NOT be reachable in any real deploy. The mounted route is
 * PRE-AUTH (it issues the session); a caller with only the demo's anon cookie can
 * reach it, and the response overwrites that cookie with a user-tier one.
 *
 * @see docs/adr/0026-firebase-email-password-supersede-host-credentials.md
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { createLogger } from '../observability/logger.js';
import { issueUserSession } from '../middleware/auth.js';
import { upsertFromPrincipal } from '../features/users/usersService.js';

const log = createLogger('routes.authTestSeam');

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 32);
}

export function registerAuthTestSeamRoutes(app: Express): void {
  if (process.env.OPENWOP_TEST_AUTH_ENABLED !== 'true') {
    log.info('auth test seam disabled (set OPENWOP_TEST_AUTH_ENABLED=true to enable)');
    return;
  }
  log.warn('auth test seam ENABLED — /v1/host/sample/test/login mints sessions. NEVER enable in a real deploy.');

  // POST /v1/host/sample/test/login
  //   { email?, displayName?, tenantId?, subject? }
  // Derives a stable subject from `email` (so re-login is idempotent, like real
  // auth) unless one is given; the home `tenantId` defaults to the subject's
  // deterministic personal tenant — pass an explicit one to make co-tenant users.
  app.post('/v1/host/sample/test/login', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { email?: string; displayName?: string; tenantId?: string; subject?: string };
      const subject = body.subject ?? `oidc:test-${shortHash(body.email ?? randomUUID()).slice(0, 16)}`;
      const tenantId = body.tenantId ?? `user:${shortHash(subject)}`;
      const user = await upsertFromPrincipal({
        tenantId,
        principalId: subject,
        source: 'oidc',
        ...(body.email ? { email: body.email } : {}),
        ...(body.displayName ? { displayName: body.displayName } : {}),
      });
      issueUserSession(res, { userId: user.userId, tenantId, personalTenant: tenantId, subject });
      res.status(201).json({ user });
    } catch (err) {
      next(err);
    }
  });
}
