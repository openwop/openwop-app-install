/**
 * seams-v2 `mintLaneCredential` + `revokeLaneCredential` (RFC 0170 §B.3; used by
 * RFC 0199's `v2-credential-interrupt` for a FRESH Subject per run — ADR 0753).
 * Lives in `routes/` (beside `testSeam.ts`), not in a feature: it composes TWO
 * features' production paths (developer-keys + users), and a feature importing
 * another is the coupling the feature-dependency map exists to catch.
 * Registered ONLY when `OPENWOP_TEST_SEAM_ENABLED=true`, behind the seam's
 * non-anonymous guard; never on the production service.
 *
 * Both go through the PRODUCTION issuance and revocation of the `api-key` lane
 * (`issueApiKey` / `revokeApiKey`, the developer-keys store the auth middleware
 * verifies against), so the credential they return authenticates exactly as an
 * ordinary `owk_` key does, and a revoked one is refused by the real middleware.
 * Each mint is a new key and therefore a new Subject (`apikey:<keyId>`).
 *
 * `session` (suite ≥ 2.40.3, openwop#1602): a NEW user in the caller's tenant
 * and a session minted for it through the production signer
 * (`mintUserSessionCookieValue`, the same one `issueUserSession` uses), returned
 * with `presentation: {kind: "cookie", name}` so the suite presents it as the
 * cookie it is. Revocation is the production ADR 0621 epoch bump — the next
 * request presenting it is refused `session_revoked` (v2: `credential_revoked`).
 * Only while cookies are enabled — exactly when the lane is advertised.
 * `anonymous` advertises no revocation (nothing to revoke), so it is not minted.
 */
import type { Express, Request, RequestHandler } from 'express';
import { sendError } from '../middleware/errorEnvelope.js';
import { vendorTwin } from '../middleware/protocolVersion.js';
import { randomBytes } from 'node:crypto';
import { issueApiKey, keyIdOfToken, revokeApiKey } from '../features/developer-keys/apiKeyService.js';
import { COOKIE_NAME, mintUserSessionCookieValue, verifySession } from '../middleware/cookieSession.js';
import { bumpSessionEpoch, sessionEpochOf, upsertFromPrincipal } from '../features/users/usersService.js';

const cookiesEnabled = (): boolean => process.env.OPENWOP_AUTH_DISABLE_COOKIES !== 'true';

const subjectOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;
const tenantOf = (req: Request): string => req.tenantId ?? 'default';

export function registerCredentialLaneSeams(app: Express, seamAuth: RequestHandler): void {
  app.post(vendorTwin('/auth/credential/mint'), seamAuth, async (req, res, next) => {
    try {
      const subject = subjectOf(req);
      if (!subject) { sendError(res, 401, 'unauthenticated', 'The mint seam needs an authenticated caller.'); return; }
      const lane = (req.body as { lane?: unknown } | undefined)?.lane ?? 'api-key';
      if (lane === 'session' && cookiesEnabled()) {
        const tenantId = tenantOf(req);
        const user = await upsertFromPrincipal({ tenantId, principalId: `oidc:conformance-mint-${randomBytes(9).toString('hex')}`, source: 'oidc' });
        const credential = mintUserSessionCookieValue({ userId: user.userId, tenantId, epoch: sessionEpochOf(user) });
        res.status(201).json({ lane: 'session', credential, subjectId: user.userId, presentation: { kind: 'cookie', name: COOKIE_NAME } });
        return;
      }
      if (lane !== 'api-key') {
        sendError(res, 400, 'validation_error', `lane '${String(lane)}' is not mintable by this seam (api-key, or session while cookies are enabled).`, { lane });
        return;
      }
      const { token, key } = await issueApiKey({ tenantId: tenantOf(req), name: 'conformance mint seam', createdBy: subject });
      res.status(201).json({ lane: 'api-key', credential: token, subjectId: `apikey:${key.keyId}` });
    } catch (err) {
      next(err);
    }
  });

  app.post(vendorTwin('/auth/credential/revoke'), seamAuth, async (req, res, next) => {
    try {
      const subject = subjectOf(req);
      const credential = (req.body as { credential?: unknown } | undefined)?.credential;
      if (!subject || typeof credential !== 'string' || credential === '') {
        sendError(res, 400, 'validation_error', 'credential is required.');
        return;
      }
      if (!credential.startsWith('owk_')) {
        // A session cookie value: revoke through the production epoch bump, and
        // only a session of the caller's own tenant.
        const session = verifySession(credential);
        if (!session?.userId || session.tenantId !== tenantOf(req) || !(await bumpSessionEpoch(session.userId))) {
          sendError(res, 404, 'not_found', 'No active credential matches.');
          return;
        }
        res.status(200).json({ revoked: true });
        return;
      }
      const found = await keyIdOfToken(credential);
      // Only a key in the caller's own tenant; anything else is "no active match".
      if (!found || found.tenantId !== tenantOf(req) || !(await revokeApiKey(found.tenantId, found.keyId, { callerSubject: subject, isAdmin: true }))) {
        sendError(res, 404, 'not_found', 'No active credential matches.');
        return;
      }
      res.status(200).json({ revoked: true });
    } catch (err) {
      next(err);
    }
  });
}
