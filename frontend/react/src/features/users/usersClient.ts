/**
 * Users feature client (host-extension, non-normative). Wraps
 * /host/openwop-app/users/*. The surface 404s when the `users` toggle is off — the
 * page gates on useFeatureAccess('users') so it never calls a disabled surface.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { readErrorCode, readErrorMessage } from '../../client/errorEnvelope.js';
import { noteSessionRefusal } from '../../client/sessionRefusal.js';

export type UserStatus = 'active' | 'disabled';
export type UserSource = 'oidc' | 'password' | 'saml' | 'scim' | 'manual';

export interface User {
  userId: string;
  tenantId: string;
  principalId: string;
  email?: string;
  displayName?: string;
  groups: string[];
  source: UserSource;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

const base = `${config.baseUrl}/host/openwop-app/users`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/**
 * Carries the HTTP status, because callers must distinguish "the server ANSWERED
 * that you have no record" (401/404) from "we could not reach it" (5xx, offline).
 * Without it both arrive as a bare Error and the session store settles an
 * unreadable read to `{ user: null, resolved: true }` — grade-data FRD-1/FRD-2.
 */
export class UsersApiError extends Error {
  /** The canonical envelope's machine-readable `error` code (`self_lockout`,
   *  `legal_hold`, `validation_error`, `account_disabled`, …) — USERS-UX-13/14/
   *  15/16 key their designed states on THIS, never on the English message. */
  readonly code: string | undefined;
  /** The parsed envelope, where `classifyHttpError`'s carrier walk reads it. */
  readonly body: unknown;
  constructor(message: string, readonly status: number, body?: unknown) {
    super(message);
    this.name = 'UsersApiError';
    this.body = body;
    this.code = readErrorCode(body);
  }
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    throw await usersError(res, ctx);
  }
  return (await res.json()) as T;
}

/** Build the typed failure off a non-ok response — keeps `error` AND
 *  `message`, and runs the ADR 0621 D5 session-refusal choke. */
async function usersError(res: Response, ctx: string): Promise<UsersApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  noteSessionRefusal(res.status, body);
  return new UsersApiError(readErrorMessage(body) || `${ctx} returned ${res.status}`, res.status, body);
}

/** The caller's own durable record (find-or-create reconciliation seam). */
export async function getMe(): Promise<User> {
  const res = await fetch(`${base}/me`, fetchOpts({ headers: authedHeaders() }));
  return asJson<User>(res, 'getMe');
}

/** ADR 0389 P1 — session security posture for the Security panel. */
export interface MySecurity {
  source: UserSource;
  /** Whether THIS session's sign-in verified a second factor (host-read
   *  `firebase.sign_in_second_factor` claim — never factor material). */
  mfaSessionVerified: boolean;
}

/** GET /users/me/security — the caller's identity source + session MFA mark. */
export async function getMySecurity(): Promise<MySecurity> {
  const res = await fetch(`${base}/me/security`, fetchOpts({ headers: authedHeaders() }));
  return asJson<MySecurity>(res, 'getMySecurity');
}

/**
 * ADR 0389 § Correction — tell the backend an authenticator was bound/unbound so
 * it can notify the user + write the tamper-evident audit row (NIST 800-63B-4
 * §4.1.2.1). Best-effort: a failure here must NEVER fail the user's security
 * action, and nothing authorizes on it (the ID-token claim remains the only
 * authorization signal).
 */
export async function reportFactorEvent(event: 'bound' | 'unbound', factorCount: number): Promise<void> {
  await fetch(`${base}/me/security/factor-event`, fetchOpts({
    method: 'POST',
    headers: { ...authedHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ event, factorCount }),
  })).catch(() => { /* best-effort */ });
}

/** Self-serve: set the caller's own display name (PATCH /users/me). */
export async function updateMyDisplayName(displayName: string): Promise<User> {
  const res = await fetch(`${base}/me`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ displayName }) }));
  return asJson<User>(res, 'updateMyDisplayName');
}

export async function listUsers(): Promise<User[]> {
  const res = await fetch(`${base}/users`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ users: User[] }>(res, 'listUsers')).users;
}

export async function createUser(input: { principalId: string; email?: string; displayName?: string }): Promise<User> {
  const res = await fetch(`${base}/users`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<User>(res, 'createUser');
}

export async function setUserEnabled(userId: string, enabled: boolean): Promise<User> {
  const verb = enabled ? 'enable' : 'disable';
  const res = await fetch(`${base}/users/${encodeURIComponent(userId)}/${verb}`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({}) }));
  return asJson<User>(res, 'setUserEnabled');
}

export async function deleteUser(userId: string): Promise<void> {
  const res = await fetch(`${base}/users/${encodeURIComponent(userId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  // Typed like every other failure here: a legal-hold / self-lockout 409 must
  // reach the page as its CODE, not as `deleteUser returned 409` (USERS-UX-15).
  if (!res.ok && res.status !== 204) throw await usersError(res, 'deleteUser');
}

/**
 * ADR 0621 D5 — admin "Sign out everywhere": bump the target's session epoch
 * so every live session of theirs is refused on its next request. Same gate
 * as disable (`host:members:manage`); the caller's OWN row 409s `self_lockout`.
 */
export async function revokeUserSessions(userId: string): Promise<void> {
  const res = await fetch(`${base}/users/${encodeURIComponent(userId)}/sessions/revoke`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: '{}' }));
  if (!res.ok) throw await usersError(res, 'revokeUserSessions');
}

/**
 * ADR 0621 D5 — self-service "Sign out of all other devices". The server
 * clears the CALLER's cookie too, so a success here IS a sign-out: the caller
 * must run the hard-sign-out path right after (`auth/hardSignOut.ts`).
 */
export async function revokeMySessions(): Promise<void> {
  const res = await fetch(`${base}/me/sessions/revoke`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: '{}' }));
  if (!res.ok) throw await usersError(res, 'revokeMySessions');
}

/** ADR 0003 Phase 4a — bind the current Firebase OIDC identity to a durable User.
 *  Called once after OIDC sign-in so subsequent requests resolve the canonical
 *  `user:<userId>` subject (the backend re-keys any `oidc:<sub>` memberships and
 *  issues a bound cookie). Idempotent + best-effort: a 404 (the `users` toggle is
 *  off) is a benign no-op and MUST NOT fail sign-in. Returns the bound user, or
 *  null when unavailable. */
export async function bindOidc(): Promise<{ user: User; rekeyed: number } | null> {
  const res = await fetch(`${base}/auth/oidc/bind`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: '{}' }));
  if (!res.ok) return null; // 404 (feature off) / transient — best-effort, never blocks sign-in.
  return (await res.json()) as { user: User; rekeyed: number };
}

/** Sign out — expire the backend session cookie. Best-effort (never throws). */
export async function logout(): Promise<void> {
  await fetch(`${base}/auth/logout`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: '{}' })).catch(() => {});
}
