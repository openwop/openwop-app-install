/**
 * seams-v2 `startOAuthAuthorization` + `expireOAuthAccessToken` (RFC 0199 §A–§C
 * witnesses, ADR 0753 D12). Registered ONLY when `OPENWOP_TEST_SEAM_ENABLED=true`,
 * behind the seam's non-anonymous guard; never on the production service.
 *
 * R9 (RFC 0199 §Implementation notes): the seam sits in the ASSERTION PATH of the
 * PKCE, `state`, same-Subject and `iss` legs, so it is admissible only because it
 * builds nothing itself. It CONFIGURES a provider the production way —
 * `registerProvider` (the registry the real callback reads) and
 * `setHostOAuthClient` (the admin client store) — and then calls the production
 * `beginAuthorization`. The callback, `iss` check, token exchange and credential
 * store the suite then drives are the live ones. A pack handed in as `connection`
 * goes through `installConnectionPackManifest`, the production pack path, so
 * §B.3's discovery and §B.4's pin run exactly as for a real pack.
 */
import { randomBytes } from 'node:crypto';
import type { Express, Request, RequestHandler } from 'express';
import { OpenwopError } from '../../types.js';
import { sendError } from '../../middleware/errorEnvelope.js';
import { registerProvider, type ProviderManifest } from './providerRegistry.js';
import { setHostOAuthClient } from './oauthClientStore.js';
import { beginAuthorization } from './oauthFlow.js';
import { installConnectionPackManifest } from './connectionPackLoader.js';
import { authorizationServerMetadataUrls } from './mcpReachVerifier.js';
import { expireAccessTokenForSeam } from './connectionsService.js';
import { guardedEgressFetch } from '../../host/webhookEgressGuard.js';
import { vendorTwin } from '../../middleware/protocolVersion.js';

/** The suite's providers (seams-v2): one with an issuer, two issuer-less ones
 *  that §A.4 requires distinct redirect URIs for. Advertised only while seams are
 *  mounted (`oauthAdvertisement.ts`); the seam refuses any other id outside a
 *  `connection` pack, so it can never re-point a real provider. */
export const SYNTHETIC_OAUTH_PROVIDERS = ['synthetic', 'synthetic-noiss', 'synthetic-noiss-b'] as const;

const subjectOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;
const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const originOf = (req: Request): string => `${req.protocol}://${req.get('host') ?? 'localhost'}`;

/** RFC 9207 §3 — does the issuer's metadata promise `iss` on the response?
 *  Read from the metadata the issuer publishes (never assumed by the seam). */
async function issResponseParameterOf(issuer: string): Promise<boolean> {
  for (const url of authorizationServerMetadataUrls(issuer)) {
    try {
      const res = await guardedEgressFetch(url, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
      if (res.status !== 200) continue;
      const meta = (await res.json()) as Record<string, unknown>;
      if (meta.issuer === issuer) return meta.authorization_response_iss_parameter_supported === true;
    } catch {
      // try the next well-known URI
    }
  }
  return false;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export function registerOAuthConformanceSeams(app: Express, seamAuth: RequestHandler): void {
  app.post(vendorTwin('/oauth/authorize-start'), seamAuth, async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const subject = subjectOf(req);
      if (!subject) { sendError(res, 401, 'unauthenticated', 'authorize-start needs an authenticated Subject.'); return; }
      const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === 'string' && s !== '') : [];
      let provider = str(body.provider);

      if (body.connection !== undefined) {
        // The production pack path: schema validation, supersede rules, §B.4 pin.
        // A re-sent pack that does not supersede the installed one is refused as a
        // conflict and the INSTALLED provider stays — which is what the pinning leg
        // needs (the grant then re-verifies against the pin). Anything else that
        // did not install is the caller's error.
        const outcome = installConnectionPackManifest(body.connection);
        const conflictOnly = !outcome.installed && (outcome.errors ?? []).every((e) => e.code === 'connection_provider_conflict');
        if (!outcome.installed && !conflictOnly) {
          sendError(res, 400, 'validation_error', 'The connection pack did not install.', { errors: outcome.errors ?? [] });
          return;
        }
        provider = str(((body.connection as { provider?: { id?: unknown } }).provider ?? {}).id) ?? provider;
      } else {
        if (!provider || !(SYNTHETIC_OAUTH_PROVIDERS as readonly string[]).includes(provider)) {
          sendError(res, 400, 'validation_error', `provider must be one of ${SYNTHETIC_OAUTH_PROVIDERS.join(', ')} (or supply a connection pack).`);
          return;
        }
        const authUrl = str(body.authUrl);
        const tokenUrl = str(body.tokenUrl);
        if (!authUrl || !tokenUrl) { sendError(res, 400, 'validation_error', 'authUrl and tokenUrl are required for a synthetic provider.'); return; }
        const issuer = str(body.issuer);
        const pkce = body.pkce === 'unsupported' ? 'unsupported' as const : undefined;
        const granted = scopes.length > 0 ? scopes : ['openwop.read'];
        const manifest: ProviderManifest = {
          id: provider,
          label: provider,
          kind: 'oauth2',
          authFlow: 'pkce',
          reach: 'openapi',
          scopes: { read: [{ key: 'conformance', label: 'Conformance', scopes: granted }] },
          endpoints: { authorize: authUrl, token: tokenUrl },
          refreshable: true,
          defaultScopes: granted,
          consumerNodes: [],
          ...(issuer ? { issuer, issResponseParameter: await issResponseParameterOf(issuer) } : {}),
          ...(pkce ? { pkce } : {}),
        };
        registerProvider(manifest);
      }
      if (!provider) { sendError(res, 400, 'validation_error', 'provider is required.'); return; }
      await setHostOAuthClient({ provider, clientId: `openwop-conformance-${provider}`, clientSecret: randomBytes(24).toString('base64url'), updatedBy: 'conformance-seam' });

      // `redirectUri` in the body is a PROBE (§A.5): it is deliberately never read.
      const { authorizeUrl } = await beginAuthorization({
        provider,
        tenantId: tenantOf(req),
        userId: subject,
        reqOrigin: originOf(req),
        ...(scopes.length > 0 ? { scopes } : {}),
      });
      res.status(201).json({ authorizationUrl: authorizeUrl });
    } catch (err) {
      if (err instanceof OpenwopError) { sendError(res, err.httpStatus, err.code, err.message, err.details); return; }
      next(err);
    }
  });

  app.post(vendorTwin('/oauth/expire-refresh'), seamAuth, async (req, res, next) => {
    try {
      const subject = subjectOf(req);
      const provider = str(((req.body ?? {}) as { provider?: unknown }).provider);
      if (!subject || !provider) { sendError(res, 400, 'validation_error', 'provider is required.'); return; }
      if (!(await expireAccessTokenForSeam(tenantOf(req), provider, subject))) {
        sendError(res, 404, 'not_found', 'The caller holds no oauth2 credential for this provider.');
        return;
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });
}
