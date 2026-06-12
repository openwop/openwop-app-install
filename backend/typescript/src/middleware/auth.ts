/**
 * Auth middleware. Supports two modes:
 *
 *   1. Signed session cookie (`__session` by default, configurable via
 *      OPENWOP_SESSION_COOKIE_NAME) — the default for
 *      browser visitors on the public demo. On first request without
 *      a cookie, mints one: HS256 over a small JSON payload
 *      `{ sid, tenantId: "anon:<sid>", tier: "anon", iat, exp }`. Each
 *      visitor gets a fresh tenantId derived from their cookie so
 *      cross-tenant collisions are impossible. 24h sliding window.
 *
 *   2. Bearer-token allow-list — for the conformance harness + curl
 *      smoke + signed-in users (Phase 3). Token values come from
 *      `OPENWOP_API_KEYS` (CSV) or `OPENWOP_API_KEY` (single). Default
 *      `sample-token` for local dev; production deployments MUST set
 *      either OPENWOP_API_KEYS (real keys) or rely on cookies only.
 *
 * Modes are NOT mutually exclusive — Bearer auth wins when present;
 * cookie auth is the fallback. Set `OPENWOP_AUTH_DISABLE_COOKIES=true`
 * to require Bearer (legacy conformance / curl-only deploys).
 *
 * Public paths (`/health`, `/readiness`, `/.well-known/openwop`,
 * `/v1/openapi.json`, `/v1/packs/*`, `/v1/interrupts/*`) bypass auth
 * entirely.
 *
 * Tenant derivation: `req.principal.tenants[0]` and `req.tenantId` are
 * BOTH set from the authenticated principal. Routes that need a
 * tenant MUST read from `req.tenantId` (or fall back to req.body but
 * the principalAuthorizer will reject mismatched values). This kills
 * the cross-tenant impersonation hole where `body.tenantId` could be
 * any string a caller wanted.
 *
 * Session cookie shape — single base64url-encoded value containing
 * payload + HS256 signature:
 *    __session=<payloadB64>.<sigB64>
 * where payloadB64 = base64url(JSON.stringify({sid, tenantId, tier, iat, exp}))
 *       sigB64     = base64url(HMAC_SHA256(secret, payloadB64))
 * Constant-time signature compare via timingSafeEqual.
 *
 * @see SECURITY/external-audit-engagement.md §2.1.1
 * @see plans/openwop-app-deployment-plan.md (P0.2)
 */

import type { RequestHandler } from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Principal } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { noteTenantActivity } from '../routes/admin.js';
import { isWorkspaceMember } from '../host/accessControlService.js';
import {
  OidcVerifier,
  OidcVerificationError,
  readOidcConfigFromEnv,
  type OidcClaims,
} from './oidcVerifier.js';

const log = createLogger('middleware.auth');

declare module 'express-serve-static-core' {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface Request {
    principal?: Principal;
    /** Tenant id derived from the authenticated principal. Routes
     *  SHOULD prefer this over `req.body.tenantId` so a misbehaving
     *  client can't claim another tenant. */
    tenantId?: string;
    /** Durable `User.userId` when the session is bound to a durable account
     *  (ADR 0003). The canonical subject identity — features resolve the caller
     *  via `getUser(req.userId)` rather than reconstructing a principal string. */
    userId?: string;
    /** The caller's OWN private tenant (ADR 0015) — `anon:<sid>` for an anon
     *  session, `user:<hash>` for a signed-in user. `req.tenantId` is the ACTIVE
     *  workspace (defaults to this, or a shared `ws:<uuid>` once switched). The
     *  route-auth layer treats a caller as the implicit OWNER of their own
     *  personal tenant (a single-principal scope by construction), while shared
     *  workspaces are strictly membership-derived. */
    personalTenant?: string;
    /** Raw request body bytes, captured by a scoped `express.json({ verify })`
     *  for surfaces that must verify a provider HMAC over the exact payload
     *  (ADR 0024 inbound webhooks). Undefined everywhere else. */
    rawBody?: Buffer;
  }
}

const PUBLIC_PATH_PREFIXES = [
  '/health',
  '/readiness',
  '/.well-known/openwop',
  '/v1/openapi.json',
  '/v1/packs',
  '/v1/interrupts',
  // Production SAML SSO (ADR 0002 / RFC 0050): the SP-initiated redirect, the IdP's
  // browser-driven ACS form-POST, and the SP metadata are all PRE-AUTH (the user
  // has no session yet — the ACS is what MINTS it). The assertion's XML signature
  // is the credential, validated by `host/auth/samlSso`. 404s when SAML is unconfigured.
  '/v1/host/sample/auth/saml/sso',
  // SCIM 2.0 provisioning (RFC 0050 §B): the IdP's SCIM client (Okta / Azure AD)
  // POSTs to /scim/v2/{Users,Groups} with the IdP SCIM bearer — NOT a session
  // cookie or an OPENWOP_API_KEY. Each route does its OWN constant-time bearer
  // check against OPENWOP_SCIM_BEARER (and 404s when unset), so it is the sole
  // gate — like the SAML ACS + /v1/interrupts/{token}, the credential in the
  // request IS the auth. It MUST bypass the global layer: a hardened host
  // (OPENWOP_AUTH_ENFORCE_BEARER / _DISABLE_COOKIES) would otherwise 401 the
  // unrecognized SCIM bearer before the route runs, making SCIM unreachable for
  // exactly the production postures that use it. The conformance seam
  // (/v1/host/sample/auth/scim/provision) is NOT here — it runs under the
  // caller's auth context, so it stays globally gated.
  '/scim/v2',
  // RFC 0055 §C media-asset serving: GET /v1/host/sample/assets/{token} is
  // token-authed (the 32-byte capability token is the credential, like
  // /v1/interrupts/{token}), so embeddable <img src> URLs work without a
  // bearer/cookie. The store path (POST /v1/host/sample/media/put) is NOT
  // under this prefix and stays authenticated.
  '/v1/host/sample/assets',
  // Demo messaging relay device-loop (heartbeat/inbound/outbound/ack) is
  // authed by the per-device token in the `x-openwop-device-token` header
  // — the device token is the credential, like /v1/interrupts/{token}. The
  // operator endpoints (register/activate/revoke/enqueue, connectors,
  // sessions) are NOT under /device and stay bearer-authed.
  '/v1/host/sample/messaging/device',
  // Admin endpoints do their own constant-time check against
  // OPENWOP_ADMIN_TOKEN (separate from OPENWOP_API_KEYS so the
  // session/bearer paths can't confuse the two). Bypassing the
  // session-cookie auth path here lets Cloud Scheduler hit the
  // cleanup cron with just the Bearer admin token.
  '/v1/host/sample/admin',
  // ADR 0012 Publishing & SEO: the PUBLIC published-site surface
  // (GET /v1/host/sample/public/{orgId}/{pages/:slug,sitemap.xml,robots.txt,
  // feed.rss}). Intentionally unauthenticated — published content is public by
  // definition. There is NO credential: the org is in the URL, its tenant comes
  // from `getOrg`, and the surface is gated on the org-tenant's `publishing`
  // toggle + served published-only (drafts never resolve). The authoring +
  // SEO-write surface lives under /v1/host/sample/publishing/* and stays
  // authorizeOrgScope-gated, NOT under this prefix.
  '/v1/host/sample/public',
  // ADR 0027 Site config: the PUBLIC front-page pointer the anonymous SPA reads
  // at '/' (GET /v1/host/sample/public-site-config → { enabled, orgId, slug }).
  // Exposes only already-public ids; the superadmin WRITE is /v1/host/sample/site-config.
  '/v1/host/sample/public-site-config',
  // ADR 0013 Sharing: the PUBLIC share-link resolve surface
  // (GET /v1/host/sample/shared/{token}[/card]). Unauthenticated by design — the
  // 32-byte base64url token IS the credential (like /v1/interrupts/{token} and
  // the media serve route). Tenant comes from the link, the surface is gated on
  // the link-tenant's `sharing` toggle, and revoked/expired links 404. The
  // management surface lives under /v1/host/sample/sharing/* and stays
  // authorizeOrgScope-gated — note `shared` ≠ `sharing`, so this prefix does NOT
  // match it.
  '/v1/host/sample/shared',
  // Forms (ADR 0017) — the PUBLIC render + submit surface
  // (GET /v1/host/sample/public-forms/{formId}, POST …/submit). Unauthenticated
  // by design — a published form is public-by-intent. Tenant comes from the form,
  // the surface is gated on the form-tenant's `forms` toggle, and unpublished /
  // missing forms 404. The management surface lives under /v1/host/sample/forms/*
  // and stays authorizeOrgScope-gated — `public-forms` ≠ `forms`, so this prefix
  // does NOT match it.
  '/v1/host/sample/public-forms',
  // Consent (ADR 0020) — the PUBLIC record/read surface
  // (POST /v1/host/sample/public-consent/{orgId}, GET …/{orgId}/{subjectKey}).
  // Unauthenticated by design — a visitor records consent before any auth. Tenant
  // comes from the org, gated on the org-tenant's `consent` toggle. The management
  // surface lives under /v1/host/sample/consent/* and stays authorizeOrgScope-gated
  // — `public-consent` ≠ `consent`, so this prefix does NOT match it.
  '/v1/host/sample/public-consent',
  // Analytics (ADR 0018) — the PUBLIC beacon
  // (POST /v1/host/sample/public-analytics/{orgId}/collect). Unauthenticated by
  // design — a visitor's page/event hit. Tenant comes from the org, gated on the
  // org-tenant's `analytics` toggle AND consent (ADR 0020). The reporting surface
  // lives under /v1/host/sample/analytics/* and stays authorizeOrgScope-gated —
  // `public-analytics` ≠ `analytics`, so this prefix does NOT match it.
  '/v1/host/sample/public-analytics',
  // Connections inbound webhooks (ADR 0024 §6) — the PUBLIC provider-push ingest
  // (POST /v1/host/sample/connections-inbound/{connectionId}). Unauthenticated by
  // design — the provider HMAC signature IS the credential (verified against the
  // connection's stored signing secret); tenant comes from the inbound config.
  // The authoring surface lives under /v1/host/sample/connections/* and stays
  // auth + admin-gated (org-shared connections need `host:connections:manage`;
  // it is no longer feature-toggle-gated — ADR 0024 § Correction) —
  // `connections-inbound` ≠ `connections`, so this prefix does NOT match it.
  '/v1/host/sample/connections-inbound',
];

// Firebase Hosting strips every cookie except `__session` from
// requests it forwards to Cloud Run/Functions
// (https://firebase.google.com/docs/hosting/manage-cache#using_cookies).
// Adopters fronting the workflow-engine with a different reverse proxy
// can override this via OPENWOP_SESSION_COOKIE_NAME — default keeps
// the app.openwop.dev demo working.
const COOKIE_NAME = process.env.OPENWOP_SESSION_COOKIE_NAME || '__session';
const COOKIE_TTL_SECONDS = 86_400; // 24h
const REFRESH_THRESHOLD_SECONDS = 21_600; // refresh when < 6h left

interface SessionPayload {
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
  iat: number;
  exp: number;
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecode(s: string): Buffer {
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
  const s = process.env.OPENWOP_SESSION_SECRET;
  if (s && s.length >= 32) return null;
  if (process.env.NODE_ENV === 'production') {
    return 'OPENWOP_SESSION_SECRET must be set in production (>=32 chars) — cookie-session minting will fail without it';
  }
  return null;
}

function readSessionSecret(): string {
  const s = process.env.OPENWOP_SESSION_SECRET;
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

function signSession(payload: SessionPayload): string {
  const payloadB64 = base64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = createHmac('sha256', readSessionSecret()).update(payloadB64).digest();
  return `${payloadB64}.${base64urlEncode(sig)}`;
}

function verifySession(cookie: string): SessionPayload | null {
  const dot = cookie.indexOf('.');
  if (dot <= 0 || dot === cookie.length - 1) return null;
  const payloadB64 = cookie.slice(0, dot);
  const sigB64 = cookie.slice(dot + 1);
  const expected = createHmac('sha256', readSessionSecret()).update(payloadB64).digest();
  let provided: Buffer;
  try { provided = base64urlDecode(sigB64); } catch { return null; }
  if (expected.length !== provided.length) return null;
  if (!timingSafeEqual(expected, provided)) return null;
  let payload: SessionPayload;
  try { payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8')) as SessionPayload; }
  catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  if (typeof payload.tenantId !== 'string' || typeof payload.sid !== 'string') return null;
  return payload;
}

function mintAnonSession(): SessionPayload {
  const sid = base64urlEncode(randomBytes(18));
  const now = Math.floor(Date.now() / 1000);
  return {
    sid,
    tenantId: `anon:${sid}`,
    tier: 'anon',
    iat: now,
    exp: now + COOKIE_TTL_SECONDS,
  };
}

/**
 * Bind the response's session cookie to a durable user (ADR 0003, Phase 2). The
 * password login/signup routes call this on success so every subsequent request
 * carries `req.userId` + the stable, opaque `user:<userId>` principal — one
 * canonical subject for `/me`, MFA, run ownership, and (ADR 0006) RBAC.
 */
export function issueUserSession(
  res: import('express').Response,
  opts: { userId: string; tenantId: string; personalTenant?: string; subject?: string },
): void {
  const now = Math.floor(Date.now() / 1000);
  const session: SessionPayload = {
    sid: base64urlEncode(randomBytes(18)),
    tenantId: opts.tenantId,
    tier: 'user',
    userId: opts.userId,
    // OIDC bind (ADR 0003 Phase 4a) carries the `oidc:<sub>` so a follow-up bearer
    // request matches this cookie and resolves the bound `user:<userId>`. Absent
    // for password login (no bearer to match against).
    ...(opts.subject ? { subject: opts.subject } : {}),
    // The caller's intrinsic tenant — defaults to the active tenant at login
    // (their personal workspace), preserved verbatim across a later switch.
    personalTenant: opts.personalTenant ?? opts.tenantId,
    iat: now,
    exp: now + COOKIE_TTL_SECONDS,
  };
  setSessionCookie(res, signSession(session));
}

function readCookie(header: string | undefined, name: string): string | undefined {
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

function setSessionCookie(res: import('express').Response, signed: string): void {
  const secure = process.env.NODE_ENV === 'production' || process.env.OPENWOP_COOKIE_SECURE === 'true';
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
  res.append('Set-Cookie', parts.join('; '));
}

function readValidKeys(): ReadonlySet<string> {
  const multi = process.env.OPENWOP_API_KEYS;
  const single = process.env.OPENWOP_API_KEY;
  const raw = multi ?? single ?? 'sample-token';
  return new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
}

/** Lazy-init OIDC verifier — if config is unset, returns null and the
 *  bearer branch falls through to the API-key allow-list. */
let oidcVerifierInstance: OidcVerifier | null | undefined;
function getOidcVerifier(): OidcVerifier | null {
  if (oidcVerifierInstance !== undefined) return oidcVerifierInstance;
  const cfg = readOidcConfigFromEnv();
  oidcVerifierInstance = cfg ? new OidcVerifier(cfg) : null;
  if (oidcVerifierInstance) {
    log.info('OIDC verifier configured', { issuer: cfg!.issuer, audience: cfg!.audience });
  }
  return oidcVerifierInstance;
}

/** Map a verified OIDC claim set to a deterministic openwop tenant id.
 *  Issuer-scoped SHA-256 of `<iss>:<sub>` so cross-IdP `sub` collisions
 *  are impossible. Truncates to 32 hex chars (128 bits) — plenty for
 *  unique-per-user across any realistic IdP+user count. */
function tenantIdFromOidc(claims: OidcClaims): string {
  const h = createHash('sha256').update(`${claims.iss}:${claims.sub}`).digest('hex').slice(0, 32);
  return `user:${h}`;
}

/**
 * The personal tenant for a stable RBAC subject (ADR 0015). For an OIDC subject
 * (`oidc:<sub>`) this recomputes the same `user:<hash>` the bearer path derives,
 * using the configured issuer — so the cookie-only path and the implicit
 * personal-owner check agree with the bearer path WITHOUT a store lookup.
 * Returns undefined for a non-OIDC subject or when OIDC isn't configured.
 */
export function personalTenantForSubject(subject: string | undefined): string | undefined {
  if (!subject || !subject.startsWith('oidc:')) return undefined;
  const cfg = readOidcConfigFromEnv();
  if (!cfg) return undefined;
  const sub = subject.slice('oidc:'.length);
  const h = createHash('sha256').update(`${cfg.issuer}:${sub}`).digest('hex').slice(0, 32);
  return `user:${h}`;
}

/**
 * Mint a user-tier session bound to a stable RBAC subject (ADR 0015 workspace
 * switch). Unlike {@link issueUserSession} (durable `User.userId`), this carries
 * the opaque `subject` (e.g. `oidc:<sub>`) and an ACTIVE workspace tenant — the
 * workspace-switch route calls it after verifying membership, so the next
 * request routes to the chosen workspace.
 */
export function issueSubjectSession(
  res: import('express').Response,
  opts: { subject: string; tenantId: string; personalTenant?: string },
): void {
  const now = Math.floor(Date.now() / 1000);
  const session: SessionPayload = {
    sid: base64urlEncode(randomBytes(18)),
    tenantId: opts.tenantId,
    tier: 'user',
    subject: opts.subject,
    personalTenant: opts.personalTenant,
    iat: now,
    exp: now + COOKIE_TTL_SECONDS,
  };
  setSessionCookie(res, signSession(session));
}

/** Test affordance — wipe the verifier singleton so subsequent calls
 *  re-read env vars. Used by unit tests that flip OPENWOP_OIDC_*. */
export function _resetOidcVerifier(): void {
  oidcVerifierInstance = undefined;
}

/** Sliding-window failure tracker for OIDC verify fall-throughs. A
 *  misconfigured `OPENWOP_OIDC_AUDIENCE` would silently downgrade
 *  every signed-in user to the anon path; without an aggregate signal
 *  the only evidence is per-request `log.warn` entries that get
 *  drowned out under normal token-rotation churn. We track the count
 *  in the trailing 60s window and emit a louder `log.error` (with the
 *  config snapshot operators need to debug) when failures cross the
 *  threshold — once per minute, so a sustained problem reports
 *  steadily without per-request noise. */
const FALLTHROUGH_WINDOW_MS = 60_000;
const FALLTHROUGH_ALARM_THRESHOLD = 10;
let fallthroughTimestamps: number[] = [];
let lastFallthroughAlarmAt = 0;

function noteOidcFallthrough(reason: string): void {
  const now = Date.now();
  // Drop timestamps outside the trailing window so the array stays
  // bounded to roughly one minute's worth of failures.
  fallthroughTimestamps = fallthroughTimestamps.filter((t) => now - t < FALLTHROUGH_WINDOW_MS);
  fallthroughTimestamps.push(now);
  if (
    fallthroughTimestamps.length >= FALLTHROUGH_ALARM_THRESHOLD
    && now - lastFallthroughAlarmAt > FALLTHROUGH_WINDOW_MS
  ) {
    lastFallthroughAlarmAt = now;
    const cfg = readOidcConfigFromEnv();
    log.error('OIDC fall-through rate exceeded threshold — verify OPENWOP_OIDC_* config', {
      countInWindow: fallthroughTimestamps.length,
      windowMs: FALLTHROUGH_WINDOW_MS,
      lastReason: reason,
      configuredIssuer: cfg?.issuer ?? null,
      configuredAudience: cfg?.audience ?? null,
    });
  }
}

/** Test affordance — reset the fall-through tracker so unit tests get
 *  a clean window between assertions. */
export function _resetFallthroughTracker(): void {
  fallthroughTimestamps = [];
  lastFallthroughAlarmAt = 0;
}

/** When bearer verification fails, the middleware can either (a) emit
 *  401 immediately (the original, strict behavior — required when
 *  cookies are disabled and there's nothing to fall back to) or (b)
 *  fall through to the cookie path so a browser with a healthy session
 *  cookie isn't poisoned by a stale Firebase ID token. (b) is the
 *  default when cookies are enabled. */
export function authMiddleware(): RequestHandler {
  const cookiesDisabled = process.env.OPENWOP_AUTH_DISABLE_COOKIES === 'true';
  // When set, a request with no bearer AND no valid session cookie gets a strict
  // 401 instead of an auto-minted anon session — the spec-correct bearer-required
  // posture (auth.md). Default-off preserves the app.openwop.dev demo's anon-session
  // UX; production / conformance set it so "no Authorization → 401" holds
  // independently of NODE_ENV (the anon fallback was previously only suppressed
  // under NODE_ENV=production).
  const enforceBearer = process.env.OPENWOP_AUTH_ENFORCE_BEARER === 'true';
  return async (req, res, next) => {
    if (PUBLIC_PATH_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + '/'))) {
      next();
      return;
    }

    // Read + verify the session cookie ONCE up front, even though we
    // only consume it on the cookie path or the OIDC-promotion path
    // below. The bearer-success branch needs it to decide whether to
    // reissue the cookie as user-tier; the cookie branch needs it to
    // decide mint-vs-refresh. Computing it twice (the prior shape)
    // risked drift if the verification logic ever diverged between
    // the two sites. Skip entirely in `cookiesDisabled` mode — there
    // are no cookies to read.
    const cookieSession = (() => {
      if (cookiesDisabled) return null;
      const raw = readCookie(req.header('cookie'), COOKIE_NAME);
      return raw ? verifySession(raw) : null;
    })();

    // ─── 1. Bearer token (or ?apiKey= for SSE EventSource) ───
    const header = req.header('authorization');
    let bearerToken: string | undefined;
    if (header && header.toLowerCase().startsWith('bearer ')) {
      bearerToken = header.slice('bearer '.length).trim();
    } else if (typeof req.query.apiKey === 'string' && req.query.apiKey.trim().length > 0) {
      bearerToken = req.query.apiKey.trim();
    }
    if (bearerToken) {
      // Try the API-key allow-list first (cheap, sync). API keys are
      // short opaque strings; OIDC tokens are dot-segmented JWTs. The
      // shape disambiguates without crypto.
      if (readValidKeys().has(bearerToken)) {
        // API-key path — wildcard tenant (conformance harness / admin
        // tooling). Real deployments narrow via a key→tenant table.
        req.principal = {
          principalId: `bearer:${bearerToken.slice(0, 8)}`,
          tenants: ['*'],
          token: bearerToken,
        };
        next();
        return;
      }
      // Looks like a JWT? Try OIDC verification.
      const looksLikeJwt = bearerToken.split('.').length === 3;
      const oidc = getOidcVerifier();
      if (looksLikeJwt && oidc) {
        try {
          const claims = await oidc.verify(bearerToken);
          // The caller's OWN private tenant (ADR 0015). `oidc:<sub>` is the
          // stable, opaque RBAC subject (RFC 0048: non-PII — a Firebase UID).
          const personalTenant = tenantIdFromOidc(claims);
          const subject = `oidc:${claims.sub}`;
          // ADR 0003 Phase 4a: if a prior OIDC bind issued a user-tier cookie
          // carrying the durable `userId` for THIS caller, the canonical RBAC
          // subject is `user:<userId>` (not the transient `oidc:<sub>`). Read it
          // from the cookie only — no store touch on the hot path (ADR 0015 §0).
          // Match on `personalTenant` (deterministic from the bearer, set by
          // EVERY user-tier issuer) — NOT `subject`, which a workspace switch's
          // `issueUserSession` drops, which would otherwise silently un-bind the
          // caller after a switch and bounce them out of shared workspaces.
          const boundUserId =
            cookieSession?.tier === 'user'
            && cookieSession.personalTenant === personalTenant
            && typeof cookieSession.userId === 'string'
              ? cookieSession.userId
              : undefined;
          const effectiveSubject = boundUserId ?? subject;
          // The ACTIVE workspace defaults to the personal tenant, but honors a
          // previously-switched workspace recorded on a matching user-tier cookie.
          // Defense-in-depth (ADR 0015): when that workspace is SHARED (≠ the
          // personal tenant), re-validate membership every request — so a member
          // removed after switching loses access even when authorization
          // enforcement is off (tenant-scoped reads aren't gated then). A
          // non-member falls back to the personal tenant (and the cookie is
          // re-pinned below). Authority is ALSO re-resolved per-op and fails
          // closed, so this is belt-and-suspenders.
          const requested =
            cookieSession?.tier === 'user'
            && cookieSession.personalTenant === personalTenant
            && typeof cookieSession.tenantId === 'string'
              ? cookieSession.tenantId
              : undefined;
          let active = personalTenant;
          if (requested && requested !== personalTenant) {
            // Membership keys on the CANONICAL subject — after an OIDC bind the
            // member rows were re-keyed `oidc:<sub>` → `user:<userId>`.
            if (await isWorkspaceMember(effectiveSubject, requested)) active = requested;
          } else if (requested) {
            active = requested;
          }
          req.personalTenant = personalTenant;
          req.tenantId = active;
          // Bound (post-bind) callers present the stable `user:<userId>` principal;
          // unbound OIDC callers stay `oidc:<sub>` (backward-compatible).
          if (boundUserId) req.userId = boundUserId;
          req.principal = { principalId: effectiveSubject, tenants: [active], token: bearerToken };
          noteTenantActivity(active);
          // Promote / refresh the cookie when it doesn't already encode this
          // (subject, active-workspace) at user-tier. Without this, a request
          // that drops the Authorization header (SPA token-cache race,
          // EventSource without `?apiKey=`) would fall back to a still-anon
          // cookie and land as anon. No-op on the steady-state hot path.
          if (!cookiesDisabled
            && (!cookieSession
              || cookieSession.tier !== 'user'
              || cookieSession.subject !== subject
              || cookieSession.tenantId !== active
              || cookieSession.userId !== boundUserId)
          ) {
            const sid = base64urlEncode(randomBytes(18));
            const now = Math.floor(Date.now() / 1000);
            const upgraded: SessionPayload = {
              sid, tenantId: active, tier: 'user', subject, personalTenant,
              // Preserve the bound durable userId across re-mints (e.g. a switch),
              // else the canonical subject would silently revert to oidc:<sub>.
              ...(boundUserId ? { userId: boundUserId } : {}),
              iat: now, exp: now + COOKIE_TTL_SECONDS,
            };
            setSessionCookie(res, signSession(upgraded));
          }
          next();
          return;
        } catch (err: unknown) {
          // Stale / expired / wrong-audience JWTs would previously
          // kill the request with 401 even when the browser still
          // had a healthy session cookie. The Firebase JS SDK rotates
          // ID tokens ~hourly but the FE's `cachedIdToken` can lag
          // a few seconds behind the actual rotation, so any in-flight
          // request landing in that window used to hard-fail.
          //
          // Behavior split:
          //   - `cookiesDisabled` (server-to-server callers, the OIDC
          //     conformance test surface) — keep the strict 401 with
          //     the verification reason. There's no fallback path to
          //     use and silently downgrading would be wrong.
          //   - Cookies enabled (the browser case) — log + fall
          //     through to the cookie path so a healthy session
          //     cookie keeps the request alive. Worst case the user
          //     lands on the anon path, which still works for tenant-
          //     scoped reads that key off the resource's tenantId.
          const code = err instanceof OidcVerificationError ? err.code : 'verification_failed';
          if (cookiesDisabled) {
            res.status(401).json({
              error: 'unauthenticated',
              message: 'OIDC token rejected.',
              details: { reason: code },
            });
            return;
          }
          log.warn('OIDC verify failed — falling through to cookie path', { code });
          noteOidcFallthrough(code);
          // fall through
        }
      } else {
        // Bearer present, but neither in the allow-list nor a JWT
        // shape we can verify. Mirror the verify-failure branch:
        // strict 401 when cookies are disabled, log + fall through
        // otherwise.
        if (cookiesDisabled) {
          res.status(401).json({
            error: 'unauthenticated',
            message: 'Bearer token is not recognized by this host.',
          });
          return;
        }
        log.warn('Bearer token unrecognized — falling through to cookie path', {
          looksLikeJwt,
          hasOidc: oidc !== null,
        });
        noteOidcFallthrough(looksLikeJwt ? 'jwt_no_verifier' : 'not_jwt');
        // fall through
      }
    }

    // ─── 2. Session cookie (default for browsers) ───
    if (cookiesDisabled) {
      res.status(401).json({
        error: 'unauthenticated',
        message: 'Missing Bearer token (Authorization header) or apiKey query param.',
      });
      return;
    }
    let session = cookieSession;
    if (!session) {
      if (enforceBearer) {
        // Bearer-required posture: no anon fallback. Matches the spec contract
        // (auth.md) + lets the conformance `auth.test.ts` "no Authorization → 401"
        // pass against the reference host without forcing NODE_ENV=production.
        res.status(401).json({
          error: 'unauthenticated',
          message: 'Missing Bearer token (Authorization header) or apiKey query param.',
        });
        return;
      }
      session = mintAnonSession();
      setSessionCookie(res, signSession(session));
    } else {
      // Sliding-window refresh: if the cookie is past the refresh
      // threshold, reissue it.
      const now = Math.floor(Date.now() / 1000);
      if (session.exp - now < REFRESH_THRESHOLD_SECONDS) {
        session.iat = now;
        session.exp = now + COOKIE_TTL_SECONDS;
        setSessionCookie(res, signSession(session));
      }
    }
    // ADR 0003: a session bound to a durable user presents the STABLE, opaque
    // `user:<userId>` principal (RFC 0048 — non-PII). An OIDC-promoted session
    // carries `subject` (`oidc:<sub>`); an unbound anon session keeps the
    // per-session `session:<sid>` principal.
    const subject = session.userId ?? session.subject;
    // The caller's INTRINSIC personal tenant (persisted on the session, or
    // recomputed from the OIDC subject) — NOT the active tenant, which may be a
    // shared `ws:` the user switched into. Keeps the implicit personal-owner
    // check correct on cookie-only requests.
    const personalTenant =
      session.personalTenant
      ?? (session.subject ? personalTenantForSubject(session.subject) : undefined)
      ?? session.tenantId;
    // Defense-in-depth (ADR 0015): if the active tenant is a SHARED workspace
    // (≠ the personal tenant), re-validate membership every request so a removed
    // member loses access even with authorization enforcement off. A non-member
    // falls back to the personal tenant and we re-pin the cookie to clear the
    // stale workspace.
    let activeTenant = session.tenantId;
    if (subject && activeTenant !== personalTenant) {
      if (!(await isWorkspaceMember(subject, activeTenant))) {
        activeTenant = personalTenant;
        session.tenantId = personalTenant;
        setSessionCookie(res, signSession(session));
      }
    }
    req.tenantId = activeTenant;
    req.personalTenant = personalTenant;
    if (session.userId) {
      req.userId = session.userId;
      req.principal = { principalId: session.userId, tenants: [activeTenant], token: '' };
    } else if (session.subject) {
      req.principal = { principalId: session.subject, tenants: [activeTenant], token: '' };
    } else {
      req.principal = { principalId: `session:${session.sid}`, tenants: [activeTenant], token: '' };
    }
    // Tells the daily cleanup endpoint this tenant is still live so
    // its ephemeral BYOK secrets aren't GC'd.
    noteTenantActivity(activeTenant);
    next();
  };
}
