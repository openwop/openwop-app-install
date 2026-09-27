/**
 * Brokered egress — the shared spine behind the Connections integration adapters
 * (ADR 0024 §4 Phase 3). Resolves the run's acting human's Connection for a
 * provider and performs an SSRF-guarded, token-injected POST. The provider's
 * response shape + success criterion differ (Slack `{ok}`, SendGrid `202`), so
 * the caller maps `res` and stamps provenance on its own success check.
 *
 * Security spine (identical for every adapter): token over https only (loopback
 * http allowed only when private egress is explicitly enabled), SSRF via the
 * audited RFC 0093 dispatcher, no-redirect (a token-bearing request must not
 * follow a redirect), bounded timeout, `connections:use` enforced by the broker
 * for org connections (fail-closed), token never in node config / events / the
 * run doc / a log.
 */

import { fetch as undiciFetch } from 'undici';
import type { Storage } from '../storage/storage.js';
import { resolveConnectionCredential } from '../features/connections/connectionsService.js';
import { getProvider } from '../features/connections/providerRegistry.js';
import { hostMatchesApi, type ConnectionUseProvenance } from './connectionInjection.js';
import { isDeniedWebhookHost, webhookEgressDispatcher, webhookPrivateEgressAllowed } from './webhookEgressGuard.js';
import { assertEgressAllowed, evaluateEgress, getEgressRules } from './egressPolicy.js';
import { assertEffectAllowed } from './runEffectContext.js';

const TIMEOUT_MS = 10_000;

export interface BrokeredEgressDeps {
  storage: Storage;
  tenantId: string;
  runId: string;
  /** The acting human (run.metadata.actingUserId). Absent ⇒ system run ⇒ the
   *  broker withholds the user/org connection (fail-closed). */
  actingUserId?: string;
  orgId?: string;
}

/** The subset the egress SPINE itself reads (`storage`/`runId` feed caller-side
 *  provenance stamping only) — run-less callers (e.g. the KB external reranker)
 *  pass just this; adapter callers keep passing their full BrokeredEgressDeps
 *  (the optional halves let a full-deps literal type-check unchanged). */
export type BrokeredCallDeps = Pick<BrokeredEgressDeps, 'tenantId' | 'actingUserId' | 'orgId'> & Partial<Pick<BrokeredEgressDeps, 'storage' | 'runId'>>;

export type BrokeredPostOutcome =
  | { outcome: 'no_connection' }
  | { outcome: 'insecure_base' }
  | { outcome: 'request_failed'; timedOut: boolean }
  | { outcome: 'sent'; res: Awaited<ReturnType<typeof undiciFetch>>; provenance: ConnectionUseProvenance };

/** How the resolved secret is placed in the auth header (default `Authorization`,
 *  overridable via `authHeaderName`).
 *  - `bearer` → `Bearer <secret>` (Slack oauth2 token, SendGrid / Expo api_key).
 *  - `basic`  → `Basic <base64(secret)>` (the secret IS the `user:pass` pair,
 *    e.g. Twilio's `AccountSid:AuthToken`).
 *  - `raw`    → `<secret>` verbatim, no prefix (e.g. TikTok's `Access-Token` header). */
export type AuthScheme = 'bearer' | 'basic' | 'raw';

function authHeader(scheme: AuthScheme, secret: string): string {
  if (scheme === 'basic') return `Basic ${Buffer.from(secret).toString('base64')}`;
  if (scheme === 'raw') return secret;
  return `Bearer ${secret}`;
}

/**
 * Resolve the acting user's `provider` Connection and POST `body` to `url` with
 * the resolved secret in the `Authorization` header per `authScheme` (default
 * `bearer`). Does NOT stamp provenance — the caller stamps (via
 * `stampConnectionUse`) once it deems the call successful, so a provider-rejected
 * send isn't recorded as a use.
 */
export async function brokeredPost(
  deps: BrokeredCallDeps,
  opts: {
    provider: string;
    /** A fixed URL, or a builder over the resolved secret for providers whose
     *  endpoint embeds a public credential half (e.g. Twilio's `AccountSid` in
     *  the path). The builder runs host-side; it MUST only use the public half. */
    url: string | ((secret: string) => string);
    body: string;
    contentType?: string;
    authScheme?: AuthScheme;
    /** Where the broker writes its resolved secret — default `authorization`; some
     *  providers want it under a different header (e.g. TikTok's `Access-Token`).
     *  MUST be a hardcoded strategy constant, never derived from caller/agent input. */
    authHeaderName?: string;
    /** Additional STATIC, non-secret-via-the-broker headers the caller needs (e.g.
     *  Google Ads' app-level `developer-token` / `login-customer-id`). The broker
     *  remains the SOLE authority for the credential: any case-variant of the
     *  auth-header-name / `content-type` here is stripped before merge, so a caller
     *  can never override the broker's token or smuggle a second auth header. */
    extraHeaders?: Record<string, string>;
  },
): Promise<BrokeredPostOutcome> {
  // ADR 0531 — fail closed BEFORE the credential is resolved: a replay must not
  // even touch the secret, let alone dial.
  assertEffectAllowed('network-egress', `brokeredPost ${opts.provider}`);
  const resolved = await resolveConnectionCredential({
    tenantId: deps.tenantId,
    provider: opts.provider,
    ...(deps.actingUserId ? { actingUserId: deps.actingUserId } : {}),
    ...(deps.orgId ? { orgId: deps.orgId } : {}),
  });
  if (!resolved) return { outcome: 'no_connection' };
  const url = typeof opts.url === 'function' ? opts.url(resolved.secret) : opts.url;
  // ADR 0187 — enforce the tenant egress firewall (+ SSRF baseline) before dial.
  await assertEgressAllowed(deps.tenantId, url);
  // Token over https only — loopback http allowed only when private egress is
  // explicitly enabled (local dev / tests).
  if (!url.startsWith('https://') && !webhookPrivateEgressAllowed()) {
    return { outcome: 'insecure_base' };
  }
  // The broker owns the auth header (whatever its name) + content-type. Strip every
  // case-variant of those from caller extras (a plain object keeps `Access-Token` and
  // `access-token` distinct; undici lowercases at send, so an unstripped variant would
  // survive as a SECOND auth header). The case-insensitive strip — not the set-last —
  // is what protects the credential.
  const authName = (opts.authHeaderName ?? 'authorization').trim().toLowerCase();
  const safeExtra = Object.fromEntries(
    Object.entries(opts.extraHeaders ?? {}).filter(([k]) => {
      const n = k.trim().toLowerCase();
      return n !== authName && n !== 'content-type';
    }),
  );
  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: { 'content-type': opts.contentType ?? 'application/json; charset=utf-8', ...safeExtra, [authName]: authHeader(opts.authScheme ?? 'bearer', resolved.secret) },
      body: opts.body,
      dispatcher: webhookEgressDispatcher(),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { outcome: 'sent', res, provenance: resolved.provenance };
  } catch (err) {
    return { outcome: 'request_failed', timedOut: err instanceof Error && err.name === 'TimeoutError' };
  }
}

/** A generic brokered call (arbitrary HTTP method) for the connector framework
 *  (ADR 0037). `brokeredPost` covers the fixed-shape integration adapters; this
 *  is the open-method egress a connector node/agent-tool needs (e.g. a ServiceNow
 *  Table API `GET`/`PATCH`). It adds ONE thing on top of brokeredPost's spine: it
 *  pins the destination to the provider's HOST-CURATED `apiHosts` so a connector
 *  can never be turned into a generic egress bypass — the resolved token only ever
 *  reaches the provider's own hosts (same eTLD+1 boundary as `connectionInjection`,
 *  never substring). */
export type BrokeredFetchOutcome =
  | { outcome: 'no_connection' }
  | { outcome: 'host_not_allowed'; host: string }
  | { outcome: 'insecure_base' }
  | { outcome: 'request_failed'; timedOut: boolean }
  | { outcome: 'sent'; res: Awaited<ReturnType<typeof undiciFetch>>; provenance: ConnectionUseProvenance };

export async function brokeredFetch(
  deps: BrokeredCallDeps,
  opts: {
    provider: string;
    url: string;
    method?: string;
    body?: string;
    contentType?: string;
    authScheme?: AuthScheme;
    /** `'manual'` RETURNS a 3xx instead of erroring — for reading a pre-authenticated
     *  download `Location` (e.g. Box `/content`) WITHOUT following it. `'manual'` does
     *  NOT follow the redirect, so the credentialed request only ever reaches the
     *  `apiHosts`-pinned host; the caller MUST fetch the `Location` un-credentialed
     *  (the token is never sent to the redirect target). Default keeps `'error'`. */
    redirect?: 'manual';
    /** Additional STATIC, non-secret headers the caller needs (e.g. NetSuite
     *  SuiteQL's required `Prefer: transient`, or a SOAP `SOAPAction`). The broker
     *  remains the SOLE authority for the credential + content-type: any
     *  case-variant of `authorization` / `content-type` here is stripped before
     *  merge, so a caller can never override the broker's token or content-type.
     *  MUST be hardcoded strategy constants, never caller/agent-derived. */
    extraHeaders?: Record<string, string>;
    /** ADR 0627 D5 — pin the credential to ONE connection row (EXACT, at the
     *  broker's selection choke): returned iff `active`, this provider, and
     *  owned by the acting user / org-shared with `connections:use`. A pin that
     *  fails is `no_connection` — never the user→org→workspace fall-through. */
    connectionId?: string;
  },
): Promise<BrokeredFetchOutcome> {
  // ADR 0531 — a replay never dials. Deliberately THROWS rather than returning a
  // `host_not_allowed` outcome: a policy denial is a normal result callers handle,
  // whereas reaching here during a replay is a classification BUG that must be
  // loud (`executor/sideEffects.ts` should have short-circuited this node).
  assertEffectAllowed('network-egress', `brokeredFetch ${opts.provider}`);
  // Resolve the destination host up front so we can pin it BEFORE resolving a
  // credential (fail closed on a bad URL without ever touching the secret).
  let parsed: URL;
  try {
    parsed = new URL(opts.url);
  } catch {
    return { outcome: 'host_not_allowed', host: opts.url };
  }

  // SSRF: reject a denied host (loopback/metadata/private) unless private egress
  // is explicitly enabled — same guard the http seam and webhook dispatcher use.
  if (!webhookPrivateEgressAllowed() && isDeniedWebhookHost(parsed.hostname)) {
    return { outcome: 'host_not_allowed', host: parsed.hostname };
  }

  // The connector may only reach the provider's curated apiHosts (eTLD+1, never
  // substring). A provider with no apiHosts (or no manifest) is NOT reachable via
  // a connector — fail closed rather than allow an open destination.
  const apiHosts = getProvider(opts.provider)?.apiHosts ?? [];
  if (!apiHosts.some((ah) => hostMatchesApi(parsed.hostname, ah))) {
    return { outcome: 'host_not_allowed', host: parsed.hostname };
  }

  // ADR 0187 — the tenant egress firewall layers on top of the provider apiHosts
  // restriction (a tenant may denylist even a provider host). Non-throwing here:
  // map a policy denial to the existing `host_not_allowed` outcome.
  if (!evaluateEgress(opts.url, await getEgressRules(deps.tenantId)).allowed) {
    return { outcome: 'host_not_allowed', host: parsed.hostname };
  }

  // Token over https only — loopback http allowed only when private egress is on.
  if (parsed.protocol !== 'https:' && !webhookPrivateEgressAllowed()) {
    return { outcome: 'insecure_base' };
  }

  const resolved = await resolveConnectionCredential({
    tenantId: deps.tenantId,
    provider: opts.provider,
    ...(deps.actingUserId ? { actingUserId: deps.actingUserId } : {}),
    ...(deps.orgId ? { orgId: deps.orgId } : {}),
    ...(opts.connectionId !== undefined ? { connectionId: opts.connectionId } : {}), // '' is a (refused) pin, not an un-pin
  });
  if (!resolved) return { outcome: 'no_connection' };

  // The broker owns `authorization` + `content-type`. Strip every case-variant of
  // those from caller extras before merge (undici lowercases at send, so an
  // unstripped variant would survive as a SECOND auth header) — the same guard
  // brokeredPost applies. Everything else (e.g. `Prefer`, `SOAPAction`) passes.
  const safeExtra = Object.fromEntries(
    Object.entries(opts.extraHeaders ?? {}).filter(([k]) => {
      const n = k.trim().toLowerCase();
      return n !== 'authorization' && n !== 'content-type';
    }),
  );

  try {
    const res = await undiciFetch(opts.url, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'content-type': opts.contentType ?? 'application/json; charset=utf-8' } : {}),
        ...safeExtra,
        authorization: authHeader(opts.authScheme ?? 'bearer', resolved.secret),
      },
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      dispatcher: webhookEgressDispatcher(),
      // `'manual'` returns the 3xx (caller reads Location, never follows with the token);
      // default `'error'` refuses to follow a token-bearing redirect at all.
      redirect: opts.redirect === 'manual' ? 'manual' : 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { outcome: 'sent', res, provenance: resolved.provenance };
  } catch (err) {
    return { outcome: 'request_failed', timedOut: err instanceof Error && err.name === 'TimeoutError' };
  }
}
