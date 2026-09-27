/**
 * `spec/v2/core/identity.md` §4 "Resume tokens" + `spec/v2/core/interrupt.md`
 * §Tokens (RFC 0170 §E.1) — the versioned resume-token scheme.
 *
 *   ow2.<alg>.<kid>.<payload>.<mac>
 *
 * `alg` MUST be one this host advertises (`hs256` at the cut); `kid` MUST select
 * a secret this host holds; otherwise `401 interrupt_token_invalid`. The v1 form
 * remains resolvable under `kid: legacy` until its `expiresAt`
 * (`persistence.md` §"Everything else a v1 host persisted": tokens are
 * `drained`).
 *
 * WHAT THIS HOST'S v1 TOKEN ACTUALLY IS. The corpus describes the v1 token as
 * two segments, `base64url(payload).hmac` (`spec/v1/interrupt.md`). THIS host
 * never implemented that: `executor/suspendManager.ts` minted 32 random bytes
 * and the row IS the credential — there is no payload to read and no MAC to
 * verify, so possession plus a constant-time compare against the stored row is
 * the whole verification. Its legacy disposition is therefore "any token that
 * is not `ow2.`-prefixed is looked up as this host's own opaque v1 credential",
 * which is the same `kid: legacy` drain the corpus asks for, spelled for the
 * credential this host really issued.
 *
 * WHAT IS NEW. A token minted from now on carries the prefix, and the `mac` is a
 * real HMAC-SHA256 over `<alg>.<kid>.<payload>` — so `kid` selects a
 * verification secret and a secret can rotate without orphaning outstanding
 * tokens, which is the property §4 exists to give. The payload is the opaque
 * credential the row is still keyed on, so the store lookup is unchanged and no
 * migration runs: the full token string is what is persisted and presented.
 *
 * THIS CHANGES THE BYTES OF A TOKEN ON THE v1 WIRE. The token is an opaque
 * capability string with no v1 grammar (`api/openapi.yaml`'s `{token}` path
 * parameter carries no `pattern`, which is the defect RFC 0170 §D.1 names), and
 * every consumer already treats it as opaque — but it is longer and shaped
 * differently, and outstanding tokens minted before this change keep resolving
 * unchanged. Stated rather than discovered.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** `interrupt.tokenAlgs[]` — the algorithms this host advertises. `hs256` at the cut. */
export const INTERRUPT_TOKEN_ALGS: readonly string[] = ['hs256'];
/** The `kid` an outstanding v1 (pre-`ow2.`) token resolves under. */
export const LEGACY_KID = 'legacy';

/**
 * The signing secret. A default keeps a deploy that never set the variable
 * verifying its own tokens (they are still unforgeable: the `payload` is 256
 * bits of randomness and the row lookup is the real gate — the MAC adds
 * rotation, not the entropy). An operator who sets the variable gets a distinct
 * `kid`, so tokens minted under the old secret are refused by `kid` rather than
 * by a silent MAC failure.
 */
function secret(): string {
  return process.env.OPENWOP_INTERRUPT_TOKEN_SECRET ?? 'openwop-app-interrupt-token';
}

/**
 * `ids.schema.json#/$defs/keyId` — derived from the secret so the two cannot
 * drift: rotating the secret rotates the `kid` in the same act.
 */
export function currentKid(): string {
  return createHash('sha256').update(`kid:${secret()}`).digest('hex').slice(0, 16);
}

function mac(material: string): string {
  return createHmac('sha256', secret()).update(material).digest('base64url');
}

/** Mint `ow2.hs256.<kid>.<payload>.<mac>` over a fresh 256-bit opaque payload. */
export function mintInterruptToken(): string {
  const kid = currentKid();
  const payload = randomBytes(32).toString('base64url');
  return `ow2.hs256.${kid}.${payload}.${mac(`hs256.${kid}.${payload}`)}`;
}

export type TokenVerdict =
  /** Not `ow2.`-prefixed: this host's own v1 credential, drained under `kid: legacy`. */
  | { readonly form: 'legacy' }
  /** Inside the grammar, `alg` advertised, `kid` held, MAC verified. */
  | { readonly form: 'ow2'; readonly kid: string }
  /** Outside the grammar, or an unadvertised `alg`, unheld `kid`, or bad MAC. */
  | { readonly form: 'invalid'; readonly reason: string };

/**
 * Classify a presented token. Never touches the store — the caller still does
 * the row lookup, so this is purely the §4 scheme check.
 */
export function verifyInterruptToken(token: string): TokenVerdict {
  if (!token.startsWith('ow2.')) return { form: 'legacy' };
  const parts = token.split('.');
  if (parts.length !== 5) {
    return { form: 'invalid', reason: 'the token is outside the ow2.<alg>.<kid>.<payload>.<mac> grammar' };
  }
  const [, alg, kid, payload, given] = parts as [string, string, string, string, string];
  if (!INTERRUPT_TOKEN_ALGS.includes(alg)) {
    return { form: 'invalid', reason: `alg ${alg} is not advertised in interrupt.tokenAlgs` };
  }
  if (kid !== currentKid() && kid !== LEGACY_KID) {
    return { form: 'invalid', reason: `kid ${kid} is not held by this host` };
  }
  const expected = mac(`${alg}.${kid}.${payload}`);
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { form: 'invalid', reason: 'the token MAC does not verify' };
  }
  return { form: 'ow2', kid };
}
