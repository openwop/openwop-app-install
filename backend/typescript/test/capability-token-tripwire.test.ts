/**
 * ADR 0448 D4 — the capability-token tripwire. A NEW hand-rolled bearer-token
 * store (the mint+hash pair, or a local `hashToken`) outside the two homes —
 * a `sharing` resolver for link-shaped capabilities, a store built on
 * `host/capabilityToken.ts` for bearer-shaped ones — is a red TEST, not a
 * review catch.
 *
 * Two lists, both shrink-only in spirit:
 *  - DEBT: pre-0448 stores still to adopt. **Empty as of OQ3 (2026-07-20)** —
 *    apiKeyService / invitationsService / ucpClientStore all adopted the helper.
 *    A new entry here is a promise to adopt, never a parking spot.
 *  - EXEMPT: files the predicate flags but per-edge review cleared as NOT
 *    token-at-rest stores. Each carries its reason; adding one is a review
 *    decision, not a bypass.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FEATURES_ROOT = join(__dirname, '..', 'src', 'features');

/** Pre-0448 hand-rolled mint+hash sites still awaiting adoption. EMPTY (OQ3). */
const RECORDED_DEBT = new Set<string>([]);

/** Reviewed FALSE POSITIVES — the predicate fires, but the `createHash` is a
 *  protocol transform / content hash, not token-at-rest storage. */
const REVIEWED_EXEMPT = new Map<string, string>([
  // ADR 0544 P2 — the attestation token. The BEARER SECRET is minted by the
  // sanctioned helper (`mintToken('owatt')` from host/capabilityToken.ts) and
  // only its hash is stored, so this is not a hand-rolled token store. The
  // predicate fires on two unrelated uses in the same file:
  //   - `createHash` derives the opaque SOURCE DIGEST a verifier sees instead of
  //     a grant id / audit seq (a content hash, not token-at-rest);
  //   - `randomBytes` mints the `attestationId` RECORD id, which is not a
  //     credential and grants nothing.
  // Cleared by /code-review 2026-08-11 rather than dodged: contorting the code
  // to avoid a predicate would be worse than recording why it does not apply.
  ['job-search/attestation/token.ts', 'bearer secret comes from host/capabilityToken.ts; createHash is the verifier source-digest and randomBytes is a record id'],
  // The `createHash('sha256')` here is the PKCE S256 `code_challenge`
  // derivation (RFC 7636), and `state` is an ephemeral single-use CSRF nonce
  // (the pending-auth row key, consumed on callback) — neither is a bearer
  // credential stored at rest. ADR 0448 OQ3 per-edge review.
  ['connections/oauthFlow.ts', 'PKCE S256 challenge + ephemeral CSRF nonce, not a token store'],
  // ADR 0569 — the cookieless visitor-identity module. `randomBytes` mints the
  // DAILY SALT (a server-side secret that never leaves the process boundary,
  // is never issued to any caller, and grants nothing — the opposite of a
  // bearer credential); `createHash` derives the anonymous per-visitor
  // dimension stored on event rows (a content hash of salt|org|ip|ua, not
  // token-at-rest). No mintable/redeemable artifact exists here to route
  // through host/capabilityToken.ts. Per-edge review with the ADR 0569
  // never-logged tripwire (analytics-visitor-identity.test.ts) as the
  // enforcement that the salt stays server-side.
  ['analytics/visitorIdentity.ts', 'daily salt is a never-issued server secret; createHash is the anonymous visitor dimension, not token-at-rest'],
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') && !p.includes('__tests__') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('capability-token discipline (ADR 0448 D4)', () => {
  it('no NEW hand-rolled bearer-token store outside the two homes', () => {
    const offenders: string[] = [];
    for (const file of walk(FEATURES_ROOT)) {
      const src = readFileSync(file, 'utf8');
      // Hardened predicate (grade fix #4): any-quote/any-arg createHash paired
      // with randomBytes in one file, or ANY locally-defined hashToken
      // (const/let/function). A renamed import or a cross-file split can still
      // evade — this is defense-in-depth on top of review, never a substitute.
      const mintsAndHashes = /createHash\s*\(/.test(src) && /randomBytes\s*\(/.test(src);
      const localHashToken = /(const|let|function)\s+hashToken\b/.test(src);
      if (!mintsAndHashes && !localHashToken) continue;
      const rel = file.slice(FEATURES_ROOT.length + 1).split('\\').join('/');
      if (!RECORDED_DEBT.has(rel) && !REVIEWED_EXEMPT.has(rel)) offenders.push(rel);
    }
    expect(offenders, 'New bearer-token minting must use host/capabilityToken.ts (bearer-shaped) or a sharing resolver (link-shaped) — see ADR 0448 D3').toEqual([]);
  });

  it('every allowlisted file still exists and still trips the predicate (no stale entries)', () => {
    const stale: string[] = [];
    for (const rel of [...RECORDED_DEBT, ...REVIEWED_EXEMPT.keys()]) {
      let src: string;
      try { src = readFileSync(join(FEATURES_ROOT, rel), 'utf8'); }
      catch { stale.push(`${rel} (missing)`); continue; }
      const trips = (/createHash\s*\(/.test(src) && /randomBytes\s*\(/.test(src)) || /(const|let|function)\s+hashToken\b/.test(src);
      if (!trips) stale.push(`${rel} (no longer trips — remove the allowlist entry)`);
    }
    expect(stale, 'Allowlist entries that no longer trip the predicate are stale — remove them so the list stays honest').toEqual([]);
  });
});
