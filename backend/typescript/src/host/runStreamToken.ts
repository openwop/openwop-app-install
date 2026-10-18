/**
 * Run-scoped stream capability token — the cross-origin-safe authorization for
 * the run-event SSE stream (ADR 0088 follow-up).
 *
 * Why this exists: the run-read tenant gate (`runAccess.loadReadableRun`)
 * enforces `run.tenantId === req.tenantId`. That works for the same-origin
 * JSON paths (the `openwop.session` cookie travels), but the SSE stream hits a
 * DIFFERENT origin (`config.sseBaseUrl` → `*.run.app`), where the cookie does
 * NOT travel. A signed-in user can send their Firebase ID token cross-origin
 * (handled in `streamsClient`), but a **BYOK user with no account** has no
 * token — so cross-origin they can never match their own anon tenant, and the
 * live chat feed 404s.
 *
 * This token closes that gap. It is minted ONLY behind the normal same-origin
 * tenant check (`GET /v1/runs/:id/events/token`, which an anon owner passes via
 * their same-origin cookie) and grants read of EXACTLY one run's event stream
 * for a bounded window. The client presents it on the cross-origin SSE request
 * (`?streamToken=…`). Stateless: an HMAC over `runId:exp` keyed by the session
 * secret — no storage, verifiable on any instance.
 *
 * Security: the capability is mintable only by a caller who already passes the
 * tenant gate for that run (the owner). A third party who merely knows a
 * `runId` cannot mint one (the mint endpoint 404s them) and cannot forge one
 * (no secret). Domain-separated from cookie-session signatures by the
 * `runstream:v1:` message prefix.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createLogger } from '../observability/logger.js';
import { readSessionSecret } from '../middleware/cookieSession.js';

const log = createLogger('host.runStreamToken');

/** Capability lifetime. Short enough to bound a leaked URL, long enough that a
 *  reconnect loop re-mints rarely. The client re-fetches per (re)connect, so a
 *  longer-lived stream just gets a fresh token on its next reconnect. */
const TTL_SECONDS = 3600;
const PREFIX = 'runstream:v1:';
/** Issue #4543 — a grant WITHOUT the run's payload, for a member who may watch
 *  the run but neither started it nor administers the workspace. The cross-origin
 *  stream arrives on a fresh anonymous session, so the caller's identity cannot be
 *  re-checked there: what the minting caller may read is carried in the token.
 *  Its own message prefix (and `v1r.` wire tag) means a redacted token can never
 *  verify as a full one. */
const REDACTED_PREFIX = 'runstream:v1:redacted:';

/** What a stream token grants: the full event log, or the log without payloads. */
export type RunStreamGrant = 'full' | 'redacted';

// SEC-1 — reuse cookieSession's `readSessionSecret` as the SINGLE source for the signing
// secret. This token IS a cookie-mode capability, so it inherits the same fail-closed gate
// (throws in production when `OPENWOP_SESSION_SECRET` is unset) instead of silently falling
// back to an ephemeral secret of its own — no second copy to drift, fail-closed on its own.
function sign(runId: string, exp: number, grant: RunStreamGrant): string {
  return createHmac('sha256', readSessionSecret())
    .update(`${grant === 'full' ? PREFIX : REDACTED_PREFIX}${runId}:${exp}`)
    .digest('base64url');
}

/** SEC-2 — log a token rejection at DEBUG (off by default in prod) so a stream 404 is
 *  diagnosable, with a coarse `reason` and the (non-secret) `runId` ONLY — never the token
 *  or the signing secret. */
function reject(runId: string, reason: 'malformed' | 'expired' | 'bad_signature'): false {
  log.debug('run_stream_token_rejected', { runId, reason });
  return false;
}

/** Mint a capability granting read of `runId`'s event stream for TTL_SECONDS.
 *  `grant: 'redacted'` mints one whose holder reads the events without payloads. */
export function mintRunStreamToken(runId: string, nowMs: number = Date.now(), grant: RunStreamGrant = 'full'): string {
  const exp = Math.floor(nowMs / 1000) + TTL_SECONDS;
  return `${grant === 'full' ? 'v1' : 'v1r'}.${exp}.${sign(runId, exp, grant)}`;
}

/** The grant `token` carries for `runId`, or `null` when it is malformed,
 *  expired, or not a capability for `runId`. */
export function runStreamTokenGrant(runId: string, token: string, nowMs: number = Date.now()): RunStreamGrant | null {
  const parts = token.split('.');
  const grant: RunStreamGrant | null = parts[0] === 'v1' ? 'full' : parts[0] === 'v1r' ? 'redacted' : null;
  if (parts.length !== 3 || grant === null) { reject(runId, 'malformed'); return null; }
  const exp = Number(parts[1]);
  if (!Number.isInteger(exp)) { reject(runId, 'malformed'); return null; }
  if (exp <= Math.floor(nowMs / 1000)) { reject(runId, 'expired'); return null; }
  const expectedSig = sign(runId, exp, grant);
  const a = Buffer.from(parts[2]!);
  const b = Buffer.from(expectedSig);
  // timingSafeEqual throws on length mismatch — guard so a malformed token is a
  // clean `null`, not a 500.
  if (a.length !== b.length || !timingSafeEqual(a, b)) { reject(runId, 'bad_signature'); return null; }
  return grant;
}

/** True iff `token` is a well-formed, unexpired capability for `runId` (either grant). */
export function verifyRunStreamToken(runId: string, token: string, nowMs: number = Date.now()): boolean {
  return runStreamTokenGrant(runId, token, nowMs) !== null;
}
