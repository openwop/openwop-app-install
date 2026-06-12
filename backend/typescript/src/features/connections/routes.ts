/**
 * Connections feature routes (host-extension, sample-grade — ADR 0024).
 *
 * Surface under /v1/host/sample/{connections,providers}. Always-on: Connections
 * graduated off its feature toggle to a permanent admin surface (ADR 0024
 * § Correction, 2026-06-11). Phase A: the provider registry + the
 * api_key/bearer create path + list/revoke + the resolver. Phase B (this commit):
 * the OAuth2 PKCE consent round-trip (authorize → consent URL; callback → code
 * exchange → KMS-enveloped token store), on-demand + warm refresh, and the
 * `/test` health probe.
 *
 * Secrets are NEVER returned on any response — only connection metadata + status.
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { createLogger } from '../../observability/logger.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { isProviderAllowed } from '../../host/governanceService.js';
import { requireSuperadmin } from '../../host/superadmin.js';
import { listProviders, getProvider, type CredentialKind } from './providerRegistry.js';
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
  writeScopesOf,
  inboundIngestUrl,
} from './oauthFlow.js';
import {
  setInboundConfig,
  getInboundConfig,
  removeInboundConfig,
  handleInboundEvent,
  inboundSupported,
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
  app.get('/v1/host/sample/providers', wrap(async (_req, res) => {
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
  app.get('/v1/host/sample/providers/:id', wrap(async (req, res) => {
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
  app.get('/v1/host/sample/connections-oauth-clients', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'OAuth client configuration');
      res.json({ clients: await listHostOAuthClients() });
    } catch (err) {
      next(err);
    }
  });

  app.put('/v1/host/sample/connections-oauth-clients/:provider', async (req, res, next) => {
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

  app.delete('/v1/host/sample/connections-oauth-clients/:provider', async (req, res, next) => {
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
  app.get('/v1/host/sample/connections', wrap(async (req, res) => {
    res.json({ connections: await listConnections(tenantOf(req), actingUserOf(req)) });
  }));

  app.post('/v1/host/sample/connections', wrap(async (req, res) => {
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
  app.post('/v1/host/sample/connections/:provider/authorize', wrap(async (req, res) => {
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

  // callback: the provider's browser redirect. Identity comes from the single-use
  // server-stored `state` (NOT the session) — so we drive it ourselves and bounce
  // the browser back to the SPA on both success and failure, never a JSON 4xx.
  app.get('/v1/host/sample/connections/:provider/callback', async (req: Request, res: import('express').Response) => {
    const provider = req.params.provider;
    const origin = reqOriginOf(req);
    const fail = (returnTo: string, reason: string): void => {
      res.redirect(appReturnUrl(origin, returnTo, { connectError: provider, reason }));
    };
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    let returnTo = '/connections';
    try {
      // Provider-side consent error (user declined / invalid scope, etc.).
      if (typeof req.query.error === 'string' && req.query.error) {
        const pendingErr = state ? await consumePendingAuth(state) : null;
        return fail(pendingErr?.returnTo ?? returnTo, 'consent_denied');
      }
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!state || !code) return fail(returnTo, 'missing_params');

      const pending = await consumePendingAuth(state); // single-use
      if (!pending || pending.provider !== provider) return fail(returnTo, 'invalid_state');
      returnTo = pending.returnTo;

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
      return res.redirect(appReturnUrl(origin, returnTo, { connected: provider }));
    } catch (err) {
      log.warn('oauth callback failed', { provider, error: err instanceof Error ? err.message : String(err) });
      return fail(returnTo, 'exchange_failed');
    }
  });

  // test: health-probe a connection's credential (refreshes oauth2 on the way).
  app.post('/v1/host/sample/connections/:id/test', wrap(async (req, res) => {
    const existing = await getConnection(tenantOf(req), req.params.id);
    if (!existing) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId: req.params.id });
    await authorizeManage(req, existing);
    const result = await probeConnection(tenantOf(req), req.params.id);
    res.json(result ?? { ok: false, status: 'revoked' });
  }));

  app.delete('/v1/host/sample/connections/:id', wrap(async (req, res) => {
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
  app.get('/v1/host/sample/connections/:id/inbound', wrap(async (req, res) => {
    const existing = await getConnection(tenantOf(req), req.params.id);
    if (!existing) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId: req.params.id });
    await authorizeManage(req, existing);
    const config = await getInboundConfig(tenantOf(req), req.params.id);
    res.json({ config, ingestUrl: inboundIngestUrl(req.params.id, reqOriginOf(req)) }); // never the signing secret
  }));

  app.put('/v1/host/sample/connections/:id/inbound', wrap(async (req, res) => {
    const existing = await getConnection(tenantOf(req), req.params.id);
    if (!existing) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId: req.params.id });
    await authorizeManage(req, existing);
    if (!inboundSupported(existing.provider)) {
      throw new OpenwopError('validation_error', `Inbound webhooks are not supported for '${existing.provider}'.`, 400, { provider: existing.provider });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const config = await setInboundConfig({
      tenantId: tenantOf(req),
      connectionId: req.params.id,
      provider: existing.provider,
      workflowId: requireString(body.workflowId, 'workflowId'),
      signingSecret: requireString(body.signingSecret, 'signingSecret'),
    });
    res.status(201).json({ config, ingestUrl: inboundIngestUrl(req.params.id, reqOriginOf(req)) });
  }));

  app.delete('/v1/host/sample/connections/:id/inbound', wrap(async (req, res) => {
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
  app.post('/v1/host/sample/connections-inbound/:connectionId', async (req: Request, res: import('express').Response) => {
    try {
      // The scoped `express.json({ verify })` parser populates rawBody for every
      // application/json POST on this path. If it's absent the HMAC can't be
      // verified over the exact bytes the provider signed — reject rather than
      // re-serialize (which could never match) and pretend to have a body.
      if (!req.rawBody) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const tsHeader = req.get('x-slack-request-timestamp');
      const sigHeader = req.get('x-slack-signature');
      const outcome = await handleInboundEvent(startDeps, {
        connectionId: req.params.connectionId,
        rawBody: req.rawBody.toString('utf8'),
        body: (req.body ?? {}) as Record<string, unknown>,
        headers: {
          ...(tsHeader ? { timestamp: tsHeader } : {}),
          ...(sigHeader ? { signature: sigHeader } : {}),
        },
        now: Date.now(),
      });
      switch (outcome.status) {
        case 'challenge':
          res.json({ challenge: outcome.challenge });
          return;
        case 'accepted':
          res.status(202).json({ accepted: true, deduped: outcome.deduped });
          return;
        case 'ignored':
          res.status(202).json({ accepted: true });
          return;
        case 'unauthorized':
          res.status(401).json({ error: 'unauthorized' });
          return;
        case 'not_found':
        default:
          res.status(404).json({ error: 'not_found' });
          return;
      }
    } catch (err) {
      log.error('inbound webhook handler error', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'internal_error' });
    }
  });
}
