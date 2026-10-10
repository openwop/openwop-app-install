# ADR 0827 — serve the protocol origin off the CDN (`api.openwop.dev`)

Status: **implemented** (2026-10-06). `api.openwop.dev` is live; certification, `openwop-app` #4460 and `@openwop/cli` 1.5.0 use it.

## Context

The public front door `app.openwop.dev` is Firebase Hosting, and it rewrites
`/api/**`, `/.well-known/**` and the 28 v2 manifest sources to Cloud Run. Its edge
(Fastly) drops a client's `If-None-Match` on about half of all conditional requests:

| Measured 2026-10-05, 20 samples each | Direct `*.run.app` | `app.openwop.dev` |
|---|---|---|
| `GET /prompts/{id}`, matching ETag | 304 always | 304 in 11/20 |
| `GET /.well-known/openwop`, matching ETag | 304 always | 304 in 11/20 |

v2 `headers.md` makes the 304 a MUST on discovery and the run snapshot. The
2026-10-05 certification of `ce2abbde3` recorded `prompts.etag-revalidation`
executed-fail for exactly this reason (402 pass / 2 fail / 0 blocked). Suite 2.45.17
added `v2-discovery-etag`, and 2.45.18 adds four more `If-None-Match` legs, so the
public origin goes from one red row to several, each a coin flip.

**Not a host defect.** Our matcher (`ifNoneMatchSatisfied`, #4380) answers 304
direct every time. **Not fixable in `firebase.json` either (falsified).** A preview
channel set `Cache-Control: private, no-cache` on every protocol rewrite source. The
header applied, but the conditional survived 9/20 and 11/20, the same as prod's
`no-store`. The edge does not use Cache-Control to decide whether to forward the
conditional. See memory `firebase-api-rewrite-drops-if-none-match` for the full trail
(first-sight hit-for-pass, the `%2F` decoding sibling).

The front door has already rewritten what it should pass through twice:
- `%2F` decoding (#4382, RFC 0184's `~` projection exists partly because of it);
- the conditionals, above.

A protocol origin wants a transparent proxy, and a CDN in front of a SPA is not one.

## Decision

**Give the protocol its own origin, `https://api.openwop.dev`: a Cloud Run domain
mapping on `openwop-app-backend` with no CDN in front.** `app.openwop.dev` stays as it
is for the SPA.

- **Discovery needs no change.** It carries no base-URL field: a client uses the origin
  it fetched `/.well-known/openwop` from. No wire change and no RFC are needed.
- **`api.openwop.dev` becomes the canonical protocol base for:**
  - the certification cut (`publish-evidence.sh` `BASE`) and `verify-deploy.sh`'s v2 probes;
  - the CLI's "shared demo" preset;
  - the docs, README and DEPLOY-SMOKE.
- **`app.openwop.dev/api` keeps working, unchanged.** The SPA uses it with cookie auth
  (same-site, so no CORS or cookie-domain change), and existing clients keep their URL.
  It simply stops being the origin we certify and advertise.
- **SSE needs no change.** The SPA already streams from the direct `*.run.app` URL
  because the CDN buffers SSE (CLAUDE.md), so this extends an existing precedent.

## Alternatives

- **Certify against the raw `*.run.app` URL.** No DNS needed, and it works today. But
  the hostname embeds the project number, is not a name we would hand to users, and
  would make the certified origin differ from the advertised one. Kept only as the
  interim, below.
- **A Google external HTTPS load balancer on `api.openwop.dev`.** Also transparent,
  with Cloud Armor and IAP options. It costs a forwarding rule plus a certificate, and
  more moving parts than a domain mapping need. Revisit if Cloud Run domain mappings
  (a preview-tier feature) prove unsuitable.
- **Keep Firebase and fix the edge with `firebase.json`.** Falsified (Context).
- **Cache the public discovery doc at the edge** (`public, no-cache`, so the edge
  revalidates and answers 304 itself). Possible for discovery only. Every
  authenticated route still flips coins, and a shared CDN must never cache those.

## Consequences

- A second public hostname exists. Its TLS certificate is Google-managed and is
  provisioned once the DNS record resolves.
- **Rate limits are per IP.** Direct callers are no longer behind Firebase's egress, so
  `middleware/rateLimit.ts` sees the true client IP. That is more accurate, and the
  trusted-proxy hop handling is open as KEY work; verify the IP resolution in Phase 2.
- Nothing about the SPA changes, so the `/` shell, the TTL and the bundle checks in
  CLAUDE.md are untouched.

## Implementation plan

1. **Interim (no DNS).** Allow `publish-evidence.sh` `BASE` to be the direct
   `*.run.app` origin, so the next certification measures the host, not the edge. Record
   in the bundle note that it is the direct origin.
2. **DNS (owner action).** At the registrar (GoDaddy, `domaincontrol.com`), add
   `CNAME api → ghs.googlehosted.com.`. Then
   `gcloud beta run domain-mappings create --service openwop-app-backend --domain api.openwop.dev --region us-central1`.
   Wait for the managed certificate.
3. **Point clients.** `deploy.env` `BASE`, `verify-deploy.sh` v2 probes, the CLI
   "shared" preset (openwop-cli), README/DEPLOY-SMOKE. Re-certify against
   `api.openwop.dev`; expect `prompts.etag-revalidation` and the 2.45.17+/2.45.18
   `If-None-Match` legs to pass deterministically.
4. **Verify.** 20-sample conditional A/B on `api.openwop.dev` (expect 20/20 304); rate
   limiter sees the client IP; CORS is not needed (bearer clients only).

## Implementation record

| Phase | Result |
|---|---|
| P2 DNS + mapping | 2026-10-06: the owner added `CNAME api → ghs.googlehosted.com.` at the registrar. `openwop.dev` was already a verified domain for the deploy account. The mapping was created through the Cloud Run domains REST API (`…/apis/domains.cloudrun.com/v1/namespaces/openwop-dev/domainmappings`), because the GA `gcloud run domain-mappings` targets Cloud Run for Anthos and the `beta` component is not installed. Route `openwop-app-backend`. |
| P3 evidence origin | `publish-evidence.sh` takes `OPENWOP_EVIDENCE_BASE` (default `BASE`). `BASE` stays shared with `deploy.sh`, whose SPA checks need the Firebase front door. |
| P3 measured | 20-sample conditional A/B, 2026-10-06: `api.openwop.dev` answered 304 in **20/20** on `/prompts/{id}` and **20/20** on discovery; `app.openwop.dev/api` answered 0/20 and 1/20. A major-2 certification of `97baad74b` against `api.openwop.dev` gave **404 pass / 0 fail / 0 blocked** (11 skipped, 393 inapplicable): `prompts.etag-revalidation` passes. The same night's cut through the CDN (`ce2abbde3`) gave 402 / 2 fail, both that row. The bundle's discovery URL is `https://api.openwop.dev/.well-known/openwop`. |

> **P4 correction (2026-10-06): the CLI preset cannot simply move.** `openwop
> login` builds its approval link as base origin + the host's relative
> `verificationPath`. With base `https://api.openwop.dev`, that is
> `https://api.openwop.dev/access?tab=api-keys`, which answers **401 JSON**
> (measured): the protocol origin serves no SPA and no session cookie. So P4 is:
> - **host** (#4460): `cli-login/start` also returns an absolute `verificationUri`
>   built from `OPENWOP_PUBLIC_BASE_URL` (prod `https://app.openwop.dev`), and
>   omits it when unset or not http(s);
> - **CLI** (openwop-cli#77, merged): `login` prefers an https `verificationUri`
>   (http only on loopback) and otherwise falls back unchanged;
> - **then** move the "shared demo" preset, after #4460 is deployed AND a CLI
>   release ships. Until then `app.openwop.dev/api` stays the CLI's default.
>   That costs little: the CLI does not rely on conditional GETs, ids no longer
>   use `%2F`, and streams already use the advertised direct origin.
>
> Third-party clients and certification should use `https://api.openwop.dev`.
> Browsers and the CLI keep `app.openwop.dev`.

| P4 shipped | openwop-app #4460 (`2bf0ad707`, rev `00878-w4m`): `cli-login/start` returns `verificationUri: https://app.openwop.dev/access?tab=api-keys` on BOTH origins (verified live). openwop-cli #77 + #78 → **`@openwop/cli` 1.5.0** on npm (`latest`, provenance-signed; tarball SHA-1 `717dc8fe…` matches the CI publish log). Its "shared demo" preset is `https://api.openwop.dev`. Live smoke of the built CLI against it: `doctor`, `runs list`, `runs create` (bound id; `eventsUrl` on `api.openwop.dev` in the `~2F` form), `runs events`, and `login`, which prints the app-origin approval link. |

## Open questions

- [x] Owner: approve the DNS record (Phase 2). Done 2026-10-06: `CNAME api → ghs.googlehosted.com.`
- [x] Is `api.openwop.dev` the right name? Kept: the owner created that record.
