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

// SEC-1 — reuse cookieSession's `readSessionSecret` as the SINGLE source for the signing
// secret. This token IS a cookie-mode capability, so it inherits the same fail-closed gate
// (throws in production when `OPENWOP_SESSION_SECRET` is unset) instead of silently falling
// back to an ephemeral secret of its own — no second copy to drift, fail-closed on its own.
function sign(runId: string, exp: number): string {
  return createHmac('sha256', readSessionSecret())
    .update(`${PREFIX}${runId}:${exp}`)
    .digest('base64url');
}

/** SEC-2 — log a token rejection at DEBUG (off by default in prod) so a stream 404 is
 *  diagnosable, with a coarse `reason` and the (non-secret) `runId` ONLY — never the token
 *  or the signing secret. */
function reject(runId: string, reason: 'malformed' | 'expired' | 'bad_signature'): false {
  log.debug('run_stream_token_rejected', { runId, reason });
  return false;
}

/** Mint a capability granting read of `runId`'s event stream for TTL_SECONDS. */
export function mintRunStreamToken(runId: string, nowMs: number = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + TTL_SECONDS;
  return `v1.${exp}.${sign(runId, exp)}`;
}

/** True iff `token` is a well-formed, unexpired capability for `runId`. */
export function verifyRunStreamToken(runId: string, token: string, nowMs: number = Date.now()): boolean {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return reject(runId, 'malformed');
  const exp = Number(parts[1]);
  if (!Number.isInteger(exp)) return reject(runId, 'malformed');
  if (exp <= Math.floor(nowMs / 1000)) return reject(runId, 'expired');
  const expectedSig = sign(runId, exp);
  const a = Buffer.from(parts[2]!);
  const b = Buffer.from(expectedSig);
  // timingSafeEqual throws on length mismatch — guard so a malformed token is a
  // clean `false`, not a 500.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return reject(runId, 'bad_signature');
  return true;
}
