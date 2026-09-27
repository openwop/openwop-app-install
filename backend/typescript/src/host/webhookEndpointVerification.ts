/**
 * RFC 0201 §D — endpoint verification for a registration that opts into
 * `standard-webhooks-1` (ADR 0747).
 *
 * A registration is a standing instruction for this host to POST, with durable
 * retries, to a URL the CALLER chose. The egress guard protects this host's
 * network; it cannot protect a legitimate public endpoint that never asked for
 * the traffic. Only the endpoint can consent, so before an opted-in
 * registration is persisted it gets exactly ONE signed request and must echo
 * the challenge back.
 *
 * The request leaves through the SAME egress path a delivery does — the
 * scheme re-check, `webhookEgressDispatcher()` (pinned resolution: every
 * resolved address re-validated inside the connection's own lookup) and
 * `redirect: 'error'` — because a verification that took a laxer path than the
 * deliveries it authorises would be an SSRF probe with a consent-shaped name.
 *
 * NOT retried, by rule (§D.14): each registration costs the named endpoint one
 * request, and the caller fixes its endpoint and registers again.
 */
import { randomBytes } from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import { assertEgressSchemeAllowed, EgressUrlRejectedError, webhookEgressDispatcher } from './webhookEgressGuard.js';
import { signStandardWebhooks } from './webhookSignature.js';
import { APP_VERSION } from '../version.js';

/** §D.14 — the endpoint has 10 seconds. */
export const VERIFICATION_TIMEOUT_MS = 10_000;
/** A consenting endpoint answers a few dozen bytes. Anything past this is not
 *  an echo, and reading it unbounded would let an endpoint hold a request
 *  handler's memory hostage. */
const MAX_RESPONSE_BYTES = 16 * 1024;

/**
 * Why a verification failed, as a CLOSED set — for the LOG. A registration route
 * that echoed `connect ECONNREFUSED 203.0.113.9:443` or the egress guard's denial
 * text would hand any tenant member a reachability / DNS oracle for arbitrary
 * hosts, one registration at a time.
 *
 * ADR 0755 (WIT-WH-5) — and so would these seven codes, more coarsely: they
 * still told `request_failed` (nothing listening, TLS failed) from `non_2xx` /
 * `body_not_json` / `challenge_missing` (an HTTP server answered) — a port and
 * HTTP-liveness probe for any public host:port at the verification budget. RFC
 * 0201 §D.14 mandates ONLY the `400 webhook_endpoint_unverified` code, never a
 * reason, so the caller now gets the single `CallerVerificationReason` and the
 * fine code rides `detail`, which is logged and never returned.
 */
export type VerificationFailure =
  | 'scheme_refused'
  | 'request_failed'
  | 'non_2xx'
  | 'body_too_large'
  | 'body_not_json'
  | 'challenge_missing'
  | 'challenge_mismatch';

/** The one reason a caller may see — it distinguishes nothing about the endpoint. */
export type CallerVerificationReason = 'not_confirmed';

export type VerificationOutcome =
  | { ok: true }
  | { ok: false; reason: CallerVerificationReason; detail: string };

/** Fold a fine failure into the caller-safe outcome; the fine code leads `detail`. */
function refused(fine: VerificationFailure, detail: string): VerificationOutcome {
  return { ok: false, reason: 'not_confirmed', detail: `${fine}: ${detail}` };
}

/** Read at most `MAX_RESPONSE_BYTES` of the body; `null` past the cap. */
async function readCapped(body: ReadableStream<Uint8Array> | null): Promise<string | null> {
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      // Release the socket rather than leaving the rest of the body unread.
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Send the §D.13 verification request and judge the answer. Never throws for
 * an endpoint's behaviour — every failure is `{ ok:false, reason, detail }` and
 * the caller refuses `400 webhook_endpoint_unverified`. `reason` (always
 * `not_confirmed`) may reach the caller; `detail` — led by the fine
 * `VerificationFailure` — is for the log only. Neither carries the secret.
 */
export async function verifyWebhookEndpoint(url: string, secret: string): Promise<VerificationOutcome> {
  try {
    assertEgressSchemeAllowed(url, { honorDevFlag: true });
  } catch (e) {
    if (e instanceof EgressUrlRejectedError) return refused('scheme_refused', e.reason);
    throw e;
  }
  // ≥128 bits (§D.13): 24 bytes → 32 base64url characters, inside the schema's
  // `^[A-Za-z0-9_-]{22,128}$`.
  const challenge = randomBytes(24).toString('base64url');
  // The verification is not a delivery, so it has no delivery row to take a
  // stable id from; it gets its own, in the `webhook-id` grammar (§C.10).
  const webhookId = `msg_${randomBytes(18).toString('base64url')}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({ type: 'openwop.webhook.verification', challenge });
  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    res = await undiciFetch(url, {
      method: 'POST',
      // Deliberately NO `OpenWOP-*` headers: no subscription exists yet for
      // `OpenWOP-Webhook-Id` to name, and `OpenWOP-Event-Type` is forbidden
      // outright (§D.13) so no subscriber can mistake this for a delivery.
      headers: {
        'content-type': 'application/json',
        'user-agent': `openwop-webhook-dispatcher/${APP_VERSION}`,
        'webhook-id': webhookId,
        'webhook-timestamp': timestamp,
        'webhook-signature': signStandardWebhooks(secret, webhookId, timestamp, body),
      },
      body,
      redirect: 'error',
      dispatcher: webhookEgressDispatcher(),
      signal: AbortSignal.timeout(VERIFICATION_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
    return refused('request_failed', `${err instanceof Error ? err.message : String(err)}${cause}`);
  }
  if (res.status < 200 || res.status > 299) {
    await res.body?.cancel().catch(() => undefined);
    return refused('non_2xx', `HTTP ${res.status}`);
  }
  let text: string | null;
  try {
    text = await readCapped(res.body);
  } catch (err) {
    return refused('request_failed', `response unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (text === null) return refused('body_too_large', `over ${MAX_RESPONSE_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refused('body_not_json', `${text.length} bytes`);
  }
  const echoed = (parsed as { challenge?: unknown } | null)?.challenge;
  if (echoed === undefined) return refused('challenge_missing', 'no challenge field');
  if (echoed !== challenge) return refused('challenge_mismatch', 'challenge differs');
  return { ok: true };
}
