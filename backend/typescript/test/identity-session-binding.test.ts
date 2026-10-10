/**
 * Canonical user identity & session binding (ADR 0003; ADR 0621 for the
 * no-permissive-default authority seam).
 *
 * Proves the architectural fix on a BARE Express app (real `Request`/`Response`
 * objects, no `createApp`):
 *  - issueUserSession writes a cookie that, read back by authMiddleware, yields
 *    `req.userId` AND the stable, opaque `user:<uuid>` principal — NOT a
 *    `session:<sid>` or a PII `password:<email>` principal (RFC 0048 / finding C2);
 *  - with NO session authority registered, that cookie is refused 503
 *    `session_authority_unregistered` (ADR 0621 — no permissive default);
 *  - resolveCallerUser keys on `req.userId` (the ONE keying that makes /me, MFA,
 *    and the /login gate agree — finding C1), falls back to principal-keyed
 *    reconciliation for OIDC, refuses anonymous sessions (finding #8), and fails
 *    closed on a bound id whose row is gone.
 *
 * Sabotage that turns it red: `auth.ts` cookie branch
 * `principalId: session.userId,` → `` principalId: `session:${session.sid}`, ``
 * reds the round-trip case.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { authMiddleware, issueUserSession } from '../src/middleware/auth.js';
import { __resetUsersStore, createUser } from '../src/features/users/usersService.js';
import { __resetSessionAuthority, registerSessionAuthority } from '../src/host/sessionAuthority.js';
import { usersSessionAuthority } from '../src/features/users/feature.js';
import { resolveCallerUser } from '../src/features/users/usersGuards.js';
import { OpenwopError, type Principal } from '../src/types.js';

const dir = mkdtempSync(join(tmpdir(), 'owop-id-'));

// A session secret so signSession/verifySession round-trip deterministically.
process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-chars-long';

/** The caller shape a route sees after the auth middleware (set directly in
 *  the resolveCallerUser block, which is a pure read of these fields). */
interface Caller { tenantId: string; userId?: string; principal: Principal }

let server: http.Server;
let BASE = '';
/** The caller the `/resolve` route injects before `resolveCallerUser`. */
let caller: Caller = { tenantId: '', principal: { principalId: '', tenants: [], token: '' } };

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Mint: issueUserSession on a REAL response.
  app.post('/mint', (req: Request, res: Response) => {
    const body = req.body as { userId: string; tenantId: string };
    issueUserSession(res, { userId: body.userId, tenantId: body.tenantId, epoch: 0, freshAuth: true });
    res.json({ ok: true });
  });
  // Read back: the real auth middleware on a real request.
  app.get('/host/openwop-app/users/me', authMiddleware(), (req: Request, res: Response) => {
    res.json({ userId: req.userId ?? null, principalId: req.principal?.principalId ?? null, tenantId: req.tenantId ?? null });
  });
  // resolveCallerUser over the fields the middleware would have set.
  app.get('/resolve', (req: Request, res: Response, next: NextFunction) => {
    req.tenantId = caller.tenantId;
    if (caller.userId !== undefined) req.userId = caller.userId;
    req.principal = caller.principal;
    resolveCallerUser(req).then((u) => res.json({ userId: u.userId, principalId: u.principalId, source: u.source }), next);
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof OpenwopError) { res.status(err.httpStatus).json({ code: err.code }); return; }
    res.status(500).json({ code: 'unexpected', message: err instanceof Error ? err.message : String(err) });
  });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

async function mintCookie(userId: string, tenantId: string): Promise<string> {
  const res = await fetch(`${BASE}/mint`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId, tenantId }) });
  expect(res.status).toBe(200);
  const pair = /(__session=[^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
  expect(pair, 'issueUserSession must set the session cookie').toBeTruthy();
  return pair!;
}
async function readBack(cookie: string): Promise<{ status: number; body: { userId?: string | null; principalId?: string | null; tenantId?: string | null; code?: string } }> {
  const res = await fetch(`${BASE}/host/openwop-app/users/me`, { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as { userId?: string | null; principalId?: string | null; tenantId?: string | null; code?: string } };
}
async function resolve(c: Caller): Promise<{ status: number; body: { userId?: string; principalId?: string; source?: string; code?: string } }> {
  caller = c;
  const res = await fetch(`${BASE}/resolve`);
  return { status: res.status, body: (await res.json()) as { userId?: string; principalId?: string; source?: string; code?: string } };
}

describe('ADR 0003: session binding round-trip', () => {
  // ADR 0621 — a `userId`-bearing cookie is validated per request through the
  // session-authority seam, which has NO permissive default. This bare harness
  // registers the users feature's real authority, and the row the cookie names
  // must exist (an unknown id is `account_erased`).
  beforeEach(async () => {
    __resetHostExtPersistence();
    initHostExtPersistence(openSqliteStorage(join(dir, 'bind.db')));
    await __resetUsersStore();
    registerSessionAuthority(usersSessionAuthority);
  });

  it('issueUserSession -> authMiddleware yields req.userId + opaque user principal', async () => {
    const u = await createUser({ tenantId: 'acme', principalId: 'password:abc@acme.test', source: 'password' });
    const resolved = await readBack(await mintCookie(u.userId, 'acme'));
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body.userId).toBe(u.userId);
    expect(resolved.body.principalId).toBe(u.userId); // NOT session:<sid>, NOT double-prefixed
    expect(resolved.body.tenantId).toBe('acme');
    // RFC 0048: the principal is opaque + carries no PII (no email).
    expect(resolved.body.principalId).not.toMatch(/@/);
    expect(resolved.body.principalId!.startsWith('user:')).toBe(true);
  });

  it('ADR 0621 — with NO session authority registered, a userId-bearing cookie is refused 503 (no permissive default)', async () => {
    const u = await createUser({ tenantId: 'acme', principalId: 'password:noauth@acme.test', source: 'password' });
    const cookie = await mintCookie(u.userId, 'acme');
    __resetSessionAuthority();
    const resolved = await readBack(cookie);
    expect(resolved.status).toBe(503);
    expect(resolved.body.code).toBe('session_authority_unregistered');
    expect(resolved.body.userId).toBeUndefined(); // the route never ran
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
    const r = await resolve({ tenantId: 't', userId: u.userId, principal: { principalId: u.userId, tenants: ['t'], token: '' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.userId).toBe(u.userId); // /me and MFA now agree on this user
    expect(r.body.source).toBe('password');
  });

  it('an OIDC bearer (no bound userId) falls back to principal reconciliation', async () => {
    const c: Caller = { tenantId: 't', principal: { principalId: 'oidc:sub-9', tenants: ['t'], token: '' } };
    const a = await resolve(c);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.principalId).toBe('oidc:sub-9');
    expect(a.body.source).toBe('oidc');
    // idempotent — same principal, same durable user
    expect((await resolve(c)).body.userId).toBe(a.body.userId);
  });

  it('an anonymous session is refused (finding #8)', async () => {
    const r = await resolve({ tenantId: 'anon:xyz', principal: { principalId: 'session:xyz', tenants: ['anon:xyz'], token: '' } });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('sign_in_required');
  });

  it('a bound session pointing at a deleted user fails closed', async () => {
    const r = await resolve({ tenantId: 't', userId: 'user:gone', principal: { principalId: 'user:gone', tenants: ['t'], token: '' } });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('sign_in_required');
  });
});
