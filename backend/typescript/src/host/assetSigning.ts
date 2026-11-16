/**
 * ADR 1122 P2 — the signed arm: a short-lived signed read of one asset, for a reader
 * that carries no session (an export file, a headless film or slide renderer, a model
 * provider fetching an image). Minted only by server code that has already decided the
 * caller may read the asset; verified statelessly on any instance.
 *
 * Shape: `<serve url>?asig=v1.<kid>.<exp>.<sig>`, where `sig` is an HMAC-SHA256 over
 * `asset-read:v1:<kid>:<token>:<exp>` keyed by the session secret (`readSessionSecret`,
 * the same fail-closed source the run-stream capability uses). The `asset-read:v1:`
 * prefix separates it from every other signature that key makes.
 *
 * Rotation (the `interruptToken` precedent): `kid` is derived from the key, so rotating
 * the session secret rotates the key id in the same act. During a rotation an operator
 * sets `OPENWOP_ASSET_SIGNING_PREVIOUS_SECRET` to the old secret, and a URL signed
 * under it keeps verifying for the rest of its at most 15 minutes. An unknown `kid`
 * refuses.
 *
 * - `exp` is at most 15 minutes ahead. That cap rules out email and newsletter
 *   pictures, opened days later, ON PURPOSE: those use public grants (ADR 1122 D2.2).
 *   Do not raise the cap for them.
 * - Verification allows 30 seconds of clock skew between instances.
 * - A bad, expired, unknown-key or other-asset signature is not an error: the serve
 *   route treats it as no signature, and a refusal stays the uniform 404.
 * - Signatures are never logged; the route's would-deny log carries no query string.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readSessionSecret } from '../middleware/cookieSession.js';
import { readSecretEnv } from './secretEnv.js';
import { assetServeUrl } from './assetServePath.js';

const PREFIX = 'asset-read:v1:';
export const MAX_SIGNED_SECONDS = 15 * 60;
const SKEW_SECONDS = 30;
export const ASSET_SIGNATURE_PARAM = 'asig';
export const PREVIOUS_SECRET_ENV = 'OPENWOP_ASSET_SIGNING_PREVIOUS_SECRET';

const kidOf = (secret: string): string => createHash('sha256').update(`asset-read-kid:${secret}`).digest('hex').slice(0, 12);

function mac(secret: string, kid: string, token: string, exp: number): string {
  return createHmac('sha256', secret).update(`${PREFIX}${kid}:${token}:${exp}`).digest('base64url');
}

/** The serve URL for `token`, signed for `seconds` (at most 15 minutes). */
export function signedAssetUrl(token: string, seconds: number, nowMs: number = Date.now()): string {
  const ttl = Math.max(1, Math.min(MAX_SIGNED_SECONDS, Math.floor(seconds)));
  const exp = Math.floor(nowMs / 1000) + ttl;
  const secret = readSessionSecret();
  const kid = kidOf(secret);
  return `${assetServeUrl(token)}?${ASSET_SIGNATURE_PARAM}=v1.${kid}.${exp}.${mac(secret, kid, token, exp)}`;
}

/** The secret a key id names: the current one, or the operator-set previous one. */
function secretForKid(kid: string): string | null {
  const current = readSessionSecret();
  if (kidOf(current) === kid) return current;
  const previous = readSecretEnv(PREVIOUS_SECRET_ENV);
  if (previous && previous.length >= 32 && kidOf(previous) === kid) return previous;
  return null;
}

/** Seconds left on a valid signature for exactly `token`, or null. Never throws. */
export function assetSignatureRemaining(token: string, signature: unknown, nowMs: number = Date.now()): number | null {
  if (typeof signature !== 'string' || signature.length > 200) return null;
  const parts = signature.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const kid = parts[1] ?? '';
  const exp = Number(parts[2]);
  if (!Number.isInteger(exp)) return null;
  const nowS = Math.floor(nowMs / 1000);
  if (exp + SKEW_SECONDS <= nowS) return null; // expired, beyond the skew allowance
  if (exp - nowS > MAX_SIGNED_SECONDS + SKEW_SECONDS) return null; // longer than any mint allows
  let secret: string | null;
  try { secret = secretForKid(kid); } catch { return null; }
  if (!secret) return null; // a key id this host does not hold
  const a = Buffer.from(parts[3] ?? '');
  const b = Buffer.from(mac(secret, kid, token, exp));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return Math.max(0, exp - nowS);
}
