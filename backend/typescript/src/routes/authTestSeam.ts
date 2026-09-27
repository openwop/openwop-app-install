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
import { upsertFromPrincipal, sessionEpochOf } from '../features/users/usersService.js';
import { ensurePersonalWorkspace, getWorkspace } from '../host/accessControlService.js';

const log = createLogger('routes.authTestSeam');

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 32);
}

export function registerAuthTestSeamRoutes(app: Express): void {
  if (process.env.OPENWOP_TEST_AUTH_ENABLED !== 'true') {
    log.info('auth test seam disabled (set OPENWOP_TEST_AUTH_ENABLED=true to enable)');
    return;
  }
  log.warn('auth test seam ENABLED — /v1/host/openwop-app/test/login mints sessions. NEVER enable in a real deploy.');

  // POST /v1/host/openwop-app/test/login
  //   { email?, displayName?, tenantId?, subject? }
  // Derives a stable subject from `email` (so re-login is idempotent, like real
  // auth) unless one is given; the home `tenantId` defaults to the subject's
  // deterministic personal tenant — pass an explicit one to make co-tenant users.
  app.post('/v1/host/openwop-app/test/login', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as {
        email?: string; displayName?: string; tenantId?: string; subject?: string;
        sharedWorkspace?: boolean;
      };
      const subject = body.subject ?? `oidc:test-${shortHash(body.email ?? randomUUID()).slice(0, 16)}`;
      const tenantId = body.tenantId ?? `user:${shortHash(subject)}`;
      const user = await upsertFromPrincipal({
        tenantId,
        principalId: subject,
        source: 'oidc',
        ...(body.email ? { email: body.email } : {}),
        ...(body.displayName ? { displayName: body.displayName } : {}),
      });
      // ADR 0434 P4 / IDN-5 — the test seam deliberately does NOT consult the
      // stored active-workspace preference. A test seam must mint a session
      // whose tenant is EXACTLY what the caller asked for; resolving a stored
      // preference would make the seam's output depend on prior test state and
      // silently break tenant isolation between cases.
      //
      // Workspace-root membership: real login flows land in a workspace the
      // subject is a MEMBER of; without any row the SPA's workspace bootstrap
      // finds nothing ("No workspace available") and every membership-gated
      // read 403s. Mirror the real flows' shape:
      //  - personal default tenant (no explicit tenantId) → the caller OWNS it;
      //  - explicit tenantId, workspace absent → FIRST login founds + owns it;
      //  - explicit tenantId, workspace present → co-tenant user: mint the
      //    session ONLY. The RBAC suites assign that user's roles explicitly —
      //    auto-seeding an owner row here silently promoted every "viewer" to
      //    owner and inverted the 403 assertions.
      if (!body.tenantId || !(await getWorkspace(tenantId))) {
        await ensurePersonalWorkspace({
          tenantId,
          ownerSubject: user.userId,
          name: body.tenantId ? `Test workspace ${tenantId}` : 'Personal workspace',
          ...(body.displayName ? { ownerDisplayName: body.displayName } : {}),
          ...(body.email ? { ownerEmail: body.email } : {}),
        });
      }
      // GC-1 — whether `tenantId` is the caller's OWN home tenant or a SHARED
      // workspace they merely belong to is NOT derivable here, and getting it
      // wrong in either direction is a real defect:
      //
      //  - Collapsing personal onto active for a genuinely SHARED workspace makes
      //    `isOwnPersonalWorkspace` true, which short-circuits SIX authorization
      //    choke points (`featureRoute.ts:136,237`, `protocolAuthorization.ts:113`,
      //    `orgs/routes.ts:65`, `accessControl.ts:132`, `kanban.ts:723`). That is
      //    the GC-1 defect: an RBAC test could not deny authority the seam had
      //    already granted, so its 403 assertions were unfalsifiable.
      //  - Deriving a distinct personal tenant for a SINGLE-TENANT harness is
      //    equally wrong: those callers' home tenant really IS `tenantId`, and
      //    forcing them apart flips `resolveCallerUser` (`usersGuards.ts:85`) onto
      //    the canonical-home branch, so `requireOrgScope` then compares the org's
      //    ACTIVE tenant against the caller's HOME tenant and 404s
      //    (`featureRoute.ts:188-190`). Measured: 501 of 890 tests across 120
      //    files, none of which were authority defects.
      //
      // So the caller DECLARES it. `sharedWorkspace: true` means "this is NOT my
      // home tenant", and yields honest, membership-derived authority. The
      // default stays collapsed because for the single-tenant harness idiom it
      // is TRUE, not a legacy compromise.
      const personalTenant =
        body.sharedWorkspace === true && body.tenantId ? `user:${shortHash(subject)}` : tenantId;
      // NOTE for the next author: under `sharedWorkspace: true` a NON-member is
      // bounced to their personal tenant by the ADR 0015 re-check
      // (`middleware/auth.ts:868-874`) — a branch that was unreachable while the
      // collapse was in place. Their refusal therefore surfaces as 404 (the
      // feature gate in the bounced-to tenant), not 403. A candidate fix — also
      // founding the personal workspace here so the bounce has a real landing
      // site — was written and MEASURED NOT TO CHANGE THE OUTCOME, so it was
      // dropped rather than shipped as unverified code. Assert refusal as
      // `>= 400`, not a specific code, until someone makes 403 actually reachable.
      issueUserSession(res, { userId: user.userId, tenantId, personalTenant, subject, epoch: sessionEpochOf(user) });
      res.status(201).json({ user });
    } catch (err) {
      next(err);
    }
  });
}
