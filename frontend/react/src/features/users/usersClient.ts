/**
 * Users feature client (host-extension, non-normative). Wraps
 * /v1/host/sample/users/*. The surface 404s when the `users` toggle is off — the
 * page gates on useFeatureAccess('users') so it never calls a disabled surface.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

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

const base = `${config.baseUrl}/v1/host/sample/users`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      detail = body?.message ?? '';
    } catch {
      /* non-JSON */
    }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

/** The caller's own durable record (find-or-create reconciliation seam). */
export async function getMe(): Promise<User> {
  const res = await fetch(`${base}/me`, fetchOpts({ headers: authedHeaders() }));
  return asJson<User>(res, 'getMe');
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
  if (!res.ok && res.status !== 204) throw new Error(`deleteUser returned ${res.status}`);
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
