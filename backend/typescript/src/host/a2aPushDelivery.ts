/**
 * ADR 1045 push follow-up / RFC 0214 §A–§C — deliver ONE A2A push.
 *
 * This is the sink `registerAllRoutes.ts` (`a2a:pushSink`) installs when
 * durable tasks are on. It used to be an inline `undiciFetch` there that sent no
 * credential and followed redirects. Now:
 *
 *   - The original URL passes the registration SSRF predicate again
 *     (`assertPushUrlAllowed`) and the scheme arm (`assertEgressSchemeAllowed`,
 *     ADR 0607), both with `honorDevFlag: false`, and the dial goes through the
 *     pinned `webhookEgressDispatcher()` (re-resolve + validate every address at
 *     connect time, `webhooks.md` §Egress).
 *   - `redirect: 'manual'`: a 3xx is returned as a FAILED delivery and never
 *     followed (RFC 0214 §B, `interop.md` "a `3xx` is a failed delivery"), so
 *     the credential cannot ride a redirect to another origin (§A).
 *   - The registered credential goes out as `Authorization` (§A/§C), only to
 *     this URL. It is never logged and never in the returned outcome.
 *   - No OpenWOP signature is added (§C).
 *
 * The outcome carries no URL and no credential, so callers may log it.
 */

import { fetch as undiciFetch, type Dispatcher } from 'undici';
import { assertEgressSchemeAllowed, webhookEgressDispatcher } from './webhookEgressGuard.js';
import { assertPushUrlAllowed, type A2aPushOutcome, type A2aPushTarget } from './a2aTaskStore.js';

export interface A2aPushDeliveryOptions {
  /** Test seam: replaces the pinned egress dispatcher (undici `MockAgent`). The
   *  production sink never passes it. */
  dispatcher?: Dispatcher;
}

export async function deliverA2aPush(
  target: A2aPushTarget,
  event: Record<string, unknown>,
  opts: A2aPushDeliveryOptions = {},
): Promise<A2aPushOutcome> {
  try {
    // ADR 0607 — delivery-time re-check. A config stored before the
    // registration arm existed still reaches here, and this is the layer that
    // decides what leaves the process. `honorDevFlag: false` matches
    // registration: the two layers MUST agree or the flag becomes a way to
    // deliver what registration refused.
    assertPushUrlAllowed(target.url);
    assertEgressSchemeAllowed(target.url, { honorDevFlag: false });
  } catch {
    return { delivered: false, reason: 'egress_denied' };
  }
  const headers: Record<string, string> = { 'content-type': target.contentType ?? 'application/json' };
  if (target.authorization !== undefined) headers.authorization = target.authorization;
  let status: number;
  try {
    const res = await undiciFetch(target.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(event),
      redirect: 'manual',
      dispatcher: opts.dispatcher ?? webhookEgressDispatcher(),
    });
    status = res.status;
    // Release the connection; the receiver's body is not read.
    await res.body?.cancel().catch(() => undefined);
  } catch {
    // The error text can name the URL; the outcome carries only its class.
    return { delivered: false, reason: 'network' };
  }
  if (status >= 300 && status < 400) return { delivered: false, status, reason: 'redirect' };
  if (status < 200 || status >= 300) return { delivered: false, status, reason: 'http_status' };
  return { delivered: true, status };
}
