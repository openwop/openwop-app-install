/**
 * ADR 0003 Phase 4a — OIDC bind route + middleware honoring of the bound userId.
 *
 * Proves over HTTP against the real app (createApp + the real auth middleware +
 * a synthetic OIDC issuer):
 *   - POST /host/openwop-app/users/auth/oidc/bind find-or-creates a durable User for
 *     the verified oidc:<sub> and is idempotent;
 *   - the FIRST unbound touch already provisions the personal-owner member under
 *     the CANONICAL user:<userId> (ADR 0003 canonical-identity fix), so bind is a
 *     no-op re-key (rekeyed=0) — no duplicate owner/board accrues per auth channel;
 *     the re-key path stays as a safety net for legacy oidc:<sub> memberships;
 *   - after bind, the bound user-tier cookie makes the OIDC bearer resolve the
 *     stable user:<userId> subject (membership keys on it);
 *   - bind without an OIDC bearer is refused (`401 unauthenticated`, the route's
 *     own verified-bearer guard);
 *   - a bound OIDC user stays in a switched shared workspace on bearer requests;
 *   - re-enabling a disabled user restores bind / switch (the REFUSAL half —
 *     the middleware's `401 account_disabled` — is `auth-session-epoch.test.ts`
 *     (ii)/(iii), which goes red under the same break, so it is not repeated);
 *   - the same human across unbound bearer + bound cookie gets ONE personal board;
 *   - ADR 0684: bind auto-joins the CANONICAL subject into a declared default
 *     workspace (no `user:user:` double prefix).
 *
 * Sabotage that turns it red: `auth.ts`
 * `if (await isWorkspaceMember(effectiveSubject, requested)) active = requested;`
 * → `isWorkspaceMember(subject, requested)` reds the switched-workspace case.
 *
 * @see docs/adr/0003-canonical-user-identity-session-binding.md (Phase 4a)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync, createHash, type KeyObject } from 'node:crypto';
import express from 'express';
import { createApp } from '../src/index.js';
import { _resetOidcVerifier } from '../src/middleware/auth.js';
import { listMembers, isWorkspaceMember } from '../src/host/accessControlService.js';
import { ensureFeatureDefaultOrgs, type FeatureDefaultOrg } from '../src/host/featureDefaultOrgs.js';
import { setDefaultWorkspaceTargets } from '../src/host/workspaceJoinLedger.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { getBoard, personalBoardId } from '../src/host/kanbanService.js';
import { setUserStatus } from '../src/features/users/usersService.js';

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

let BASE: string;
const AUD = 'openwop-test-aud';
let server: http.Server;
let issuerServer: http.Server;
let issuer: string;
let privateKey: KeyObject;

function mint(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: 'test-kid-1', typ: 'JWT' };
  const payload = { iss: issuer, aud: AUD, sub, iat: now, exp: now + 300 };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createSign('sha256').update(signingInput).sign(privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

/** Reproduce middleware/auth.ts `tenantIdFromOidc`. */
function personalTenantOfSub(sub: string): string {
  return `user:${createHash('sha256').update(`${issuer}:${sub}`).digest('hex').slice(0, 32)}`;
}

beforeAll(async () => {
  const { publicKey, privateKey: priv } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = priv;
  const pubJwk = publicKey.export({ format: 'jwk' });
  const jwks = { keys: [{ ...pubJwk, kid: 'test-kid-1', alg: 'RS256', use: 'sig' }] };
  const issuerApp = express();
  issuerApp.get('/.well-known/jwks.json', (_req, res) => res.json(jwks));
  issuerServer = await new Promise<http.Server>((r) => { const s = issuerApp.listen(0, '127.0.0.1', () => r(s)); });
  issuer = `http://127.0.0.1:${(issuerServer.address() as { port: number }).port}`;

  process.env.OPENWOP_OIDC_ISSUER = issuer;
  process.env.OPENWOP_OIDC_AUDIENCE = AUD;
  process.env.OPENWOP_OIDC_JWKS_URL = `${issuer}/.well-known/jwks.json`;
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  _resetOidcVerifier();

  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => issuerServer.close(() => res()));
  _resetOidcVerifier();
  for (const k of ['OPENWOP_OIDC_ISSUER', 'OPENWOP_OIDC_AUDIENCE', 'OPENWOP_OIDC_JWKS_URL']) delete process.env[k];
});

/** The union of the response bodies this file reads (bind, me/workspaces,
 *  workspace create/switch, personal board, error envelope). */
interface Body {
  error?: string;
  bound?: boolean;
  rekeyed?: number;
  user?: { userId: string };
  workspaceId?: string;
  active?: string;
  workspaces?: Array<{ workspaceId: string; roles: string[] }>;
  board?: { id: string };
}
interface Res { status: number; body: Body }
/** A bearer-carrying client with a cookie jar (the SPA shape: bearer + __session). */
function client(token: string): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    const setCookies: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [];
    for (const sc of setCookies) {
      // ADR 0621 — honour a cookie CLEAR (`__session=; …Max-Age=0`) the way a
      // browser does: the jar drops the session instead of replaying it.
      if (/^__session=;/.test(sc)) { cookie = ''; continue; }
      const m = /(__session=[^;]+)/.exec(sc);
      if (m) cookie = m[1];
    }
    const out = res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Body);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

describe('ADR 0003 Phase 4a — OIDC bind', () => {
  it('refuses bind without an OIDC bearer', async () => {
    const res = await fetch(`${BASE}/host/openwop-app/users/auth/oidc/bind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Body & { message?: string };
    expect(body.error).toBe('unauthenticated');
    expect(body.message).toBe('OIDC bind requires a verified OIDC bearer.');
  });

  it('first unbound touch provisions the owner member under the CANONICAL user:<userId>; bind is then a no-op re-key', async () => {
    const sub = 'firebase-uid-bind-1';
    const oidcSubject = `oidc:${sub}`;
    const personalTenant = personalTenantOfSub(sub);
    const c = client(mint(sub));

    // First touch (unbound OIDC bearer) provisions the personal workspace. With
    // the canonical-identity fix (ADR 0003), the personal-owner member + board are
    // keyed on the caller's ONE durable user:<userId> from the START — never the
    // volatile oidc:<sub> — so no duplicate owner / "My Board" accrues per auth
    // channel (the bug: two "My Board"s + a stray principal on /users).
    expect((await c.get('/host/openwop-app/me/workspaces')).status).toBe(200);
    expect(await isWorkspaceMember(oidcSubject, personalTenant)).toBe(false);
    const owners0 = (await listMembers(personalTenant, personalTenant)).filter((m) => m.roles.includes('owner'));
    expect(owners0.length).toBe(1);
    expect(owners0[0]!.subject).toMatch(/^user:/);

    // Bind: resolves the SAME canonical durable user; the owner member is already
    // canonical, so there is NOTHING to re-key (the re-key path stays as a safety
    // net for legacy memberships seeded under oidc:<sub> before this fix).
    const bind = await c.post('/host/openwop-app/users/auth/oidc/bind');
    expect(bind.status, JSON.stringify(bind.body)).toBe(200);
    expect(bind.body.bound).toBe(true);
    const userId = bind.body.user!.userId;
    expect(userId).toMatch(/^user:/);
    expect(owners0[0]!.subject).toBe(userId); // first-touch owner WAS the canonical id
    expect(bind.body.rekeyed).toBe(0);

    // The owner member keys on the canonical user:<userId>, never oidc:<sub>.
    expect(await isWorkspaceMember(userId, personalTenant)).toBe(true);
    expect(await isWorkspaceMember(oidcSubject, personalTenant)).toBe(false);

    // Idempotent: a second bind resolves the SAME userId, still nothing to re-key.
    const bind2 = await c.post('/host/openwop-app/users/auth/oidc/bind');
    expect(bind2.body.user!.userId).toBe(userId);
    expect(bind2.body.rekeyed).toBe(0);
  });

  it('after bind, the bound cookie makes the bearer resolve the durable user:<userId>', async () => {
    const sub = 'firebase-uid-bind-2';
    const personalTenant = personalTenantOfSub(sub);
    const c = client(mint(sub));

    const bind = await c.post('/host/openwop-app/users/auth/oidc/bind');
    const userId = bind.body.user!.userId;

    // A subsequent request (bearer + bound cookie) resolves user:<userId>: the
    // personal-workspace owner membership (keyed user:<userId>) is honored.
    const me = await c.get('/host/openwop-app/me/workspaces');
    expect(me.status).toBe(200);
    const personal = me.body.workspaces?.find((w) => w.workspaceId === personalTenant);
    expect(personal).toBeTruthy();
    expect(personal!.roles).toContain('owner');
    expect(await isWorkspaceMember(userId, personalTenant)).toBe(true);
  });

  // Regression: a bound OIDC user who switches into a SHARED workspace must STAY
  // there on subsequent BEARER requests. The switch's issueUserSession drops the
  // cookie `subject`; matching the bound cookie on `subject` (the old code) would
  // un-bind the caller → bounce them to personal as oidc:<sub> → lose access to
  // their re-keyed shared memberships. The fix matches on `personalTenant`.
  it('a bound OIDC user STAYS in a switched shared workspace on bearer requests', async () => {
    const sub = 'firebase-uid-switch';
    const c = client(mint(sub));

    const userId = (await c.post('/host/openwop-app/users/auth/oidc/bind')).body.user!.userId;

    // Create a shared workspace (caller becomes owner) and switch into it.
    const ws = (await c.post('/host/openwop-app/workspaces', { name: 'SwitchCo' })).body.workspaceId!;
    expect(ws).toMatch(/^ws:/);
    const sw = await c.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    expect(sw.body.active).toBe(ws);

    // The next BEARER request must keep active === ws (not revert to personal)
    // and resolve the caller as user:<userId> (shared membership keyed on it).
    const me = await c.get('/host/openwop-app/me/workspaces');
    expect(me.body.active).toBe(ws);
    const shared = me.body.workspaces?.find((w) => w.workspaceId === ws);
    expect(shared?.roles).toContain('owner');
    expect(await isWorkspaceMember(userId, ws)).toBe(true);
  });

  // USERS-1 (fail-closed, finding H5) / ADR 0621 D1. The REFUSAL half of the
  // disable lifecycle — bearer-only bind and bearer + stale bound cookie both
  // `401 account_disabled`, no bound cookie minted — is witnessed by
  // `auth-session-epoch.test.ts` (ii)/(iii) under the same break (the
  // middleware's liveness check), so this case keeps only what is unique to the
  // bind lane: the explicit lifecycle call restores sign-in onto the SAME row.
  it('a DISABLED user re-enabled by the lifecycle call binds again onto the SAME userId', async () => {
    const boundCookies = (res: Response): Array<Record<string, unknown>> => {
      const h = res.headers as Headers & { getSetCookie?: () => string[] };
      const all = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
      return all
        .map((sc) => /__session=([^;]+)/.exec(sc)?.[1])
        .filter((v): v is string => Boolean(v))
        .map((v) => JSON.parse(Buffer.from(v.split('.')[0]!, 'base64url').toString()) as Record<string, unknown>)
        .filter((p) => typeof p.userId === 'string');
    };
    const sub = 'firebase-uid-disabled-1';
    const c = client(mint(sub));
    const bind = await c.post('/host/openwop-app/users/auth/oidc/bind');
    expect(bind.status, JSON.stringify(bind.body)).toBe(200);
    const userId = bind.body.user!.userId;

    await setUserStatus(userId, 'disabled', { reason: 'admin' });
    const refused = await fetch(`${BASE}/host/openwop-app/users/auth/oidc/bind`, {
      method: 'POST',
      headers: { authorization: `Bearer ${mint(sub)}`, 'content-type': 'application/json' },
    });
    expect(refused.status, 'precondition: disabled ⇒ bind refused').toBe(401);

    await setUserStatus(userId, 'active', { reason: 'admin' });
    const restored = await fetch(`${BASE}/host/openwop-app/users/auth/oidc/bind`, {
      method: 'POST',
      headers: { authorization: `Bearer ${mint(sub)}`, 'content-type': 'application/json' },
    });
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as Body).user?.userId).toBe(userId);
    const bound = boundCookies(restored);
    expect(bound.length).toBeGreaterThan(0);
    expect(bound[0]!.userId).toBe(userId);
  });

  // USERS-1 family (review F1a): the workspace SWITCH also re-mints the bound
  // session. The refused switch below is a PRECONDITION (it makes the client
  // drop the cookie, as a browser does on the cleared 401) — its refusal is
  // `auth-session-epoch.test.ts` (ii). What this case owns is ADR 0621 D2: the
  // pre-disable cookie stays dead, and only a re-bind (new epoch) lets the
  // switch work again.
  it('after re-enable, a re-bind (new epoch) — not the old cookie — makes the workspace switch work again', async () => {
    const sub = 'firebase-uid-disabled-switch';
    const c = client(mint(sub));
    const userId = (await c.post('/host/openwop-app/users/auth/oidc/bind')).body.user!.userId;
    const ws = (await c.post('/host/openwop-app/workspaces', { name: 'DisabledCo' })).body.workspaceId!;
    expect(ws).toMatch(/^ws:/);

    await setUserStatus(userId, 'disabled', { reason: 'admin' });
    // ADR 0621 D1 (b): the middleware refuses the bearer + stale-bound-cookie
    // request (`401 account_disabled`, cookie cleared) before the switch route's
    // own USERS-1 403 — the LIVE session ends, not just the re-mint.
    const refused = await c.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
    expect(refused.status, JSON.stringify(refused.body)).toBe(401);
    expect(refused.body.error).toBe('account_disabled');

    await setUserStatus(userId, 'active', { reason: 'admin' });
    // ADR 0621 D2: the disable bumped the session epoch, so the pre-disable
    // cookie stays dead by construction (re-enable does not reset it). The
    // browser dropped it on the 401 above; the SPA re-binds from its IdP token
    // — the bind stamps the NEW epoch — and only then does the switch work.
    const rebound = await c.post('/host/openwop-app/users/auth/oidc/bind');
    expect(rebound.status, JSON.stringify(rebound.body)).toBe(200);
    const ok = await c.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.active).toBe(ws);
  });

  // Regression for the duplicate "My Board" bug: the SAME human reaching the host
  // first over an UNBOUND bearer then over a BOUND cookie must get exactly ONE
  // personal board. Pre-fix, the provisioning choke point keyed the board on the
  // raw callerSubject (oidc:<sub> when unbound), so a second board accrued; the fix
  // keys it on the canonical user:<userId> at both touches.
  it('the same human across unbound bearer + bound cookie gets exactly ONE personal board', async () => {
    const sub = 'firebase-uid-board-dedupe';
    const personalTenant = personalTenantOfSub(sub);
    const c = client(mint(sub));

    // Unbound first touch provisions the personal board (durable via personalTenant).
    const b1 = await c.get('/host/openwop-app/kanban/boards/personal');
    expect(b1.status, JSON.stringify(b1.body)).toBe(200);

    // Bind, then touch again on the bound channel.
    const userId = (await c.post('/host/openwop-app/users/auth/oidc/bind')).body.user!.userId;
    const b2 = await c.get('/host/openwop-app/kanban/boards/personal');
    expect(b2.status).toBe(200);

    // Both touches resolve the SAME canonical-owner board…
    const canonicalBoardId = personalBoardId(personalTenant, userId);
    expect(b1.body.board?.id).toBe(canonicalBoardId);
    expect(b2.body.board?.id).toBe(canonicalBoardId);
    // …and the oidc:<sub>-keyed duplicate board was NEVER created.
    expect(await getBoard(canonicalBoardId)).not.toBeNull();
    expect(await getBoard(personalBoardId(personalTenant, `oidc:${sub}`))).toBeNull();
  });
});

// ADR 0684 correction (second defect) — auto-join must key on the CANONICAL
// subject the rest of the request path resolves. `bind` prefixed an already-
// prefixed `userId`, so every row landed under `user:user:<hash>`; the
// service-level enterable test could not see it because it hands auto-join a
// consistent subject directly. This one goes through the real route.
describe('ADR 0684 — bind auto-joins the CANONICAL subject into a declared default workspace', () => {
  const DECL: FeatureDefaultOrg = {
    featureId: 'bind-default-feature', orgId: 'host-bindtest', tenantId: 'host-bindtest', name: 'Bind Test',
  };

  beforeAll(async () => {
    registerToggleDefault({ id: DECL.featureId, label: DECL.name, status: 'on', bucketUnit: 'user', salt: DECL.featureId });
    await ensureFeatureDefaultOrgs([DECL]);
    setDefaultWorkspaceTargets([DECL]);
  });

  it('the joined subject is the one the session resolves — listable, switchable, sticky', async () => {
    const sub = 'firebase-uid-bind-default-1';
    const c = client(mint(sub));
    const bind = await c.post('/host/openwop-app/users/auth/oidc/bind');
    expect(bind.status, JSON.stringify(bind.body)).toBe(200);
    const userId = bind.body.user!.userId;
    expect(userId).toMatch(/^user:/);

    // The regression, stated as the row that must NOT exist: nothing may be
    // keyed under a double-prefixed subject.
    expect(await isWorkspaceMember(`user:${userId}`, DECL.tenantId), 'double-prefixed subject must own nothing').toBe(false);
    expect(await isWorkspaceMember(userId, DECL.tenantId), 'canonical subject is a member').toBe(true);

    // 1. LISTABLE through the route the switcher uses.
    const me = await c.get('/host/openwop-app/me/workspaces');
    expect(me.status).toBe(200);
    expect(me.body.workspaces?.map((w) => w.workspaceId)).toContain(DECL.tenantId);

    // 2. SWITCHABLE — the 403 seen in production.
    const sw = await c.post(`/host/openwop-app/workspaces/${DECL.tenantId}/switch`);
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);

    // 3. STICKY — a fresh bind re-resolves the active workspace fail-closed and
    //    must keep it rather than bounce the caller to personal.
    const c2 = client(mint(sub));
    const bind2 = await c2.post('/host/openwop-app/users/auth/oidc/bind');
    expect(bind2.status).toBe(200);
    const me2 = await c2.get('/host/openwop-app/me/workspaces');
    expect(me2.body.active).toBe(DECL.tenantId);
  });
});
