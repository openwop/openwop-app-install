/**
 * sessionRefusal — the ONE choke for a mid-session hard sign-out (ADR 0621 D5 /
 * `USERS-UX-13`).
 *
 * The backend now REFUSES a live session whose account was disabled, erased, or
 * whose sessions an admin (or the user, from another device) revoked: a 401
 * carrying `error ∈ {account_disabled, account_erased, session_revoked}`, with
 * the `__session` cookie cleared on the same response. Before this module every
 * 401 was classified from its STATUS alone (`classifyHttpError.ts`), so such a
 * refusal would have been swallowed into a per-page "your session may have
 * expired" while the header kept showing the account — and, worse, the cached
 * Firebase ID token would re-promote on the very next request (D1 (c) refuses
 * that server-side, but the client would loop).
 *
 * There is no single fetch wrapper in this SPA (167 raw `fetch(…, fetchOpts())`
 * sites), so the hook is called from the SHARED helpers every typed client
 * rides — `requestJson`, `apiErrorFrom`, `assertSynced`, the SDK fetch wrapper
 * in `runsClient`, and `usersClient.asJson` (the `/me` read every
 * `SignInButton` mount performs, which makes the choke reachable from ANY page).
 *
 * Cycle-free by the `onAuthChange` rule: this module never imports the auth
 * layer. `auth/hardSignOut.ts` registers the actual sign-out action.
 *
 * A 503 `session_authority_unavailable` is NOT a refusal (D6) — it is a
 * transient error and never reaches the handler.
 */
/** Minimal envelope-code read (flat `error`, legacy nested `error.code`) —
 *  duplicated from `errorEnvelope.readErrorCode` on purpose so that module can
 *  static-import THIS one (`apiErrorFrom` calls the hook) without a cycle. */
function readErrorCode(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const b = body as { error?: unknown };
  if (typeof b.error === 'string' && b.error.length > 0) return b.error;
  const nested = b.error;
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    const code = (nested as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return undefined;
}

export const SESSION_REFUSAL_CODES = ['account_disabled', 'account_erased', 'session_revoked'] as const;
export type SessionRefusalCode = (typeof SESSION_REFUSAL_CODES)[number];

export function isSessionRefusalCode(code: unknown): code is SessionRefusalCode {
  return typeof code === 'string' && (SESSION_REFUSAL_CODES as readonly string[]).includes(code);
}

/** The refusal code a 401 body carries, or null when the 401 is an ordinary
 *  "no session" (`sign_in_required`) that must NOT evict anyone. */
export function sessionRefusalOf(status: number, body: unknown): SessionRefusalCode | null {
  if (status !== 401) return null;
  const code = readErrorCode(body);
  // RFC 0170 — on the v2 wire a revoked session is spelled `credential_revoked`
  // (the backend aliases its `session_revoked`). Same refusal, same eviction.
  if (code === 'credential_revoked') return 'session_revoked';
  return isSessionRefusalCode(code) ? code : null;
}

type RefusalHandler = (code: SessionRefusalCode) => void;
let handler: RefusalHandler | null = null;

/** Register the hard-sign-out action (the auth layer does this once). */
export function registerSessionRefusalHandler(fn: RefusalHandler | null): void {
  handler = fn;
}

/**
 * Sync form — for helpers that have ALREADY parsed the error body. Returns
 * true when the response was a session refusal (the handler has been invoked;
 * the caller should still throw its typed error so the in-flight page settles).
 */
export function noteSessionRefusal(status: number, body: unknown): boolean {
  const code = sessionRefusalOf(status, body);
  if (!code) return false;
  handler?.(code);
  return true;
}

/**
 * Async form — for wrappers that hold the raw `Response`. Reads the body off a
 * CLONE so the caller's own parse is unaffected. Only a 401 is ever read.
 */
export async function handleSessionRefusal(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  const body: unknown = await res.clone().json().catch(() => undefined);
  return noteSessionRefusal(res.status, body);
}
