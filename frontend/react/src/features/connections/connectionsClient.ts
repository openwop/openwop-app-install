/**
 * Connections feature client (host-extension, non-normative). Wraps
 * /v1/host/openwop-app/{connections,providers}/*. Always-on — Connections graduated
 * off its feature toggle to a permanent admin surface (ADR 0024 § Correction).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Provider {
  id: string;
  label: string;
  kind: string;
  reach: string;
  refreshable: boolean;
  /** True when this host can run the OAuth consent flow for the provider
   *  (oauth2 provider AND host-side client creds configured). */
  oauthConfigured?: boolean;
  /** The provider's WRITE scope strings — present means a write re-consent is
   *  offerable (ADR 0024 Phase C). */
  writeScopes?: string[];
}

export interface Connection {
  connectionId: string;
  provider: string;
  kind: string;
  displayName: string;
  status: string;
  scopes: string[];
  connectedAt: string;
  /** Per-user connection owner (absent for org/workspace). */
  userId?: string;
  /** Org-shared connection (absent for user/workspace). */
  orgId?: string;
}

const base = `${config.baseUrl}/v1/host/openwop-app`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string })?.message ?? '';
    } catch {
      /* non-JSON */
    }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listProviders(): Promise<Provider[]> {
  const res = await fetch(`${base}/providers`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ providers: Provider[] }>(res, 'listProviders')).providers;
}

export async function listConnections(): Promise<Connection[]> {
  const res = await fetch(`${base}/connections`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ connections: Connection[] }>(res, 'listConnections')).connections;
}

export async function createConnection(input: { provider: string; kind: string; secret: string; displayName?: string; scope?: 'user' | 'org' }): Promise<Connection> {
  const { scope = 'user', ...rest } = input;
  const res = await fetch(`${base}/connections`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ ...rest, scope }) }));
  return asJson<Connection>(res, 'createConnection');
}

export async function revokeConnection(connectionId: string): Promise<void> {
  const res = await fetch(`${base}/connections/${encodeURIComponent(connectionId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) throw new Error(`revokeConnection returned ${res.status}`);
}

/** Begin the OAuth2 PKCE consent flow: ask the host for a provider consent URL
 *  (bound server-side to this user + a single-use state), then hand it back so
 *  the caller can navigate the browser to it. `returnTo` is where the callback
 *  bounces back (a same-origin SPA path). */
export async function beginOAuth(provider: string, returnTo = '/connections', opts: { write?: boolean } = {}): Promise<string> {
  const res = await fetch(
    `${base}/connections/${encodeURIComponent(provider)}/authorize`,
    fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ returnTo, ...(opts.write ? { write: true } : {}) }) }),
  );
  return (await asJson<{ authorizeUrl: string }>(res, 'beginOAuth')).authorizeUrl;
}

/** Health-probe a connection (refreshes an oauth2 token on the way). Never
 *  returns the secret — only `{ ok, status }`. */
export async function testConnection(connectionId: string): Promise<{ ok: boolean; status: string }> {
  const res = await fetch(
    `${base}/connections/${encodeURIComponent(connectionId)}/test`,
    fetchOpts({ method: 'POST', headers: jsonHeaders() }),
  );
  return asJson<{ ok: boolean; status: string }>(res, 'testConnection');
}

// ── Host OAuth client config (superadmin) — ADR 0024 § host-managed OAuth ──────

/** A provider's host OAuth client configuration. The client SECRET is never
 *  returned by the API — only `clientId` + `configured` + audit metadata. */
export interface OAuthClientConfig {
  provider: string;
  clientId: string;
  configured: boolean;
  updatedAt: string;
  updatedBy?: string;
}

/** A typed marker so the admin panel can distinguish "you're not a superadmin"
 *  (403) from a real error and hide itself rather than show a scary notice. */
export class ForbiddenError extends Error {}

/** List host-configured OAuth clients (superadmin only). Throws `ForbiddenError`
 *  on 403 so the caller can hide the panel for non-superadmins. */
export async function listOAuthClients(): Promise<OAuthClientConfig[]> {
  const res = await fetch(`${base}/connections-oauth-clients`, fetchOpts({ headers: authedHeaders() }));
  if (res.status === 403) throw new ForbiddenError('not a superadmin');
  return (await asJson<{ clients: OAuthClientConfig[] }>(res, 'listOAuthClients')).clients;
}

/** Configure a provider's OAuth client (superadmin). The secret is write-only —
 *  it is sealed server-side and never read back. */
export async function setOAuthClient(provider: string, clientId: string, clientSecret: string): Promise<void> {
  const res = await fetch(
    `${base}/connections-oauth-clients/${encodeURIComponent(provider)}`,
    fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ clientId, clientSecret }) }),
  );
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `setOAuthClient returned ${res.status}`);
  }
}

/** Remove a provider's host OAuth client (superadmin). It then falls back to env
 *  vars, or reads as unconfigured. */
export async function deleteOAuthClient(provider: string): Promise<void> {
  const res = await fetch(
    `${base}/connections-oauth-clients/${encodeURIComponent(provider)}`,
    fetchOpts({ method: 'DELETE', headers: authedHeaders() }),
  );
  if (!res.ok && res.status !== 204) throw new Error(`deleteOAuthClient returned ${res.status}`);
}
