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

/** Phase 2 — create a local (email/password) account. Returns the new user (the
 *  one-time verifyToken is surfaced only outside production by the backend). */
export async function signupLocal(input: { email: string; password: string; displayName?: string }): Promise<{ user: User; verifyToken?: string }> {
  const res = await fetch(`${base}/auth/signup`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<{ user: User; verifyToken?: string }>(res, 'signupLocal');
}
