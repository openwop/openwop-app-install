/**
 * ADR 0549 — the HTTP idempotency lane.
 *
 * ONE owner for everything about caller-supplied `Idempotency-Key` handling:
 * which endpoints participate, how a request body is digested, and how a key
 * is rendered safe for a log line. The route modules import from here; they
 * never hand-roll any of it.
 *
 * WHY THIS FILE EXISTS AT ALL (ADR 0549 CORRECTION 1/2). Before this, one
 * method — then named `storage.claimIdempotency(rawHeaderValue)` — served two
 * unrelated concepts:
 *
 *   1. this lane — caller-supplied keys, ATTACKER-CONTROLLED, identified by
 *      (tenant, endpoint, key), holding a cached response; and
 *   2. the daemons' fire-once mutex — host-generated keys, unforgeable, one
 *      opaque global key, holding nothing but its own existence.
 *
 * Sharing one keyspace between them was a critical defect in both directions:
 * tenant B could replay tenant A's cached response, and *any* caller could
 * send `Idempotency-Key: schedule-fire:<jobId>:<slot>` to win the scheduler's
 * mutex and suppress a host-scheduled job. The two lanes are now separate
 * tables with separate interfaces, and the split is what makes that class
 * unreachable rather than merely unlikely. The mutex lane lives on
 * `Storage.claimOnce` / `putOnce` / `pruneOnceByPrefix`.
 */

import { createHash, randomUUID } from 'node:crypto';
import { resolveRequestTimeoutMs } from '../middleware/requestTimeout.js';

/**
 * The CLOSED set of endpoints that accept an `Idempotency-Key`.
 *
 * Deliberately a union and not a string: `endpointId` is part of the ledger's
 * primary key, so a typo (`post:/v1/runs` vs `POST:/v1/runs`) would silently
 * mint a SECOND keyspace and reopen the cross-endpoint replay this key
 * component exists to prevent. A new participating route must add its literal
 * here, which makes registration a compile-time obligation rather than a
 * convention someone can forget.
 */
export type IdempotentEndpoint = 'POST:/v1/runs' | 'POST:/v1/host/openwop-app/agents';

/** Every endpoint in the union, for tests and the lane tripwire. */
export const IDEMPOTENT_ENDPOINTS: readonly IdempotentEndpoint[] = [
  'POST:/v1/runs',
  'POST:/v1/host/openwop-app/agents',
];

/**
 * The endpoint's SEMANTIC request version, mixed into the digest.
 *
 * Bump an entry when the meaning of a request body changes without its shape
 * changing — otherwise a client retrying across a deploy would match the old
 * digest and be served a response computed under the old semantics.
 */
const REQUEST_VERSION: Record<IdempotentEndpoint, string> = {
  'POST:/v1/runs': 'v1',
  'POST:/v1/host/openwop-app/agents': 'v1',
};

/**
 * Digest of a request body, stable across key ordering.
 *
 * Sorts object keys at every level so two equivalent requests whose client
 * varied key order between retries digest identically (no false replay
 * mismatch).
 *
 * NOT RFC 8785 canonical JSON, and P1 deliberately did NOT make it so.
 *
 * > CORRECTION (ADR 0549 P1 review). This comment previously claimed "a client
 * > that varies `1.0` vs `1` between retries can see a spurious mismatch".
 * > **That is false, and measured false**: the body is `JSON.parse`d before it
 * > reaches here, so `{"a":1.0}` and `{"a":1}` are the same JS number by the
 * > time we hash, and `1e2`/`100` likewise. Number canonicalization is a
 * > non-issue for a parsed body. Left uncorrected, the claim is the next
 * > person's reason to add a JCS dependency that buys nothing.
 *
 * What genuinely differs from JCS is Unicode normalization: two strings that
 * look identical but differ in NFC/NFD digest differently. That fails in the
 * safe direction — a 409 mismatch, never a wrong body served.
 *
 * Full JCS becomes a real requirement at **P3**, where RFC 0150 makes effect
 * identity cross-host and digests must agree between implementations. Today
 * every digest is compared only against digests THIS host wrote, so
 * cross-implementation agreement is not required and a hand-rolled
 * canonicalization would be risk without benefit.
 */
export function canonicalRequestDigest(body: unknown, endpoint: IdempotentEndpoint): string {
  function sortDeep(v: unknown): unknown {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(sortDeep);
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, sortDeep(val)]),
    );
  }
  // The ENDPOINT is bound into the digest, not merely its version — both
  // endpoints sit at `v1`, so hashing the version alone made two different
  // endpoints digest identically (this file's own test asserted the opposite
  // and caught it). Isolation never depended on it: `endpoint_id` is part of
  // the primary key, so a row written for one endpoint is already unreachable
  // from another. Binding it makes the digest self-describing, so it cannot be
  // lifted from one endpoint's row to validate a claim on another if some
  // later change reads a digest outside its key. Length-prefixed so
  // ("a","bc") and ("ab","c") cannot collide.
  const prefix = `${endpoint} ${REQUEST_VERSION[endpoint]}`;
  return createHash('sha256')
    .update(`${prefix.length}:${prefix} `)
    .update(JSON.stringify(sortDeep(body) ?? null))
    .digest('hex');
}

/**
 * Per-process salt for log redaction. Random per boot: a caller must not be
 * able to precompute the digest of a key they are guessing at, and correlating
 * one key across process restarts is not a use case worth the exposure.
 */
const LOG_SALT = randomUUID();

/**
 * Render an idempotency key safe to log — ADR 0549 "the key and request digest
 * are never logged in plaintext".
 *
 * A caller-supplied key routinely carries customer identifiers (order numbers,
 * user ids, email addresses) because clients derive it from their own domain
 * objects. Logging it verbatim exports that into log storage with a completely
 * different retention and access model. Twelve salted hex chars is enough to
 * correlate two log lines within one process and useless for recovering the
 * key.
 */
export function redactKey(key: string): string {
  return `idk_${createHash('sha256').update(LOG_SALT).update(key).digest('hex').slice(0, 12)}`;
}

/**
 * ADR 0549 P1 — how long a claim is held before another caller may reclaim it.
 *
 * DERIVED from the request timeout, never a second magic number. The whole
 * safety argument for reclaiming rests on one property: **a live holder must
 * not be able to outlive its lease.** The claim→complete critical section runs
 * entirely inside one HTTP request (`routes/runs.ts` completes the ledger
 * BEFORE it responds), and that request is bounded by
 * `requestTimeoutMiddleware`. So a lease longer than the request timeout means
 * an expired claim implies a DEAD holder, not a slow one.
 *
 * Get that wrong and reclaiming actively causes the duplicate this whole
 * feature exists to prevent: a slow holder and its reclaimer would each create
 * a run, and while compare-and-set means the client only ever sees one
 * response, the other run still exists and still executes. Hence derivation —
 * a duplicated constant is a constant that drifts. (The same reasoning is why
 * `LATEST_SCHEMA_VERSION` is computed from `MIGRATIONS` rather than hand-set.)
 *
 * `OPENWOP_REQUEST_TIMEOUT_MS=0` DISABLES the middleware, so there is no
 * in-process bound at all; the effective ceiling is then Cloud Run's outer
 * request timeout (300s per DEPLOY.md `--timeout=300`), and the lease must
 * clear that instead.
 */
export function idempotencyLeaseMs(): number {
  const CLOUD_RUN_OUTER_TIMEOUT_MS = 300_000;
  const MARGIN_MS = 60_000;
  const configured = resolveRequestTimeoutMs();
  const bound = configured > 0 ? configured : CLOUD_RUN_OUTER_TIMEOUT_MS;
  return bound + MARGIN_MS;
}

/** Outcome of an atomic claim against the ledger. Storage decides; the route maps to HTTP. */
export type IdempotentClaim =
  /**
   * This caller won — proceed, then `complete` (or `release` on failure) with
   * this exact token. The token is what makes the commit a compare-and-set: a
   * holder whose lease was reclaimed cannot overwrite the winner's response.
   *
   * `reclaimed` marks the RECOVERY case: this caller took over an EXPIRED
   * claim. Both are "you won, proceed", which is why they share a variant and
   * why every existing caller is unaffected — but they are not the same event.
   * A live holder cannot outlive its lease (`idempotencyLeaseMs` derives from
   * the request timeout precisely so that it cannot), so a reclaim means a
   * previous holder DIED mid-request. ADR 0556 P1 needs to see that: without it
   * is indistinguishable from a first claim, and the most interesting outcome
   * the ledger produces would be reported as the most routine one.
   */
  | { outcome: 'claimed'; claimToken: string; reclaimed?: true }
  /** A completed response already exists for this exact (tenant, endpoint, key, digest). */
  | { outcome: 'replay'; responseStatus: number; responseBody: string }
  /** Another caller holds the claim and has not finished. */
  | { outcome: 'in-flight' }
  /** Same key, DIFFERENT request digest — the caller broke the idempotency contract. */
  | { outcome: 'mismatch' };
