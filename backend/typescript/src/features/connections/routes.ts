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

import { getProject, resolveProjectAccess } from '../projects/projectsService.js';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveAndResume } from '../../routes/interrupts.js';
import { vendorPath } from '../../middleware/protocolVersion.js';
import { createLogger } from '../../observability/logger.js';
import { resolveEffectiveAccess, getOrg } from '../../host/accessControlService.js';
import { isProviderAllowed } from '../../host/governanceService.js';
import { requireSuperadmin } from '../../host/superadmin.js';
import { publicBaseUrl, requireTenantWrite, callerSubjectSpellings } from '../featureRoute.js';
import { isOwnPersonalWorkspace } from '../../host/requestSubject.js';
import { credentialAuthority, keyDeclarationPermits, requireProtocolScope, tenantOwnerScopes } from '../../host/protocolAuthorization.js';
import { providerRegistryPage, resolveProviderRow } from './providerRegistryRead.js';
import { resolveLaunchWorkflow } from '../../host/resolveLaunchDefinition.js';
import { validateDataSourceBaseUrl } from '../../host/dataSourceUrl.js';
import { isAuthoredByOtherTenant } from '../../host/workflowOwnership.js';
import { getUser } from '../users/usersService.js';
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
  setConnectionDataSource,
  createSecretConnection,
  upsertOAuthConnection,
  revokeConnection,
  probeConnection,
  type ConnectionScope,
  type Connection,
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

/**
 * ADR 0780 D2 — every spelling of the ONE human making this request: the
 * request's own (canonical after the OIDC bind, `middleware/auth.ts:1091`), the
 * other half of `callerSubjectSpellings`, and — for a `user:` spelling, IN ITS
 * HOME TENANT ONLY — its durable User row's `principalId`. Rows keep the spelling
 * their writer carried, so a connection made before the bind is keyed
 * `oidc:<sub>` while its owner now presents `user:<id>`.
 *
 * CORRECTED (ADR 0780 D2 correction): this first added the principal in ANY
 * tenant. Principal ids are not issuer-qualified, so in a shared workspace the
 * same `scim:jsmith` string can be that workspace's OWN, different jsmith — the
 * widening let one person list and revoke another's credential. Shared-workspace
 * legacy rows stay out of reach (`CONNWF-5e`).
 */
async function callerOwnerIds(req: Request): Promise<ReadonlySet<string>> {
  const tenantId = tenantOf(req);
  const ids = new Set(await callerSubjectSpellings(req));
  const own = actingUserOf(req);
  if (own) ids.add(own);
  for (const id of [...ids]) {
    if (!id.startsWith('user:')) continue;
    const u = await getUser(id).catch(() => null);
    if (u && u.tenantId === tenantId && u.principalId) ids.add(u.principalId);
  }
  return ids;
}

/**
 * The caller's connections as `GET /connections` lists them — the ONE reader that
 * route and the Access hub summary share (ADR 0864 D2), so the summary can never
 * count a row the list would not show.
 */
export async function listCallerConnections(req: Request): Promise<Connection[]> {
  return listConnections(tenantOf(req), await callerOwnerIds(req));
}

/**
 * Require `host:connections:manage` on `orgId` (ADR 0024 D2) — the admin gate
 * for an ORG-shared row and (ADR 0780 D1) a WORKSPACE row, judged at the
 * workspace-root org (`orgId === tenantId`). Read by PROVENANCE, never by the id
 * string (ADR 0601 C4): it used to resolve `actingUserOf` alone, which refused
 * the env-key operator (its `bearer:<8>` id is no member) and a workspace owner
 * whose member row is keyed by the other spelling. Deliberately at the ORG, not
 * the tenant-wide union: a sub-org admin is not a workspace-root admin.
 */
async function requireConnectionsManage(req: Request, orgId: string): Promise<void> {
  const scope = 'host:connections:manage';
  const tenantId = tenantOf(req);
  const refuse = (): never => {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope, orgId });
  };
  // An org from another tenant (or none at all) is nobody's to bind here — not
  // even the operator's. The workspace-root org is the tenant itself.
  if (orgId !== tenantId && (await getOrg(orgId))?.tenantId !== tenantId) return refuse();
  if (req.principal?.tenants?.includes('*') === true) return; // wildcard operator
  if (isOwnPersonalWorkspace(req) && orgId === tenantId) return; // the implicit owner of their own workspace
  let subjects: Iterable<string>;
  if (req.principal) {
    const authority = credentialAuthority(req.principal, actingUserOf(req));
    if (authority.source === 'tenant-owner') {
      if ((await tenantOwnerScopes(tenantId)).includes(scope)) return;
      return refuse();
    }
    if (authority.declaredScopes && !keyDeclarationPermits(authority.declaredScopes, scope)) return refuse();
    subjects = req.principal.auth?.kind === 'api-key' ? (authority.subject ? [authority.subject] : []) : await callerOwnerIds(req);
  } else {
    subjects = await callerOwnerIds(req);
  }
  for (const subject of subjects) {
    const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
    if (access.scopes.includes(scope)) return;
  }
  return refuse();
}

/**
 * Fail-closed authorization for mutating/probing one connection (ADR 0024 D2).
 *   - ORG-shared → admin-gated on `host:connections:manage` for that org.
 *   - USER → owner-only, by any of the owner's spellings (ADR 0780 D2).
 *   - WORKSPACE default → admin-gated at the workspace-root org (ADR 0780 D1).
 *     It used to fall through ("no API create path" — false: `scope:'workspace'`
 *     created one), so any member could delete, probe or re-wire it.
 */
async function authorizeManage(req: Request, connection: { userId?: string; orgId?: string; connectionId: string }): Promise<void> {
  if (connection.orgId) {
    await requireConnectionsManage(req, connection.orgId);
    return;
  }
  if (connection.userId) {
    if (!(await callerOwnerIds(req)).has(connection.userId)) {
      throw new OpenwopError('forbidden', 'Only the connecting user may manage this connection.', 403, { connectionId: connection.connectionId });
    }
    return;
  }
  await requireConnectionsManage(req, tenantOf(req));
}

const SCOPE_AXES: ReadonlySet<string> = new Set<ConnectionScope>(['user', 'org', 'workspace']);

/** ADR 0780 D1 — a signing secret is the HMAC key (and whatsapp-cloud's verify
 *  token), so a guessable one is a forged-delivery hole. Every supported provider
 *  issues ≥16 characters. */
const MIN_SIGNING_SECRET_LENGTH = 16;

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OpenwopError('validation_error', `Field \`${field}\` is required and MUST be a non-empty string.`, 400, { field });
  }
  return value;
}

export function registerConnectionsRoutes(deps: RouteDeps): void {
  const { app } = deps;

  // RFC 0233 — the connection-provider registry reads, MAJOR-2 ONLY (v1 resolves
  // a collision by version precedence and has no such operation, so under major
  // 1 these are 404 rather than a new v1 surface on the twin). Host-global and
  // content-free; `manifest:read`, and an unauthenticated caller is refused 401
  // by the auth layer before this runs.
  app.get('/connection-providers', async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'manifest:read');
      res.json(providerRegistryPage());
    } catch (err) { next(err); }
  });
  app.get('/connection-providers/:providerId', async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'manifest:read');
      const pack = typeof req.query.pack === 'string' && req.query.pack.length > 0 ? req.query.pack : undefined;
      const row = resolveProviderRow(String(req.params.providerId), pack);
      if (!row) throw new OpenwopError('connection_provider_unresolved', 'No provider definition matches this reference.', 404);
      res.json(row);
    } catch (err) { next(err); }
  });
  const wrap = (h: (req: Request, res: import('express').Response) => Promise<void>) =>
    async (req: Request, res: import('express').Response, next: import('express').NextFunction) => {
      try {
        await h(req, res);
      } catch (err) {
        next(err);
      }
    };

  // ── Provider registry (the catalog — adding an integration is a manifest) ──
  app.get('/host/openwop-app/providers', wrap(async (_req, res) => {
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
  app.get('/host/openwop-app/providers/:id', wrap(async (req, res) => {
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
  app.get('/host/openwop-app/connections-oauth-clients', async (req, res, next) => {
    try {
      requireSuperadmin(req, 'OAuth client configuration');
      res.json({ clients: await listHostOAuthClients() });
    } catch (err) {
      next(err);
    }
  });

  app.put('/host/openwop-app/connections-oauth-clients/:provider', async (req, res, next) => {
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

  app.delete('/host/openwop-app/connections-oauth-clients/:provider', async (req, res, next) => {
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
  app.get('/host/openwop-app/connections', wrap(async (req, res) => {
    res.json({ connections: await listCallerConnections(req) });
  }));

  app.post('/host/openwop-app/connections', wrap(async (req, res) => {
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

    // ADR 0780 D1 — the scope axis is a CLOSED set. It was read unvalidated, so
    // `workspace` (or any unknown string, which set neither `userId` nor `orgId`)
    // minted a WORKSPACE credential with no authority check — the fallback the
    // broker hands every member without a personal row and every actorless run.
    const rawScope = body.scope === undefined ? 'user' : body.scope;
    if (typeof rawScope !== 'string' || !SCOPE_AXES.has(rawScope)) {
      throw new OpenwopError('validation_error', '`scope` MUST be one of user | org | workspace.', 400, { field: 'scope' });
    }
    const scope = rawScope as ConnectionScope;
    await requireTenantWrite(req);
    // D2 (Phase C): an org-shared connection is ADMIN-managed. Creating one now
    // requires `host:connections:manage` on the target org (default: the
    // workspace-root org, orgId === tenantId), checked fail-closed below. These
    // are S2S credentials (api_key/bearer) — an OAuth org *service identity* is a
    // later step (D2 tripwire: per-user attribution needs per-user connections).
    // ADR 0780 D1 — a WORKSPACE row is admin-managed the same way, at the root org.
    let orgId: string | undefined;
    if (scope === 'org') {
      orgId = typeof body.orgId === 'string' && body.orgId.trim() ? body.orgId.trim() : tenantOf(req);
      await requireConnectionsManage(req, orgId);
    } else if (scope === 'workspace') {
      await requireConnectionsManage(req, tenantOf(req));
    } else if (!actingUserOf(req)) {
      // A user row with no user fell through to a WORKSPACE row.
      throw new OpenwopError('unauthenticated', 'Sign in to connect an account.', 401);
    }

    const connection = await createSecretConnection({
      tenantId: tenantOf(req),
      provider,
      kind,
      secret: requireString(body.secret, 'secret'),
      scope,
      ...(scope === 'user' ? { userId: actingUserOf(req)! } : {}),
      ...(scope === 'org' && orgId ? { orgId } : {}),
      ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
      ...(Array.isArray(body.scopes) ? { scopes: (body.scopes as unknown[]).filter((s): s is string => typeof s === 'string') } : {}),
    });
    res.status(201).json(connection); // metadata only — no secret
  }));

  // ── OAuth2 PKCE consent (ADR 0024 Phase B §3) ──
  // authorize: mint a consent URL bound to (tenant, user) with PKCE + state.
  app.post('/host/openwop-app/connections/:provider/authorize', wrap(async (req, res) => {
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
    // ADR 0780 D1 — binding a credential is a workspace write, and the grant is
    // always the caller's own: without a subject the callback used to land a
    // WORKSPACE row.
    const subject = actingUserOf(req);
    if (!subject) throw new OpenwopError('unauthenticated', 'Sign in to connect an account.', 401);
    await requireTenantWrite(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { authorizeUrl } = await beginAuthorization({
      provider,
      tenantId: tenantOf(req),
      reqOrigin: reqOriginOf(req),
      userId: subject,
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
  app.get(vendorPath('/connections/connect/:runId/:nodeId'), wrap(async (req, res) => {
    const subject = actingUserOf(req);
    if (!subject) throw new OpenwopError('unauthenticated', 'Sign in to authorize this connection.', 401);
    const run = await deps.storage.getRun(req.params.runId);
    const owner = typeof (run?.metadata as Record<string, unknown> | undefined)?.actingUserId === 'string'
      ? ((run!.metadata as Record<string, unknown>).actingUserId as string)
      : undefined;
    // One refusal for "not your run" and "no such run": existence is not leaked.
    // ADR 0780 D2 — the run's stamp may be the legacy `oidc:` spelling of the
    // caller (#4215 found exactly those on loop runs), so compare against every
    // spelling of the caller, never the canonical one alone.
    if (!run || run.tenantId !== tenantOf(req) || owner === undefined || !(await callerOwnerIds(req)).has(owner)) {
      throw new OpenwopError('forbidden', 'Only the user who started this run can authorize it.', 403);
    }
    const interrupt = await deps.storage.getInterruptByNode(run.runId, req.params.nodeId);
    if (!interrupt || interrupt.kind !== 'credential' || interrupt.resolvedAt) {
      throw new OpenwopError('not_found', 'No open authorization request for this step.', 404);
    }
    const data = (interrupt.data ?? {}) as { provider?: unknown; scopes?: unknown };
    if (typeof data.provider !== 'string') throw new OpenwopError('not_found', 'No open authorization request for this step.', 404);
    // ADR 0780 D2 — the grant is bound under the RUN's recorded spelling: the
    // resolve-time re-check reads `run.metadata.actingUserId`
    // (`routes/interrupts.ts` `assertCredentialAuthorizedResolves`), and a grant
    // stored under the caller's canonical spelling would never satisfy a
    // legacy-stamped run in a shared workspace — the interrupt would never resolve.
    const { authorizeUrl } = await beginAuthorization({
      provider: data.provider,
      tenantId: run.tenantId,
      userId: owner,
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
  app.get('/host/openwop-app/connections/:provider/callback', async (req: Request, res: import('express').Response) => {
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
      // ADR 0780 D2 — "differs" means a different HUMAN: the `connect` lane binds
      // the grant under the run's recorded spelling, which may be the caller's
      // legacy one. Any other human is still refused.
      const callbackSubject = actingUserOf(req);
      if (callbackSubject && (pending.userId === undefined || !(await callerOwnerIds(req)).has(pending.userId))) {
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
        ...(pending.redirectUri ? { redirectUri: pending.redirectUri } : {}),
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
  app.post('/host/openwop-app/connections/:id/test', wrap(async (req, res) => {
    const existing = await getConnection(tenantOf(req), req.params.id);
    if (!existing) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId: req.params.id });
    await authorizeManage(req, existing);
    const result = await probeConnection(tenantOf(req), req.params.id);
    res.json(result ?? { ok: false, status: 'revoked' });
  }));

  app.delete('/host/openwop-app/connections/:id', wrap(async (req, res) => {
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
  app.get('/host/openwop-app/connections/:id/inbound', wrap(async (req, res) => {
    const existing = await getConnection(tenantOf(req), req.params.id);
    if (!existing) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId: req.params.id });
    await authorizeManage(req, existing);
    const config = await getInboundConfig(tenantOf(req), req.params.id);
    res.json({ config, ingestUrl: inboundIngestUrl(req.params.id, reqOriginOf(req)) }); // never the signing secret
  }));

  app.put('/host/openwop-app/connections/:id/inbound', wrap(async (req, res) => {
    const existing = await getConnection(tenantOf(req), req.params.id);
    if (!existing) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId: req.params.id });
    await authorizeManage(req, existing);
    // ADR 0780 D1 — wiring a public ingest that starts workflows is a workspace
    // write; owning the connection is not enough for a Viewer.
    await requireTenantWrite(req);
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
    const signingSecret = requireString(body.signingSecret, 'signingSecret');
    if (signingSecret.length < MIN_SIGNING_SECRET_LENGTH) {
      throw new OpenwopError('validation_error', `\`signingSecret\` MUST be at least ${MIN_SIGNING_SECRET_LENGTH} characters.`, 400, { field: 'signingSecret' });
    }
    let workflowId: string | undefined;
    if (!observerOnly) {
      workflowId = requireString(body.workflowId, 'workflowId');
      // ADR 0780 D5 — the target must be a workflow THIS workspace may run. An
      // unknown id was accepted and every delivery became a silent `nofire:`; the
      // catalog is host-global, so existence alone also admitted another
      // workspace's workflow. One refusal for both (no existence leak).
      const runnable = (await resolveLaunchWorkflow(deps.hostSuite.workflowCatalog, tenantOf(req), workflowId, { launch: 'published' })) !== null
        && !(await isAuthoredByOtherTenant(tenantOf(req), workflowId));
      if (!runnable) {
        throw new OpenwopError('validation_error', `Workflow '${workflowId}' was not found in this workspace.`, 400, { field: 'workflowId' });
      }
    }
    // ADR 0853 D4 — an optional project for `decision:` messages: the caller must
    // be able to edit it (a project they cannot see is the same 400, no oracle).
    let projectId: string | undefined;
    if (body.projectId !== undefined && body.projectId !== null && body.projectId !== '') {
      const pid = typeof body.projectId === 'string' ? body.projectId.trim() : '';
      const project = pid ? await getProject(tenantOf(req), pid) : null;
      if (!project || (await resolveProjectAccess(tenantOf(req), project.id, req.userId ?? req.principal?.principalId)) !== 'write') {
        throw new OpenwopError('validation_error', 'Choose a project you can edit.', 400, { field: 'projectId' });
      }
      projectId = project.id;
    }
    const config = await setInboundConfig({
      tenantId: tenantOf(req),
      connectionId: req.params.id,
      provider: existing.provider,
      ...(workflowId !== undefined ? { workflowId } : {}),
      ...(projectId ? { projectId } : {}),
      signingSecret,
      ...(isStreamInbound(existing.provider) && streamSource ? { streamSource } : {}),
    });
    res.status(201).json({ config, ingestUrl: inboundIngestUrl(req.params.id, reqOriginOf(req)) });
  }));

  app.delete('/host/openwop-app/connections/:id/inbound', wrap(async (req, res) => {
    const existing = await getConnection(tenantOf(req), req.params.id);
    if (!existing) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId: req.params.id });
    await authorizeManage(req, existing);
    await removeInboundConfig(tenantOf(req), req.params.id);
    res.status(204).end();
  }));

  // ── Data source (ADR 0783 D1) ──
  // A connection's base URL for `ctx.dataIntegration.fetchRest`/`fetchGraphql`.
  // The same gates as the inbound config: manage the connection AND hold a
  // workspace write (a data source is what workflows in this workspace call).
  // Validated against the provider's `apiHosts` here, and again on every call.
  app.get('/host/openwop-app/connections/:id/data-source', wrap(async (req, res) => {
    const existing = await getConnection(tenantOf(req), req.params.id);
    if (!existing) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId: req.params.id });
    await authorizeManage(req, existing);
    res.json({ dataSource: existing.dataSource ?? null });
  }));

  app.put('/host/openwop-app/connections/:id/data-source', wrap(async (req, res) => {
    const existing = await getConnection(tenantOf(req), req.params.id);
    if (!existing) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId: req.params.id });
    await authorizeManage(req, existing);
    await requireTenantWrite(req);
    let baseUrl: string;
    try {
      baseUrl = validateDataSourceBaseUrl((req.body ?? {}).baseUrl, getProvider(existing.provider)?.apiHosts);
    } catch (err) {
      throw new OpenwopError('validation_error', (err as Error).message, 400, { field: 'baseUrl' });
    }
    const saved = await setConnectionDataSource(tenantOf(req), req.params.id, baseUrl);
    if (!saved) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId: req.params.id });
    res.json({ dataSource: saved.dataSource });
  }));

  app.delete('/host/openwop-app/connections/:id/data-source', wrap(async (req, res) => {
    const existing = await getConnection(tenantOf(req), req.params.id);
    if (!existing) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId: req.params.id });
    await authorizeManage(req, existing);
    await requireTenantWrite(req);
    await setConnectionDataSource(tenantOf(req), req.params.id, null);
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
  app.get('/host/openwop-app/connections-inbound/:connectionId', async (req: Request, res: import('express').Response) => {
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
  app.post('/host/openwop-app/connections-inbound/:connectionId', async (req: Request, res: import('express').Response) => {
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
