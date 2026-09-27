/**
 * Canonical user identity & session binding (ADR 0003).
 *
 * Proves the architectural fix end to end without HTTP plumbing:
 *  - issueUserSession writes a cookie that, read back by authMiddleware, yields
 *    `req.userId` AND the stable, opaque `user:<uuid>` principal — NOT a
 *    `session:<sid>` or a PII `password:<email>` principal (RFC 0048 / finding C2);
 *  - resolveCallerUser keys on `req.userId` (the ONE keying that makes /me, MFA,
 *    and the /login gate agree — finding C1), falls back to principal-keyed
 *    reconciliation for OIDC, and refuses anonymous sessions (finding #8).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { authMiddleware, issueUserSession } from '../src/middleware/auth.js';
import { __resetUsersStore, createUser } from '../src/features/users/usersService.js';
import { __resetSessionAuthority, registerSessionAuthority } from '../src/host/sessionAuthority.js';
import { usersSessionAuthority } from '../src/features/users/feature.js';
import { resolveCallerUser } from '../src/features/users/usersGuards.js';

const dir = mkdtempSync(join(tmpdir(), 'owop-id-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A session secret so signSession/verifySession round-trip deterministically.
process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-chars-long';

/** Capture the cookie value issueUserSession sets, then replay it through
 *  authMiddleware as an incoming request. Returns the resolved request. */
async function roundTripSession(setCookieHeader: string): Promise<{ userId?: string; principalId?: string; tenantId?: string; nextErr?: unknown }> {
  // Set-Cookie: __session=<value>; Path=/; ...   -> extract the value.
  const value = /__session=([^;]+)/.exec(setCookieHeader)?.[1] ?? '';
  const req: any = { method: 'GET', path: '/v1/host/openwop-app/users/me', query: {}, header: (h: string) => (h.toLowerCase() === 'cookie' ? `__session=${value}` : undefined) };
  const res: any = { append() {}, setHeader() {}, getHeader() {}, status() { return res; }, json() {}, end() {} };
  let nexted = false;
  let nextErr: unknown;
  await new Promise<void>((resolve) => {
    void authMiddleware()(req, res, (err?: unknown) => { nexted = true; nextErr = err; resolve(); });
    // give a sync handler a tick to fall through if it didn't call next
    setTimeout(resolve, 50);
  });
  expect(nexted, 'authMiddleware should pass the bound session through').toBe(true);
  return { userId: req.userId, principalId: req.principal?.principalId, tenantId: req.tenantId, nextErr };
}

describe('ADR 0003: session binding round-trip', () => {
  // ADR 0621 — a `userId`-bearing cookie is validated per request through the
  // session-authority seam, which has NO permissive default. This bare
  // (no-createApp) harness registers the users feature's real authority, and
  // the row the cookie names must exist (an unknown id is `account_erased`).
  beforeEach(async () => {
    __resetHostExtPersistence();
    initHostExtPersistence(openSqliteStorage(join(dir, 'bind.db')));
    await __resetUsersStore();
    registerSessionAuthority(usersSessionAuthority);
  });

  it('issueUserSession -> authMiddleware yields req.userId + opaque user principal', async () => {
    const u = await createUser({ tenantId: 'acme', principalId: 'password:abc@acme.test', source: 'password' });
    let cookie = '';
    const res: any = { append: (k: string, v: string) => { if (k.toLowerCase() === 'set-cookie') cookie = Array.isArray(v) ? v[0] : v; } };
    issueUserSession(res, { userId: u.userId, tenantId: 'acme', epoch: 0 });
    expect(cookie).toContain('__session=');

    const resolved = await roundTripSession(cookie);
    expect(resolved.nextErr).toBeUndefined();
    expect(resolved.userId).toBe(u.userId);
    expect(resolved.principalId).toBe(u.userId); // NOT session:<sid>, NOT double-prefixed
    expect(resolved.tenantId).toBe('acme');
    // RFC 0048: the principal is opaque + carries no PII (no email).
    expect(resolved.principalId).not.toMatch(/@/);
    expect(resolved.principalId!.startsWith('user:')).toBe(true);
  });

  it('ADR 0621 — with NO session authority registered, a userId-bearing cookie is refused 503 (no permissive default)', async () => {
    const u = await createUser({ tenantId: 'acme', principalId: 'password:noauth@acme.test', source: 'password' });
    let cookie = '';
    const res: any = { append: (k: string, v: string) => { if (k.toLowerCase() === 'set-cookie') cookie = Array.isArray(v) ? v[0] : v; } };
    issueUserSession(res, { userId: u.userId, tenantId: 'acme', epoch: 0 });
    __resetSessionAuthority();
    const resolved = await roundTripSession(cookie);
    expect(resolved.nextErr).toMatchObject({ code: 'session_authority_unregistered', httpStatus: 503 });
    expect(resolved.userId).toBeUndefined();
  });
});

describe('ADR 0003: resolveCallerUser keys on req.userId', () => {
  beforeEach(async () => {
    __resetHostExtPersistence();
    initHostExtPersistence(openSqliteStorage(join(dir, 'id.db')));
    await __resetUsersStore();
  });

  it('a bound session resolves the SAME durable user by id (finding C1)', async () => {
    const u = await createUser({ tenantId: 't', principalId: 'password:jane@t.test', source: 'password' });
    const req: any = { tenantId: 't', userId: u.userId, principal: { principalId: u.userId } };
    const resolved = await resolveCallerUser(req);
    expect(resolved.userId).toBe(u.userId); // /me and MFA now agree on this user
    expect(resolved.source).toBe('password');
  });

  it('an OIDC bearer (no bound userId) falls back to principal reconciliation', async () => {
    const req: any = { tenantId: 't', principal: { principalId: 'oidc:sub-9' } };
    const a = await resolveCallerUser(req);
    expect(a.principalId).toBe('oidc:sub-9');
    expect(a.source).toBe('oidc');
    // idempotent — same principal, same durable user
    expect((await resolveCallerUser(req)).userId).toBe(a.userId);
  });

  it('an anonymous session is refused (finding #8)', async () => {
    const req: any = { tenantId: 'anon:xyz', principal: { principalId: 'session:xyz' } };
    await expect(resolveCallerUser(req)).rejects.toMatchObject({ httpStatus: 401 });
  });

  it('a bound session pointing at a deleted user fails closed', async () => {
    const req: any = { tenantId: 't', userId: 'user:gone', principal: { principalId: 'user:gone' } };
    await expect(resolveCallerUser(req)).rejects.toMatchObject({ httpStatus: 401 });
  });
});
