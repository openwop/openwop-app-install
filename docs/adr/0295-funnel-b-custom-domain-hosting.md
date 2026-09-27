# ADR 0295 — Funnel B: custom domains + TLS for published content

**Status:** implemented (host-side halves, 2026-07-06) — **P0 pinned: option A with the GCLB certificate map** (matches the existing GCP deployment; no second vendor; subdomains-first, apex via the DNS host's ALIAS). P1: `custom-domains` feature (hostname-PK rows — globally unique so no cross-tenant claim; `_openwop-verify.<host>` TXT ownership check with an injectable resolver; disable-don't-delete on a clean negative; resolver noise never demotes a live domain; 6h re-check sweep). P2: `middleware/customDomain.ts` — the fail-closed host guard (org-pinned, public-only allowlist: published pages/funnels + the storefront; authed app/protocol surface never serve on customer hostnames; platform origin byte-identical; `public-forms` excluded in v1 — no orgId in its path to pin). P3: per-domain fixed-window rate budget (`OPENWOP_CUSTOM_DOMAIN_REQS_PER_MIN`, default 600) + the DEPLOY.md operator recipe. The TLS/routing tier (cert map, LB) is OPERATOR INFRASTRUCTURE per the option-A design — deliberately not app code; certificate-map automation from the domain rows is the recorded follow-on.
**Date:** 2026-07-06 · **Program:** [ADR 0293](0293-funnel-program.md) · **Closes:** FM-4
(the ADR 0012 explicit deferral: "Custom domains + SSL + static export/deploy —
Deferred (real hosting infra)")
**Toggle:** new `custom-domains` toggle, OFF, bucket `tenant`.
**Wire impact:** none — host serving topology; no protocol surface.

## Context

Published pages, storefronts, forms, and (with ADR 0294) funnels all serve from the
app's own origin. MyndHyve ships the full adopter expectation: a domain-setup wizard,
DNS validation, SSL provisioning (`functions/src/domain/ssl.ts`), static export, and
CDN configs. For a funnel product this is table stakes — sales pages live on the
brand's domain, not the platform's.

This is **the one lane in the program that is primarily an infrastructure decision**,
and it interacts with the deploy topology (Firebase Hosting fronts the SPA;
`/api/**` rewrites to Cloud Run; SSE bypasses the CDN — `DEPLOY.md`).

## Decision (draft — option A recommended, review may overturn)

**Option A — platform-managed proxy tier (recommended):** a dedicated
domain-terminating proxy (Google Cloud Load Balancer with certificate-map, or
Cloudflare-for-SaaS) in front of the existing backend. Tenant flow:

1. Tenant registers `pages.acme.com` → host-extension route issues a TXT/CNAME
   verification challenge (`domain { hostname, orgId, status: pending|verified|
   failed|live, verificationToken, verifiedAt }` in a `DurableCollection`).
2. A scheduler job (the ONE scheduler) polls DNS; on verification, the domain is
   added to the certificate map (managed certs — no key material ever handled by the
   app, consistent with the BYOK doctrine of never holding avoidable secrets).
3. The backend gains a **host-resolution middleware**: requests arriving with a
   `Host` that matches a live tenant domain are scoped to that org and constrained to
   the PUBLIC surface only (published pages/funnels/forms/storefront). The authed
   app, admin routes, and the protocol surface are NEVER served on custom domains —
   fail-closed allowlist, because cookie/session scope and OAuth origins
   (`PUBLIC_BASE_URL` doctrine) must stay on the platform origin.

**Option B — static export to tenant-operated hosting** (MyndHyve's `StaticExporter`
lane): rejected as the primary path — it forks rendering (exported snapshot vs live
publishing pipeline), breaks experiments/analytics/dynamic routing, and reintroduces
the "two page pipelines" smell. May return later as an explicitly-degraded offline
artifact.

**Option C — certificates on the app origin itself** (Cloud Run domain mappings
per tenant domain): rejected — per-domain mapping quotas, no wildcard story, couples
tenant onboarding to deploy-project IAM.

## Security invariants (binding regardless of option)

- Custom-domain requests are **public-surface-only**, org-pinned by the domain row —
  a hostile domain must never reach another org's content or any authed route.
- No cookies are set on custom domains in v1 (visitor identity = the consent-gated
  sessionKey mechanism, which is origin-local by design).
- Domain verification must be re-checked periodically (revocation on DNS change) —
  the connection-revocation seam pattern (disable, don't delete).
- Rate limiting applies per-domain as well as per-IP (a tenant's viral page must not
  starve the platform origin).

## Phases

| Phase | Ships | Gate |
|---|---|---|
| 0 | Infra decision review (this ADR → Accepted with the option pinned) + cost model | architect + operator sign-off |
| 1 | Domain entity + verification challenge routes + DNS-poll job + FE wizard | route tests |
| 2 | Proxy/cert automation + host-resolution middleware (public-only allowlist) | staging domain end-to-end; fail-closed tests |
| 3 | Funnel/page/storefront serving on live domains + per-domain rate limits | DEPLOY.md + DEPLOY-SMOKE.md updates |

## Open questions

- GCLB certificate-map vs Cloudflare-for-SaaS (cost per domain, cert issuance
  latency, operational ownership — the deploy account separation in DEPLOY.md).
- Apex-domain support (ALIAS/ANAME guidance) vs subdomains-only in v1 (leaning
  subdomains-only).
- Whether the white-label bundle (ADR 0052) documents this as adopter-operated infra
  with their own proxy credentials (it must — the steward's cert map is not shared).
