/**
 * CONS-2 — proof-of-possession for the PUBLIC consent lane.
 *
 * THE DEFECT. `POST /v1/host/openwop-app/public-consent/:orgId` took
 * `subjectKey` straight from an unauthenticated request body and called
 * latest-wins `recordConsent`, which REPLACES the stored record wholesale. That
 * keyspace is shared with CRM contactIds, `User.userId`s, email addresses and
 * (since ADR 0394) raw E.164 numbers — so anyone who knew or guessed a subject
 * key could flip a recorded `marketing:false` to `true` and drop every
 * per-channel specific. `GET …/public-consent/:orgId/:subjectKey` was the
 * matching anonymous oracle over the same keyspace. The repo already held the
 * counter-argument in writing: `mergeConsentCategories`'s docblock says a
 * compliance revocation "must not be silently overwritten".
 *
 * THE CURE, and why it does not break legitimate public capture. This is the
 * ONLY consent-capture path the host ships, so failing closed on "no
 * authenticated caller" would have left the feature with no way in at all — a
 * gate with no exit. Instead the lane gets its OWN identity space:
 *
 *   - a visitor arrives with no token; the POST MINTS one and returns it. The
 *     caller (a cookie banner) stores it and sends it back on every later
 *     write and read. That is strictly MORE usable than before, where the
 *     caller had to invent a key;
 *   - the stored subject key is `visitor:<uuid>`, a namespace the authed
 *     identity spaces can never collide with — a contactId is `crm:`-prefixed,
 *     a userId is not a UUID under a `visitor:` prefix, and an email/E.164
 *     cannot be one either. So a public write can no longer ADDRESS an authed
 *     subject, which is the actual vulnerability rather than a symptom of it;
 *   - the read requires the same token, so the oracle is gone: you can only
 *     read a record you can prove you minted.
 *
 * A supplied-but-INVALID token is a 400, never a silent fresh mint: silently
 * minting would write a brand-new record while the caller believes they updated
 * theirs — a fabrication with a green status code.
 *
 * THE SECRET IS THE EXPIRY WE DIDN'T CHOOSE (review F3). `readSessionSecret()`
 * falls back to a per-process `randomBytes(32)` when `OPENWOP_SESSION_SECRET`
 * is unset, and is rotatable when it is set. So a rotation — or, without the
 * env var, ANY restart — invalidates every token ever minted, at which point
 * the visitor can no longer read, update, or WITHDRAW their consent. GDPR
 * Art. 7(3) requires withdrawal to be as easy as giving, so a refusal that
 * names no way out is itself the compliance defect. Two things follow, and both
 * are implemented rather than merely noted:
 *
 *   - the 400 NAMES ITS EXIT — "discard it and omit the field to mint a new
 *     one" — so a stranded visitor has a one-step recovery instead of a dead
 *     end. The cost is honestly stated: the old record is orphaned, not
 *     re-reachable, which is why the operator half matters;
 *   - `OPENWOP_SESSION_SECRET` MUST be set in any deployment that runs this
 *     lane. Unset, it is not a weaker guarantee, it is no guarantee: the tokens
 *     survive exactly as long as the process does.
 *
 * This is the same property that disqualified an HMAC-keyed erasure tombstone
 * in ADR 0586 D1 ("a rotation would silently drop every tombstone and fail
 * OPEN"). The reasoning is identical; the verdict differs because the failure
 * runs the other way — here a rotation fails CLOSED (a 400), which is
 * recoverable, whereas there it would have failed open, which is not. A
 * `token_version` an operator could pin is the proper cure and is recorded as
 * open work in ADR 0586.
 *
 * NO EXPIRY, deliberately. An expired token would strand the visitor from their
 * OWN consent record and the next POST would mint a second, orphaning the first
 * — a worse outcome than a long-lived bearer credential whose entire authority
 * is "read and set my own consent categories". The token is bound to the
 * TENANT (not the org) because consent is tenant-scoped by design, so it cannot
 * be replayed into another tenant's keyspace.
 *
 * The identity join an operator loses (keying consent by their own visitor
 * cookie so it lines up with CRM) is not lost: `analytics:identity-link` is the
 * sanctioned seam for that (ADR 0381), and it is what the DSAR fan-out already
 * expands over — so a `visitor:`-keyed record and a contact-keyed one are still
 * reached by one erasure.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readSessionSecret } from '../../middleware/cookieSession.js';

/** The public lane's identity-space prefix. Never produced by any authed path. */
export const PUBLIC_SUBJECT_PREFIX = 'visitor:';

const TOKEN_PREFIX = 'publicconsent:v1:';
/** A generous cap that still bounds a malicious body. A real token is ~90 chars. */
const MAX_TOKEN_LENGTH = 256;

/**
 * The signed message. Domain-separated AND injective, so no `(tenantId,
 * visitorId)` pair can produce the same bytes as a different pair (which would
 * let a token minted for one tenant verify for another).
 *
 * Review F5 — the separator used to be a raw NUL byte. It was sound
 * cryptographically and broke every TEXT tool: git classified this file as
 * BINARY, so `gh pr diff` and the GitHub UI showed "Binary files … differ" —
 * a reviewer of the app's newest security-critical file saw NOTHING — and
 * `git grep` reported "Binary file matches" with no lines, silently degrading
 * any shell gate that greps source. A LENGTH PREFIX gives the same injectivity
 * in printable ASCII: `<len>:<tenantId>` parses exactly one way, so a
 * `:`-bearing tenant id (`ws:acme`, `anon:xyz`) cannot straddle the boundary.
 *
 * This CHANGES the signature domain, so tokens minted before it stop verifying.
 * Safe here and only here: the lane is new in this PR and has never shipped, so
 * the live population is empty. Any later change to this function is a
 * breaking one and needs the `v2.` token version, not an edit.
 */
function signedMessage(tenantId: string, visitorId: string): string {
  return `${TOKEN_PREFIX}${tenantId.length}:${tenantId}:${visitorId}`;
}

function sign(tenantId: string, visitorId: string): string {
  return createHmac('sha256', readSessionSecret())
    .update(signedMessage(tenantId, visitorId))
    .digest('base64url');
}

/** Mint a fresh visitor identity + its bearer token for one tenant. */
export function mintPublicSubjectToken(tenantId: string): { token: string; subjectKey: string } {
  const visitorId = randomUUID();
  return {
    token: `v1.${visitorId}.${sign(tenantId, visitorId)}`,
    subjectKey: `${PUBLIC_SUBJECT_PREFIX}${visitorId}`,
  };
}

/**
 * Verify a token and return the subject key it addresses, or `null`.
 *
 * `null` covers every failure uniformly (wrong shape, wrong tenant, bad
 * signature) so the route cannot leak which one it was — a distinguishable
 * "valid token, wrong tenant" would reintroduce a smaller oracle.
 *
 * Review F1 — SURROUNDING WHITESPACE IS TRIMMED, deliberately, and the decision
 * is stated rather than left to be inferred from a `parts[0] === ' v1'`
 * mismatch. A minted token is `v1.<uuid>.<base64url>`: it can never CONTAIN
 * whitespace, so trimming cannot make two distinct tokens collide, and the
 * trim happens HERE so the POST body lane and the GET path-param lane cannot
 * disagree about it. Rejecting instead would have meant a whitespace-padded
 * valid token 400s with "Invalid `subjectToken`" — a refusal for a token that
 * is, in every sense the visitor can act on, theirs.
 */
export function verifyPublicSubjectToken(tenantId: string, rawToken: string): string | null {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const visitorId = parts[1]!;
  // A UUID, because that is the only thing `mintPublicSubjectToken` produces —
  // pinning the shape keeps a signature forgery from also being a key-shape
  // injection into `${tenantId}:${subjectKey}`.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(visitorId)) return null;
  const expected = Buffer.from(sign(tenantId, visitorId), 'utf8');
  const provided = Buffer.from(parts[2]!, 'utf8');
  if (expected.length !== provided.length) return null;
  if (!timingSafeEqual(expected, provided)) return null;
  return `${PUBLIC_SUBJECT_PREFIX}${visitorId}`;
}
