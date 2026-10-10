/**
 * Anon → user migration route (P3.5).
 *
 *   POST /v1/host/openwop-app/migrate-tenant
 *
 * Called by the SPA immediately after Firebase Auth sign-in to
 * reassign every artifact owned by the visitor's anonymous session to
 * their new permanent user tenant. This is the moment "register to
 * keep your work" actually delivers — without it, signed-in users
 * would have to recreate workflows they built while anonymous.
 *
 * Auth requirements (BOTH must be present):
 *   - Bearer OIDC ID token            → identifies destination user tenant
 *   - openwop.session cookie          → identifies source anon tenant
 *
 * The global auth middleware only honors one principal per request,
 * so this handler MUST run AFTER auth (req.tenantId = user) but ALSO
 * peek at the raw cookie to discover the source anon tenant. The
 * source must start with `anon:` and must not equal the destination.
 *
 * Storage migration (transactional in Postgres, txn in sqlite):
 *   - runs.tenant_id      anon:* → user:*
 *   - workflows.tenant_id anon:* → user:*
 *
 * BYOK migration (in-memory):
 *   - Anon ephemeral secrets get re-encrypted under the user's
 *     KMS-wrapped DEK and written to `byok_tenant_secrets`. Requires
 *     KMS to be configured; if unset, secret migration is skipped
 *     with a logged warning (runs + workflows still migrate).
 *
 * After migration the response includes a Set-Cookie that expires the
 * anon cookie, so the next request the client sends carries only the
 * OIDC bearer.
 */

import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import { COOKIE_NAME, readCookie, verifySession, type SessionPayload } from '../middleware/cookieSession.js';
import { createLogger } from '../observability/logger.js';
import type { Storage } from '../storage/storage.js';
import {
  migrateEphemeralSecretsToTenant,
} from '../byok/secretResolver.js';
import { isKmsConfigured } from '../byok/kmsEncryption.js';
import { personalTenantOf } from '../host/requestSubject.js';
import { dedupePersonasBeforeAdopt } from '../host/adoptDedup.js';

const log = createLogger('routes.migrate');

/** The anon sandbox cookie, if this request carries a valid one. ADR 0833 D1 —
 *  through the SHARED cookie verifier: this file used to hand-roll its own copy
 *  of the HMAC check (and its own secret resolution), a second verifier the
 *  hardening of the first could never reach. */
function verifyAnonSessionCookie(req: Request): SessionPayload | null {
  const raw = readCookie(req.header('cookie'), COOKIE_NAME);
  return raw ? verifySession(raw) : null;
}

export function registerMigrateRoute(app: Express, deps: { storage: Storage }): void {
  app.post('/host/openwop-app/migrate-tenant', async (req, res, next) => {
    try {
      // ADR 0015: migrate the anon sandbox into the caller's PERSONAL tenant —
      // NOT `req.tenantId`, which is the active workspace and may be a shared
      // `ws:` (migrating your personal sandbox into a team workspace would be
      // wrong). Use the intrinsic personal tenant the auth middleware resolved.
      const userTenantId = personalTenantOf(req);
      if (!userTenantId || !userTenantId.startsWith('user:')) {
        throw new OpenwopError(
          'unauthenticated',
          'Migration requires a signed-in user (OIDC Bearer token).',
          401,
        );
      }

      const anonSession = verifyAnonSessionCookie(req);
      if (!anonSession || !anonSession.tenantId.startsWith('anon:')) {
        // No anon cookie → nothing to migrate. Idempotent success.
        res.json({ migrated: false, runs: 0, workflows: 0, secrets: 0 });
        return;
      }
      const anonTenantId = anonSession.tenantId;
      if (anonTenantId === userTenantId) {
        throw new OpenwopError(
          'invalid_request',
          'Anon tenant equals user tenant — nothing to migrate.',
          400,
        );
      }

      // Dedup per-persona demo entities BEFORE the fold — otherwise every
      // adopted anon session folds in another "Chief of Staff" etc. (the
      // agent-allowlists duplication). Preserves the anon-populated demo; only
      // drops what the user tenant already has. Best-effort, idempotent.
      await dedupePersonasBeforeAdopt(anonTenantId, userTenantId, deps.storage);

      const { runs, workflows, notifications, pushSubscriptions, hostExt, hostExtKeysRekeyed, hostExtKeysDeduped } =
        await deps.storage.reassignTenant(anonTenantId, userTenantId);

      let secrets = 0;
      let secretsFailed = 0;
      if (isKmsConfigured()) {
        try {
          const result = await migrateEphemeralSecretsToTenant(anonTenantId, userTenantId);
          secrets = result.migrated;
          secretsFailed = result.failed;
        } catch (err) {
          log.warn('ephemeral secret migration failed; continuing', {
            anonTenantId, userTenantId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      await deps.storage.appendAudit({
        timestamp: new Date().toISOString(),
        principalId: req.principal?.principalId,
        action: 'tenant.migrate',
        resource: userTenantId,
        outcome: 'success',
        payload: { from: anonTenantId, to: userTenantId, runs, workflows, notifications, pushSubscriptions, hostExt, hostExtKeysRekeyed, hostExtKeysDeduped, secrets, secretsFailed },
      });

      // ADR 0434 Phase 2 — DO NOT expire the cookie here.
      //
      // This used to append `Set-Cookie: <name>=; Max-Age=0` to "expire the anon
      // cookie so the next request carries only the bearer". But the auth
      // middleware has ALREADY appended a Set-Cookie on this same response,
      // PROMOTING that cookie to user-tier (auth.ts, the bearer-path promotion).
      // Two Set-Cookie headers, same name and path — the later one wins, so the
      // promotion was silently discarded and the browser finished sign-in with
      // NO session cookie at all.
      //
      // That left the device bearer-only, which is precisely the state where a
      // routine token-rotation race had nothing to fall back to and minted a
      // fresh anonymous tenant (see the `bearerRejected` guard in auth.ts).
      // Keeping the promoted user-tier cookie is both the correct end state and
      // the safety net. The anon session is not "left behind": it was promoted
      // in place, and its data has just been folded into the user tenant above.
      res.json({ migrated: true, runs, workflows, notifications, pushSubscriptions, hostExt, hostExtKeysRekeyed, hostExtKeysDeduped, secrets, secretsFailed });
    } catch (err) {
      next(err);
    }
  });
}
