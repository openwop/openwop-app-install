/**
 * OAuth2 PKCE consent flow (ADR 0024 Phase B / §3). Drives the consent
 * round-trip for `kind:'oauth2'` providers (Google, Slack):
 *
 *   authorize → builds a consent URL bound to (tenantId, userId|orgId) with a
 *               single-use, server-stored `state` + a PKCE `code_verifier`.
 *   callback  → verifies `state`, exchanges `code`→tokens at the provider's
 *               token endpoint, and hands the token material back to the
 *               connections store (KMS-enveloped at rest, never returned).
 *
 * SECURITY POSTURE
 *   - The OAuth CLIENT secret is host-side only — sealed at rest in the
 *     `oauthClientStore` (UI-managed, ADR 0024 § host-managed OAuth client
 *     config) or read from a Cloud Run env var — never sent to the browser,
 *     never stored per-connection.
 *   - `state` is a random 256-bit id; the verifier + scoping live ONLY in the
 *     server-side pending-auth store (a DurableCollection, so the callback can
 *     land on a different Cloud Run instance than `authorize`). Single-use:
 *     consumed (deleted) on the first callback, TTL-expired otherwise.
 *   - Token endpoints are the FIXED, host-controlled URLs from the built-in
 *     manifest — not user-supplied — so the exchange has no SSRF surface. We
 *     still hard-require https.
 */

import { createHash, randomBytes } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import { getProvider, type ProviderManifest } from './providerRegistry.js';
import { getHostOAuthClient } from './oauthClientStore.js';

const log = createLogger('connections.oauth');

/** A pending consent round-trip, stored server-side between authorize + callback. */
interface PendingAuth {
  state: string;
  provider: string;
  tenantId: string;
  userId?: string;
  scopes: string[];
  codeVerifier: string;
  /** Where to bounce the browser after the callback completes (SPA route). */
  returnTo: string;
  createdAt: string;
}

const pending = new DurableCollection<PendingAuth>('connections:pendingAuth', (p) => p.state);

/** Pending-auth TTL — a consent round-trip that takes longer than this is stale. */
const PENDING_TTL_MS = 10 * 60_000;

/** Hard ceiling on a token-endpoint request, so a hung provider can't stall the
 *  callback browser navigation or block node execution during a refresh. */
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

/** Token material we persist (KMS-enveloped) per oauth2 connection. The access
 *  token is short-lived; the refresh token is the durable credential. */
export interface OAuthTokenMaterial {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  /** Absolute expiry of `accessToken` (ISO); absent when the provider omits expires_in. */
  expiresAt?: string;
  /** The provider-side subject/account the consent was granted by, when known. */
  externalSubject?: string;
  scopes: string[];
}

const base64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ── OAuth client credentials (host-side; Cloud Run secrets via env) ──────────

interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** Read a provider's OAuth client credentials. Resolution order (ADR 0024
 *  § host-managed OAuth client config):
 *    1. the UI-configured host client (sealed at rest in `oauthClientStore`),
 *    2. else the `OPENWOP_OAUTH_<PROVIDER>_CLIENT_ID` / `…_CLIENT_SECRET` env vars.
 *  Returns null when neither is set — the host then honestly cannot offer OAuth
 *  connect for that provider (ADR 0024 RFC-gate honesty rule). The store read
 *  fails closed (a decrypt error reads as absent), so we fall through to env. */
export async function oauthClient(provider: string): Promise<OAuthClient | null> {
  const stored = await getHostOAuthClient(provider);
  if (stored) return stored;
  const key = provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const clientId = process.env[`OPENWOP_OAUTH_${key}_CLIENT_ID`];
  const clientSecret = process.env[`OPENWOP_OAUTH_${key}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** True when this host is configured to run OAuth consent for the provider — it
 *  is an oauth2/pkce provider AND its client credentials are present (via the
 *  UI-managed store or env). Drives the `oauthConfigured` honesty flag the UI
 *  uses to enable the Connect button. */
export async function isOAuthConfigured(provider: string): Promise<boolean> {
  const m = getProvider(provider);
  if (!m || m.kind !== 'oauth2' || m.authFlow !== 'pkce') return false;
  return (await oauthClient(provider)) !== null;
}

const stripTrailingSlash = (u: string): string => u.replace(/\/+$/, '');

/** The app (SPA) origin we bounce the browser back to after the callback. Prefer
 *  `OPENWOP_PUBLIC_BASE_URL` (e.g. https://app.openwop.dev); fall back to the
 *  request's own origin for local dev where the backend serves the SPA directly. */
export function appBaseUrl(reqOrigin: string): string {
  const env = process.env.OPENWOP_PUBLIC_BASE_URL;
  return stripTrailingSlash(env && env.trim() ? env.trim() : reqOrigin);
}

/** The backend base the BROWSER can reach for the OAuth callback. In production
 *  the SPA reaches the API through a `/api` rewrite, so the callback the provider
 *  redirects to is NOT the same origin as the run.app backend — set
 *  `OPENWOP_OAUTH_CALLBACK_BASE_URL` to the browser-reachable backend base
 *  (e.g. https://app.openwop.dev/api). Falls back to the app origin, then the
 *  request origin (local dev, where backend === app origin). This MUST match the
 *  redirect URI registered with the provider. */
export function callbackBaseUrl(reqOrigin: string): string {
  const explicit = process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL;
  if (explicit && explicit.trim()) return stripTrailingSlash(explicit.trim());
  return appBaseUrl(reqOrigin);
}

/** The public URL a provider posts inbound events to for a connection (ADR 0024
 *  §6). Same browser/provider-reachable backend base as the OAuth callback. */
export function inboundIngestUrl(connectionId: string, reqOrigin: string): string {
  return `${callbackBaseUrl(reqOrigin)}/v1/host/openwop-app/connections-inbound/${encodeURIComponent(connectionId)}`;
}

export function redirectUri(provider: string, reqOrigin: string): string {
  return `${callbackBaseUrl(reqOrigin)}/v1/host/openwop-app/connections/${encodeURIComponent(provider)}/callback`;
}

/** Build the post-callback SPA redirect (success or error), preserving the
 *  same-origin relative `returnTo` from the authorize step. */
export function appReturnUrl(reqOrigin: string, returnTo: string, params: Record<string, string>): string {
  const url = new URL(`${appBaseUrl(reqOrigin)}${returnTo.startsWith('/') ? returnTo : `/${returnTo}`}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function assertHttps(url: string, label: string): void {
  if (!/^https:\/\//i.test(url)) {
    throw Object.assign(new Error(`${label} MUST be https`), { code: 'insecure_endpoint' });
  }
}

/** Flatten a provider's WRITE scope groups into the scope strings a write
 *  re-consent must request (ADR 0024 §3 — write is a separate consent step). */
export function writeScopesOf(provider: string): string[] {
  const manifest = getProvider(provider);
  return [...new Set((manifest?.scopes.write ?? []).flatMap((g) => g.scopes))];
}

// ── authorize ────────────────────────────────────────────────────────────────

/**
 * Mint a consent URL (ADR 0024 §3, read-scopes-first). Stores the PKCE verifier
 * + scoping under a single-use `state`. Returns the URL the browser navigates to.
 */
export async function beginAuthorization(input: {
  provider: string;
  tenantId: string;
  userId?: string;
  scopes?: string[];
  /** Phase C re-consent: also request the provider's WRITE scope groups on top
   *  of the read defaults (a separate, explicit consent — ADR 0024 §3). */
  includeWrite?: boolean;
  reqOrigin: string;
  returnTo?: string;
}): Promise<{ authorizeUrl: string; state: string }> {
  const manifest = getProvider(input.provider);
  if (!manifest) throw Object.assign(new Error(`unknown provider '${input.provider}'`), { code: 'unknown_provider' });
  if (manifest.kind !== 'oauth2' || manifest.authFlow !== 'pkce') {
    throw Object.assign(new Error(`provider '${input.provider}' is not an oauth2/pkce provider`), { code: 'not_oauth2' });
  }
  const client = await oauthClient(input.provider);
  if (!client) {
    throw Object.assign(new Error(`OAuth is not configured for '${input.provider}' on this host`), { code: 'oauth_not_configured' });
  }
  const authorizeEndpoint = manifest.endpoints?.authorize;
  if (!authorizeEndpoint) throw Object.assign(new Error(`provider '${input.provider}' has no authorize endpoint`), { code: 'no_authorize_endpoint' });
  assertHttps(authorizeEndpoint, 'authorize endpoint');

  // Read scopes first; a write re-consent adds the WRITE groups on top of the
  // read defaults so the upgraded grant still covers reads (ADR 0024 §3).
  const baseScopes = input.scopes && input.scopes.length > 0 ? input.scopes : manifest.defaultScopes;
  const scopes = input.includeWrite ? [...new Set([...baseScopes, ...writeScopesOf(input.provider)])] : baseScopes;

  const state = base64url(randomBytes(32));
  const codeVerifier = base64url(randomBytes(64));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());

  await pending.put({
    state,
    provider: input.provider,
    tenantId: input.tenantId,
    scopes,
    codeVerifier,
    returnTo: sanitizeReturnTo(input.returnTo),
    createdAt: new Date().toISOString(),
    ...(input.userId ? { userId: input.userId } : {}),
  });

  const url = new URL(authorizeEndpoint);
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', redirectUri(input.provider, input.reqOrigin));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Google needs these to actually return a refresh_token on re-consent.
  if (manifest.refreshable) {
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
  }
  return { authorizeUrl: url.toString(), state };
}

/** Only allow same-origin relative return paths — never an open redirect. */
function sanitizeReturnTo(raw: string | undefined): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '/connections';
  return raw;
}

// ── callback ─────────────────────────────────────────────────────────────────

/** Consume a pending-auth by `state` (single-use). Returns null if absent,
 *  expired, or already consumed. */
export async function consumePendingAuth(state: string, now: number = Date.now()): Promise<PendingAuth | null> {
  const p = await pending.get(state);
  if (!p) return null;
  await pending.delete(state); // single-use — consume regardless of validity below
  if (now - new Date(p.createdAt).getTime() > PENDING_TTL_MS) {
    log.warn('oauth state expired', { provider: p.provider, state });
    return null;
  }
  return p;
}

/**
 * GC abandoned pending-auths. `consumePendingAuth` deletes a row when the
 * callback lands, but a consent the user never completes (closes the tab at the
 * provider) would otherwise leave its row in kv forever. The refresh daemon
 * calls this each tick to keep the store bounded. Returns the count swept.
 */
export async function sweepExpiredPendingAuth(now: number = Date.now()): Promise<number> {
  const stale = (await pending.list()).filter((p) => now - new Date(p.createdAt).getTime() > PENDING_TTL_MS);
  let swept = 0;
  for (const p of stale) {
    if (await pending.delete(p.state)) swept++;
  }
  return swept;
}

/** Exchange an authorization code for tokens at the provider's token endpoint. */
export async function exchangeCodeForTokens(input: {
  provider: string;
  code: string;
  codeVerifier: string;
  scopes: string[];
  reqOrigin: string;
}): Promise<OAuthTokenMaterial> {
  const manifest = getProvider(input.provider);
  if (!manifest) throw Object.assign(new Error(`unknown provider '${input.provider}'`), { code: 'unknown_provider' });
  const client = await oauthClient(input.provider);
  if (!client) throw Object.assign(new Error('oauth_not_configured'), { code: 'oauth_not_configured' });
  const tokenEndpoint = manifest.endpoints?.token;
  if (!tokenEndpoint) throw Object.assign(new Error('no token endpoint'), { code: 'no_token_endpoint' });
  assertHttps(tokenEndpoint, 'token endpoint');

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: redirectUri(input.provider, input.reqOrigin),
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code_verifier: input.codeVerifier,
  });
  const tokens = await postTokenRequest(tokenEndpoint, form, manifest);
  return shapeTokenMaterial(tokens, input.scopes);
}

/** Mint a fresh access token from a stored refresh token (ADR 0024 §4). */
export async function refreshAccessToken(input: {
  provider: string;
  refreshToken: string;
  scopes: string[];
}): Promise<OAuthTokenMaterial> {
  const manifest = getProvider(input.provider);
  if (!manifest) throw Object.assign(new Error(`unknown provider '${input.provider}'`), { code: 'unknown_provider' });
  const client = await oauthClient(input.provider);
  if (!client) throw Object.assign(new Error('oauth_not_configured'), { code: 'oauth_not_configured' });
  const tokenEndpoint = manifest.endpoints?.token;
  if (!tokenEndpoint) throw Object.assign(new Error('no token endpoint'), { code: 'no_token_endpoint' });
  assertHttps(tokenEndpoint, 'token endpoint');

  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
  const tokens = await postTokenRequest(tokenEndpoint, form, manifest);
  const material = shapeTokenMaterial(tokens, input.scopes);
  // Token-rotation: providers may omit a fresh refresh_token (keep the old one).
  if (!material.refreshToken) material.refreshToken = input.refreshToken;
  return material;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  // Slack returns the granted identity differently; capture what we can.
  authed_user?: { id?: string; access_token?: string; scope?: string };
  bot_user_id?: string;
  team?: { id?: string };
  ok?: boolean;
  error?: string;
}

async function postTokenRequest(endpoint: string, form: URLSearchParams, manifest: ProviderManifest): Promise<RawTokenResponse> {
  let res: Response;
  try {
    // Bound the request: a hung provider token endpoint would otherwise stall the
    // browser on the callback and (via liveSecretFor) node execution mid-run.
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    log.warn('token request failed', { provider: manifest.id, timedOut, error: err instanceof Error ? err.message : String(err) });
    throw Object.assign(new Error(timedOut ? 'token endpoint timed out' : 'token request failed'), { code: 'token_exchange_failed' });
  }
  const text = await res.text();
  let parsed: RawTokenResponse;
  try {
    parsed = JSON.parse(text) as RawTokenResponse;
  } catch {
    throw Object.assign(new Error(`token endpoint returned non-JSON (${res.status})`), { code: 'token_exchange_failed' });
  }
  // Slack returns HTTP 200 with `{ok:false, error}` on failure — treat as error.
  if (!res.ok || parsed.ok === false || parsed.error) {
    log.warn('token exchange failed', { provider: manifest.id, status: res.status, error: parsed.error });
    throw Object.assign(new Error(`token exchange failed: ${parsed.error ?? res.status}`), { code: 'token_exchange_failed' });
  }
  return parsed;
}

/** Normalize a provider's token response into our stored shape. Slack nests the
 *  user token under `authed_user`; Google/standard OAuth use the top level. */
function shapeTokenMaterial(raw: RawTokenResponse, requestedScopes: string[]): OAuthTokenMaterial {
  const accessToken = raw.authed_user?.access_token ?? raw.access_token;
  if (!accessToken) throw Object.assign(new Error('token response had no access_token'), { code: 'token_exchange_failed' });
  const grantedScopes = (raw.authed_user?.scope ?? raw.scope)?.split(/[ ,]+/).filter(Boolean);
  const material: OAuthTokenMaterial = {
    accessToken,
    tokenType: raw.token_type ?? 'Bearer',
    scopes: grantedScopes && grantedScopes.length > 0 ? grantedScopes : requestedScopes,
  };
  if (raw.refresh_token) material.refreshToken = raw.refresh_token;
  if (typeof raw.expires_in === 'number' && raw.expires_in > 0) {
    material.expiresAt = new Date(Date.now() + raw.expires_in * 1000).toISOString();
  }
  const subject = raw.authed_user?.id ?? raw.team?.id;
  if (subject) material.externalSubject = subject;
  return material;
}

export async function __resetPendingAuth(): Promise<void> {
  await pending.__clear();
}
