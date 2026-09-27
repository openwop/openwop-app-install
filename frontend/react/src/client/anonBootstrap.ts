/**
 * ADR 0750 — recover from the major-2 "no credential" 401 by establishing a
 * session, then retrying ONCE.
 *
 * On the major-2 wire the backend refuses a request that presents no credential
 * (no bearer, no session cookie) with `401` and a `WWW-Authenticate: Bearer
 * resource_metadata=…` challenge carrying NO `error` parameter (RFC 0200 §B.1).
 * It used to mint a cookie-per-visitor anonymous session instead. A first-visit
 * demo visitor whose first call is a v2 run read (a cold deep link to
 * `/runs/:id`, racing the shell's `/me`) would now see that 401, so the shared
 * v2 fetch paths route through here: bootstrap the session on the major-1 `/me`
 * route (which still mints), then retry the original request exactly once.
 *
 * ONLY that shape is retried. A challenge WITH `error=` (`invalid_token`: a
 * credential was presented and refused) is a real refusal that a new anonymous
 * session must never paper over — the ADR 0434 "no silent identity switch" rule.
 */
import { refreshBackendSession } from '../auth/backendSession.js';

/** True for the no-credential challenge: `Bearer` and no `error` parameter. */
export function isNoCredentialChallenge(res: Response): boolean {
  if (res.status !== 401) return false;
  const challenge = res.headers.get('www-authenticate');
  if (!challenge || !/^\s*Bearer\b/i.test(challenge)) return false;
  return !/\berror\s*=/i.test(challenge);
}

/**
 * Run `doFetch`; if it answers the no-credential challenge, establish a session
 * (deduped — concurrent callers share one `/me`) and run it once more. Never
 * retries twice: a second no-credential 401 is returned as-is.
 */
export async function withSessionBootstrap(doFetch: () => Promise<Response>): Promise<Response> {
  const first = await doFetch();
  if (!isNoCredentialChallenge(first)) return first;
  await refreshBackendSession();
  return doFetch();
}
