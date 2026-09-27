/**
 * `spec/v2/core/webhooks.md` §Surfaces — the `v1` signature scheme, in ONE place.
 *
 * WHY THIS MODULE EXISTS AT ALL. The signing was inline in
 * `webhookDeliveryWorker.ts`, which was fine while this host only SENT. RFC 0176
 * §D.2 makes it also a receiver obligation — a v2 host advertising `webhooks`
 * MUST accept a delivery carrying only the `X-openwop-*` family under scheme
 * `v1`, verifying the same bytes — and a verifier written beside the sender
 * rather than from it is a second implementation of one contract. Those drift,
 * and the drift is invisible: the sender keeps signing, the receiver keeps
 * accepting its own signatures, and only a foreign peer ever notices. This repo
 * has already shipped one three-way webhook signature drift.
 *
 * So the sender and the seam call the same two functions, and the signed bytes
 * are defined once: `HMAC-SHA256(secret, "{timestamp}.{rawBody}")`, hex, carried
 * as `sha256=<hex>`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The signed bytes. Sender and verifier agree because they call this. */
export function webhookSignedPayload(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/** The scheme-`v1` signature value, WITHOUT the `sha256=` prefix. */
export function signWebhookV1(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(webhookSignedPayload(timestamp, rawBody)).digest('hex');
}

export interface VerifyResult {
  accepted: boolean;
  reason?: string;
}

/**
 * Verify a delivery. Header lookup is case-insensitive and accepts EITHER family
 * (`x-openwop-*`, the v1.x canonical names, or `openwop-*`, the family v2 keeps)
 * — RFC 0165 §C.1 emits both with identical values, so a receiver that demanded
 * one would refuse half of its own host's traffic.
 */
export function verifyWebhookV1(
  secret: string,
  headers: Readonly<Record<string, string>>,
  rawBody: string,
): VerifyResult {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const pick = (name: string): string | undefined => lower[`x-openwop-${name}`] ?? lower[`openwop-${name}`];

  const algorithm = pick('signature-algorithm');
  if (algorithm !== undefined && algorithm !== 'v1') {
    return { accepted: false, reason: `unsupported signature algorithm "${algorithm}" (this host verifies scheme v1)` };
  }
  const timestamp = pick('timestamp');
  if (!timestamp) return { accepted: false, reason: 'missing timestamp header' };
  const presented = pick('signature');
  if (!presented) return { accepted: false, reason: 'missing signature header' };

  // `sha256=` is the wire form; tolerate a bare hex value rather than refusing a
  // delivery whose only fault is the prefix.
  const hex = presented.startsWith('sha256=') ? presented.slice('sha256='.length) : presented;
  const expected = signWebhookV1(secret, timestamp, rawBody);

  // Length check FIRST: `timingSafeEqual` THROWS on a length mismatch, so a
  // short signature would be a 500 rather than a refusal.
  if (hex.length !== expected.length) return { accepted: false, reason: 'signature mismatch' };
  const ok = timingSafeEqual(Buffer.from(hex, 'utf8'), Buffer.from(expected, 'utf8'));
  return ok ? { accepted: true } : { accepted: false, reason: 'signature mismatch' };
}

// ── RFC 0201 — the `standard-webhooks-1` companion scheme (ADR 0747) ─────────
//
// Standard Webhooks 1.0.0 §"Signature scheme": HMAC-SHA256 over
// `{webhook-id}.{webhook-timestamp}.{rawBody}`, base64, each entry `v1,<sig>`,
// keyed by the base64 DECODING of the secret after its `whsec_` prefix. That
// `v1,` token is Standard Webhooks' own signature identifier; it is NOT this
// host's scheme id `v1` (RFC 0201 §A.2), which stays in
// `OpenWOP-Signature-Algorithm` on every delivery. Pinned against the upstream
// reference library's `sign` test vector in `test/rfc0201-standard-webhooks.test.ts`.

export const STANDARD_WEBHOOKS_ALG = 'standard-webhooks-1';
const WHSEC_PREFIX = 'whsec_';

/** The HMAC key of a `whsec_` secret, or `null` when the secret is not that form
 *  or its body decodes outside 24–64 bytes (RFC 0201 §B.6). The alphabet is
 *  checked because `Buffer.from(…, 'base64')` silently skips foreign bytes, which
 *  would accept a secret the subscriber's library decodes to a different key. */
export function decodeWhsec(secret: string): Buffer | null {
  if (!secret.startsWith(WHSEC_PREFIX)) return null;
  const body = secret.slice(WHSEC_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  const key = Buffer.from(body, 'base64');
  return key.length >= 24 && key.length <= 64 ? key : null;
}

/** One `webhook-signature` entry, `v1,<base64>`. Throws on a non-`whsec_`
 *  secret: registration and rotation refuse one, so reaching here with it is a
 *  host bug, never a caller error. */
export function signStandardWebhooks(secret: string, webhookId: string, timestamp: string, rawBody: string): string {
  const key = decodeWhsec(secret);
  if (key === null) throw new Error('signStandardWebhooks: secret is not a whsec_ secret of 24–64 bytes');
  return `v1,${createHmac('sha256', key).update(`${webhookId}.${timestamp}.${rawBody}`).digest('base64')}`;
}
