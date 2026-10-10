/**
 * Cookie session — the HMAC-signed `__session` cookie crypto + shape (SEC-6).
 *
 * Extracted verbatim from `middleware/auth.ts` to shrink that 760-line module:
 * the cookie session is a cohesive unit (sign / verify / mint / set-cookie +
 * the session-secret config check) with no dependency on the request-handling
 * middleware around it. `auth.ts` imports these; external callers (health
 * readiness, SAML/SCIM/password routes) keep importing `sessionSecretConfigError`
 * / `issueUserSession` from `auth.ts`, which re-exports them.
 *
 * Cookie value shape (unchanged):
 *   `<payloadB64>.<sigB64>` where
 *   payloadB64 = base64url(JSON.stringify(SessionPayload))
 *   sigB64     = base64url(HMAC_SHA256(secret, payloadB64))
 */

import type { Response } from 'express';
import { readSecretEnv } from '../host/secretEnv.js';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createLogger } from '../observability/logger.js';

const log = createLogger('middleware.cookieSession');

// `__session` is the ONLY cookie name Firebase Hosting forwards to Cloud
// Run/Functions (https://firebase.google.com/docs/hosting/manage-cache#using_cookies).
// Adopters fronting the engine with a different reverse proxy can override via
// OPENWOP_SESSION_COOKIE_NAME — default keeps the app.openwop.dev demo working.
export const COOKIE_NAME = process.env.OPENWOP_SESSION_COOKIE_NAME || '__session';
export const COOKIE_TTL_SECONDS = 86_400; // 24h
export const REFRESH_THRESHOLD_SECONDS = 21_600; // refresh when < 6h left

export interface SessionPayload {
  sid: string;
  tenantId: string;
  tier: 'anon' | 'user';
  /** Durable `User.userId` this session is bound to (ADR 0003). Present once the
   *  caller has authenticated to a durable account (password login / signup);
   *  absent for anon sessions. When present, the request principal becomes the
   *  stable, opaque `user:<userId>` instead of the per-session `session:<sid>`. */
  userId?: string;
  /** Stable, opaque RBAC subject persisted on an OIDC-promoted session (ADR 0015
   *  — identity coherence). The bearer path derives `oidc:<sub>`; stamping it on
   *  the upgraded cookie means a follow-up request that DROPS the Authorization
   *  header (SPA token-cache race, EventSource without `?apiKey=`) still resolves
   *  the SAME subject instead of falling back to the per-session `session:<sid>`.
   *  Without this, an OrgMember seeded against `oidc:<sub>` stops matching the
   *  caller on cookie-only requests — the latent RBAC bug ADR 0015 §Phase 0 closes.
   *  Distinct from `userId`: this is set when there is no durable `User` record
   *  (the OIDC case today), `userId` when there is (password login). */
  subject?: string;
  /** The caller's INTRINSIC private tenant (ADR 0015), independent of the active
   *  workspace. `tenantId` above is the ACTIVE workspace (may be a shared `ws:`
   *  after a switch); this is always the caller's own `user:<hash>` / `anon:<sid>`
   *  so the implicit personal-owner check stays correct across switches. */
  personalTenant?: string;
  /** True when the sign-in that produced this session verified a second factor
   *  (ADR 0389 Phase 1). Stamped from the Firebase ID token's
   *  `firebase.sign_in_second_factor` claim at OIDC bind / bearer promotion —
   *  the host never sees or stores factor material (enrollment is fully
   *  delegated to Identity Platform). Absent ⇒ single-factor session; the
   *  tenant `requireMfa` gate (Phase 4) fails closed on absence. */
  mfa?: boolean;
  /** True ⇒ the sliding-window refresh MUST NOT extend this session (ADR 0389
   *  P3 grade-pass SEC-C2: the break-glass 10-minute session was silently
   *  re-issued for 24h by the refresh branch — a "short-lived" emergency
   *  session became an indefinitely renewable superadmin cookie). */
  noRefresh?: boolean;
  /** ADR 0621 D2 — the `User.sessionEpoch` this session was minted under.
   *  Compared per request against the durable row: a mismatch is
   *  `401 session_revoked` ("sign out everywhere", disable, erase, factor
   *  removal all bump the row's epoch). Absent on a pre-ADR cookie ⇒ read as 0,
   *  which matches a row that was never bumped. Only meaningful alongside
   *  `userId`; anon / unbound-subject sessions carry none. */
  epoch?: number;
  /** ADR 0833 D3 — the session FAMILY: minted on a fresh authentication and
   *  carried by every refresh, re-pin and re-mint (switch, promotion). Logout
   *  revokes the family, so a cookie copied BEFORE a re-mint dies with it.
   *  Absent on a pre-ADR cookie ⇒ the family is its `sid` ({@link familyOf}). */
  fid?: string;
  /** ADR 0833 D3 — SERVER time (epoch seconds) at which the IdP credential
   *  behind this session was last verified (a bearer or assertion). Never the
   *  IdP's `auth_time`. `exp` is capped at `authAt` + the absolute lifetime, so
   *  reaching the cap is an ordinary expiry. Absent on a pre-ADR cookie ⇒ the
   *  clock starts at its next refresh (no mass sign-out on deploy). */
  authAt?: number;
  iat: number;
  exp: number;
}

/** ADR 0833 D3 — a session's family id (a legacy cookie's family is its sid). */
export function familyOf(session: Pick<SessionPayload, 'fid' | 'sid'>): string {
  return session.fid ?? session.sid;
}

/** ADR 0833 D3 — the absolute session lifetime in seconds
 *  (`OPENWOP_SESSION_ABSOLUTE_MAX_HOURS`, default 720 = 30 days). */
export function sessionAbsoluteMaxSeconds(): number {
  const raw = Number(process.env.OPENWOP_SESSION_ABSOLUTE_MAX_HOURS);
  const hours = Number.isFinite(raw) && raw > 0 ? raw : 720;
  return Math.floor(hours * 3600);
}

/** The lifetime fields every minted payload gets from {@link buildSessionPayload}. */
type LifetimeFields = 'sid' | 'iat' | 'exp' | 'fid' | 'authAt';

/**
 * ADR 0833 D2/D3 — the ONE builder for a session payload's lifetime fields.
 * Every `signSession` caller (`test/adr0833-*` ratchet) mints through it, so no
 * mint can widen the session it came from:
 *
 *  - `source` — the VERIFIED user-tier session this one replaces (a switch, a
 *    promotion over a same-identity cookie). Its family is inherited; so are
 *    `authAt` and, for a `noRefresh` session, its `exp` ceiling and the flag.
 *    An anon cookie is never a source (it carries no authentication).
 *  - `freshAuth` — an IdP credential was verified on THIS request (bind,
 *    bearer promotion, SAML ACS, break-glass): `authAt` restarts at now.
 *  - `ttlSeconds` — a shorter lifetime than the cookie TTL (break-glass).
 *
 * `exp` is always ≤ `authAt` + the absolute lifetime.
 */
export function buildSessionPayload(
  fields: Omit<SessionPayload, LifetimeFields> & { sid?: string },
  opts: { source?: SessionPayload | null; freshAuth?: boolean; ttlSeconds?: number } = {},
): SessionPayload {
  const now = Math.floor(Date.now() / 1000);
  const sid = fields.sid ?? base64urlEncode(randomBytes(18));
  // An ANON session authenticates nobody: no family, no `authAt`, no absolute
  // cap — it slides as it always has (grade-code `USERS2-CD-2`: capping it
  // stranded an active visitor's sandbox on day 30).
  if (fields.tier === 'anon') {
    return { ...fields, sid, iat: now, exp: now + (opts.ttlSeconds ?? COOKIE_TTL_SECONDS) };
  }
  const source = opts.source && opts.source.tier === 'user' ? opts.source : undefined;
  const authAt = opts.freshAuth || !source ? now : (source.authAt ?? now);
  const noRefresh = fields.noRefresh === true || source?.noRefresh === true;
  let exp = Math.min(now + (opts.ttlSeconds ?? COOKIE_TTL_SECONDS), authAt + sessionAbsoluteMaxSeconds());
  if (source?.noRefresh) exp = Math.min(exp, source.exp);
  return {
    ...fields,
    sid,
    fid: source ? familyOf(source) : base64urlEncode(randomBytes(12)),
    authAt,
    ...(noRefresh ? { noRefresh: true } : {}),
    iat: now,
    exp,
  };
}

/** ADR 0833 D3 — the sliding refresh: same session, same family and `authAt`
 *  (a legacy cookie's clock starts now), `exp` slid but never past the cap. */
export function refreshSessionPayload(session: SessionPayload): SessionPayload {
  const now = Math.floor(Date.now() / 1000);
  if (session.tier === 'anon') return { ...session, iat: now, exp: now + COOKIE_TTL_SECONDS };
  const authAt = session.authAt ?? now;
  return {
    ...session,
    fid: familyOf(session),
    authAt,
    iat: now,
    exp: Math.min(now + COOKIE_TTL_SECONDS, authAt + sessionAbsoluteMaxSeconds()),
  };
}

export function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function base64urlDecode(s: string): Buffer {
  let pad = s.replace(/-/g, '+').replace(/_/g, '/');
  while (pad.length % 4 !== 0) pad += '=';
  return Buffer.from(pad, 'base64');
}

/**
 * Pure config check for the session secret — returns a human-readable reason
 * when production requires `OPENWOP_SESSION_SECRET` but it's unset/too short,
 * else null. Shared with the `/readiness` route so the health check reflects
 * the SAME condition that makes cookie-minting throw: previously readiness
 * returned 200 while the first session-minting POST 503'd, so the health check
 * lied about a deploy that was actually broken (PRD §8.3). Dev uses an ephemeral
 * fallback, so this is null outside production.
 */
export function sessionSecretConfigError(): string | null {
  const s = readSecretEnv('OPENWOP_SESSION_SECRET');
  if (s && s.length >= 32) return null;
  if (process.env.NODE_ENV === 'production') {
    return 'OPENWOP_SESSION_SECRET must be set in production (>=32 chars) — cookie-session minting will fail without it';
  }
  return null;
}

/** Resolve the session HMAC secret — the prod secret (fail-closed: throws in production when
 *  unset/too short) or a stable per-process dev fallback. Exported so OTHER same-secret signers
 *  (e.g. `host/runStreamToken`) reuse the SAME resolution + prod gate, never a drifting copy. */
export function readSessionSecret(): string {
  const s = readSecretEnv('OPENWOP_SESSION_SECRET');
  if (s && s.length >= 32) return s;
  const configError = sessionSecretConfigError();
  if (configError) {
    // Hard fail in production rather than mint cookies with a weak
    // / predictable secret. Cookie-mode deploys MUST set this.
    throw new Error(`${configError}. See P0.2 in the deploy plan.`);
  }
  // Dev fallback: stable per-process random secret. Cookies invalidate
  // on restart, which is fine for local dev.
  if (!process.env._OPENWOP_DEV_SESSION_SECRET) {
    process.env._OPENWOP_DEV_SESSION_SECRET = randomBytes(32).toString('hex');
    log.warn('OPENWOP_SESSION_SECRET unset; using ephemeral dev secret (cookies invalidate on restart)');
  }
  return process.env._OPENWOP_DEV_SESSION_SECRET;
}

export function signSession(payload: SessionPayload): string {
  const payloadB64 = base64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = createHmac('sha256', readSessionSecret()).update(payloadB64).digest();
  return `${payloadB64}.${base64urlEncode(sig)}`;
}

/** The payload of a cookie whose SIGNATURE verifies (no lifetime checks), or null. */
function decodeSignedSession(cookie: string): Partial<SessionPayload> | null {
  const dot = cookie.indexOf('.');
  if (dot <= 0 || dot === cookie.length - 1) return null;
  const payloadB64 = cookie.slice(0, dot);
  const sigB64 = cookie.slice(dot + 1);
  const expected = createHmac('sha256', readSessionSecret()).update(payloadB64).digest();
  let provided: Buffer;
  try { provided = base64urlDecode(sigB64); } catch { return null; }
  if (expected.length !== provided.length) return null;
  if (!timingSafeEqual(expected, provided)) return null;
  try { return JSON.parse(base64urlDecode(payloadB64).toString('utf8')) as Partial<SessionPayload>; }
  catch { return null; }
}

export function verifySession(cookie: string): SessionPayload | null {
  const payload = decodeSignedSession(cookie);
  if (!payload) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  if (typeof payload.tenantId !== 'string' || typeof payload.sid !== 'string') return null;
  // ADR 0833 D3 — the absolute lifetime. Minted cookies already cap `exp`; this
  // also retires older ones when an operator lowers the cap.
  if (typeof payload.authAt === 'number' && now > payload.authAt + sessionAbsoluteMaxSeconds()) return null;
  return payload as SessionPayload;
}

/**
 * ADR 0833 D3 — true when `cookie` is a GENUINE (signature-verified) user-tier
 * session that has ended: past its `exp`, or past `authAt` + the absolute
 * lifetime. The middleware answers it with `401 … reason: session_expired`
 * instead of minting an anonymous session over a signed-in user. An anon or
 * forged cookie is never "ended" — it is simply not a session.
 */
export function endedUserSession(cookie: string): boolean {
  const payload = decodeSignedSession(cookie);
  if (!payload || payload.tier !== 'user') return false;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < now) return true;
  return typeof payload.authAt === 'number' && now > payload.authAt + sessionAbsoluteMaxSeconds();
}

export function mintAnonSession(): SessionPayload {
  const sid = base64urlEncode(randomBytes(18));
  return buildSessionPayload({ sid, tenantId: `anon:${sid}`, tier: 'anon' });
}

/**
 * Bind the response's session cookie to a durable user (ADR 0003, Phase 2). The
 * password login/signup routes call this on success so every subsequent request
 * carries `req.userId` + the stable, opaque `user:<userId>` principal — one
 * canonical subject for `/me`, MFA, run ownership, and (ADR 0006) RBAC.
 */
export function issueUserSession(
  res: Response,
  opts: UserSessionOpts,
): void {
  setSessionCookie(res, mintUserSessionCookieValue(opts));
}

/** What a user-session mint needs. `source` / `freshAuth` are ADR 0833 D2: a
 *  login passes `freshAuth`, a re-mint (workspace switch) passes the verified
 *  cookie it replaces as `source` — never both, never neither by accident. */
export type UserSessionOpts = {
  userId: string; tenantId: string; personalTenant?: string; subject?: string; mfa?: boolean; epoch: number;
} & ({ freshAuth: true; source?: undefined } | { source: SessionPayload | undefined; freshAuth?: undefined });

/**
 * The signed user-session cookie VALUE — the one payload builder every user
 * session is minted through (`issueUserSession` sets it on a response; the
 * RFC 0170 mint seam returns it as a cookie-presented credential).
 */
export function mintUserSessionCookieValue(opts: UserSessionOpts): string {
  const session = buildSessionPayload({
    tenantId: opts.tenantId,
    tier: 'user',
    userId: opts.userId,
    // ADR 0621 D2 — REQUIRED: every mint site stamps the user's CURRENT epoch
    // (a login reads the row; a re-mint such as the workspace switch carries the
    // epoch the middleware just validated). Making it required is what keeps a
    // new mint site from shipping a cookie the revocation check cannot see.
    epoch: opts.epoch,
    // OIDC bind (ADR 0003 Phase 4a) carries the `oidc:<sub>` so a follow-up bearer
    // request matches this cookie and resolves the bound `user:<userId>`. Absent
    // for password login (no bearer to match against).
    ...(opts.subject ? { subject: opts.subject } : {}),
    // ADR 0389 P1: carry the verified-second-factor mark across re-issues
    // (bind, workspace switch) so the session doesn't silently lose it.
    ...(opts.mfa ? { mfa: true } : {}),
    // The caller's intrinsic tenant — defaults to the active tenant at login
    // (their personal workspace), preserved verbatim across a later switch.
    personalTenant: opts.personalTenant ?? opts.tenantId,
  }, opts.freshAuth ? { freshAuth: true } : { source: opts.source ?? null });
  return signSession(session);
}

/**
 * ADR 0621 D1 — expire the session cookie on the response. ONE definition,
 * shared by the logout route and the middleware's per-request refusal
 * (`account_disabled` / `account_erased` / `session_revoked`). Replaces any
 * pending same-name Set-Cookie (a sliding refresh or a membership re-pin that
 * already ran on this response) — the same one-cookie-per-response rule
 * `setSessionCookie` keeps, so the clear cannot lose to an earlier re-issue.
 * The attribute set mirrors `setSessionCookie` (SameSite/Secure) so browsers
 * treat it as the SAME cookie and actually drop it.
 */
export function clearSessionCookie(res: Response): void {
  const secure = sessionCookieIsCrossSite();
  const sameSite = secure ? 'None' : 'Lax';
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', `SameSite=${sameSite}`];
  if (secure) parts.push('Secure');
  if (typeof res.getHeader === 'function' && typeof res.setHeader === 'function') {
    const prior = res.getHeader('Set-Cookie');
    const others = (Array.isArray(prior) ? prior : typeof prior === 'string' ? [prior] : [])
      .map(String)
      .filter((c) => !c.startsWith(`${COOKIE_NAME}=`));
    res.setHeader('Set-Cookie', [...others, parts.join('; ')]);
  } else {
    res.append('Set-Cookie', parts.join('; '));
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  // RFC 6265 cookie header is `k1=v1; k2=v2; …`.
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * ADR 0833 D4 — the ONE cookie-posture decision: `true` ⇒ the session cookie is
 * `SameSite=None; Secure`, so SameSite gives no CSRF protection and the
 * credentialed-origin check (`cors.ts credentialedOriginAllowed`) must. Read by
 * the cookie writers below AND by that check, so the two cannot disagree again
 * (the CSRF guard used to assume "no allowlist ⇒ dev ⇒ Lax").
 */
export function sessionCookieIsCrossSite(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.OPENWOP_COOKIE_SECURE === 'true';
}

export function setSessionCookie(res: Response, signed: string): void {
  const secure = sessionCookieIsCrossSite();
  // SameSite MUST be `None` in production. The SPA streams run events via SSE
  // directly against the underlying Cloud Run URL (`*-run.app`) — a *cross-site*
  // request — because Firebase Hosting's `/api/**` → Cloud Run rewrite BUFFERS
  // SSE (the CDN waits for body completion before flushing), so live `node.*` /
  // `node.suspended` events never reach the FE through the proxy. A `SameSite=Lax`
  // cookie is NOT sent on that cross-site request → the SSE stream has no session
  // → no live workflow-step updates and no HITL interrupt cards. `None` lets the
  // session cookie ride along to the direct Cloud Run origin.
  //
  // CSRF is held by the CORS allowlist instead: `cors.ts` emits
  // `Access-Control-Allow-Credentials` ONLY for origins explicitly listed in
  // `OPENWOP_CORS_ORIGINS` (never the reflect-any default), and mutations are
  // JSON (preflighted). `None` REQUIRES `Secure`, so it is used only when the
  // cookie is Secure (prod / HTTPS); local dev over http stays `Lax` (same-origin
  // there, so cross-site travel is moot).
  const sameSite = secure ? 'None' : 'Lax';
  const parts = [
    `${COOKIE_NAME}=${signed}`,
    `Path=/`,
    `Max-Age=${COOKIE_TTL_SECONDS}`,
    `HttpOnly`,
    `SameSite=${sameSite}`,
  ];
  if (secure) parts.push('Secure');
  // ONE session cookie per response. A cookieless request that ends in a login
  // (test/login, OAuth callback, password login) first gets an auto-minted anon
  // Set-Cookie from the request middleware, then the user Set-Cookie here —
  // and which same-name cookie a client keeps is implementation-defined
  // (browsers keep the last; some proxy/jar stacks kept the FIRST, leaving the
  // caller anonymous despite a 201 login). Replace any pending same-name
  // cookie instead of appending a competitor.
  if (typeof res.getHeader === 'function' && typeof res.setHeader === 'function') {
    const prior = res.getHeader('Set-Cookie');
    const others = (Array.isArray(prior) ? prior : typeof prior === 'string' ? [prior] : [])
      .map(String)
      .filter((c) => !c.startsWith(`${COOKIE_NAME}=`));
    res.setHeader('Set-Cookie', [...others, parts.join('; ')]);
  } else {
    // Minimal res stubs (tests) without header introspection: plain append.
    res.append('Set-Cookie', parts.join('; '));
  }
}
