/**
 * Capability-token discipline (ADR 0448 D1) — the ONE way bearer secrets are
 * minted and stored in this app. Pure helpers (no storage here; stores stay
 * with their features), plus the store CONTRACT every adopter follows:
 *
 *  - the row KEY is `hashToken(raw)` — the raw token is NEVER at rest;
 *  - the tenant lives IN CONTENT, never only in the key (purge-safe — the
 *    KTD-1 lesson: a tenant purge must be able to find the row by content);
 *  - verify = hash the presented token, point-get, uniform not-found (an
 *    invalid, revoked, and absent token are indistinguishable to the caller);
 *  - the raw token is returned exactly ONCE at mint and never logged.
 *
 * TWO HOMES rule (ADR 0448 D3, enforced by the D4 tripwire test): a
 * LINK-shaped capability (a URL a human opens → a projection) is a `sharing`
 * resolver (ADR 0013) — never a parallel token store. A BEARER-shaped secret
 * (feed/API/attribution credential) is a feature-owned store built on these
 * helpers. Hand-rolled `createHash` token storage outside those homes is a
 * review-blocking finding.
 *
 * Adopters: kicktodo-core/inviteService, kicktodo-integrations feed tokens,
 * sharing/sharingService (hashed-at-rest keys — ADR 0448 P2).
 */

import { createHash, randomBytes } from 'node:crypto';

/** sha256 hex of the raw token — the ONLY at-rest representation. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** True when a string is already a token hash (64 lowercase hex chars) — the
 *  shape test the ADR 0448 P2 re-key migration keys its idempotency on. */
export function isTokenHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** Mint a CSPRNG bearer token. The `raw` goes to the caller exactly once;
 *  everything durable uses `hash`. Prefix conventions stay feature-owned
 *  (`ktinv`, `ktfeed`, …) — they aid support/log triage, never security. */
export function mintToken(prefix: string): { raw: string; hash: string } {
  const raw = `${prefix}_${randomBytes(32).toString('base64url')}`;
  return { raw, hash: hashToken(raw) };
}
