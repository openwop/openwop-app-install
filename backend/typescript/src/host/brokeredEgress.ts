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
import { webhookEgressDispatcher, webhookPrivateEgressAllowed } from './webhookEgressGuard.js';
import type { ConnectionUseProvenance } from './connectionInjection.js';

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

export type BrokeredPostOutcome =
  | { outcome: 'no_connection' }
  | { outcome: 'insecure_base' }
  | { outcome: 'request_failed'; timedOut: boolean }
  | { outcome: 'sent'; res: Awaited<ReturnType<typeof undiciFetch>>; provenance: ConnectionUseProvenance };

/** How the resolved secret is placed in the `Authorization` header.
 *  - `bearer` → `Bearer <secret>` (Slack oauth2 token, SendGrid / Expo api_key).
 *  - `basic`  → `Basic <base64(secret)>` (the secret IS the `user:pass` pair,
 *    e.g. Twilio's `AccountSid:AuthToken`). */
export type AuthScheme = 'bearer' | 'basic';

function authHeader(scheme: AuthScheme, secret: string): string {
  return scheme === 'basic' ? `Basic ${Buffer.from(secret).toString('base64')}` : `Bearer ${secret}`;
}

/**
 * Resolve the acting user's `provider` Connection and POST `body` to `url` with
 * the resolved secret in the `Authorization` header per `authScheme` (default
 * `bearer`). Does NOT stamp provenance — the caller stamps (via
 * `stampConnectionUse`) once it deems the call successful, so a provider-rejected
 * send isn't recorded as a use.
 */
export async function brokeredPost(
  deps: BrokeredEgressDeps,
  opts: {
    provider: string;
    /** A fixed URL, or a builder over the resolved secret for providers whose
     *  endpoint embeds a public credential half (e.g. Twilio's `AccountSid` in
     *  the path). The builder runs host-side; it MUST only use the public half. */
    url: string | ((secret: string) => string);
    body: string;
    contentType?: string;
    authScheme?: AuthScheme;
  },
): Promise<BrokeredPostOutcome> {
  const resolved = await resolveConnectionCredential({
    tenantId: deps.tenantId,
    provider: opts.provider,
    ...(deps.actingUserId ? { actingUserId: deps.actingUserId } : {}),
    ...(deps.orgId ? { orgId: deps.orgId } : {}),
  });
  if (!resolved) return { outcome: 'no_connection' };
  const url = typeof opts.url === 'function' ? opts.url(resolved.secret) : opts.url;
  // Token over https only — loopback http allowed only when private egress is
  // explicitly enabled (local dev / tests).
  if (!url.startsWith('https://') && !webhookPrivateEgressAllowed()) {
    return { outcome: 'insecure_base' };
  }
  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: { 'content-type': opts.contentType ?? 'application/json; charset=utf-8', authorization: authHeader(opts.authScheme ?? 'bearer', resolved.secret) },
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
