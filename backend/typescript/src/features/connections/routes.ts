/**
 * Connections feature routes (host-extension, best-effort — ADR 0024).
 *
 * Surface under /v1/host/openwop-app/{connections,providers}. Always-on: Connections
 * graduated off its feature toggle to a permanent admin surface (ADR 0024
 * § Correction, 2026-06-11). Phase A: the provider registry + the
 * api_key/bearer create path + list/revoke + the resolver. Phase B (this commit):
 * the OAuth2 PKCE consent round-trip (authorize → consent URL; callback → code
 * exchange → KMS-enveloped token store), on-demand + warm refresh, and the
 * `/test` health probe.
 *
 * Secrets are NEVER returned on any response — only connection metadata + status.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveAndResume } from '../../routes/interrupts.js';
import { vendorTwin } from '../../middleware/protocolVersion.js';
import { createLogger } from '../../observability/logger.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { isProviderAllowed } from '../../host/governanceService.js';
import { requireSuperadmin } from '../../host/superadmin.js';
import { publicBaseUrl } from '../featureRoute.js';
import { listProviders, getProvider, type CredentialKind } from './providerRegistry.js';
import { sendError } from '../../middleware/errorEnvelope.js';
import {
  setHostOAuthClient,
  listHostOAuthClients,
  deleteHostOAuthClient,
} from './oauthClientStore.js';
import {
  listConnections,
  getConnection,
  createSecretConnection,
  upsertOAuthConnection,
  revokeConnection,
  probeConnection,
  type ConnectionScope,
} from './connectionsService.js';
import {
  beginAuthorization,
  consumePendingAuth,
  exchangeCodeForTokens,
  isOAuthConfigured,
  appReturnUrl,
  authorizationResponseIssuerOk,
  callbackRefusalPage,
  writeScopesOf,
  inboundIngestUrl,
} from './oauthFlow.js';
import {
  setInboundConfig,
  getInboundConfig,
  getInboundConfigForWebhook,
  resolveInboundSigningSecret,
  removeInboundConfig,
  handleInboundEvent,
  inboundConfigurable,
  inboundObserverOnly,
  isStreamInbound,
} from './inboundWebhooks.js';

const log = createLogger('connections.routes');

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

/** The browser-facing origin of THIS request — only used as a local-dev fallback
 *  when no OPENWOP_PUBLIC_BASE_URL / OPENWOP_OAUTH_CALLBACK_BASE_URL is set. */
const reqOriginOf = (req: Request): string => `${req.protocol}://${req.get('host') ?? 'localhost'}`;

/** Require `host:connections:manage` on `orgId` (ADR 0024 D2). Fail-closed: a
 *  non-member / non-admin resolves to no scopes ⇒ 403. */
async function requireConnectionsManage(req: Request, orgId: string): Promise<void> {
  const access = await resolveEffectiveAccess(tenantOf(req), { subject: actingUserOf(req), orgId });
  if (!access.scopes.includes('host:connections:manage')) {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: host:connections:manage', 403, {
      requiredScope: 'host:connections:manage',
      orgId,
    });
  }
}

/**
 * Fail-closed authorization for mutating/probing one connection (ADR 0024 D2).
 *   - ORG-shared → admin-gated on `host:connections:manage` for that org.
 *   - USER → owner-only.
 *   - WORKSPACE default → no API create path, so it falls through (no owner to
 *     check); reachable only if seeded out-of-band.
 */
async function authorizeManage(req: Request, connection: { userId?: string; orgId?: string; connectionId: string }): Promise<void> {
  if (connection.orgId) {
    await requireConnectionsManage(req, connection.orgId);
    return;
  }
  if (connection.userId && connection.userId !== actingUserOf(req)) {
    throw new OpenwopError('forbidden', 'Only the connecting user may manage this connection.', 403, { connectionId: connection.connectionId });
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OpenwopError('validation_error', `Field \`${field}\` is required and MUST be a non-empty string.`, 400, { field });
  }
  return value;
}

export function registerConnectionsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const wrap = (h: (req: Request, res: import('express').Response) => Promise<void>) =>
    async (req: Request, res: import('express').Response, next: import('express').NextFunction) => {
      try {
        await h(req, res);
      } catch (err) {
        next(err);
      }
    };

  // ── Provider registry (the catalog — adding an integration is a manifest) ──
  app.get('/v1/host/openwop-app/providers', wrap(async (_req, res) => {
    // `oauthConfigured` is the honesty signal (ADR 0024 RFC-gate): an oauth2
    // provider is only offered for Connect when its host-side client creds exist.
    // `writeScopes` lets the UI offer a Phase C write re-consent (ADR 0024 §3).
    res.json({
      providers: await Promise.all(
        listProviders().map(async (p) => ({
          ...p,
          oauthConfigured: await isOAuthConfigured(p.id),
          writeScopes: writeScopesOf(p.id),
        })),
      ),
    });
  }));
  app.get('/v1/host/openwop-app/providers/:id', wrap(async (req, res) => {
    const m = getProvider(req.params.id);
    if (!m) throw new OpenwopError('not_found', 'Provider not found.', 404, { provider: req.params.id });
    res.json(m);
  }));

  // ── Host OAuth client config (superadmin) — ADR 0024 § host-managed OAuth ──
  // Lets an operator configure each provider's OAuth app (client id + secret)
  // through the UI instead of OPENWOP_OAUTH_* env vars. SIBLING prefix
  // `connections-oauth-clients` (NOT nested under `/connections/:id`, which the
  // param routes own — same discipline as `connections-inbound`). The client
  // SECRET is sealed at rest and NEVER returned on any read.
  app.get('/v1/host/openwop-app/connections-oauth-clients', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'OAuth client configuration');
      res.json({ clients: await listHostOAuthClients() });
    } catch (err) {
      next(err);
    }
  });

  app.put('/v1/host/openwop-app/connections-oauth-clients/:provider', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'OAuth client configuration');
      const provider = req.params.provider;
      const manifest = getProvider(provider);
      if (!manifest) throw new OpenwopError('not_found', 'Provider not found.', 404, { provider });
      if (manifest.kind !== 'oauth2') {
        throw new OpenwopError('validation_error', `Provider '${provider}' does not use OAuth — no client credentials to configure.`, 400, { provider });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      await setHostOAuthClient({
        provider,
        clientId: requireString(body.clientId, 'clientId'),
        clientSecret: requireString(body.clientSecret, 'clientSecret'),
        ...(actingUserOf(req) ? { updatedBy: actingUserOf(req) } : {}),
      });
      res.status(204).end(); // secret never echoed
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/openwop-app/connections-oauth-clients/:provider', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'OAuth client configuration');
      const existed = await deleteHostOAuthClient(req.params.provider);
      if (!existed) {
        throw new OpenwopError('not_found', 'No host OAuth client configured for that provider.', 404, { provider: req.params.provider });
      }
      res.status(204).end(); // falls back to env vars (or unconfigured) after delete
    } catch (err) {
      next(err);
    }
  });

  // ── Connections ──
  app.get('/v1/host/openwop-app/connections', wrap(async (req, res) => {
    res.json({ connections: await listConnections(tenantOf(req), actingUserOf(req)) });
  }));

  app.post('/v1/host/openwop-app/connections', wrap(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const provider = requireString(body.provider, 'provider');
    const manifest = getProvider(provider);
    if (!manifest) throw new OpenwopError('connection_provider_unresolved', `No connection provider '${provider}' — install a connection pack whose provider.id is '${provider}', or none is built in (RFC 0095 §B.6).`, 404, { provider });
    // ADR 0028 — provider allowlist, same predicate as the resolve seam.
    if (!(await isProviderAllowed(tenantOf(req), provider))) {
      throw new OpenwopError('forbidden', `Provider '${provider}' is not on this workspace's allowlist.`, 403, { provider });
    }

    const kind = requireString(body.kind, 'kind') as CredentialKind;
    if (kind === 'oauth2') {
      throw new OpenwopError('validation_error', "oauth2 connections are acquired via /connections/:provider/authorize (Phase B), not by posting a secret.", 400, { provider });
    }
    if (kind !== 'api_key' && kind !== 'bearer' && kind !== 'basic') {
      throw new OpenwopError('validation_error', '`kind` MUST be one of api_key | bearer | basic for this endpoint.', 400, { field: 'kind' });
    }

    const scope = (typeof body.scope === 'string' ? body.scope : 'user') as ConnectionScope;
    // D2 (Phase C): an org-shared connection is ADMIN-managed. Creating one now
    // requires `host:connections:manage` on the target org (default: the
    // workspace-root org, orgId === tenantId), checked fail-closed below. These
    // are S2S credentials (api_key/bearer) — an OAuth org *service identity* is a
    // later step (D2 tripwire: per-user attribution needs per-user connections).
    let orgId: string | undefined;
    if (scope === 'org') {
      orgId = typeof body.orgId === 'string' && body.orgId.trim() ? body.orgId.trim() : tenantOf(req);
      await requireConnectionsManage(req, orgId);
    }

    const connection = await createSecretConnection({
      tenantId: tenantOf(req),
      provider,
      kind,
      secret: requireString(body.secret, 'secret'),
      scope,
      ...(scope === 'user' && actingUserOf(req) ? { userId: actingUserOf(req) } : {}),
      ...(scope === 'org' && orgId ? { orgId } : {}),
      ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
      ...(Array.isArray(body.scopes) ? { scopes: (body.scopes as unknown[]).filter((s): s is string => typeof s === 'string') } : {}),
    });
    res.status(201).json(connection); // metadata only — no secret
  }));

  // ── OAuth2 PKCE consent (ADR 0024 Phase B §3) ──
  // authorize: mint a consent URL bound to (tenant, user) with PKCE + state.
  app.post('/v1/host/openwop-app/connections/:provider/authorize', wrap(async (req, res) => {
    const provider = req.params.provider;
    const manifest = getProvider(provider);
    if (!manifest) throw new OpenwopError('connection_provider_unresolved', `No connection provider '${provider}' — install a connection pack whose provider.id is '${provider}', or none is built in (RFC 0095 §B.6).`, 404, { provider });
    // ADR 0028 — provider allowlist, same predicate as the resolve seam.
    if (!(await isProviderAllowed(tenantOf(req), provider))) {
      throw new OpenwopError('forbidden', `Provider '${provider}' is not on this workspace's allowlist.`, 403, { provider });
    }
    if (!(await isOAuthConfigured(provider))) {
      throw new OpenwopError('conflict', `OAuth is not configured for '${provider}' on this host.`, 409, { provider });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { authorizeUrl } = await beginAuthorization({
      provider,
      tenantId: tenantOf(req),
      reqOrigin: reqOriginOf(req),
      ...(actingUserOf(req) ? { userId: actingUserOf(req) } : {}),
      ...(Array.isArray(body.scopes) ? { scopes: (body.scopes as unknown[]).filter((s): s is string => typeof s === 'string') } : {}),
      ...(body.write === true ? { includeWrite: true } : {}),
      ...(typeof body.returnTo === 'string' ? { returnTo: body.returnTo } : {}),
    });
    res.json({ authorizeUrl });
  }));

  // connect: a `credential` interrupt's connectUrl (RFC 0199 §C.3, ADR 0753 D9).
  // NOT pre-authenticated: it requires a signed-in user who IS the run's recorded
  // owner (read verbatim from the run, never re-resolved — fork-safe), and an OPEN
  // credential interrupt at that node. Only then does it start §A's grant for that
  // Subject, through the production authorization-URL builder, carrying the
  // interrupt on the single-use state. Anyone else gets no authorization URL.
  // Registered on the version-agnostic vendor root's `/v1` twin (ADR 0652): the
  // canonical `/host/openwop-app/…` address — the one `connectUrl` names — reaches it too.
  app.get(vendorTwin('/connections/connect/:runId/:nodeId'), wrap(async (req, res) => {
    const subject = actingUserOf(req);
    if (!subject) throw new OpenwopError('unauthenticated', 'Sign in to authorize this connection.', 401);
    const run = await deps.storage.getRun(req.params.runId);
    const owner = typeof (run?.metadata as Record<string, unknown> | undefined)?.actingUserId === 'string'
      ? ((run!.metadata as Record<string, unknown>).actingUserId as string)
      : undefined;
    // One refusal for "not your run" and "no such run": existence is not leaked.
    if (!run || run.tenantId !== tenantOf(req) || owner !== subject) {
      throw new OpenwopError('forbidden', 'Only the user who started this run can authorize it.', 403);
    }
    const interrupt = await deps.storage.getInterruptByNode(run.runId, req.params.nodeId);
    if (!interrupt || interrupt.kind !== 'credential' || interrupt.resolvedAt) {
      throw new OpenwopError('not_found', 'No open authorization request for this step.', 404);
    }
    const data = (interrupt.data ?? {}) as { provider?: unknown; scopes?: unknown };
    if (typeof data.provider !== 'string') throw new OpenwopError('not_found', 'No open authorization request for this step.', 404);
    const { authorizeUrl } = await beginAuthorization({
      provider: data.provider,
      tenantId: run.tenantId,
      userId: subject,
      reqOrigin: reqOriginOf(req),
      ...(Array.isArray(data.scopes) && data.scopes.length > 0 ? { scopes: data.scopes.filter((x): x is string => typeof x === 'string') } : {}),
      returnTo: `/runs/${encodeURIComponent(run.runId)}`,
      interruptId: interrupt.interruptId,
    });
    res.set('Cache-Control', 'no-store').redirect(authorizeUrl);
  }));

  // callback: the provider's browser redirect. The grant is bound by the single-use
  // server-stored `state`; the browser is always sent back to the SPA. A HOST
  // refusal (bad/replayed state, wrong Subject, wrong `iss`, failed exchange) is a
  // 4xx page that meta-refreshes there (ADR 0753 D1) — observable as a refusal,
  // same UX. A PROVIDER-reported error (the user declined at the provider) and a
  // success stay plain 302s.
  app.get('/v1/host/openwop-app/connections/:provider/callback', async (req: Request, res: import('express').Response) => {
    const provider = req.params.provider;
    const origin = reqOriginOf(req);
    const bounce = (returnTo: string, reason: string): void => {
      res.redirect(appReturnUrl(origin, returnTo, { connectError: provider, reason }));
    };
    const fail = (returnTo: string, reason: string, status = 400): void => {
      res
        .status(status)
        .set('Cache-Control', 'no-store')
        .set('Content-Security-Policy', "default-src 'none'")
        .type('html')
        .send(callbackRefusalPage(appReturnUrl(origin, returnTo, { connectError: provider, reason })));
    };
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    let returnTo = '/connections';
    try {
      // Provider-side consent error (user declined / invalid scope, etc.).
      if (typeof req.query.error === 'string' && req.query.error) {
        const pendingErr = state ? await consumePendingAuth(state) : null;
        return bounce(pendingErr?.returnTo ?? returnTo, 'consent_denied');
      }
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!state || !code) return fail(returnTo, 'missing_params');

      const pending = await consumePendingAuth(state); // single-use (an atomic claim)
      if (!pending || pending.provider !== provider) return fail(returnTo, 'invalid_state');
      returnTo = pending.returnTo;
      // SAME-USER BINDING (RFC 0199 §A.3, invariant `oauth-same-user-binding`): if
      // the callback request is authenticated and its Subject DIFFERS from the one
      // that started the grant, refuse and store nothing. This used to take the
      // identity from `state` alone and never look at the session, so a victim's
      // browser completing an attacker-initiated consent (or vice versa) bound the
      // provider account to the wrong user — a login-CSRF / account-binding hole.
      // An UNAUTHENTICATED callback may still complete under the state's Subject
      // (the RFC refuses only on a mismatch); the `state` was already claimed above,
      // so a refused callback cannot be replayed either.
      const callbackSubject = actingUserOf(req);
      if (callbackSubject && callbackSubject !== pending.userId) {
        log.warn('oauth callback subject mismatch — refused', { provider });
        return fail(returnTo, 'subject_mismatch', 403);
      }
      // MIX-UP DEFENSE (RFC 0199 §A.4 / RFC 9207): the response must name the
      // provider's issuer before any code is exchanged. Checked against the provider
      // bound to `state`, never one named by the request.
      if (!authorizationResponseIssuerOk(pending.provider, req.query.iss)) {
        log.warn('oauth callback issuer mismatch — refused', { provider });
        return fail(returnTo, 'iss_mismatch');
      }

      const tokens = await exchangeCodeForTokens({
        provider,
        code,
        codeVerifier: pending.codeVerifier,
        scopes: pending.scopes,
        reqOrigin: origin,
      });
      const connection = await upsertOAuthConnection({
        tenantId: pending.tenantId,
        provider,
        tokens,
        ...(pending.userId ? { userId: pending.userId } : {}),
      });
      log.info('oauth connection established', { provider, connectionId: connection.connectionId });
      // RFC 0199 §C.4 — a grant started from a `credential` interrupt's
      // connectUrl resolves that interrupt itself, through the ordinary resolve
      // choke point (which re-checks that the credential now resolves). Losing a
      // race to a concurrent resolve (the user declined meanwhile) is not a
      // failure of THIS grant: the credential is stored either way.
      if (pending.interruptId) {
        try {
          await resolveAndResume(deps.storage, deps.hostSuite, pending.interruptId, { outcome: 'authorized' });
        } catch (err) {
          log.warn('credential interrupt auto-resolve did not apply', { provider, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return res.redirect(appReturnUrl(origin, returnTo, { connected: provider }));
    } catch (err) {
      log.warn('oauth callback failed', { provider, error: err instanceof Error ? err.message : String(err) });
      return fail(returnTo, 'exchange_failed', 502);
    }
  });

  // test: health-probe a connection's credential (refreshes oauth2 on the way).
  app.post('/v1/host/openwop-app/connections/:id/test', wrap(async (req, res) => {
    const existing = await getConnection(tenantOf(req), req.params.id);
    if (!existing) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId: req.params.id });
    await authorizeManage(req, existing);
    const result = await probeConnection(tenantOf(req), req.params.id);
    res.json(result ?? { ok: false, status: 'revoked' });
  }));

  app.delete('/v1/host/openwop-app/connections/:id', wrap(async (req, res) => {
    const existing = await getConnection(tenantOf(req), req.params.id);
    if (!existing) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId: req.params.id });
    await authorizeManage(req, existing);
    // Tear down any inbound wiring first so revoke leaves no orphaned signing
    // secret / config / live subscription behind (ADR 0024 §6).
    await removeInboundConfig(tenantOf(req), req.params.id);
    await revokeConnection(tenantOf(req), req.params.id);
    res.status(204).end();
  }));

  // ── Inbound provider webhooks: config (ADR 0024 §6 / Phase C) ──
  // Admin/owner-gated authoring of the per-connection inbound trigger. The
  // resulting PUBLIC ingest (below) carries no host credential — the provider
  // signature is the credential.
  app.get('/v1/host/openwop-app/connections/:id/inbound', wrap(async (req, res) => {
    const existing = await getConnection(tenantOf(req), req.params.id);
    if (!existing) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId: req.params.id });
    await authorizeManage(req, existing);
    const config = await getInboundConfig(tenantOf(req), req.params.id);
    res.json({ config, ingestUrl: inboundIngestUrl(req.params.id, reqOriginOf(req)) }); // never the signing secret
  }));

  app.put('/v1/host/openwop-app/connections/:id/inbound', wrap(async (req, res) => {
    const existing = await getConnection(tenantOf(req), req.params.id);
    if (!existing) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId: req.params.id });
    await authorizeManage(req, existing);
    if (!inboundConfigurable(existing.provider)) {
      throw new OpenwopError('validation_error', `Inbound webhooks are not supported for '${existing.provider}'.`, 400, { provider: existing.provider });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    // RFC 0127 — a streaming/CDC ingress connection declares which broker source it
    // delivers (`stream` | `change`, default `stream`); ignored for the messaging trio.
    const streamSource = body.source === 'change' || body.source === 'stream' ? body.source : undefined;
    // OBSERVER-ONLY providers (ADR 0404 zoom-webinar) fire no workflow — a
    // workflowId is meaningless for them, so it is not required (and ignored).
    const observerOnly = inboundObserverOnly(existing.provider);
    const config = await setInboundConfig({
      tenantId: tenantOf(req),
      connectionId: req.params.id,
      provider: existing.provider,
      ...(observerOnly ? {} : { workflowId: requireString(body.workflowId, 'workflowId') }),
      signingSecret: requireString(body.signingSecret, 'signingSecret'),
      ...(isStreamInbound(existing.provider) && streamSource ? { streamSource } : {}),
    });
    res.status(201).json({ config, ingestUrl: inboundIngestUrl(req.params.id, reqOriginOf(req)) });
  }));

  app.delete('/v1/host/openwop-app/connections/:id/inbound', wrap(async (req, res) => {
    const existing = await getConnection(tenantOf(req), req.params.id);
    if (!existing) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId: req.params.id });
    await authorizeManage(req, existing);
    await removeInboundConfig(tenantOf(req), req.params.id);
    res.status(204).end();
  }));

  // ── Inbound provider webhooks: PUBLIC ingest (ADR 0024 §6) ──
  // NO auth, NO toggle gate (a provider can't carry either) — the provider HMAC
  // verified against the stored signing secret IS the credential. Distinct
  // prefix `connections-inbound` (allow-listed in auth.ts), keyed by connectionId.
  const startDeps = { storage: deps.storage, hostSuite: deps.hostSuite };
  // ADR 0394 Phase 4 — Meta Cloud API webhook SUBSCRIPTION verification: Meta
  // GETs the callback with hub.mode=subscribe&hub.verify_token&hub.challenge
  // and expects the raw challenge echoed when the token matches. The verify
  // token is the connection's inbound signing config's companion (we accept the
  // stored Meta app secret as the verify token — one secret to provision).
  // Only whatsapp-cloud connections answer; everything else 404s uniformly.
  app.get('/v1/host/openwop-app/connections-inbound/:connectionId', async (req: Request, res: import('express').Response) => {
    const config = await getInboundConfigForWebhook(req.params.connectionId);
    if (!config || !config.enabled || config.provider !== 'whatsapp-cloud') { sendError(res, 404, 'not_found', 'No such inbound webhook.'); return; }
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const secret = await resolveInboundSigningSecret(req.params.connectionId, config.tenantId);
    // Constant-time token compare — the verify token IS the stored app secret.
    const tokenMatches = typeof token === 'string' && secret !== null
      && token.length === secret.length
      && timingSafeEqual(Buffer.from(token), Buffer.from(secret));
    if (mode === 'subscribe' && tokenMatches && typeof challenge === 'string') {
      res.status(200).type('text/plain').send(challenge);
      return;
    }
    // Deliberately unspecific: a message distinguishing "wrong token" from
    // "wrong mode" would be a probe oracle on the stored app secret.
    sendError(res, 403, 'verification_failed', 'Webhook verification failed.');
  });
  app.post('/v1/host/openwop-app/connections-inbound/:connectionId', async (req: Request, res: import('express').Response) => {
    try {
      // The scoped `express.json({ verify })` parser populates rawBody for every
      // application/json POST on this path. If it's absent the HMAC can't be
      // verified over the exact bytes the provider signed — reject rather than
      // re-serialize (which could never match) and pretend to have a body.
      if (!req.rawBody) {
        sendError(res, 401, 'unauthorized', 'The raw request body is required to verify the webhook signature.');
        return;
      }
      // Pass every provider's signature/secret headers (ADR 0175); the handler picks
      // the ones its configured provider needs.
      const tsHeader = req.get('x-slack-request-timestamp');
      const sigHeader = req.get('x-slack-signature');
      const discordSig = req.get('x-signature-ed25519');
      const discordTs = req.get('x-signature-timestamp');
      const telegramToken = req.get('x-telegram-bot-api-secret-token');
      const twilioSig = req.get('x-twilio-signature'); // adr 0394 whatsapp-twilio
      const hubSig256 = req.get('x-hub-signature-256'); // adr 0394 whatsapp-cloud (meta)
      const streamSig = req.get('x-openwop-stream-signature'); // rfc0127 broker/CDC push
      const streamTs = req.get('x-openwop-stream-timestamp');
      const zoomSig = req.get('x-zm-signature'); // adr 0404 zoom-webinar
      const zoomTs = req.get('x-zm-request-timestamp');
      const outcome = await handleInboundEvent(startDeps, {
        connectionId: req.params.connectionId,
        rawBody: req.rawBody.toString('utf8'),
        body: (req.body ?? {}) as Record<string, unknown>,
        headers: {
          ...(tsHeader ? { timestamp: tsHeader } : {}),
          ...(sigHeader ? { signature: sigHeader } : {}),
          ...(discordSig ? { discordSignature: discordSig } : {}),
          ...(discordTs ? { discordTimestamp: discordTs } : {}),
          ...(telegramToken ? { telegramToken } : {}),
          ...(streamSig ? { streamSignature: streamSig } : {}),
          ...(streamTs ? { streamTimestamp: streamTs } : {}),
          ...(twilioSig ? { twilioSignature: twilioSig } : {}),
          ...(hubSig256 ? { signature256: hubSig256 } : {}),
          ...(zoomSig ? { zoomSignature: zoomSig } : {}),
          ...(zoomTs ? { zoomTimestamp: zoomTs } : {}),
        },
        now: Date.now(),
        // ADR 0394 — Twilio signs the full public delivery URL + params (not the
        // raw body); reconstructed from the sanitized public base (never the
        // client-influenceable Host header alone).
        requestUrl: `${publicBaseUrl(req)}${req.originalUrl}`,
      });
      switch (outcome.status) {
        case 'challenge':
          res.json({ challenge: outcome.challenge });
          return;
        case 'respond':
          // Provider handshake needing a JSON body (e.g. Discord PING → PONG).
          res.json(outcome.json);
          return;
        case 'accepted':
          res.status(202).json({ accepted: true, deduped: outcome.deduped });
          return;
        case 'ignored':
          res.status(202).json({ accepted: true });
          return;
        case 'rejected':
          // RFC 0127 — a verified push whose body failed normalization (e.g. an invalid
          // CDC `op`, over-cap body) — verified sender, unprocessable payload.
          // H27-b — `reason` was a NEW TOP-LEVEL key, which
          // `error-envelope.schema.json` forbids (`additionalProperties: false`).
          // It is contextual data, so it belongs under `details`.
          sendError(
            res,
            422,
            'rejected',
            'The push was verified but its payload could not be processed.',
            outcome.reason ? { reason: outcome.reason } : undefined,
          );
          return;
        case 'unauthorized':
          sendError(res, 401, 'unauthorized', 'Webhook signature verification failed.');
          return;
        case 'not_found':
        default:
          sendError(res, 404, 'not_found', 'No such inbound webhook.');
          return;
      }
    } catch (err) {
      log.error('inbound webhook handler error', { error: err instanceof Error ? err.message : String(err) });
      sendError(res, 500, 'internal_error', 'An unexpected error occurred.');
    }
  });
}
