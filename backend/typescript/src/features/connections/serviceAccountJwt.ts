/**
 * Service-account-JWT token mint (ADR 0081 P2) — for UNATTENDED BigQuery reads.
 *
 * A GCP service-account key is a JSON private key, NOT a bearer token, and a scheduled
 * run has no interactive user to do OAuth PKCE. This mints a short-lived access token:
 * RS256-sign a JWT assertion from the BYOK SA key and exchange it at the Google token
 * endpoint (grant_type=jwt-bearer). The access token is cached in-process to expiry and
 * returned to `liveSecretFor`, which hands it to the broker as a bearer — exactly like
 * the oauth2 refresh branch.
 *
 * Security (threat-model-secret-leakage): the SA key is the highest-sensitivity secret
 * (it mints tokens indefinitely). It stays BYOK-enveloped; this module logs ONLY
 * {connectionId, expiresAt} on success and a stable code on failure — never the
 * private_key, the assembled JWS, or the minted token. The minted token is ephemeral —
 * never persisted, never in the run event log / node outputs.
 *
 * Stdlib-only: `node:crypto` RS256 (no jsonwebtoken/jose dep). The token exchange goes to
 * the fixed Google endpoint (not the connector broker — that pin is for the BigQuery query).
 */

import { createSign } from 'node:crypto';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('connections.saJwt');

const TOKEN_AUD = 'https://oauth2.googleapis.com/token';
const BIGQUERY_READONLY_SCOPE = 'https://www.googleapis.com/auth/bigquery.readonly';
const REFRESH_SKEW_MS = 60_000;
const MINT_TIMEOUT_MS = 10_000;

interface ServiceAccountKey { client_email?: string; private_key?: string; token_uri?: string }

/** access tokens cached in-process to expiry — NEVER persisted (the SA key doesn't rotate). */
const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();
/** single-flight: concurrent resolves of the same connection coalesce onto one mint. */
const inFlight = new Map<string, Promise<string | null>>();

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Pure: build the RS256-signed JWT assertion. Exported for unit testing (verifiable with
 *  the SA key's public half). Throws `sa_jwt_bad_key` on a key missing client_email/private_key. */
export function assembleServiceAccountJwt(sa: ServiceAccountKey, opts: { scope: string; aud: string; now: number }): string {
  if (!sa.client_email || !sa.private_key) throw new Error('sa_jwt_bad_key');
  const iat = Math.floor(opts.now / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: opts.scope, aud: opts.aud, iat, exp: iat + 3600 }));
  const signingInput = `${header}.${claims}`;
  const signature = b64url(createSign('RSA-SHA256').update(signingInput).sign(sa.private_key));
  return `${signingInput}.${signature}`;
}

export interface MintDeps { now?: number; fetchImpl?: typeof fetch }

/**
 * Mint (or return a cached) BigQuery read-only access token for a service-account connection.
 * `connectionId` keys the cache + single-flight; `saKeyJson` is the BYOK-resolved SA key JSON.
 * Returns null (fail closed) on a malformed key or a failed exchange — never throws to the caller.
 */
export async function mintServiceAccountToken(connectionId: string, saKeyJson: string, deps: MintDeps = {}): Promise<string | null> {
  const now = deps.now ?? Date.now();
  const cached = tokenCache.get(connectionId);
  if (cached && cached.expiresAt - REFRESH_SKEW_MS > now) return cached.accessToken;

  const existing = inFlight.get(connectionId);
  if (existing) return existing;

  const promise = (async (): Promise<string | null> => {
    try {
      let sa: ServiceAccountKey;
      try { sa = JSON.parse(saKeyJson) as ServiceAccountKey; }
      catch { log.error('sa_jwt_mint_failed', { connectionId, reason: 'bad_key_json' }); return null; }

      const aud = sa.token_uri ?? TOKEN_AUD;
      let jws: string;
      try { jws = assembleServiceAccountJwt(sa, { scope: BIGQUERY_READONLY_SCOPE, aud, now }); }
      catch { log.error('sa_jwt_mint_failed', { connectionId, reason: 'bad_key' }); return null; }

      const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jws });
      const doFetch = deps.fetchImpl ?? fetch;
      const res = await doFetch(aud, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      });
      if (!res.ok) { log.error('sa_jwt_mint_failed', { connectionId, reason: 'token_endpoint', status: res.status }); return null; }
      const data = await res.json() as { access_token?: string; expires_in?: number };
      if (!data.access_token) { log.error('sa_jwt_mint_failed', { connectionId, reason: 'no_access_token' }); return null; }

      // Clamp expires_in to a sane max (defense-in-depth: a mis-pointed token_uri can't
      // pin a token far past its real validity → we'd just re-mint sooner).
      const ttlMs = typeof data.expires_in === 'number' ? Math.min(data.expires_in, 3600) * 1000 : 3_600_000;
      const expiresAt = now + ttlMs;
      tokenCache.set(connectionId, { accessToken: data.access_token, expiresAt });
      log.info('sa_jwt_minted', { connectionId, expiresAt: new Date(expiresAt).toISOString() });
      return data.access_token;
    } catch (err) {
      // Never log err.message — it could embed key/JWS material. Stable code only.
      log.error('sa_jwt_mint_failed', { connectionId, reason: 'mint_error', kind: err instanceof Error ? err.name : 'unknown' });
      return null;
    } finally {
      inFlight.delete(connectionId);
    }
  })();
  inFlight.set(connectionId, promise);
  return promise;
}

/** Evict a single connection's cached token — call on revoke so a minted token doesn't
 *  linger in memory after the connection is gone (defense-in-depth). */
export function evictServiceAccountToken(connectionId: string): void {
  tokenCache.delete(connectionId);
  inFlight.delete(connectionId);
}

/** Test-only — clear the token cache + in-flight map. */
export function __resetSaJwtCache(): void { tokenCache.clear(); inFlight.clear(); }
