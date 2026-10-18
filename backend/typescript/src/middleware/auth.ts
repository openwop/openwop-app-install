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
 *      Each entry is `<key>` or `<key>:<tenant>` (ADR 0561):
 *        "k1"      -> tenants: ['default']  (scoped — the safe default)
 *        "k1:acme" -> tenants: ['acme']
 *        "k1:*"    -> tenants: ['*']        (cross-tenant operator; deliberate)
 *      A bare key used to receive the WILDCARD, which made every configured
 *      key a cross-tenant grant. See `readKeyTenants`.
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

import type { Request as ExpressRequest, RequestHandler } from 'express';
import { isProtocolClient, isProtocolRequest, vendorPath } from './protocolVersion.js';
import { SIGNED_INGEST_ROOT } from '../host/signedIngestRoot.js';
import { readKeyTenants } from './apiKeyTenants.js';
import { createHash } from 'node:crypto';
import type { Principal } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { noteTenantActivity } from '../routes/admin.js';
import { delegationIssuerIsLive, isWorkspaceMember } from '../host/accessControlService.js';
import { tenantRequiresMfa } from '../host/governanceService.js';
import { isRevokedApiKey, verifyApiKey } from '../features/developer-keys/apiKeyService.js';
import { tenantKeysDisabled } from '../features/developer-keys/tenantKeyPolicyCache.js';
import { CLI_LOGIN_PATHS, LEAKED_KEYS_PATH } from '../features/developer-keys/paths.js';
import { clientIp } from '../host/clientIp.js';
import { keyAuthorityRefuses, keyPolicyMode, registerOperatorIssuerCheck, reportKeyPolicy } from '../host/delegatedSubject.js';
import { OpenwopError } from '../types.js';
import { resolveSessionSubject, resolveSessionSubjectByPersonalTenant } from '../host/sessionAuthority.js';
import { isPersonalTenantId } from '../host/requestSubject.js';
import { setBearerChallenge } from './authChallenge.js';
import {
  OidcVerifier,
  OidcVerificationError,
  readOidcConfigFromEnv,
  type OidcClaims,
} from './oidcVerifier.js';

const log = createLogger('middleware.auth');

declare module 'express-serve-static-core' {
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
    /** ADR 0621 D2 (review SHOULD-2) — the session epoch THIS request's session
     *  was validated against by `assertSessionSubjectLive` (the cookie's stamp,
     *  asserted equal to the durable row's on the way in; on the unbound lane
     *  the canonical row's). A route that re-mints the session (the workspace
     *  switch) MUST carry this value, never a fresh row read: a bump landing
     *  between middleware validation and the route would otherwise be stamped
     *  onto the new cookie and survive the revoke. Absent when the session has
     *  no durable row (anon, never-bound, break-glass, api-key). */
    sessionEpoch?: number;
    /** ADR 0833 D2/D3 — the VERIFIED user-tier cookie this request's identity
     *  rides on (cookie branch, or the same-identity cookie on the bearer
     *  branch), after the live-session check. A route that re-mints passes it
     *  as the mint's `source` (a re-mint never widens it); logout revokes its
     *  family. Absent for anon, API-key and cookieless bearer requests. */
    cookieSession?: SessionPayload;
    /** True when the caller presented NO credential and this host minted an
     *  identity for them (ADR 0015 anon sessions). Set from `session.tier`, so
     *  it covers a returning anon cookie as well as a fresh mint.
     *
     *  WHY A FLAG AND NOT A `tenantId.startsWith('anon:')` TEST at each call
     *  site: that is a classification derived from an identifier, which is the
     *  exact trap that put `core.db.sql-query` on the wrong side of the replay
     *  classifier. The decision is made HERE, where the credential is (or is
     *  not) presented; every consumer reads the decision instead of re-deriving
     *  it from a string that happens to encode it today.
     *
     *  Consumers MUST NOT treat an anonymous principal as authenticated. See
     *  `requireNonAnonymousPrincipal` — `host-sample-test-seams.md` makes this
     *  normative for any enabled test seam: a host minting an identity BECAUSE
     *  no credential was presented may not count it as authentication. */
    anonymousPrincipal?: boolean;
    /** True when THIS request's session verified a second factor (ADR 0389 P1).
     *  Bearer path: derived per-request from the Firebase ID token's
     *  `firebase.sign_in_second_factor` claim (authoritative). Cookie path: read
     *  from the session payload's `mfa` mark stamped at bind/promotion. Absent ⇒
     *  single-factor; the tenant `requireMfa` gate (Phase 4) fails closed. */
    mfaVerified?: boolean;
    /** The bearer ID token's `auth_time` claim (seconds since epoch of the
     *  Firebase sign-in that minted it), when present (ADR 0389 P2). The vault
     *  reveal route uses it as the STEP-UP gate — a reveal demands a token from
     *  a fresh re-authentication, not an hour-old cached one. Bearer path only;
     *  absent on cookie-only requests (which therefore cannot reveal). */
    oidcAuthTime?: number;
    /** The bearer ID token's `email` claim, present ONLY when the token also
     *  carries `email_verified: true` (ADR 0622 D7 / USERS-20). This is the IdP's
     *  attestation of the address, and the ONLY way an OIDC user's row gets an
     *  `emailProvenance: 'idp'` email — the bind route and the lazy canonical
     *  resolver fold it into the durable `User`. An unverified claim is dropped
     *  here, so downstream never has to re-check the flag. Bearer path only. */
    oidcEmail?: string;
    /** Raw request body bytes, captured by a scoped `express.json({ verify })`
     *  for surfaces that must verify a provider HMAC over the exact payload
     *  (ADR 0024 inbound webhooks). Undefined everywhere else. */
    rawBody?: Buffer;
  }
}


/** ADR 0389 P4 — tenant MFA enforcement, FAIL-CLOSED. A shared workspace whose
 *  governance policy sets `requireMfa` refuses sessions that did not verify a
 *  second factor (`req.mfaVerified` — the Firebase claim on the bearer path,
 *  the session mark on the cookie path, the IdP-delegated SAML stamp). The
 *  PERSONAL tenant is exempt by construction: the user must be able to sign in
 *  and reach Settings → Security to enroll. Returns true when the request was
 *  refused (response already sent). */
/** Escape hatches from the MFA gate — the routes a REFUSED session still needs
 *  to recover: sign out, switch back to the personal workspace, list
 *  workspaces, and read its own security posture (the enroll deep-link's data).
 *  Without these, a cookie pinned to a requireMfa workspace is a full lockout
 *  (even logout would 401). */
const MFA_GATE_EXEMPT_PREFIXES = [
  '/host/openwop-app/users/auth',
  '/host/openwop-app/users/me/security',
  '/host/openwop-app/me/workspaces',
];
/** The one workspaces route a refused session needs: switching BACK. Bare
 *  startsWith('/workspaces') also exempted CREATE (grade-pass SEC-C10). */
const MFA_GATE_SWITCH_RE = /^\/host\/openwop-app\/workspaces\/[^/]+\/switch$/;
/** Segment-boundary match (the isPublicPath idiom) — plain startsWith would
 *  also exempt any future '/…securityX' sibling (grade-pass SEC-C10). */
// A missed exemption fails CLOSED: an MFA-refused user could not even sign out.
function isMfaGateExempt(rawPath: string): boolean {
  const path = rawPath;
  if (MFA_GATE_SWITCH_RE.test(path)) return true;
  return MFA_GATE_EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** True when `activeTenant` requires a second factor this session did not
 *  verify. The ONE decision, shared by the HTTP gate below and the
 *  `resolveLiveCookieSession` lanes (ADR 0833 D1 — a socket answers it too). */
async function mfaGap(activeTenant: string, personalTenant: string | undefined, mfaVerified: boolean): Promise<boolean> {
  // USERS-19 (review SHOULD-3): "active === personal" only means "one human, the
  // enrollment path must stay reachable" when the personal tenant has a personal
  // SHAPE. A SAML session's `personalTenant` IS `OPENWOP_SAML_TENANT` (a shared,
  // deployment-named tenant), so without the shape gate that tenant's `requireMfa`
  // policy was never enforced on the sessions that live there.
  if (activeTenant === personalTenant && isPersonalTenantId(personalTenant)) return false;
  if (mfaVerified) return false;
  return tenantRequiresMfa(activeTenant);
}

async function refuseIfMfaRequired(
  req: import('express').Request,
  res: import('express').Response,
  activeTenant: string,
  personalTenant: string | undefined,
): Promise<boolean> {
  if (isMfaGateExempt(req.path)) return false;
  if (!(await mfaGap(activeTenant, personalTenant, req.mfaVerified === true))) return false;
  res.status(401).json({
    error: 'unauthenticated',
    message: 'This workspace requires two-factor authentication. Enroll an authenticator app in Settings → Security, sign in again, and retry.',
    details: { reason: 'mfa_required', settingsUrl: '/settings#security' },
  });
  return true;
}

export const PUBLIC_PATH_PREFIXES = [
  // ADR 0785 P1 — the Claude Code companion's device-code start + poll. It has
  // no identity until paired (that is what these two routes produce); it holds
  // only a hashed device code, is operator-gated (404 when off), rate-limited per
  // IP, and expires in ten minutes. Nothing else under /claude-code is public.
  vendorPath('/claude-code/pair/device'),
  // ADR 0421 P1 — the tokenized KickTodo calendar feed: the token IS the
  // capability (hashed at rest, revocable); the route 404s uniformly and
  // exposes titles+day numbers only. Auth-bypassed like the other public
  // resource-derived surfaces.
  '/public/kicktodo/feed',
  // ADR 0462 P2 — the tokenized KickTodo wearable provider webhook: the token IS the
  // (tenant,provider) capability; the push signature is verified before any work;
  // uniform 401/404. Auth-bypassed like the feed (the provider has no session).
  '/public/kicktodo/wearable-webhook',
  // ADR 0260 — the reference UCP-over-MCP DEMO merchant endpoint. The caller is
  // the app's own UCP buyer acting as an EXTERNAL MCP client (loopback in tests):
  // it presents the seeded demo bearer, not a session — without this bypass the
  // fail-closed bearer rejection 401s the hop before the route can answer. The
  // route mounts ONLY under OPENWOP_UCP_REF_MERCHANT_ENABLED (never a real
  // deploy) and serves demo catalog data; money safety lives in the buyer.
  '/host/openwop-app/dev/ucp-merchant/mcp',
  // RFC 0132 (Draft) — the anonymous-actor conformance witness seam
  // (GET/POST /v1/host/sample/anon-surface/*). Unauthenticated BY CONSTRUCTION —
  // an anonymous public surface has no credential (the RFC's whole point); the
  // handlers 404 unless OPENWOP_ANON_ACTOR_ENABLED, so this exposes nothing when
  // off. The production widget path is separately public under
  // /v1/host/openwop-app/public and stays there.
  '/host/sample/anon-surface',
  '/health',
  '/readiness',
  '/.well-known/openwop',
  // RFC 0076/0100 — the A2A v0.3 AgentCard discovery doc. `a2a.agentCardUrl`
  // points here; cross-host peer discovery is anonymous (no credential), so the
  // GET must bypass auth like `/.well-known/openwop`. The route 404s unless
  // OPENWOP_A2A_SERVER_ENABLED (agents.ts), so this exposes nothing when off.
  '/.well-known/agent-card.json',
  // RFC 0200 §A.2 — the protected-resource metadata MUST be readable WITHOUT a
  // credential: its entire purpose is to be fetched by a client that has just been
  // refused, off the `resource_metadata` in the challenge. Behind a credential it could
  // not serve that role. A prefix, not an exact path, because RFC 9728 §3.1's sub-path
  // form (`…/oauth-protected-resource/api`) is the URL this host is reached at behind
  // the Hosting rewrite. It discloses nothing an unauthenticated caller cannot already
  // read at `/.well-known/openwop`: the same lane issuers.
  '/.well-known/oauth-protected-resource',
  // ADR 0550 P4 — the published conformance claims + the RFC 0148 §C bundle
  // `capabilities.conformance.certificationBundleUrl` points at. A certification
  // claim behind a credential is not a public claim: RFC 0089 §D exists so "any
  // third party (auditor, adopter, registry)" can mechanically re-check it, the
  // same anonymous-discovery trust model as `/.well-known/openwop` above. Both
  // routes 404 unless the image carries the stamp, so this exposes nothing when
  // absent, and RFC 0148 §E + the emitter's scrub keep credentials out of the
  // evidence itself.
  '/host/openwop-app/conformance',
  '/schemas/artifacts', // ADR 0055 — public artifact-type JSON Schemas (RFC 0075)
  '/openapi.json',
  // v1 end-of-support (2026-10-04) — the same read-only, public installed-pack
  // reads at the host's vendor address, which survives the v1 cut (the `/v1`
  // Registry HTTP API above retires with v1). `openwop catalog` reads these.
  vendorPath('/packs'),
  '/interrupts',
  // ADR 0478 §2 — the decide-by-email confirm page fronting POST /v1/interrupts/:token.
  // Same trust model as /v1/interrupts: the RFC 0093 token IS the authorization
  // (guest approvers have no session); GET renders a form and never mutates.
  '/host/openwop-app/interrupt-action',
  // `/v1/content` is deliberately NOT here (ADR 0748). It used to be, which made
  // the whole subtree auth-less and CSRF-exempt — harmless while it held one
  // anonymous GET, and an open write surface the moment the RFC 0103 §D admin
  // ops landed beside it. The delivery GET is now OPTIONALLY authenticated
  // instead: see `isCredentialOptionalRead` below.
  // Production SAML SSO (ADR 0002 / RFC 0050): the SP-initiated redirect, the IdP's
  // browser-driven ACS form-POST, and the SP metadata are all PRE-AUTH (the user
  // has no session yet — the ACS is what MINTS it). The assertion's XML signature
  // is the credential, validated by `host/auth/samlSso`. 404s when SAML is unconfigured.
  '/host/openwop-app/auth/saml/sso',
  // Break-glass operator login (ADR 0389 P3): the scrypt-verified token in the
  // body IS the credential (SAML-ACS precedent). Must bypass the global layer —
  // a hardened posture 401ing the locked-out operator is exactly the scenario
  // break-glass exists for. 404s unless OPENWOP_BREAKGLASS_ENABLED=true.
  '/host/openwop-app/auth/break-glass',
  // ADR 0798 D8 — report a leaked API key. The full secret in the body IS the
  // credential (whoever holds it could use the key; this only lets them revoke
  // it), so a secret scanner with no account can call it. POST only; the rest
  // of `/developer-keys` stays authenticated — this is an exact path, and
  // `isPublicPath` matches a prefix only at a segment boundary.
  LEAKED_KEYS_PATH,
  // ADR 0799 — CLI sign-in: the CLI starts and polls with no credential (the
  // device code it holds is one, kept only as a hash). Approving is NOT here.
  CLI_LOGIN_PATHS.start,
  CLI_LOGIN_PATHS.poll,
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
  '/host/openwop-app/assets',
  // ADR 0328 P4 present-mode phone remote: the stateless HMAC capability token
  // in the path IS the credential (mintable only behind the canvas factory's
  // org gate); every route under it 404s uniformly on a bad/expired token.
  '/host/openwop-app/present',
  // Demo messaging relay device-loop (heartbeat/inbound/outbound/ack) is
  // authed by the per-device token in the `x-openwop-device-token` header
  // — the device token is the credential, like /v1/interrupts/{token}. The
  // operator endpoints (register/activate/revoke/enqueue, connectors,
  // sessions) are NOT under /device and stay bearer-authed.
  '/host/openwop-app/messaging/device',
  // Admin endpoints do their own constant-time check against
  // OPENWOP_ADMIN_TOKEN (separate from OPENWOP_API_KEYS so the
  // session/bearer paths can't confuse the two). Bypassing the
  // session-cookie auth path here lets Cloud Scheduler hit the
  // cleanup cron with just the Bearer admin token.
  '/host/openwop-app/admin',
  // ADR 0012 Publishing & SEO: the PUBLIC published-site surface
  // (GET /v1/host/openwop-app/public/{orgId}/{pages/:slug,sitemap.xml,robots.txt,
  // feed.rss}). Intentionally unauthenticated — published content is public by
  // definition. There is NO credential: the org is in the URL, its tenant comes
  // from `getOrg`, and the surface is gated on the org-tenant's `publishing`
  // toggle + served published-only (drafts never resolve). The authoring +
  // SEO-write surface lives under /v1/host/openwop-app/publishing/* and stays
  // authorizeOrgScope-gated, NOT under this prefix.
  '/host/openwop-app/public',
  // ADR 0407 D2 — the anonymous entity read (entity-backed CMS sections + the
  // headless delivery surface). Opt-in TWICE server-side: the tenant's
  // `entities` toggle AND the type's `publicRead` flag (a type-admin op); the
  // route serves published types' LIVE entries only, via a projection that
  // strips actor subjects. A sibling prefix, NOT nested under the authed
  // /entities namespace (the `public-forms` ≠ `forms` rule below).
  '/host/openwop-app/public-entities',
  // ADR 0544 D3 attestation verification: an EMPLOYER who received an
  // application resolves a bearer token to the claims it carries. Anonymous by
  // definition — the verifier is a stranger we have no relationship with, so
  // requiring onboarding would make the feature unusable and requiring auth
  // would tell us who is checking. A SIBLING prefix, not nested under the authed
  // /job-search namespace (the `public-forms` ≠ `forms` rule below). Unknown,
  // revoked and cross-tenant are one uniform 404.
  '/host/openwop-app/public-attestations',
  // ADR 0384 crawler prerender: the platform-origin DOCUMENT paths (`/` exact +
  // `/p/:slug`) are served by the publishing feature once the Firebase Hosting
  // document-rewrite is flipped (DEPLOY.md). Anonymous by definition — the same
  // published-only public surface as /public above, in HTML instead of JSON.
  // `/` is matched EXACT-ONLY by the matcher below (the `p + '/'` startsWith
  // branch is skipped for it) — so it can never widen the anonymous surface to a
  // `//`-prefixed path, independent of any upstream path-normalization behavior.
  '/',
  '/p',
  // ADR 0824 D4/D5 — the ROOT crawler/agent doors: `/llms.txt` (docs routes)
  // and `/robots.txt` + `/sitemap.xml` (publishing routes). Exact paths, no
  // credential, the same published-only content as the `/public` prefix
  // above. `/llms.txt` was hosting-rewritten here but missing from this list,
  // so the live door answered every agent with a 401.
  '/llms.txt',
  '/robots.txt',
  '/sitemap.xml',
  // ADR 0281 — the dealer PARTNER PORTAL. The capability token in the path IS the
  // credential (the Sharing pattern): tenant/org/dealer resolve FROM the token,
  // never the request; a bad token 404s uniformly. Rides the global per-IP rate
  // limit + bounded payloads. Registers no session.
  '/host/openwop-app/partner',
  // ADR 0027 Site config: the PUBLIC front-page pointer the anonymous SPA reads
  // at '/' (GET /v1/host/openwop-app/public-site-config → { enabled, orgId, slug }).
  // Exposes only already-public ids; the superadmin WRITE is /v1/host/openwop-app/site-config.
  '/host/openwop-app/public-site-config',
  // ADR 0170 App brand: the PUBLIC white-label identity (logo/colors/fonts/title/
  // theme) the anonymous SPA applies before login (it renders on the public shell +
  // gate). GET /v1/host/openwop-app/public-brand → { identity } for the reserved app
  // brand ONLY (no id param; identity subset — no voice/governance/secret data). The
  // superadmin WRITE is /v1/host/openwop-app/app-brand.
  '/host/openwop-app/public-brand',
  // ADR 0013 Sharing: the PUBLIC share-link resolve surface
  // (GET /v1/host/openwop-app/shared/{token}[/card]). Unauthenticated by design — the
  // 32-byte base64url token IS the credential (like /v1/interrupts/{token} and
  // the media serve route). Tenant comes from the link, and revoked/expired
  // links 404.
  // § CORRECTION (SHARE-1, 2026-08-18): this comment used to say the surface is
  // "gated on the link-tenant's `sharing` toggle". That toggle was REMOVED by
  // ADR 0434 — the sentence outlived the mechanism, on a security boundary, and
  // the next auditor would have trusted a gate that was not there. What gates
  // content today is the OWNING feature's toggle, resolved against the LINK's
  // tenant, for the eight resource types whose owner declares one; four types
  // (cms_page, kb_collection, prompt, conversation) have no owning toggle
  // because their features are always-on. See `sharingService.ts`
  // `owningFeatureEnabled`.
  // The management surface lives under /v1/host/openwop-app/sharing/* and stays
  // authorizeOrgScope-gated — note `shared` ≠ `sharing`, so this prefix does NOT
  // match it.
  '/host/openwop-app/shared',
  // Forms (ADR 0017) — the PUBLIC render + submit surface
  // (GET /v1/host/openwop-app/public-forms/{formId}, POST …/submit). Unauthenticated
  // by design — a published form is public-by-intent. Tenant comes from the form,
  // the surface is gated on the form-tenant's `forms` toggle, and unpublished /
  // missing forms 404. The management surface lives under /v1/host/openwop-app/forms/*
  // and stays authorizeOrgScope-gated — `public-forms` ≠ `forms`, so this prefix
  // does NOT match it.
  '/host/openwop-app/public-forms',
  // Booking links (ADR 0402) — the PUBLIC self-serve scheduler + slot claim + the
  // manage (reschedule/cancel) surface. Unauthenticated by design; tenant comes
  // from the resolved booking link (never the request), gated on the link-tenant's
  // `crm` toggle + published-only, uniform 404. The manage routes authorize by the
  // sharing `booking_manage` capability TOKEN. `public-book` ≠ `crm`/`book`, so
  // this prefix does NOT shadow the authed `…/crm/*` management surface.
  '/host/openwop-app/public-book',
  // E-signature (ADR 0402 §b) — the PUBLIC signing surface. The signer authorizes
  // by the emailed sharing `sign_request` capability token (possession = identity,
  // the commerce-quote precedent); tenant from the resolved request, gated on the
  // link-tenant's `crm` toggle, uniform 404. `public-sign` ≠ `crm`, so this prefix
  // does NOT shadow the authed `…/crm/*` management surface.
  '/host/openwop-app/public-sign',
  // Consent (ADR 0020) — the PUBLIC record/read surface
  // (POST /v1/host/openwop-app/public-consent/{orgId}, GET …/{orgId}/{subjectKey}).
  // Unauthenticated by design — a visitor records consent before any auth. Tenant
  // comes from the org, gated on the org-tenant's `consent` toggle. The management
  // surface lives under /v1/host/openwop-app/consent/* and stays authorizeOrgScope-gated
  // — `public-consent` ≠ `consent`, so this prefix does NOT match it.
  '/host/openwop-app/public-consent',
  // Analytics (ADR 0018) — the PUBLIC beacon
  // (POST /v1/host/openwop-app/public-analytics/{orgId}/collect). Unauthenticated by
  // design — a visitor's page/event hit. Tenant comes from the org, gated on the
  // org-tenant's `analytics` toggle AND consent (ADR 0020). The reporting surface
  // lives under /v1/host/openwop-app/analytics/* and stays authorizeOrgScope-gated —
  // `public-analytics` ≠ `analytics`, so this prefix does NOT match it.
  '/host/openwop-app/public-analytics',
  // Email engagement redirects + unsubscribe (ADR 0218): followed by recipients'
  // mail clients — no session exists. Opaque single-purpose tokens; the handlers
  // only 302 to a stored URL or flip an unsubscribe. `public-email` ≠ `email`,
  // so the authed feature prefix stays gated.
  '/host/openwop-app/public-email',
  // App-builder inbound sync webhook (ADR 0393 Phase 2) — the PUBLIC GitHub-push
  // ingest (POST /v1/host/openwop-app/app-builder-sync/webhook/{webhookId}).
  // Unauthenticated by design — the GitHub HMAC signature over the raw body IS
  // the credential (verified against the binding's sealed secret); tenant comes
  // from the stored binding. The editor/binding surface lives under
  // /v1/host/openwop-app/app-builder/* and stays authorizeOrgScope-gated —
  // `app-builder-sync` ≠ `app-builder`, so this prefix does NOT match it.
  '/host/openwop-app/app-builder-sync/webhook',
  // ADR 0793 / RFC 0230 — the SIGNED inbound-webhook ingest
  // (POST /host/openwop-app/trigger-ingest/{subscriptionId}). Unauthenticated by
  // design: the Standard Webhooks signature over the raw body IS the credential
  // (verified against the subscription's sealed `whsec_` secret); tenant comes
  // from the stored subscription. 404 unless OPENWOP_TRIGGER_INBOUND_SIGNING=true.
  // The subscription-management surface `/v1/trigger-subscriptions*` stays
  // credential-gated; `trigger-ingest` shares no prefix with it.
  SIGNED_INGEST_ROOT,
  // Connections inbound webhooks (ADR 0024 §6) — the PUBLIC provider-push ingest
  // (POST /v1/host/openwop-app/connections-inbound/{connectionId}). Unauthenticated by
  // design — the provider HMAC signature IS the credential (verified against the
  // connection's stored signing secret); tenant comes from the inbound config.
  // The authoring surface lives under /v1/host/openwop-app/connections/* and stays
  // auth + admin-gated (org-shared connections need `host:connections:manage`;
  // it is no longer feature-toggle-gated — ADR 0024 § Correction) —
  // `connections-inbound` ≠ `connections`, so this prefix does NOT match it.
  '/host/openwop-app/connections-inbound',
  // Stripe billing webhook (ADR 0176) — the PUBLIC provider-push ingest
  // (POST /v1/host/openwop-app/billing/webhook). Unauthenticated by design — Stripe's
  // signature over the raw body IS the credential (verified against the host webhook
  // signing secret); tenant is resolved from the event's customer/metadata. The
  // authoring/read surface `/v1/host/openwop-app/billing/*` stays auth-gated —
  // `billing/webhook` is the ONLY public billing path (exact-or-deeper match, and
  // `/billing/subscription` etc. do NOT start with `/billing/webhook`).
  '/host/openwop-app/billing/webhook',
  // Public storefront (ADR 0177 Phase 3) — read-only active-product listing, org in the
  // URL, tenant host-resolved. Unauthenticated + published-only (like public-forms).
  // The authoring surface `/v1/host/openwop-app/commerce/*` stays auth-gated;
  // `public-store` ≠ `commerce`, so this prefix does NOT match it.
  '/host/openwop-app/public-store',
  '/host/openwop-app/public-recommendations',
  '/host/openwop-app/public-discovery',
  // Commerce Stripe webhook (ADR 0177 deferred P3) — PUBLIC provider-push; Stripe's
  // signature over the raw body IS the credential; tenant/order from the event metadata.
  // `commerce/webhook` ≠ `commerce`, so this does NOT match the authed commerce surface.
  '/host/openwop-app/commerce/webhook',
  // UCP server adapter (ADR 0178) — PUBLIC agentic-commerce surface; external AI agents
  // discover the catalog + transact. Tenant from the merchant-org in the path; the
  // `commerce-ucp` toggle gates it; cart/checkout writes need an OAuth bearer + scope.
  // `commerce/ucp` ≠ `commerce/orgs`, so the authed admin UCP routes stay auth-gated.
  '/host/openwop-app/commerce/ucp',
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
  REFRESH_THRESHOLD_SECONDS,
  signSession,
  verifySession,
  mintAnonSession,
  readCookie,
  setSessionCookie,
  sessionSecretConfigError,
  issueUserSession,
  clearSessionCookie,
  buildSessionPayload,
  refreshSessionPayload,
  familyOf,
  endedUserSession,
  type SessionPayload,
} from './cookieSession.js';
export { sessionSecretConfigError, issueUserSession, clearSessionCookie };

/** True when `path` is a PUBLIC (pre-auth) surface — the same match the auth
 *  middleware uses to bypass. Exported so the CSRF guard exempts the exact same
 *  set (the public embed/webhook POST surfaces are cross-origin BY DESIGN). */
// ADR 0795 D6 — an operator-issued delegation is the tenant's own only while
// the env key that issued it is still configured (`bearer:<first 8 chars>`).
// ADR 0822 (WFAC-17) — with a `tenantId`, the key must ALSO be configured for
// that tenant (or `*`): a run actor carries no delegation row to bind it.
registerOperatorIssuerCheck((issuer, tenantId) => {
  const prefix = issuer.slice('bearer:'.length);
  if (prefix.length === 0) return false;
  for (const [key, tenants] of readKeyTenants()) {
    if (key.slice(0, 8) !== prefix) continue;
    if (tenantId === undefined || tenants.includes(tenantId) || tenants.includes('*')) return true;
  }
  return false;
});

/**
 * ADR 0795 D6 — cached for a minute per key: the answer is a membership read
 * (three full collection lists on a shared workspace), and member removal
 * REVOKES the issuer's keys outright, so this is the backstop, not the switch.
 */
const issuerLiveCache = new Map<string, { live: boolean; at: number }>();
const ISSUER_LIVE_TTL_MS = 60_000;
async function issuerStillLive(keyId: string, tenantId: string): Promise<boolean> {
  const now = Date.now();
  const hit = issuerLiveCache.get(keyId);
  if (hit && now - hit.at < ISSUER_LIVE_TTL_MS) return hit.live;
  let live: boolean;
  try {
    live = await delegationIssuerIsLive(tenantId, `apikey:${keyId}`);
  } catch (err) {
    // A store error is not an answer. Refuse THIS request and cache nothing, so
    // a blip neither admits the key nor keeps it out for a minute.
    log.error('issuer liveness read failed — refusing this request', { keyId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
  if (issuerLiveCache.size > 5000) issuerLiveCache.clear();
  issuerLiveCache.set(keyId, { live, at: now });
  return live;
}

/**
 * ADR 0795 D6 for a lane that verifies a key WITHOUT this middleware (the
 * Claude Code device websocket). True when the key must be refused.
 */
export async function apiKeyIssuerRefused(keyId: string, tenantId: string): Promise<boolean> {
  if (await issuerStillLive(keyId, tenantId)) return false;
  return keyAuthorityRefuses('issuer-not-live', keyId, { tenantId });
}

/** Test seam: forget cached issuer answers. */
export function resetIssuerLiveCacheForTests(): void {
  issuerLiveCache.clear();
}

/** A GET on a run's event stream — the one request `EventSource` makes, which
 *  cannot carry an Authorization header. */
function isRunEventsStream(req: ExpressRequest): boolean {
  // Anchored on the canonical protocol path: a vendor route that merely ENDS
  // in `/runs/<x>/events` is not the stream.
  return req.method === 'GET' && RUN_EVENTS_STREAM.test(req.path);
}
const RUN_EVENTS_STREAM = /^\/runs\/[^/]+\/events$/;

/** A GET on a run's event stream carrying a `?streamToken=` capability. */
export function carriesRunStreamToken(req: ExpressRequest): boolean {
  return req.method === 'GET'
    && typeof req.query?.streamToken === 'string'
    && /\/runs\/[^/]+\/events$/.test(req.path);
}

// This one predicate also feeds the CSRF exemption and the ADR 0806 forwarder
// (`heldByThirdParties` in `index.ts`, which strips the inbound `/v1` twin with
// `retiredVendorTwinPath` before asking), so all three move together. It is only
// ever handed an unversioned path (ADR 0812 P3c).
export function isPublicPath(path: string): boolean {
  // The `p !== '/'` guard keeps a `/` prefix from matching every path via `'//'`.
  if (PUBLIC_PATH_PREFIXES.some((p) => path === p || (p !== '/' && path.startsWith(p + '/')))) return true;
  // ADR 0915 — a feature path is public only on a CANONICAL path: no dot
  // segment and no percent-escape anywhere. `startsWith` on an un-normalized
  // path would let `<prefix>/..%2F..%2Fother` count as public, and the /api
  // rewrite decodes `%2F` (measured), so a proxy that normalizes after this
  // check could route it to a session-only handler.
  if (FEATURE_PUBLIC_PATHS.size > 0 && !/(?:^|\/)\.{1,2}(?:\/|$)|%/.test(path)) {
    for (const p of FEATURE_PUBLIC_PATHS) if (path === p || path.startsWith(p + '/')) return true;
  }
  return false;
}

/**
 * ADR 0915 (Book AI P4) — public paths a FEATURE declares
 * (`BackendFeature.publicPaths`), merged into `isPublicPath` at boot.
 *
 * The closed list above belongs to this file, so a feature with its own
 * capability-token surface (Book AI's beta-reader links) could only borrow
 * ANOTHER feature's public prefix — and that feature's security boundary. A
 * declared path is confined to the declaring feature's own namespace:
 *
 *   - it must sit strictly BELOW `/host/openwop-app/<featureId>/` (one or more
 *     lowercase segments), so a feature can never open its whole namespace,
 *     another feature's namespace, or anything outside the vendor tree;
 *   - no wildcards, no trailing slash, no `..`.
 *
 * A violation throws at boot, never at request time. Being public only skips
 * session resolution: the owning route MUST authenticate its own capability
 * (the token IS the credential, hashed at rest), answer a uniform 404 for an
 * unknown or revoked one (no existence leak), and it still rides the global
 * per-IP limiter — the ADR 0013 share-link precedent. The same predicate feeds
 * the CSRF exemption, which is correct for a cookie-less route.
 */
const FEATURE_PUBLIC_PATHS = new Set<string>();
const FEATURE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SEGMENTS = /^(?:\/[a-z0-9][a-z0-9-]{0,63}){1,6}$/;

export function registerFeaturePublicPaths(featureId: string, paths: readonly string[]): void {
  if (!FEATURE_ID.test(featureId)) throw new Error(`feature public paths: invalid feature id ${JSON.stringify(featureId)}`);
  const root = `/host/openwop-app/${featureId}`;
  for (const p of paths) {
    if (typeof p !== 'string' || !p.startsWith(root + '/') || !SEGMENTS.test(p.slice(root.length))) {
      throw new Error(`feature ${featureId}: public path ${JSON.stringify(p)} must be strictly below ${root}/ (lowercase segments, no wildcard, no trailing slash)`);
    }
    FEATURE_PUBLIC_PATHS.add(p);
  }
}

/** The feature-declared public paths, for the boot log and the ratchet. */
export function featurePublicPaths(): readonly string[] { return [...FEATURE_PUBLIC_PATHS].sort(); }

/** Test seam. */
export function resetFeaturePublicPathsForTests(): void { FEATURE_PUBLIC_PATHS.clear(); }

/**
 * ADR 0748 — `GET|HEAD /v1/content/pages/<slug>`, and nothing else: exact method,
 * exact depth. RFC 0103 §F makes the delivery tenant credential-derived WHEN
 * authenticated and host-defined when anonymous, so this read must see a
 * credential if one is presented — which a public-prefix bypass never does.
 * The shape is exact because its siblings (`POST /v1/content/pages`, `PUT …/sections/…`)
 * are admin writes that must never ride this carve-out.
 */
export function isCredentialOptionalRead(method: string, path: string): boolean {
  return (method === 'GET' || method === 'HEAD') && /^\/content\/pages\/[^/]+$/.test(path);
}

/**
 * Refuse a request whose principal is ANONYMOUS — i.e. one this host minted
 * because no credential was presented.
 *
 * `host-sample-test-seams.md` §"Production safety": an enabled test seam MUST
 * require an authenticated, NON-ANONYMOUS principal, and a host minting an
 * identity because no credential was presented MUST NOT count it.
 *
 * WHY THE CLAUSE READS THAT WAY, since the history is the point. It first said
 * a seam must apply "the same authentication and tenant resolution as the
 * canonical surface" — which THIS host already satisfied while the seam was
 * wide open, because RFC 0132 makes anonymous actors legitimate on the
 * canonical surface. `authMiddleware` runs on the seam prefix, is not on
 * `PUBLIC_PATH_PREFIXES`, resolves a tenant, and SUCCEEDS anonymously
 * (`mintAnonSession`). So "auth is applied" was true and worthless.
 *
 * That is why the check binds the property rather than the mechanism: a route
 * having a gate is a PROXY for unauthenticated callers being refused, and the
 * proxy failed here in the reassuring direction.
 *
 * Deliberately NOT `req.tenantId.startsWith('anon:')` — see the
 * `anonymousPrincipal` docblock.
 */
export function requireNonAnonymousPrincipal(surface: string): RequestHandler {
  return (req, res, next) => {
    if (req.anonymousPrincipal === true || !req.principal) {
      res.status(401).json({
        error: 'unauthenticated',
        message: `${surface} requires an authenticated, non-anonymous principal.`,
        details: { reason: 'anonymous_principal_refused' },
      });
      return;
    }
    next();
  };
}

/**
 * Pure config check, surfaced via `/readiness` (SEC-2). The built-in
 * `dev-token` is withdrawn in production by `readKeyTenants` (the actual
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

/**
 * The env-configured API keys, each mapped to the tenants it may act as
 * (ADR 0561).
 *
 * SYNTAX. `OPENWOP_API_KEYS` is a CSV of `<key>` or `<key>:<tenant>`:
 *
 *     "k1"        -> tenants: ['default']   (scoped — the safe default)
 *     "k1:acme"   -> tenants: ['acme']
 *     "k1:*"      -> tenants: ['*']         (cross-tenant, and it has to be WRITTEN)
 *
 * WHY THE DEFAULT CHANGED. Every configured key used to receive `tenants:['*']`
 * unconditionally, and that is a full cross-tenant grant: `host/runAccess.ts`
 * returns any run to a wildcard principal before the ownership check, and a
 * dozen other sites treat it as operator authority. The comment sitting on that
 * code said "real deployments narrow via a key→tenant table" — describing a
 * table that did not exist, so there was no way to narrow and the wildcard was
 * the only reachable behaviour.
 *
 * MEASURED before changing it: the demo deployment sets `OPENWOP_API_KEYS=""`
 * (DEPLOY.md documents the empty value as correct for the cookie-per-visitor
 * posture) and `OPENWOP_API_KEY` is absent, so the set is empty and no bearer
 * matched. The grant was inert in production — a loaded gun with no round
 * chambered, not an active breach. Fixing the default is cheap precisely
 * because nothing depends on it yet.
 *
 * Cross-tenant access is still available; it is now something an operator
 * writes down. That is the whole change.
 */

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
function personalTenantForSubject(subject: string | undefined): string | undefined {
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
  opts: { subject: string; tenantId: string; personalTenant?: string; mfa?: boolean; epoch?: number; source: SessionPayload | undefined },
): void {
  // ADR 0833 D2 — `source` is the verified cookie being replaced: a re-mint
  // inherits its family, `authAt` and (break-glass) its `noRefresh` + `exp`
  // ceiling. It used to set `exp = now + 24h` and drop `noRefresh`, so a
  // 10-minute break-glass session became a sliding 24h cookie via one switch.
  const session = buildSessionPayload({
    tenantId: opts.tenantId,
    tier: 'user',
    subject: opts.subject,
    personalTenant: opts.personalTenant,
    // GRADE-PASS 2026-07-17 (DATA-7): an unbound OIDC user's workspace switch
    // was silently dropping the verified-second-factor mark.
    ...(opts.mfa ? { mfa: true } : {}),
    // ADR 0621 rev. 2 — the unbound lane carries the canonical row's epoch too
    // (the value the middleware validated on THIS request, `req.sessionEpoch`),
    // so "sign out everywhere" ends an unbound session as well.
    ...(typeof opts.epoch === 'number' ? { epoch: opts.epoch } : {}),
  }, { source: opts.source ?? null });
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

/** The session's INTRINSIC personal tenant — persisted on the payload, else
 *  recomputed from the OIDC subject, else (an unswitched subject session) the
 *  active tenant. One definition, shared by the cookie branch and the
 *  unbound-lane authority read so the two can never disagree. */
function personalTenantOfSession(session: SessionPayload): string {
  return session.personalTenant
    ?? (session.subject ? personalTenantForSubject(session.subject) : undefined)
    ?? session.tenantId;
}

/** What a live-session check hands back: the epoch the session was validated
 *  against (`req.sessionEpoch`), or `undefined` when the session has no durable
 *  row to be revoked against (anon, never-bound, break-glass). */
export interface SessionLiveness { epoch: number }

/**
 * ADR 0621 D1 — is this durable-user session still allowed to exist? Called at
 * EVERY point a cookie-borne `userId` becomes `req.userId` (the cookie branch,
 * the OIDC bearer branch's `boundUserId`, and — by ordering — the promotion
 * mint, which can only carry a `userId` this check has just validated on the
 * same request). A keyed point read through the `host/sessionAuthority.ts`
 * seam the users feature registers (core never imports the feature).
 *
 * Rev. 2 (review BLOCKER-1): an UNBOUND user-tier session (`oidc:<sub>`, no
 * `userId`) in a `user:`-shaped personal tenant is checked too, through the
 * seam's READ-ONLY canonical read (`assertPersonalSubjectLive`) — the durable
 * row for that human exists whether or not the cookie names it, so "no row to
 * disable" was never true for this lane.
 *
 * Skipped by TIER, not by tenant prefix (D4 / the ADR 0601 rule): an anon
 * session and a break-glass session carry no durable identity — untouched. A
 * user-tier session whose personal tenant is NOT personal-shaped (SAML's
 * `OPENWOP_SAML_TENANT`, `default`) is bound by construction (the SAML ACS
 * always mints a `userId`), so the unbound read has nothing to resolve there.
 *
 * Outcomes, all typed so `errorEnvelope` renders the canonical envelope:
 *   - no row            → `401 account_erased`
 *   - status ≠ active   → `401 account_disabled`
 *   - epoch mismatch    → `401 session_revoked`   (D2: `(cookie.epoch ?? 0) !== row.sessionEpoch`)
 *   - authority throws  → `503 session_authority_unavailable` (D6: propagate,
 *                         never grant, never evict — the cookie stays)
 *   - seam unregistered → `503 session_authority_unregistered` (no permissive
 *                         default; `createApp` asserts registration at boot)
 */
export async function assertSessionSubjectLive(session: SessionPayload): Promise<SessionLiveness | undefined> {
  if (session.tier !== 'user') return undefined;
  if (typeof session.userId !== 'string') {
    // ADR 0621 correction (2026-10-05): every user-tier mint carries a `userId`
    // (`mintUserSessionCookieValue`) or a `subject` (`issueSubjectSession`, the
    // OIDC upgrade, break-glass). One with NEITHER is not a session this host
    // issued, and returning `undefined` here skipped the erased / disabled /
    // epoch checks for it entirely. Fail closed.
    if (!session.subject) {
      throw new OpenwopError('session_revoked', 'This session was signed out. Sign in again.', 401, {});
    }
    const personalTenant = personalTenantOfSession(session);
    if (!personalTenant.startsWith('user:')) return undefined;
    return assertPersonalSubjectLive(personalTenant, session.subject, { session });
  }
  let state: Awaited<ReturnType<typeof resolveSessionSubject>>;
  try {
    state = await resolveSessionSubject(session.userId);
  } catch (err: unknown) {
    throw mapAuthorityFault(err);
  }
  if (!state) {
    throw new OpenwopError('account_erased', 'This account no longer exists. Sign in again.', 401, {});
  }
  if (state.status !== 'active') {
    throw new OpenwopError('account_disabled', 'This account is disabled.', 401, {});
  }
  if ((session.epoch ?? 0) !== state.sessionEpoch) {
    throw new OpenwopError('session_revoked', 'This session was signed out. Sign in again.', 401, {});
  }
  refuseRevokedFamily(session, state.revokedFamilies);
  return { epoch: session.epoch ?? 0 };
}

/** ADR 0833 D3 (review H1) — how stale a cookie's `authAt` may be before a
 *  verified bearer re-stamps it. */
const REAUTH_RESTAMP_SECONDS = 86_400;

/** What {@link resolveLiveCookieSession} answers. */
export interface LiveCookieSession {
  session: SessionPayload;
  /** The RBAC subject (`userId`, else the opaque `subject`); absent for anon. */
  subject?: string;
  personalTenant: string;
  /** `session.tenantId`, or the personal tenant when the caller is no longer a
   *  member of the shared workspace the cookie names. */
  activeTenant: string;
  /** True when the membership re-check moved the caller off `session.tenantId`. */
  repinned: boolean;
  /** True when the active tenant requires a second factor this session lacks. */
  mfaGap: boolean;
}

/**
 * ADR 0833 D1 — the cookie-session decision for every lane that is NOT the HTTP
 * middleware (the collab WebSocket upgrade). The same four questions in the
 * same order: signature/expiry, the live-session authority (disabled / erased /
 * epoch / revoked family — THROWS the typed refusal), shared-workspace
 * membership, and the active tenant's MFA policy. A lane that called bare
 * `verifySession` admitted a removed, disabled or signed-out member until the
 * cookie's `exp` (S1). `null` ⇒ no valid cookie.
 */
export async function resolveLiveCookieSession(raw: string | undefined): Promise<LiveCookieSession | null> {
  if (!raw) return null;
  const session = verifySession(raw);
  if (!session) return null;
  await assertSessionSubjectLive(session);
  const subject = session.userId ?? session.subject;
  const personalTenant = personalTenantOfSession(session);
  let activeTenant = session.tenantId;
  let repinned = false;
  if (subject && activeTenant !== personalTenant && !(await isWorkspaceMember(subject, activeTenant))) {
    activeTenant = personalTenant;
    repinned = true;
  }
  return {
    session,
    ...(subject ? { subject } : {}),
    personalTenant,
    activeTenant,
    repinned,
    mfaGap: session.tier === 'user' && (await mfaGap(activeTenant, personalTenant, session.mfa === true)),
  };
}

/** ADR 0833 D3 — a signed-out session FAMILY is refused on the read the
 *  request already paid for (the durable row carries the list). */
function refuseRevokedFamily(session: SessionPayload, revoked: readonly string[] | undefined): void {
  if (revoked && revoked.includes(familyOf(session))) {
    throw new OpenwopError('session_revoked', 'This session was signed out. Sign in again.', 401, {});
  }
}

/**
 * ADR 0621 D1 rev. 2 — the UNBOUND-lane check. `personalTenant` is the
 * `user:<hash(iss:sub)>` the bearer derives (or the cookie carries) and
 * `subject` the `oidc:<sub>` principal. When `session` is given it is the
 * unbound user-tier cookie riding along, whose epoch stamp is compared against
 * the canonical row's (a bump since it was minted ⇒ `session_revoked`); with
 * no cookie (bearer-only) there is no stamp to compare — the caller stamps the
 * returned epoch on the cookie it is about to mint. `undefined` ⇒ no durable
 * row was ever bound for this human (the ADR 0003 Phase 4 residual — nothing
 * to refuse, nothing to stamp).
 */
async function assertPersonalSubjectLive(
  personalTenant: string,
  subject: string,
  opts: { session?: SessionPayload } = {},
): Promise<SessionLiveness | undefined> {
  let state: Awaited<ReturnType<typeof resolveSessionSubjectByPersonalTenant>>;
  try {
    state = await resolveSessionSubjectByPersonalTenant(personalTenant, subject);
  } catch (err: unknown) {
    throw mapAuthorityFault(err);
  }
  if (!state) return undefined;
  if (state.status === 'erased') {
    throw new OpenwopError('account_erased', 'This account no longer exists. Sign in again.', 401, {});
  }
  if (state.status !== 'active') {
    throw new OpenwopError('account_disabled', 'This account is disabled.', 401, {});
  }
  if (opts.session && (opts.session.epoch ?? 0) !== state.sessionEpoch) {
    throw new OpenwopError('session_revoked', 'This session was signed out. Sign in again.', 401, {});
  }
  if (opts.session) refuseRevokedFamily(opts.session, state.revokedFamilies);
  return { epoch: state.sessionEpoch };
}

/**
 * ADR 0893 VOX2-F3 — the OIDC bearer lane's liveness, re-asked by a caller that
 * holds no request (the voice sideband between tool calls). The bearer lane
 * authenticates every request from the IdP token, checks the durable row and
 * remembers the epoch it validated (`req.sessionEpoch`); a long-lived call
 * re-asks the same row instead. Bound (`userId`): the keyed row. Unbound: the
 * read-only personal-tenant row. Throws the same typed refusals as the request
 * lane; an epoch that moved since connect is `session_revoked` ("sign out
 * everywhere" covers a live call too).
 */
export async function assertBearerSubjectLive(b: { personalTenant: string; subject: string; userId?: string; epoch?: number }): Promise<void> {
  if (b.userId) {
    let state: Awaited<ReturnType<typeof resolveSessionSubject>>;
    try {
      state = await resolveSessionSubject(b.userId);
    } catch (err: unknown) {
      throw mapAuthorityFault(err);
    }
    if (!state) throw new OpenwopError('account_erased', 'This account no longer exists. Sign in again.', 401, {});
    if (state.status !== 'active') throw new OpenwopError('account_disabled', 'This account is disabled.', 401, {});
    if (b.epoch !== undefined && b.epoch !== state.sessionEpoch) {
      throw new OpenwopError('session_revoked', 'This session was signed out. Sign in again.', 401, {});
    }
    return;
  }
  if (!b.personalTenant.startsWith('user:')) return;
  const live = await assertPersonalSubjectLive(b.personalTenant, b.subject);
  if (live && b.epoch !== undefined && live.epoch !== b.epoch) {
    throw new OpenwopError('session_revoked', 'This session was signed out. Sign in again.', 401, {});
  }
}

/** True for the three DEFINITIVE liveness refusals (not a transient 503). */
export function isSessionRefusal(err: unknown): boolean {
  return err instanceof OpenwopError && SESSION_REFUSAL_CODES.has(err.code);
}

/** D6 — a thrown authority read fails THIS request as a typed 503 (never a grant,
 *  never an eviction); the unregistered-seam 503 passes through unchanged. */
function mapAuthorityFault(err: unknown): OpenwopError {
  if (err instanceof OpenwopError && err.code === 'session_authority_unregistered') return err;
  log.error('session_authority_unavailable', { error: err instanceof Error ? err.message : String(err) });
  return new OpenwopError('session_authority_unavailable', 'The session could not be validated; retry.', 503, { retry: true });
}

/** The three DEFINITIVE refusals — the only outcomes that clear the cookie. A
 *  503 (authority fault / unregistered seam) leaves the cookie intact (D6). */
const SESSION_REFUSAL_CODES: ReadonlySet<string> = new Set(['account_disabled', 'account_erased', 'session_revoked']);

/** Hand a live-session failure to the error envelope. Clears the cookie ONLY on
 *  a definitive refusal; never mints an anon session on either outcome (the
 *  caller returns immediately — the SPA's sign-in modal owns recovery; a silent
 *  anon downgrade would mask the lockout). */
function refuseSession(res: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2], err: unknown): void {
  if (err instanceof OpenwopError && SESSION_REFUSAL_CODES.has(err.code)) {
    // ADR 0621 — a refusal is a security event; log it ids-only so an operator
    // can see a lockout land (the cookie clear is otherwise invisible).
    log.warn('session_refused', { code: err.code, status: err.httpStatus });
    clearSessionCookie(res);
  }
  next(err);
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
  // GRADE-PASS 2026-07-17 (SEC-C8): Express 4 does not forward async handler
  // rejections. ADR 0389 added the first per-request storage read on this path
  // (tenantRequiresMfa) — a transient DB error must become next(err), not a
  // hung request + process-level unhandled rejection.
  const inner: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2]) => Promise<void> = async (req, res, next) => {
    if (isPublicPath(req.path)) {
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
    const rawCookie = cookiesDisabled ? undefined : readCookie(req.header('cookie'), COOKIE_NAME);
    const cookieSession = rawCookie ? verifySession(rawCookie) : null;

    // ADR 0748 — the one OPTIONALLY-authenticated read. With no credential at all
    // it passes through with no principal (the system-site lane, exactly the old
    // public behaviour — no anon session is minted, and `OPENWOP_AUTH_ENFORCE_BEARER`
    // does not 401 it). With ANY credential it authenticates below like every
    // other route, so a rejected bearer is still a 401 (ADR 0434: a refused
    // credential never degrades to anonymous) and a real one reads its own tenant.
    if (isCredentialOptionalRead(req.method, req.path)
      && !req.header('authorization')
      && !(typeof req.query.apiKey === 'string' && req.query.apiKey.trim().length > 0)
      && cookieSession === null) {
      next();
      return;
    }

    // ─── 1. Bearer token (or ?apiKey= for SSE EventSource) ───
    const header = req.header('authorization');
    let bearerToken: string | undefined;
    // ADR 0434 Phase 2 — set when a bearer WAS presented and REJECTED (expired,
    // wrong audience, JWKS blip, unrecognized shape). Falling through to a
    // healthy session cookie is legitimate and stays; falling through to
    // MINTING A NEW ANONYMOUS TENANT is not, and this flag is what forbids it.
    // See the guard at the anon-mint site below for the full failure chain.
    let bearerRejected = false;
    /** Why the bearer was rejected, when the OIDC verifier said (`wrong_audience`, …). */
    let bearerRejectedReason: string | undefined;
    if (header && header.toLowerCase().startsWith('bearer ')) {
      bearerToken = header.slice('bearer '.length).trim();
    } else if (typeof req.query.apiKey === 'string' && req.query.apiKey.trim().length > 0) {
      bearerToken = req.query.apiKey.trim();
      // ADR 0795 D5 — a self-service key travels in a header. A URL reaches
      // request logs, proxies and browser history, and unlike an operator's env
      // key this one belongs to a person. The one caller that cannot set a
      // header is `EventSource`, so the run-events stream keeps the query form.
      if (bearerToken.startsWith('owk_') && !isRunEventsStream(req)) {
        const mode = keyPolicyMode('OPENWOP_KEY_QUERY_PARAM');
        if (mode === 'report') {
          reportKeyPolicy('query-param', 'unverified', { method: req.method, family: req.path.split('/').slice(0, 4).join('/') });
        } else if (mode === 'enforce') {
          setBearerChallenge(req, res, { presented: true });
          res.status(401).json({
            error: 'unauthenticated',
            message: 'Send an API key in the Authorization header (Bearer), not in the URL. Only the run-events stream accepts ?apiKey=.',
          });
          return;
        }
      }
    }
    if (bearerToken) {
      // Try the API-key allow-list first (cheap, sync). API keys are
      // short opaque strings; OIDC tokens are dot-segmented JWTs. The
      // shape disambiguates without crypto.
      const keyTenants = readKeyTenants().get(bearerToken);
      if (keyTenants) {
        // API-key path — scoped to the tenant the key was configured for
        // (ADR 0561). `<key>:*` still yields the cross-tenant operator
        // principal the conformance harness and admin tooling use, but it is
        // now written in the config rather than granted to every key by
        // default.
        req.principal = {
          principalId: `bearer:${bearerToken.slice(0, 8)}`,
          tenants: keyTenants,
          token: bearerToken,
          // ADR 0601 — record the PROVENANCE, not just the id. `bearer:<first 8
          // chars of the key>` is not an RBAC subject and is not meant to match a
          // member row (and it changes when the key rotates). CORRECTED (ADR 0910
          // D0): it COULD — `POST /orgs` as an env key seeds the new org's owner
          // row as this id; D0 makes that row grant nothing tenant-wide in a
          // declared default workspace, as D1b already did for `ws:`. So an authority
          // resolver that only knows the id has no way to tell this lane apart
          // from an unknown stranger. It is an operator credential set in the
          // host's own environment.
          auth: { kind: 'env-key' },
        };
        // Pin tenant-scoped routes to the key's OWN tenant, exactly as the
        // `owk_` path below does. Setting `tenants` alone is NOT enough: routes
        // read `req.tenantId ?? 'default'`, so a key scoped to `acme` would
        // have acted as `default` and 404'd on its own data. The wildcard hid
        // this — `loadReadableRun` short-circuits before the ownership check —
        // so it only surfaced once scoping became reachable.
        //
        // A `*` key deliberately leaves `tenantId` unset, preserving the
        // operator posture: cross-tenant on reads, `default` for anything that
        // needs a concrete tenant to write to.
        if (keyTenants[0] !== '*') req.tenantId = keyTenants[0];
        next();
        return;
      }
      // ─── 1a. Self-service scoped API key (ADR 0270 / CDP-H) ───
      // ADDITIVE + FAIL-CLOSED: only an `owk_`-prefixed token that hashes to a
      // LIVE, non-revoked, non-expired key authenticates — scoped to the key's OWN
      // tenant. (This used to add "never the wildcard the env keys get"; since
      // ADR 0561 env keys are scoped by default too, and the wildcard is opt-in.)
      // An invalid/revoked/expired
      // `owk_` token authenticates nobody and falls through to the reject path.
      // Only `owk_` bearers pay the store lookup (env keys + JWTs skip it).
      if (bearerToken.startsWith('owk_')) {
        const callerIp = clientIp(req);
        const key = await verifyApiKey(bearerToken, Date.now(), { ip: callerIp, ...(req.header('user-agent') ? { userAgent: req.header('user-agent')! } : {}) });
        // ADR 0798 — keys turned off for the workspace is the workspace's own
        // explicit choice, so it does not wait on a `report` switch.
        if (key && (await tenantKeysDisabled(key.tenantId))) {
          log.warn('api key refused', { keyId: key.keyId, reason: 'keys_disabled' });
          setBearerChallenge(req, res, { presented: true });
          res.status(401).json({ error: 'unauthenticated', message: 'API keys are turned off for this workspace.' });
          return;
        }
        // ADR 0795 D6 — a key stops when its issuer does. Checked HERE so it
        // holds on every lane, including the protocol lane with RFC 0049
        // enforcement off, which otherwise never asks who issued the key.
        if (key && (await apiKeyIssuerRefused(key.keyId, key.tenantId))) {
          {
            setBearerChallenge(req, res, { presented: true });
            res.status(401).json({
              error: isProtocolRequest(req) ? 'credential_revoked' : 'unauthenticated',
              message: 'The person who created this API key no longer has access to this workspace.',
            });
            return;
          }
        }
        if (key) {
          // ADR 0601 — an `owk_` key is a DELEGATION, so carry who delegated it.
          // `key.createdBy` is the canonical RBAC subject of the person who
          // minted the key, which is what makes the key's authority resolvable
          // at all (`apikey:<keyId>` never matches a member row). `key.scopes`
          // rides along so a key that DECLARES scopes can be narrowed to them.
          req.principal = {
            principalId: `apikey:${key.keyId}`,
            tenants: [key.tenantId],
            token: bearerToken,
            auth: { kind: 'api-key', issuer: key.createdBy, scopes: key.scopes },
          };
          req.tenantId = key.tenantId; // pin tenant-scoped routes to the key's OWN tenant
          next();
          return;
        }
        // RFC 0170 (`identity.md` §2.2) — the `api-key` lane advertises
        // `revocation: next-request`: a REVOKED key is refused on the very next
        // request as `credential_revoked`, never as an unrecognised bearer (and
        // never allowed to fall through to a cookie or an anonymous mint).
        if (await isRevokedApiKey(bearerToken)) {
          setBearerChallenge(req, res, { presented: true });
          // The CODE is the v2 contract's; a v1 caller keeps the `unauthenticated`
          // it has always received for this key (no v1 error-code change).
          res.status(401).json({ error: isProtocolRequest(req) ? 'credential_revoked' : 'unauthenticated', message: 'This API key was revoked.' });
          return;
        }
        // fall through — an invalid scoped key is treated like any bad bearer
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
          // ADR 0389 P1: Identity Platform stamps `firebase.sign_in_second_factor`
          // (e.g. 'totp') on ID tokens minted by an MFA-completed sign-in. The
          // claim is authoritative on the bearer path — the host never handles
          // factor material, it only reads the verifier's attestation.
          const fbClaim = claims['firebase'];
          const secondFactor =
            typeof fbClaim === 'object' && fbClaim !== null
              ? (fbClaim as Record<string, unknown>)['sign_in_second_factor']
              : undefined;
          const mfaVerified = typeof secondFactor === 'string' && secondFactor.length > 0;
          if (mfaVerified) req.mfaVerified = true;
          // GRADE-PASS SEC-G3 (demote race): after completing MFA, the OLD
          // pre-MFA ID token stays valid ~1h; a cached/second-tab request
          // carrying it must not demote the freshly-MFA'd cookie. Demote only
          // when this bearer's sign-in is NOT older than the cookie mark.
          const bearerSignInS = typeof claims['auth_time'] === 'number' ? claims['auth_time'] : undefined;
          // ADR 0389 P2: surface the sign-in freshness for step-up gates.
          if (typeof claims['auth_time'] === 'number') req.oidcAuthTime = claims['auth_time'];
          // ADR 0622 D7 / USERS-20 — surface the IdP-VERIFIED email so the users
          // feature can fold it into the durable row (`emailProvenance: 'idp'`).
          // The `email_verified` flag is load-bearing: without it a Firebase
          // email/password account whose address was never confirmed would be
          // able to accept an invitation issued to that address. Unverified ⇒
          // nothing is surfaced, and the row keeps whatever it had.
          if (claims.email_verified === true && typeof claims.email === 'string' && claims.email.trim()) {
            req.oidcEmail = claims.email.trim();
          }
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
          // ADR 0621 D1 (b) — the cookie-borne `userId` is about to become
          // `req.userId`: refuse a disabled / erased / revoked account HERE, on
          // the branch the signed-in SPA actually takes (it attaches a bearer
          // whenever its cached ID token is fresh). Inside our own try/catch so
          // the refusal never reaches the OIDC catch below, which would fall
          // through to the cookie path as if the TOKEN had failed.
          // Rev. 2 (review BLOCKER-1): the UNBOUND lane is checked too — the
          // durable row for this human exists whether or not a cookie names it,
          // so a disabled/erased account must not keep (or re-mint, below) an
          // `oidc:<sub>` session in its personal tenant. Read-only: the seam's
          // canonical read never creates. The epoch it returns is what the
          // promotion mint stamps, so "sign out everywhere" covers this lane.
          let validatedEpoch: number | undefined;
          // ADR 0833 D2/D3 — the same-identity user-tier cookie riding along
          // (bound or unbound), once it has passed the live check below. It is
          // the promotion's `source` (the family carries over) and what logout
          // revokes. A cookie for another identity is never a source.
          const sameIdentityCookie =
            cookieSession?.tier === 'user' && cookieSession.personalTenant === personalTenant ? cookieSession : undefined;
          try {
            if (boundUserId && cookieSession) {
              validatedEpoch = (await assertSessionSubjectLive(cookieSession))?.epoch;
            } else {
              const unboundCookie =
                sameIdentityCookie && sameIdentityCookie.userId === undefined ? sameIdentityCookie : undefined;
              validatedEpoch = (await assertPersonalSubjectLive(personalTenant, subject, { session: unboundCookie }))?.epoch;
            }
          } catch (err: unknown) {
            refuseSession(res, next, err);
            return;
          }
          req.sessionEpoch = validatedEpoch;
          if (sameIdentityCookie) req.cookieSession = sameIdentityCookie;
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
          // The stale-bearer guard above also means THIS request should count
          // as MFA-verified when the cookie mark stands (the session did
          // verify; only this cached token predates it).
          if (!req.mfaVerified && cookieSession?.mfa === true
              && cookieSession.personalTenant === personalTenant
              && bearerSignInS !== undefined && bearerSignInS < cookieSession.iat) {
            req.mfaVerified = true;
          }
          if (await refuseIfMfaRequired(req, res, active, personalTenant)) return;
          req.personalTenant = personalTenant;
          req.tenantId = active;
          // Bound (post-bind) callers present the stable `user:<userId>` principal;
          // unbound OIDC callers stay `oidc:<sub>` (backward-compatible).
          if (boundUserId) req.userId = boundUserId;
          // ADR 0601 — `effectiveSubject` IS the RBAC subject membership is keyed
          // on, so this lane resolves through the member table like the HTTP one.
          req.principal = { principalId: effectiveSubject, tenants: [active], token: bearerToken, auth: { kind: 'subject' } };
          noteTenantActivity(active);
          // Promote / refresh the cookie when it doesn't already encode this
          // (subject, active-workspace) at user-tier. Without this, a request
          // that drops the Authorization header (SPA token-cache race,
          // EventSource without `?apiKey=`) would fall back to a still-anon
          // cookie and land as anon. No-op on the steady-state hot path.
          const nowS = Math.floor(Date.now() / 1000);
          if (!cookiesDisabled
            && (!cookieSession
              || cookieSession.tier !== 'user'
              || cookieSession.subject !== subject
              || cookieSession.tenantId !== active
              || cookieSession.userId !== boundUserId
              // ADR 0833 D3 (review H1) — a verified bearer is a fresh IdP
              // authentication: re-stamp `authAt` daily, so a user whose IdP
              // still vouches for them never reaches the absolute cap.
              || (cookieSession.authAt ?? 0) < nowS - REAUTH_RESTAMP_SECONDS
              // ADR 0389 P1: sync the second-factor mark to the bearer claim —
              // promote when the claim appears; demote only when a NEWER
              // single-factor sign-in replaces an MFA one (grade-pass SEC-G3:
              // a stale pre-MFA token must not flap the mark off).
              || (mfaVerified && !cookieSession.mfa)
              || (!mfaVerified && cookieSession.mfa === true
                  && (bearerSignInS === undefined || bearerSignInS >= cookieSession.iat)))
          ) {
            // ADR 0833 D2/D3 — through the ONE builder: a fresh authentication
            // (`authAt` = now) that keeps the same-identity cookie's family, so a
            // logout still reaches a cookie copied before this re-mint.
            const upgraded = buildSessionPayload({
              tenantId: active, tier: 'user', subject, personalTenant,
              // Preserve the bound durable userId across re-mints (e.g. a switch),
              // else the canonical subject would silently revert to oidc:<sub>.
              // ADR 0621 D1 (c): the ONLY `userId` this mint can carry is the one
              // (b) just validated on THIS request against the same authority —
              // a refused session returned before reaching here, so a cleared
              // cookie can never be re-minted from a still-valid IdP token. D2:
              // the epoch rides along unchanged (an absent legacy epoch stays
              // absent — it reads as 0, and the row it matched was 0).
              ...(boundUserId && cookieSession
                ? { userId: boundUserId, ...(typeof cookieSession.epoch === 'number' ? { epoch: cookieSession.epoch } : {}) }
                : validatedEpoch !== undefined ? { epoch: validatedEpoch } : {}),
              ...(mfaVerified || (cookieSession?.mfa === true && bearerSignInS !== undefined && bearerSignInS < cookieSession.iat) ? { mfa: true } : {}),
            }, { source: sameIdentityCookie ?? null, freshAuth: true });
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
          // RFC 0210 §B.6 — the LIFETIME refusal is terminal and names itself, in BOTH
          // cookie postures. Two properties, each load-bearing:
          //   - it never falls through. The fallthrough exists so a momentarily-stale
          //     token still reaches a healthy cookie; an over-lifetime credential is a
          //     different thing — the bound this host advertises was exceeded, and
          //     serving the request anyway would make the advertised window a number we
          //     print rather than enforce. That is the exact over-claim RFC 0210 exists
          //     to stop, and the suite presents its probe with no cookie at all, so a
          //     fallthrough would answer 201 and the row would go red honestly.
          //   - the wire code is the registered `credential_lifetime_exceeded`, not a
          //     generic `unauthenticated` with a `details.reason`. §B.6's whole point is
          //     that an outside party can tell "the bound was enforced" from "refused for
          //     some other reason"; a reason nested in `details` is not readable by
          //     `readErrorCode`, so a generic envelope would fail the code leg.
          if (code === 'credential_lifetime_exceeded') {
            setBearerChallenge(req, res, { presented: true });
            res.status(401).json({
              error: 'credential_lifetime_exceeded',
              message: err instanceof Error ? err.message : 'Credential lifetime exceeds the advertised revocation window.',
            });
            return;
          }
          if (cookiesDisabled) {
            setBearerChallenge(req, res, { presented: true });
            // RFC 0200 §D — a credential that VERIFIED but was minted for another
            // relying party carries the registered `audience_mismatch`, not a generic
            // `unauthenticated`: `v2-oidc-id-token-audience` reads the top-level code,
            // and `details.reason` is not readable there. `details.reason` is kept so
            // the v1 shape (`auth-oidc.test.ts`) still names the verifier's reason.
            res.status(401).json({
              error: code === 'wrong_audience' ? 'audience_mismatch' : 'unauthenticated',
              message: 'OIDC token rejected.',
              details: { reason: code },
            });
            return;
          }
          log.warn('OIDC verify failed — falling through to cookie path', { code });
          noteOidcFallthrough(code);
          bearerRejected = true; // ADR 0434 — may reach a healthy cookie, never a fresh anon tenant
          bearerRejectedReason = code;
          // fall through
        }
      } else {
        // Bearer present, but neither in the allow-list nor a JWT
        // shape we can verify. Mirror the verify-failure branch:
        // strict 401 when cookies are disabled, log + fall through
        // otherwise.
        if (cookiesDisabled) {
          setBearerChallenge(req, res, { presented: true });
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
        bearerRejected = true; // ADR 0434 — see the anon-mint guard below
        // fall through
      }
    }

    // ─── 2. Session cookie (default for browsers) ───
    if (cookiesDisabled) {
      setBearerChallenge(req, res, { presented: bearerToken !== undefined });
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
        setBearerChallenge(req, res, { presented: bearerToken !== undefined });
        res.status(401).json({
          error: 'unauthenticated',
          message: 'Missing Bearer token (Authorization header) or apiKey query param.',
        });
        return;
      }
      // ADR 0434 Phase 2 — NEVER mint a fresh anonymous tenant for a request
      // that presented a bearer we refused. The chain this closes:
      //   1. `/migrate-tenant` clears the session cookie on success (by design,
      //      so the next request is bearer-only);
      //   2. an hourly Firebase token rotation races, so a request arrives with
      //      a momentarily-stale token and NO cookie;
      //   3. the OIDC catch above falls through, we land here, and the user —
      //      signed in, mid-session — is silently issued a BRAND-NEW `anon:<sid>`
      //      tenant and keeps working in it. Their writes go somewhere no other
      //      device can see, and nothing ever reconciles it.
      // Falling through to a HEALTHY cookie stays legitimate (that is the case
      // the fallthrough was written for, and it is untouched above). Minting a
      // new identity is not a fallback — it is a silent identity switch. A 401
      // is honest and recoverable: the SPA refreshes the token and retries.
      if (bearerRejected) {
        setBearerChallenge(req, res, { presented: true });
        // RFC 0200 §D — in the COOKIE-ENABLED posture (production's), a verified
        // token minted for another relying party reached here after its fall-
        // through found no session, and was refused with a generic
        // `unauthenticated`. The cookies-disabled branch above already answered
        // `audience_mismatch`, so the code depended on posture. MEASURED on a
        // colocated boot of production's image: `0200.id-token-aud` failed
        // (`expected 'unauthenticated' to be 'audience_mismatch'`) while the
        // cookies-disabled in-memory boot passed. The fall-through itself is
        // unchanged: a wrong-audience bearer beside a HEALTHY cookie still reaches
        // the cookie session, which is not a refusal at all.
        const audience = bearerRejectedReason === 'wrong_audience';
        res.status(401).json({
          error: audience ? 'audience_mismatch' : 'unauthenticated',
          message: audience
            ? 'The OIDC token verified but was minted for another relying party, and no valid session cookie is present.'
            : 'Bearer credential was rejected and no valid session cookie is present. Refresh the token and retry.',
          details: { reason: audience ? 'wrong_audience' : 'bearer_rejected_no_session' },
        });
        return;
      }
      // ADR 0833 D3 (grade-ux `USERS2-UX-2`) — a SIGNED-IN session that has
      // ended (its `exp`, or the absolute lifetime) is told so, never silently
      // swapped for a fresh anonymous tenant: the header would keep showing the
      // account while every write landed in a throwaway sandbox. The SPA treats
      // `details.reason: 'session_expired'` as a sign-out with a reason. Not a
      // new error code — the envelope's `unauthenticated`, with a reason.
      if (rawCookie && endedUserSession(rawCookie)) {
        clearSessionCookie(res);
        res.status(401).json({
          error: 'unauthenticated',
          message: 'Your session has ended. Sign in again to continue.',
          details: { reason: 'session_expired' },
        });
        return;
      }
      // RFC 0200 §B.1 / ADR 0750 — on the MAJOR-2 wire a request that presents NO
      // credential (no bearer, no api key, no session cookie) is refused `401` with
      // a `Bearer resource_metadata=…` challenge and NO error code, before any
      // resource is looked up. Every v2 operation declares ApiKey/OAuth2/OIDC
      // security (api/v2/openapi.yaml), and `auth.md`'s missing-credential rule is
      // 401 — minting a cookie-per-visitor `anon:<sid>` here (ADR 0015) admitted the
      // request as a principal it never presented. MEASURED in production
      // 2026-09-24: `GET /runs/<id>` under `OpenWOP-Version: 2` with nothing
      // attached answered 404/403 plus a fresh `__session`; the in-memory
      // conformance boot never saw it (cookies disabled there).
      // The anonymous DEMO visitor is unaffected: the SPA bootstraps its session on
      // a major-1 host-extension route (`/me`), which still mints below, and its
      // v2 fetch path re-bootstraps + retries once on this exact 401.
      //
      // PROTOCOL CLIENTS ONLY (ADR 0646 `isProtocolClient`). A browser DOCUMENT
      // navigation to a shared name (`/runs`) that prefers `text/html` is the
      // page's, not the operation's — and once v1 retires, a header-less request
      // defaults to major 2, so without this guard a first-visit browser would get
      // this JSON 401 instead of the SPA shell (caught by the ADR 0669 retirement
      // rehearsal, `test/adr0669-v1-retirement-rehearsal.test.ts`).
      //
      // MAJOR 1 TOO (ADR 0750 major-1 extension). ADR 0745 recorded the major-1
      // mint as a residual "outside RFC 0200's MUST" and said that if v1's own
      // `auth.md` §3 missing-credential rule were ever measured against the
      // cookie posture, it belonged in THIS predicate. It was: the v1 floor
      // `openwop.floor.auth` (a major-1 run create, no credential → MUST 401) failed
      // on production's b29427fef and 2273db9c6 cuts with `201`, because this
      // line minted a session and admitted the call. Scoped to the protocol
      // operations v2 also serves (`isV1ProtocolOperationPath`): the vendor
      // `/host/openwop-app` space — where the SPA bootstraps its session — still
      // mints, as do the `/host/sample` seams. The SPA makes no major-1 protocol
      // calls (all protocol traffic is major 2 through `sdkFetch`).
      //
      // A run-scoped `?streamToken=` on the run-events stream IS a presented
      // credential: a capability minted same-origin for the cross-origin SSE base,
      // where the session cookie cannot follow (`host/runStreamToken.ts`,
      // `frontend/react/src/client/streamsClient.ts`). The route validates it
      // (`loadReadableRun`); refusing here as "no credential" would 401 every
      // cookie-mode viewer's live run stream on either major.
      if (isProtocolClient(req) && !carriesRunStreamToken(req) && isProtocolRequest(req)) {
        setBearerChallenge(req, res, { presented: false });
        res.status(401).json({
          error: 'unauthenticated',
          message: 'No credential presented. Authenticate, or establish a session first.',
        });
        return;
      }
      session = mintAnonSession();
      setSessionCookie(res, signSession(session));
    } else {
      // ADR 0621 D1 (a) — a cookie-only request: refuse a disabled / erased /
      // revoked durable account BEFORE the sliding refresh (which would re-issue
      // the very cookie we are about to clear) and before the membership re-pin.
      // Anon sessions are skipped by tier inside the helper (D4). No anon session
      // is minted on refusal: this branch already HAS a session, and the helper's
      // caller returns without reaching the mint above.
      try {
        req.sessionEpoch = (await assertSessionSubjectLive(session))?.epoch;
      } catch (err: unknown) {
        refuseSession(res, next, err);
        return;
      }
      // Sliding-window refresh: if the cookie is past the refresh
      // threshold, reissue it. NEVER for `noRefresh` sessions (break-glass —
      // grade-pass SEC-C2: extending a 10-minute emergency session to 24h).
      // ADR 0833 D3 — the refresh keeps the family and `authAt`, and never
      // slides `exp` past `authAt` + the absolute lifetime.
      const now = Math.floor(Date.now() / 1000);
      if (!session.noRefresh && session.exp - now < REFRESH_THRESHOLD_SECONDS) {
        session = refreshSessionPayload(session);
        setSessionCookie(res, signSession(session));
      }
      if (session.tier === 'user') req.cookieSession = session;
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
    const personalTenant = personalTenantOfSession(session);
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
    // ADR 0389 P1: a user-tier cookie carries the second-factor mark stamped at
    // bind/promotion (the bearer claim is unavailable on cookie-only requests).
    if (session.tier === 'user' && session.mfa) req.mfaVerified = true;
    // Mark the anonymous case at the ONE point that knows whether a credential
    // was presented. Read `tier`, not the `anon:` tenant prefix: the prefix is
    // an encoding that could change, the tier is the decision.
    if (session.tier === 'anon') req.anonymousPrincipal = true;
    if (await refuseIfMfaRequired(req, res, activeTenant, personalTenant)) return;
    // ADR 0601 — the first two carry a real RBAC subject (`user:<id>` /
    // `oidc:<sub>`); the third is a throwaway anon session id that is a member of
    // nothing by construction. Recording which is which is what lets an authority
    // resolver stop guessing from the string.
    if (session.userId) {
      req.userId = session.userId;
      req.principal = { principalId: session.userId, tenants: [activeTenant], token: '', auth: { kind: 'subject' } };
    } else if (session.subject) {
      req.principal = { principalId: session.subject, tenants: [activeTenant], token: '', auth: { kind: 'subject' } };
    } else {
      req.principal = { principalId: `session:${session.sid}`, tenants: [activeTenant], token: '', auth: { kind: 'anon' } };
    }
    // Tells the daily cleanup endpoint this tenant is still live so
    // its ephemeral BYOK secrets aren't GC'd.
    noteTenantActivity(activeTenant);
    next();
  };

  return (req, res, next) => {
    void inner(req, res, next).catch(next);
  };
}
