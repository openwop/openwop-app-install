/**
 * Amazon SNS message verification for SES bounce/complaint webhooks (ADR 0994 D4).
 *
 * SES publishes bounce, complaint and delivery events to an SNS topic, and SNS
 * POSTs each one to the subscribed HTTPS endpoint. The SNS SIGNATURE is the
 * credential: an RSA signature over a canonical string, made with a certificate
 * AWS hosts at `https://sns.<region>.amazonaws.com/…pem`. On top of that, the
 * message's `TopicArn` must equal the topic the operator configured (the stored
 * verification secret), so a validly signed message for SOMEONE ELSE's topic is
 * refused.
 *
 * Pure apart from the certificate fetch, which is injectable for tests and in
 * production goes through `guardedEgressFetch` (SSRF-pinned, no redirects).
 */
import { createPublicKey, createVerify } from 'node:crypto';

/** The SNS envelope fields this module reads. */
export interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Timestamp: string;
  Signature: string;
  SignatureVersion: string;
  SigningCertURL: string;
  Message?: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
}

/** How far a message's `Timestamp` may be from now (ADR 0994 D4.4). */
export const SNS_REPLAY_WINDOW_MS = 60 * 60_000;

/** AWS's documented host shape for SNS signing certificates and subscribe URLs. */
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/** True for an `https://sns.<region>.amazonaws.com/...` URL (no port, no userinfo). */
export function isSnsUrl(raw: string | undefined, opts: { pem?: boolean } = {}): boolean {
  if (!raw) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return false;
  if (!SNS_HOST.test(u.hostname)) return false;
  return opts.pem ? u.pathname.endsWith('.pem') : true;
}

/** Parse an SNS envelope; null when a required field is missing or mistyped. */
export function parseSnsMessage(body: unknown): SnsMessage | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const req = ['Type', 'MessageId', 'TopicArn', 'Timestamp', 'Signature', 'SignatureVersion', 'SigningCertURL'] as const;
  for (const k of req) if (typeof b[k] !== 'string' || b[k] === '') return null;
  for (const k of ['Message', 'Subject', 'SubscribeURL', 'Token'] as const) {
    if (b[k] !== undefined && b[k] !== null && typeof b[k] !== 'string') return null;
  }
  const str = (k: string): string | undefined => (typeof b[k] === 'string' ? (b[k] as string) : undefined);
  return {
    Type: b.Type as string, MessageId: b.MessageId as string, TopicArn: b.TopicArn as string,
    Timestamp: b.Timestamp as string, Signature: b.Signature as string,
    SignatureVersion: b.SignatureVersion as string, SigningCertURL: b.SigningCertURL as string,
    ...(str('Message') !== undefined ? { Message: str('Message')! } : {}),
    ...(str('Subject') !== undefined ? { Subject: str('Subject')! } : {}),
    ...(str('SubscribeURL') !== undefined ? { SubscribeURL: str('SubscribeURL')! } : {}),
    ...(str('Token') !== undefined ? { Token: str('Token')! } : {}),
  };
}

/** SNS's canonical string-to-sign: `Key\nValue\n` for each field, in this order. */
export function snsStringToSign(m: SnsMessage): string | null {
  const keys = m.Type === 'Notification'
    ? ['Message', 'MessageId', ...(m.Subject !== undefined ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
    : m.Type === 'SubscriptionConfirmation' || m.Type === 'UnsubscribeConfirmation'
      ? ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type']
      : null;
  if (!keys) return null;
  let out = '';
  for (const k of keys) {
    const v = (m as unknown as Record<string, string | undefined>)[k];
    if (v === undefined) return null; // a field the signature covers is missing
    out += `${k}\n${v}\n`;
  }
  return out;
}

export type SnsCertFetcher = (url: string) => Promise<string>;

const certCache = new Map<string, string>();
const CERT_CACHE_MAX = 32;

export type SnsVerifyFailure = 'malformed' | 'wrong_topic' | 'stale' | 'bad_cert_url' | 'cert_unavailable' | 'bad_signature';

/**
 * Verify one SNS message against the configured topic. Checks, in order: shape,
 * topic pin, timestamp window, certificate URL, signature. Never throws.
 */
export async function verifySnsMessage(input: {
  body: unknown; expectedTopicArn: string; now: number; fetchCert: SnsCertFetcher;
}): Promise<{ ok: true; message: SnsMessage } | { ok: false; reason: SnsVerifyFailure }> {
  const m = parseSnsMessage(input.body);
  if (!m) return { ok: false, reason: 'malformed' };
  if (m.TopicArn !== input.expectedTopicArn.trim()) return { ok: false, reason: 'wrong_topic' };
  const ts = Date.parse(m.Timestamp);
  if (!Number.isFinite(ts) || Math.abs(input.now - ts) > SNS_REPLAY_WINDOW_MS) return { ok: false, reason: 'stale' };
  if (!isSnsUrl(m.SigningCertURL, { pem: true })) return { ok: false, reason: 'bad_cert_url' };
  const algorithm = m.SignatureVersion === '1' ? 'RSA-SHA1' : m.SignatureVersion === '2' ? 'RSA-SHA256' : null;
  if (!algorithm) return { ok: false, reason: 'bad_signature' };
  const toSign = snsStringToSign(m);
  if (toSign === null) return { ok: false, reason: 'malformed' };

  let pem = certCache.get(m.SigningCertURL);
  if (!pem) {
    try {
      pem = await input.fetchCert(m.SigningCertURL);
      createPublicKey(pem); // refuse anything that is not a certificate (or key) before caching it
    } catch { return { ok: false, reason: 'cert_unavailable' }; }
    if (certCache.size >= CERT_CACHE_MAX) certCache.delete(certCache.keys().next().value as string);
    certCache.set(m.SigningCertURL, pem);
  }
  try {
    const v = createVerify(algorithm);
    v.update(toSign, 'utf8');
    return v.verify(pem, m.Signature, 'base64') ? { ok: true, message: m } : { ok: false, reason: 'bad_signature' };
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
}

/** Test seam: certificates are cached per URL for the process lifetime. */
export function __clearSnsCertCache(): void { certCache.clear(); }
