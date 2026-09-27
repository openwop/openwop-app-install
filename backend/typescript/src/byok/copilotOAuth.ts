/**
 * ADR 0757 — GitHub OAuth App connect flow for the RFC 0121 CLEARED `subscription`
 * provider (GitHub Copilot). The ONLY login/acquisition code on the subscription
 * rail: the drift guard (`test/rfc0121-subscription-mechanism-guard.test.ts`)
 * pins that no other file under `src/` names a GitHub OAuth endpoint.
 *
 * Shape: authorization code + PKCE S256 against github.com, with the token
 * exchanged host-side and stored ONLY at the caller's personal `user:` tenant
 * (RFC 0121 §B.8, via `storeSubscriptionCredential`). The token is then used ONLY
 * by the Copilot SDK in the loopback sidecar (RFC 0121 gap G2: an official-client
 * harness, never direct Copilot HTTP calls from this host).
 *
 * Least scope (architect CRITICAL): the authorize request carries NO `scope`
 * parameter, so GitHub grants a scopeless user token — no repo, no user-profile
 * write. GitHub's Copilot SDK docs name no minimum scope; the steward verifies a
 * scopeless token against Copilot when registering the OAuth App (ADR 0757
 * §Registration) and, if Copilot refuses it, the ADR records the minimal scope
 * found — never a broad default.
 *
 * Login-CSRF (architect CRITICAL-3): `state` is single-use (the DELETE is the
 * claim), expires after 10 minutes, and is bound to the initiating principal AND
 * personal tenant; the callback refuses a different principal, so nobody can bind
 * their own Copilot grant into someone else's account.
 *
 * The token is never logged, never returned, and never written anywhere but the
 * KMS-backed secret store.
 */

import { createHash, randomBytes } from 'node:crypto';
import { DurableCollection } from '../host/hostExtPersistence.js';
import { guardedEgressFetch } from '../host/webhookEgressGuard.js';
import { callbackBaseUrl, appReturnUrl } from '../features/connections/oauthFlow.js';
import { createLogger } from '../observability/logger.js';
import { OpenwopError } from '../types.js';
import { COPILOT_PROVIDER_ID, copilotOAuthClient, copilotSubscriptionConfigured } from '../aiProviders/copilotSubscription.js';
import { storeSubscriptionCredential } from './subscriptionCredential.js';
import { VENDOR_ROOT, vendorTwin } from '../middleware/protocolVersion.js';
import { assertSubscriptionStorageTenant } from './subscriptionCredentialScope.js';

const log = createLogger('byok.copilotOAuth');

const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
const PENDING_TTL_MS = 10 * 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

/** The vendor-namespace sub-path of the callback (RFC 0181). */
const COPILOT_CALLBACK_SUBPATH = `/subscription/${COPILOT_PROVIDER_ID}/callback`;
/** The fixed redirect URI path registered with GitHub (one per provider — RFC
 *  0199 rule 5). It uses the CANONICAL version-agnostic vendor root
 *  (`/host/openwop-app/…`, ADR 0652), NOT the `/v1` twin: the twin retires with
 *  `/v1`, and a registered redirect URI that stops resolving would silently break
 *  every future connect. The canonical root is rewritten onto the twin route. */
export const COPILOT_CALLBACK_PATH = `${VENDOR_ROOT}${COPILOT_CALLBACK_SUBPATH}`;
/** Where the route is REGISTERED through the overlap (ADR 0654 twin). */
export const COPILOT_CALLBACK_ROUTE = vendorTwin(COPILOT_CALLBACK_SUBPATH);

interface PendingCopilotAuth {
  state: string;
  principalId: string;
  personalTenant: string;
  codeVerifier: string;
  returnTo: string;
  createdAt: string;
}

const pending = new DurableCollection<PendingCopilotAuth>('byok:copilot-oauth-pending', (p) => p.state);

const base64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function sanitizeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '/keys';
  return raw;
}

export function copilotRedirectUri(reqOrigin: string): string {
  return `${callbackBaseUrl(reqOrigin)}${COPILOT_CALLBACK_PATH}`;
}

function notConfigured(): OpenwopError {
  return new OpenwopError('host_capability_missing', 'GitHub Copilot is not configured on this host.', 404, { provider: COPILOT_PROVIDER_ID });
}

/**
 * Mint a GitHub consent URL for the SIGNED-IN caller. Refuses (403
 * `credential_scope_forbidden`) unless the caller has a durable personal `user:`
 * tenant — the only place the token may be stored (§B.8).
 */
export async function beginCopilotAuthorization(input: {
  principalId: string | undefined;
  personalTenant: string | undefined;
  reqOrigin: string;
  returnTo?: unknown;
}): Promise<{ authorizeUrl: string }> {
  if (!copilotSubscriptionConfigured()) throw notConfigured();
  const client = copilotOAuthClient();
  if (!client) throw notConfigured();
  if (!input.principalId) {
    throw new OpenwopError('unauthenticated', 'Connecting GitHub Copilot requires a signed-in account.', 401, {});
  }
  assertSubscriptionStorageTenant(input.personalTenant);

  const state = base64url(randomBytes(32));
  const codeVerifier = base64url(randomBytes(64));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  await pending.put({
    state,
    principalId: input.principalId,
    personalTenant: input.personalTenant,
    codeVerifier,
    returnTo: sanitizeReturnTo(input.returnTo),
    createdAt: new Date().toISOString(),
  });

  const url = new URL(GITHUB_AUTHORIZE);
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', copilotRedirectUri(input.reqOrigin));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('allow_signup', 'false');
  // Least scope: NO `scope` parameter — a scopeless user token (ADR 0757).
  return { authorizeUrl: url.toString() };
}

/** Consume a pending authorization (single-use: the delete is the claim). */
async function claimPending(state: string, now: number): Promise<PendingCopilotAuth | null> {
  const p = await pending.get(state);
  if (!p) return null;
  if (!(await pending.delete(state))) return null; // a concurrent callback won the claim
  if (now - new Date(p.createdAt).getTime() > PENDING_TTL_MS) return null;
  return p;
}

export type CopilotCallbackOutcome =
  | { ok: true; returnTo: string }
  | { ok: false; returnTo: string; reason: 'invalid_state' | 'principal_mismatch' | 'denied' | 'exchange_failed' };

/**
 * Complete the flow: verify state + principal binding, exchange the code, store
 * the token at the ORIGINATING principal's personal tenant. Never throws for a
 * provider-side failure — the caller redirects the browser with a reason code.
 */
export async function completeCopilotAuthorization(input: {
  state: unknown;
  code: unknown;
  error: unknown;
  principalId: string | undefined;
  personalTenant: string | undefined;
  reqOrigin: string;
  now?: number;
}): Promise<CopilotCallbackOutcome> {
  if (typeof input.state !== 'string' || input.state.length === 0) return { ok: false, returnTo: '/keys', reason: 'invalid_state' };
  const p = await claimPending(input.state, input.now ?? Date.now());
  if (!p) return { ok: false, returnTo: '/keys', reason: 'invalid_state' };
  // The browser completing the flow MUST be the principal that started it.
  if (!input.principalId || input.principalId !== p.principalId || input.personalTenant !== p.personalTenant) {
    log.warn('copilot oauth callback principal mismatch');
    return { ok: false, returnTo: p.returnTo, reason: 'principal_mismatch' };
  }
  if (typeof input.error === 'string' && input.error.length > 0) return { ok: false, returnTo: p.returnTo, reason: 'denied' };
  if (typeof input.code !== 'string' || input.code.length === 0) return { ok: false, returnTo: p.returnTo, reason: 'invalid_state' };
  const client = copilotOAuthClient();
  if (!client) return { ok: false, returnTo: p.returnTo, reason: 'exchange_failed' };

  let accessToken: string | undefined;
  try {
    const res = await guardedEgressFetch(GITHUB_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code: input.code,
        redirect_uri: copilotRedirectUri(input.reqOrigin),
        code_verifier: p.codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; error?: unknown };
    if (res.ok && typeof body.access_token === 'string' && body.access_token.length > 0) accessToken = body.access_token;
    else log.warn('copilot oauth token exchange refused', { status: res.status, error: typeof body.error === 'string' ? body.error : undefined });
  } catch (err) {
    log.warn('copilot oauth token exchange failed', { error: err instanceof Error ? err.name : 'error' });
  }
  if (!accessToken) return { ok: false, returnTo: p.returnTo, reason: 'exchange_failed' };

  assertSubscriptionStorageTenant(p.personalTenant);
  await storeSubscriptionCredential({
    provider: COPILOT_PROVIDER_ID,
    value: accessToken,
    scope: { tenantId: p.personalTenant, actorId: p.principalId },
  });
  return { ok: true, returnTo: p.returnTo };
}

/** The SPA redirect after the callback (success or a reason code; never a token). */
export function copilotReturnUrl(reqOrigin: string, outcome: CopilotCallbackOutcome): string {
  return appReturnUrl(reqOrigin, outcome.returnTo, outcome.ok ? { copilot: 'connected' } : { copilot: 'error', reason: outcome.reason });
}

export async function __resetCopilotPendingAuth(): Promise<void> {
  await pending.__clear();
}
