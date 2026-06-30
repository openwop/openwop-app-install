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
 *      `dev-token` for local dev; production deployments MUST set
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
import { createHash, randomBytes } from 'node:crypto';
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
  // RFC 0076/0100 — the A2A v0.3 AgentCard discovery doc. `a2a.agentCardUrl`
  // points here; cross-host peer discovery is anonymous (no credential), so the
  // GET must bypass auth like `/.well-known/openwop`. The route 404s unless
  // OPENWOP_A2A_SERVER_ENABLED (agents.ts), so this exposes nothing when off.
  '/.well-known/agent-card.json',
  '/schemas/artifacts', // ADR 0055 — public artifact-type JSON Schemas (RFC 0075)
  '/v1/openapi.json',
  '/v1/packs',
  '/v1/interrupts',
  // RFC 0103 normative content delivery (ADR 0064 Phase 3): GET /v1/content/pages/{slug}
  // is anonymous, published-only. Tenant is host-resolved to the reserved system
  // site (the G11 anonymous-tenant carve-out) — never from the request.
  '/v1/content',
  // Production SAML SSO (ADR 0002 / RFC 0050): the SP-initiated redirect, the IdP's
  // browser-driven ACS form-POST, and the SP metadata are all PRE-AUTH (the user
  // has no session yet — the ACS is what MINTS it). The assertion's XML signature
  // is the credential, validated by `host/auth/samlSso`. 404s when SAML is unconfigured.
  '/v1/host/openwop-app/auth/saml/sso',
  // SCIM 2.0 provisioning (RFC 0050 §B): the IdP's SCIM client (Okta / Azure AD)
  // POSTs to /scim/v2/{Users,Groups} with the IdP SCIM bearer — NOT a session
  // cookie or an OPENWOP_API_KEY. Each route does its OWN constant-time bearer
  // check against OPENWOP_SCIM_BEARER (and 404s when unset), so it is the sole
  // gate — like the SAML ACS + /v1/interrupts/{token}, the credential in the
  // request IS the auth. It MUST bypass the global layer: a hardened host
  // (OPENWOP_AUTH_ENFORCE_BEARER / _DISABLE_COOKIES) would otherwise 401 the
  // unrecognized SCIM bearer before the route runs, making SCIM unreachable for
  // exactly the production postures that use it. The conformance seam
  // (/v1/host/openwop-app/auth/scim/provision) is NOT here — it runs under the
  // caller's auth context, so it stays globally gated.
  '/scim/v2',
  // RFC 0055 §C media-asset serving: GET /v1/host/openwop-app/assets/{token} is
  // token-authed (the 32-byte capability token is the credential, like
  // /v1/interrupts/{token}), so embeddable <img src> URLs work without a
  // bearer/cookie. The store path (POST /v1/host/openwop-app/media/put) is NOT
  // under this prefix and stays authenticated.
  '/v1/host/openwop-app/assets',
  // Demo messaging relay device-loop (heartbeat/inbound/outbound/ack) is
  // authed by the per-device token in the `x-openwop-device-token` header
  // — the device token is the credential, like /v1/interrupts/{token}. The
  // operator endpoints (register/activate/revoke/enqueue, connectors,
  // sessions) are NOT under /device and stay bearer-authed.
  '/v1/host/openwop-app/messaging/device',
  // Admin endpoints do their own constant-time check against
  // OPENWOP_ADMIN_TOKEN (separate from OPENWOP_API_KEYS so the
  // session/bearer paths can't confuse the two). Bypassing the
  // session-cookie auth path here lets Cloud Scheduler hit the
  // cleanup cron with just the Bearer admin token.
  '/v1/host/openwop-app/admin',
  // ADR 0012 Publishing & SEO: the PUBLIC published-site surface
  // (GET /v1/host/openwop-app/public/{orgId}/{pages/:slug,sitemap.xml,robots.txt,
  // feed.rss}). Intentionally unauthenticated — published content is public by
  // definition. There is NO credential: the org is in the URL, its tenant comes
  // from `getOrg`, and the surface is gated on the org-tenant's `publishing`
  // toggle + served published-only (drafts never resolve). The authoring +
  // SEO-write surface lives under /v1/host/openwop-app/publishing/* and stays
  // authorizeOrgScope-gated, NOT under this prefix.
  '/v1/host/openwop-app/public',
  // ADR 0027 Site config: the PUBLIC front-page pointer the anonymous SPA reads
  // at '/' (GET /v1/host/openwop-app/public-site-config → { enabled, orgId, slug }).
  // Exposes only already-public ids; the superadmin WRITE is /v1/host/openwop-app/site-config.
  '/v1/host/openwop-app/public-site-config',
  // ADR 0170 App brand: the PUBLIC white-label identity (logo/colors/fonts/title/
  // theme) the anonymous SPA applies before login (it renders on the public shell +
  // gate). GET /v1/host/openwop-app/public-brand → { identity } for the reserved app
  // brand ONLY (no id param; identity subset — no voice/governance/secret data). The
  // superadmin WRITE is /v1/host/openwop-app/app-brand.
  '/v1/host/openwop-app/public-brand',
  // ADR 0013 Sharing: the PUBLIC share-link resolve surface
  // (GET /v1/host/openwop-app/shared/{token}[/card]). Unauthenticated by design — the
  // 32-byte base64url token IS the credential (like /v1/interrupts/{token} and
  // the media serve route). Tenant comes from the link, the surface is gated on
  // the link-tenant's `sharing` toggle, and revoked/expired links 404. The
  // management surface lives under /v1/host/openwop-app/sharing/* and stays
  // authorizeOrgScope-gated — note `shared` ≠ `sharing`, so this prefix does NOT
  // match it.
  '/v1/host/openwop-app/shared',
  // Forms (ADR 0017) — the PUBLIC render + submit surface
  // (GET /v1/host/openwop-app/public-forms/{formId}, POST …/submit). Unauthenticated
  // by design — a published form is public-by-intent. Tenant comes from the form,
  // the surface is gated on the form-tenant's `forms` toggle, and unpublished /
  // missing forms 404. The management surface lives under /v1/host/openwop-app/forms/*
  // and stays authorizeOrgScope-gated — `public-forms` ≠ `forms`, so this prefix
  // does NOT match it.
  '/v1/host/openwop-app/public-forms',
  // Consent (ADR 0020) — the PUBLIC record/read surface
  // (POST /v1/host/openwop-app/public-consent/{orgId}, GET …/{orgId}/{subjectKey}).
  // Unauthenticated by design — a visitor records consent before any auth. Tenant
  // comes from the org, gated on the org-tenant's `consent` toggle. The management
  // surface lives under /v1/host/openwop-app/consent/* and stays authorizeOrgScope-gated
  // — `public-consent` ≠ `consent`, so this prefix does NOT match it.
  '/v1/host/openwop-app/public-consent',
  // Analytics (ADR 0018) — the PUBLIC beacon
  // (POST /v1/host/openwop-app/public-analytics/{orgId}/collect). Unauthenticated by
  // design — a visitor's page/event hit. Tenant comes from the org, gated on the
  // org-tenant's `analytics` toggle AND consent (ADR 0020). The reporting surface
  // lives under /v1/host/openwop-app/analytics/* and stays authorizeOrgScope-gated —
  // `public-analytics` ≠ `analytics`, so this prefix does NOT match it.
  '/v1/host/openwop-app/public-analytics',
  // Connections inbound webhooks (ADR 0024 §6) — the PUBLIC provider-push ingest
  // (POST /v1/host/openwop-app/connections-inbound/{connectionId}). Unauthenticated by
  // design — the provider HMAC signature IS the credential (verified against the
  // connection's stored signing secret); tenant comes from the inbound config.
  // The authoring surface lives under /v1/host/openwop-app/connections/* and stays
  // auth + admin-gated (org-shared connections need `host:connections:manage`;
  // it is no longer feature-toggle-gated — ADR 0024 § Correction) —
  // `connections-inbound` ≠ `connections`, so this prefix does NOT match it.
  '/v1/host/openwop-app/connections-inbound',
];

// Firebase Hosting strips every cookie except `__session` from
// requests it forwards to Cloud Run/Functions
// (https://firebase.google.com/docs/hosting/manage-cache#using_cookies).
// Adopters fronting the workflow-engine with a different reverse proxy
// can override this via OPENWOP_SESSION_COOKIE_NAME — default keeps
// the app.openwop.dev demo working.
// The cookie-session crypto + shape moved to ./cookieSession.ts (SEC-6). Import
// what the middleware uses; re-export the two functions external callers
// (health readiness, SAML/SCIM/password routes) import from here.
import {
  COOKIE_NAME,
  COOKIE_TTL_SECONDS,
  REFRESH_THRESHOLD_SECONDS,
  signSession,
  verifySession,
  mintAnonSession,
  readCookie,
  setSessionCookie,
  sessionSecretConfigError,
  issueUserSession,
  base64urlEncode,
  type SessionPayload,
} from './cookieSession.js';
export { sessionSecretConfigError, issueUserSession };

/** True in any posture that enforces real authentication. */
function authIsEnforced(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.OPENWOP_AUTH_ENFORCE_BEARER === 'true';
}

/**
 * Pure config check, surfaced via `/readiness` (SEC-2). The built-in
 * `dev-token` is withdrawn in production by `readValidKeys` (the actual
 * security control); this only flags a deploy that has EXPLICITLY enforced
 * bearer auth (`OPENWOP_AUTH_ENFORCE_BEARER=true`) yet configured NO bearer
 * credential at all — neither an API key nor OIDC — i.e. one that would reject
 * every request. It deliberately does NOT fire for a plain NODE_ENV=production
 * COOKIE-per-visitor deploy (which legitimately has no API keys), so readiness
 * stays green there. Returns null otherwise.
 */
export function apiKeyConfigError(): string | null {
  if (process.env.OPENWOP_AUTH_ENFORCE_BEARER !== 'true') return null;
  const configured = process.env.OPENWOP_API_KEYS ?? process.env.OPENWOP_API_KEY;
  const hasRealKey = !!configured && configured.split(',').some((s) => s.trim().length > 0);
  if (hasRealKey) return null;
  if (readOidcConfigFromEnv()) return null; // OIDC is the accepted bearer path
  return 'OPENWOP_AUTH_ENFORCE_BEARER=true but no bearer credential is configured — set OPENWOP_API_KEYS (or OIDC via OPENWOP_OIDC_*); otherwise every request is rejected.';
}

function readValidKeys(): ReadonlySet<string> {
  const multi = process.env.OPENWOP_API_KEYS;
  const single = process.env.OPENWOP_API_KEY;
  // Fail closed under enforced auth: do NOT honor the built-in `dev-token`
  // (which maps to a wildcard-tenant admin principal) when no real key is
  // configured. The OIDC/cookie bearer paths still work; only the guessable
  // default is withdrawn (SEC-2).
  const raw = multi ?? single ?? (authIsEnforced() ? '' : 'dev-token');
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
