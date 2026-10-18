# ADR 0906 — Custom domains: automated edge certificates (Certificate Manager DNS authorization) behind a provider port

**Status:** Accepted (2026-10-17) — plan only, no code. Architect-reviewed (§ Architect review). Live spend, vendor accounts and IAM wait on § Open decisions for David.
**Date:** 2026-10-17
**Feature:** `custom-domains` (extends ADR 0295; closes its "certificate-map automation from the domain
rows is the recorded follow-on"). No new toggle.
**Origin:** MyndHyve port, capability 3 of 4 (gap analysis 2026-10-17: "Hosted landing pages + custom
domains — MyndHyve ahead; custom-domains feature but no GCP load-balancer automation"). MyndHyve read
at `7246fb1ce`.
**RFC verdict:** **host-extension — no RFC.** Domain rows, their lifecycle and the edge provider are
host-extension routes and host infrastructure. The served content (published pages, storefront) is
unchanged. No wire field, capability or event is added.

## Context

### MyndHyve baseline (`7246fb1ce`) — the certificate half is real; the serving half is not

There are **three** unconnected domain systems:
(a) `functions/src/domain/ssl.ts` (744 lines) behind 7 HTTP functions (`functions/src/index.ts:2424-2720`);
(b) `campaign-studio-api/handlers.ts:1155-1315` writing `users/{uid}/custom_domains` with a different
TXT name and **per-user** uniqueness (two users can claim one domain, `:1218,1250`) and no GCP cleanup
on delete; (c) client `src/core/hosting/CustomDomainService.ts` + `publishing/PublishingService.ts:391-525`.

System (a) is the part worth porting:

| Step | Mechanism | Citation |
|---|---|---|
| Ownership | TXT `_myndhyve-verify.<d>` = `myndhyve-verification=<hex16>`, checked via Google DNS-over-HTTPS; global uniqueness by Firestore transaction | `ssl.ts:118-150,373-404` |
| DNS authorization | `createDnsAuthorization` id `dns-auth-<slug>-<sha8>`; the returned `dnsResourceRecord` CNAME is shown to the user | `ssl.ts:88-96,494-527` |
| Certificate | Google-managed, `managed:{domains:[d], dnsAuthorizations:[auth]}` — **DNS authorization**, not load-balancer authorization | `ssl.ts:535-559` |
| Map entry | `createCertificateMapEntry` `hostname: d` in map `GCP_CERTIFICATE_MAP` | `ssl.ts:567-583` |
| Status | on-demand `getCertificate`; state 3 → active, 2 → failed with `provisioningIssue` | `ssl.ts:647-725` |
| Delete | map entry → cert → DNS auth, each awaited; partial failure keeps `status:'deleting'` | `ssl.ts:191-261` |
| Infra | `.env.myndhyve-prod:20-24`: `pages.myndhyve.ai`, map `myndhyve-pages-certmap`, IP `34.117.48.29`; IP reserved by hand (`src/core/hosting/types.ts:344-350`) | — |

**Warts — never inherit:**
1. **No serving path exists in code.** The `pages` Hosting site serves a literal placeholder
   (`dist-pages/index.html`); its catch-all reaches `sharingApi`, which mounts only
   password endpoints (`functions/src/sharing/index.ts:71-77`). No function reads `Host`. Host →
   page resolution is client-only (`CustomDomainService.ts:746-800`) and cannot work for anonymous
   visitors (`firestore.rules:460-465`). `PublishingService.publish` uploads nothing (`:175-224`).
2. Without `GCP_CERTIFICATE_MAP`, `provisionSSL` **fakes success** with a made-up expiry (`ssl.ts:443-444,617-642`).
3. The client sets `status:'active'` itself; rules let the owner write status (`CustomDomainService.ts:470-480`; `firestore.rules:472`).
4. Provisioning is not idempotent: a failure after step 1 makes retry hit `ALREADY_EXISTS` (`ssl.ts:448`).
5. `removeDomain` reports success on partial cleanup (`ssl.ts:264`). No status poller — user-driven only.
6. `GCP_LB_STATIC_IP` is never read by code; the LB/NEG/URL map are not codified anywhere.
7. Apex guidance says CNAME at `@` (`types.ts:358`).

### openwop-app today (`4cdb132c3`) — the serving half is real; the certificate half is a manual script

| Concern | Owner | Finding |
|---|---|---|
| Feature | `features/custom-domains/feature.ts:22-32`; `routes.ts:15-51` | toggle `custom-domains` (OFF, tenant, Marketing); list/add/verify/delete under `…/custom-domains/orgs/:orgId/domains`, `workspace:read|write`. |
| Record | `host/customDomains.ts:26-59` | `{hostname (PK, global), tenantId, orgId, status: pending|live|failed, verificationToken, …}`; 20/org; own origin refused. **No TLS fields.** |
| Ownership | `customDomains.ts:132,158-184` | TXT `_openwop-verify.<h>` = `owp-verify=<uuid>` via `dns.resolveTxt`; resolver noise never demotes `live`. |
| Re-check | `customDomains.ts:225-251` | 6 h `setInterval` **per instance** with no `claimOnce` lease, so every instance re-checks every row. |
| Delete | `customDomains.ts:145-152` | deletes the row only. |
| Serving | `middleware/customDomain.ts:110-161`, mounted pre-auth (`index.ts:699`) | Host → org binding (cached, `customDomains.ts:186-222`), 600 req/min/domain, lapse 404, document paths rewritten to the org's prerender (`/`, `/p/:slug`, `/pricing`, `/blog[/:slug]`, `/pod/…`), otherwise only the org's `/public/:orgId` + `/public-store/:orgId`. **Better than MyndHyve — keep it.** |
| Fail mode | `middleware/customDomain.ts:157-161` | **Defect:** a resolution error falls through to `next()` with the request un-pinned, so a customer hostname can reach the full app surface during a store fault. ADR 0295 describes the guard as fail-closed. |
| Host normalisation | `customDomains.ts:65-66` vs `:201` | add strips a trailing dot, resolve strips only the port — the two disagree (ADR 0836 residue). |
| TLS / LB | `DEPLOY.md:1645-1688`; `scripts/domain-cert-commands.sh:30-40` | Manual recipe: global IP, serverless NEG on `openwop-app-backend`, map `owp-domains-map`, per-host `certificates create --domains=<h>` + map entry. **No `--dns-authorizations`** ⇒ load-balancer authorization: a cert issues only after the customer's DNS already points at the LB. |
| Prod reality | ADR 0860:375-377 (measured 2026-10-07) | **No external load balancer is deployed in prod.** ADR 0384:87-91's "domains already flow GCLB → Cloud Run" is contradicted. |
| GCP access | `features/app-builder/deploy/adapter.ts:110-130`; `runtime-posture/liveRead.ts:25-36` | metadata-token + REST is the house pattern; `@google-cloud/kms` is the only GCP SDK (optional). |
| Frontend | `frontend/react/src/features/custom-domains/DomainsPage.tsx`; i18n `en.ts:9` | copy says TLS is "configured by your operator". |

### Boundaries audit

- **Domain owner:** `host/customDomains.ts` (rows, verification, binding cache). TLS state is a
  sub-object of the same row — no second domains store (MyndHyve's three-store failure).
- **Serving owner:** `middleware/customDomain.ts`. Unchanged except the P0 fail-closed fix.
- **Sweep pattern owner:** host maintenance loops are `setInterval` + a per-(row, slot)
  `storage.claimOnce` lease — `cms/publishSweep.ts:5,47`, `retentionSweepDaemon`,
  `connections/refreshDaemon`. (`host/scheduleDaemon.ts` is the RFC 0052 **workflow-run** scheduler,
  `:1-9` — the wrong primitive for a host sweep; architect C1.)
- **GCP REST + ADC:** `host/gcpAdc.ts`, extracted from the four existing metadata-token fetchers
  (ADR 0904 D12 — whichever ADR lands first does the extraction). The token fetch goes direct (the
  metadata host is blocklisted by `webhookEgressGuard.ts:246`); `certificatemanager.googleapis.com`
  calls go through the guarded fetch.
- **Deploy-adapter boundary (ADR 0424):** that ADR called custom hostnames "operator infrastructure…
  not app code". This ADR moves the **per-domain** certificate lifecycle into the app and leaves the
  **one-time** LB/NEG/map in operator infra (codified as a script). A correction note goes on 0424
  and on 0295's status line.
- **Route collision:** new `GET …/domains/:hostname/status` and `POST …/domains/:hostname/retry`
  under the existing router; `git grep` → none.

## Decision

**D1 — An `EdgeCertificateProvider` port with two adapters.**
```ts
interface EdgeCertificateProvider {
  id: 'manual' | 'gcp-certificate-manager';
  prepare(hostname): Promise<{ dnsRecords: DnsRecord[]; handle: EdgeHandle }>; // idempotent
  issue(hostname, handle): Promise<EdgeHandle>;                                 // idempotent
  status(handle): Promise<EdgeTlsStatus>;
  release(handle): Promise<'released' | 'partial'>;                             // idempotent
}
```
`OPENWOP_CUSTOM_DOMAIN_EDGE=manual` (default — today's behaviour; the operator script stays the
recipe) or `gcp-certificate-manager` (with `OPENWOP_CUSTOM_DOMAIN_CERT_MAP`,
`OPENWOP_CUSTOM_DOMAIN_LB_IP` for display, project from the metadata server). White-label adopters
off GCP keep `manual`; a Cloudflare-for-SaaS or Caddy adapter can be added later behind the same port.

**D2 — Per-project DNS authorization, created once ownership is proven.** On add the UI shows the
ownership TXT (provider-agnostic truth, unchanged) and the routing record. When the TXT verifies,
the GCP adapter creates the DNS authorization with **`type: PER_PROJECT_RECORD`** and the UI shows its
CNAME `_acme-challenge_<id>.<host>`. Per-project, not the default `FIXED_RECORD`, because a fixed
`_acme-challenge.<host>` CNAME must be the only record at that name — `pages.myndhyve.ai` already has
one pointing at MyndHyve's project, and customer CDNs often own it (architect C3, Google
Certificate Manager docs). Creating it only after TXT verification means an unproven claim costs no
GCP quota (architect C4); pending rows are also capped per tenant (5) and `anon:` tenants cannot
add domains. The routing record is
(`CNAME` to the platform edge hostname for subdomains; `A` to the LB IP for an apex — never a CNAME
at `@`, MyndHyve wart 7). DNS authorization is chosen over LB authorization because it lets the
certificate become active **before** the customer moves traffic, which is what a zero-downtime
cutover from `pages.myndhyve.ai` (or any existing host) needs, and it works behind a customer CDN.
The certificate and map entry are created **only after** the TXT verifies — no certificate is
issued for an unproven claim, and the TXT stays the single ownership authority.

**D3 — The row gains an `edge` sub-object and an honest two-axis status.**
`edge: {provider, tls: 'not_requested'|'awaiting_dns'|'provisioning'|'active'|'failed'|'releasing',
dnsAuthName?, dnsAuthRecord?, certName?, mapEntryName?, issue?: {reason, detail}, checkedAt}`.
Ownership (`status`) and TLS (`edge.tls`) are separate axes; `live` no longer implies "serving
HTTPS". The middleware does not consult `edge.tls` (the LB terminates TLS; a request that reached
us is already on a valid connection). Only the server writes either axis (MyndHyve wart 3).

**D4 — Idempotent by construction.** Resource ids are deterministic:
`owp-cd-<sha256(hostname)[0:20]>` with `-auth` / `-cert` / `-entry` suffixes (Certificate Manager id
rules: lowercase, ≤ 63 chars). Every step is GET-then-CREATE, treats `ALREADY_EXISTS` as success,
and awaits the long-running operation; the resource name is written to the row (CAS) after each step,
so a crash resumes at the next step (MyndHyve wart 4). `release` deletes entry → cert → auth, each
`NOT_FOUND`-tolerant; anything left keeps `tls:'releasing'` and the sweep retries. Delete of the
domain row waits for `released` (or an admin force after 3 failed sweeps, audited) — MyndHyve wart 5.

**D5 — One fenced sweep (claimOnce lease).** The 6 h ownership re-check and a 5 min edge poll
(only rows in `awaiting_dns | provisioning | releasing`) keep their `setInterval` tick but take a
per-(hostname, slot) `storage.claimOnce` lease before acting (the `cms/publishSweep.ts:47` pattern),
so N instances perform each row's check once. Status mapping: Certificate Manager
`ACTIVE` → `active`; `FAILED` → `failed` with `provisioningIssue` copied into `issue`;
`PROVISIONING` with an authorization-attempt failure older than 24 h → `failed` with
`reason:'dns_not_configured'`. A transition notifies the domain's creator (ADR 0010 emit seam).
Pending-claim expiry (ADR 0836 squatting residue): a `pending` row older than 14 days is released
(edge `release` first) so a squatted hostname frees itself.

**D6 — Codify the one-time edge, keep it operator-run.** `scripts/custom-domain-edge.sh
{plan|apply|verify}` — idempotent `gcloud` for the global IP, serverless NEG on
`openwop-app-backend`, backend service, URL map (all hosts → the NEG), target HTTPS proxy with the
certificate map, HTTP → HTTPS redirect, and both forwarding rules. `verify` asserts each resource
exists and the map is attached — and **fails on an empty listing** (the CLAUDE.md "empty plus
exit 0 means the query is wrong" lesson). The script also sets `OPENWOP_TRUSTED_PROXY_CIDRS` to the
Google front-end ranges via `scripts/update-env.sh` (ADR 0851 requires it once an external LB
fronts the service). DEPLOY.md § "Custom domains" is rewritten around the script.

**D7 — Least-privilege IAM, measured before it is granted.** The runtime service account needs
create/get/delete on certificates, DNS authorizations and map entries in **one** map. P4 first measures (on a scratch project David provides)
whether Certificate Manager honours IAM Conditions on `resource.name` (prefix `owp-cd-`); if yes,
grant `roles/certificatemanager.editor` with that condition; if no, a custom role holding only the
certificate, DNS-authorization and map-entry create/get/delete permissions plus operation reads, and the map lives in a project dedicated to the edge (Open decision 3).
The app never holds private keys (ADR 0295 binding rule: Google-managed certificates only).

**D8 — Fail closed on resolution errors (P0 defect fix).** In `customDomainMiddleware`, a thrown
`resolveCustomHost` passes through **only** when the host is in the platform set; any other host gets
503 `temporarily_unavailable` with `Retry-After`. The platform set must be complete or a store blip
503s the platform itself (architect C2): `PUBLIC_BASE_URL` + `OPENWOP_CORS_ORIGINS` hosts, the Cloud
Run service hosts (`*.run.app` for `K_SERVICE` — the direct SSE host), the Firebase Hosting hosts,
and `localhost`. P0 first **measures** the `Host` header that Firebase-rewritten `/api` traffic
actually carries, and a test covers each member. Add already strips a trailing dot
(`normalizeHostname`, `customDomains.ts:65-66`); `resolveCustomHost` (`:201`) strips only the port.
Resolve reuses the same normaliser, so `pages.example.com.` cannot miss its row.

### Rejected

- **Cloud Run domain mappings per tenant** — ADR 0295 option C (quotas, IAM coupling); unchanged.
- **Load-balancer authorization (today's recipe)** — cannot pre-issue before cutover, fails behind a
  customer CDN; kept only as what the `manual` adapter documents.
- **`@google-cloud/certificate-manager` SDK** — a gRPC SDK dependency for about nine REST calls; the house
  pattern is metadata-token REST, which also keeps egress behind the existing guard.
- **Port MyndHyve's serving path** — there is none to port (wart 1); openwop's middleware already serves.
- **Firebase Hosting custom domains per tenant** — Hosting caps custom domains per site and is
  not built as a multi-tenant edge.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | `features/custom-domains/` (routes, FE client) + `host/customDomains.ts` (row, sweep) + new `host/edgeCertificates/{port,manual,gcpCertificateManager}.ts`. No core route/nav edits. |
| 2 | Toggle + admin UI | `custom-domains` unchanged (OFF, tenant). Provider is operator env (FEATURES § env-gated flags). |
| 3 | Workflow surface | **None.** DNS setup is a human act at a registrar; no run needs to add a domain. Recorded so the matrix row is answered, not skipped. |
| 4 | Node pack | **None** (same reason). |
| 5 | AI chat + envelopes | None. |
| 6 | Agent pack | None — not an AI surface. |
| 7 | Public surface | The served surface is unchanged (still the fail-closed, org-pinned public allowlist). |
| 8 | RBAC | Add/verify/retry/delete `workspace:write`; force-release after failed sweeps = `host:org:manage`; status `workspace:read`. IDOR: hostname rows are org-checked on every route (existing). |
| 9 | Replay / fork | Not run-affecting. |
| 10 | Frontend | DomainsPage: both DNS records with copy buttons, apex vs subdomain guidance, two status chips (ownership / HTTPS), `issue` explained in plain words, "Check again" (rate-limited), 4-locale copy; drop "configured by your operator" when the provider is not `manual`. |

## Implementation plan — one mergeable PR per phase

Each phase is an independently mergeable PR off `origin/main`, gated by `npm run ci`, citing
`ADR 0906 P<k>` in its commits, and adding a row to an implementation record in this ADR when it
lands. **Track 1 needs no new spend, vendor account or credential and is ordered first so it ships
regardless; Track 2 phases wait on the named Open decision.** Phases within one ADR that touch
the same large file (noted) merge serially, not in parallel. A pack version bump in any phase
needs the registry republish that `check-pack-version-bump` names.

### Track 1 — no new spend (ship in this order)

**P0 — fail-closed middleware + host normalisation + fenced sweep.** (S, 2 d) · David: no.
- Owns: `middleware/customDomain.ts` (D8 platform set, 503 on a thrown resolution for other hosts);
  `host/customDomains.ts` (`resolveCustomHost` reuses `normalizeHostname`; `claimOnce` lease on the
  sweep; pending-claim cap 5/tenant; `anon:` refused on add).
- Tests: `test/custom-domain-fail-closed.test.ts` (route-level: thrown resolution on a customer host ⇒
  503 and never reaches an authed route; each platform-set member passes); `test/custom-domain-trailing-dot.test.ts`;
  `test/custom-domain-sweep-fenced.test.ts` (two instances ⇒ one check per row); add-limit tests.
- First measures, on the deployed service, which `Host` Firebase-rewritten `/api` traffic carries
  (read-only probe) and records it in the PR.

**P1 — provider port + `manual` adapter + edge sub-object + fake Certificate Manager.** (M, 3–4 d) ·
David: no. `OPENWOP_CUSTOM_DOMAIN_EDGE` defaults to `manual` ⇒ zero behaviour change.
- Owns: new `host/edgeCertificates/{port,manual,gcpCertificateManager}.ts` (GCP adapter complete but
  only reachable with the env set); `host/customDomains.ts` (`edge` sub-object, state machine, CAS
  per step, ordered release with `releasing`); `features/custom-domains/routes.ts` (`…/status`,
  `…/retry`, audited force-release `host:org:manage`); uses `host/gcpAdc.ts` (from 0904-P1b, or
  extracts it here if this lands first).
- Tests: `test/edge-cert-manual-golden.test.ts` (zero GCP calls, behaviour identical);
  `test/edge-cert-gcp-adapter.test.ts` against an in-process fake REST server (deterministic ids,
  GET-then-CREATE, `ALREADY_EXISTS` = success, crash-resume at every step, `PER_PROJECT_RECORD`,
  no authorization before TXT verifies, partial release stays `releasing` then completes);
  route tests for status/retry/force.

**P2 — lifecycle + notifications + frontend.** (M, 4–5 d) · David: no.
- Owns: `host/customDomains.ts` (5-min edge poll in the fenced sweep, status mapping, 14-day
  pending expiry with release, ADR 0010 notifications); FE `features/custom-domains/DomainsPage.tsx`,
  `domainsClient.ts`, `i18n/*` (both DNS records with copy, apex vs subdomain guidance, ownership +
  HTTPS chips, plain-language `issue`, "Check again"); the operator-copy line hidden when the
  provider is not `manual`.
- Tests: `test/edge-cert-lifecycle.test.ts` (status mapping incl. 24 h DNS failure; expiry releases);
  FE `__tests__/DomainsPage.test.tsx`; `/browser` light + dark screenshots in the PR.

**P3 — edge infra script + DEPLOY.md.** (S–M, 2 d) · David: no to **merge** (script + docs only, not
run). Correction notes on ADRs 0295 and 0424 land here.
- Owns: new `scripts/custom-domain-edge.sh` (`plan|apply|verify`, idempotent, `verify` fails on an
  empty listing); `DEPLOY.md` § "Custom domains" rewrite; `scripts/domain-cert-commands.sh` retired
  or pointed at the script.
- Tests: `scripts/test-custom-domain-edge.sh` (dry-run `plan` against a stubbed `gcloud` on PATH;
  `verify` exits non-zero on empty output).

### Track 2 — needs David

**P4 — stand up the edge + enable the adapter.** (S, 1–2 d, ops) · David: **yes** — LB spend (Q1),
project choice (Q2), IAM grant (Q3, after the IAM-condition measurement on a scratch project).
Runs `custom-domain-edge.sh apply`, sets `OPENWOP_TRUSTED_PROXY_CIDRS`, then
`OPENWOP_CUSTOM_DOMAIN_EDGE=gcp-certificate-manager` + map env via `scripts/update-env.sh`. Evidence:
one real test domain from add → active, recorded in the implementation record.

**P5 — MyndHyve cutover.** (S, 1–2 d, ops) · David: **yes** — GoDaddy DNS (Q4). Pre-issue
`pages.myndhyve.ai` via DNS authorization, flip DNS, retire `myndhyve-pages-certmap`.

## Tests

Per-phase tests are named in the implementation plan above. Every phase lands red-first:
the failing test is committed before the fix, so each PR shows the defect and its closure.

## Costs (for the decision, verify before enabling)

- Global external Application Load Balancer: a forwarding-rule charge plus data processing per GB
  (GCP list price, roughly $18–25/month base for one HTTPS + one HTTP rule at low traffic).
- Certificate Manager: first 100 certificates free, then $0.20/certificate/month (101–2,000);
  DNS authorizations and map entries carry no separate charge in the published pricing; quota 5,000
  map entries per project.

## Open decisions for David

1. **Spend:** stand up the global LB (≈ $18–25/month + egress) on `openwop-dev`, on `myndhyve-prod`,
   or only when the first paying custom-domain customer exists?
2. **Which project hosts the edge** for the MyndHyve-branded build — reuse `myndhyve-prod`'s existing
   `myndhyve-pages-certmap` + IP (`34.117.48.29`, cheapest cutover) or a fresh one?
3. **IAM grant** on the runtime service account (D7) — an account action only David can take; and, if
   conditions are unsupported, whether to create a dedicated edge project.
4. **DNS:** `pages.myndhyve.ai` lives at GoDaddy — the P5 cutover needs David to edit records.

## Architect review (2026-10-17)

`/architect`, Track A + Track B check. Independent adversarial review; findings verified in code and
Google's Certificate Manager docs, **folded into the decisions above**.

| # | Sev | Dimension | Finding | Resolution |
|---|---|---|---|---|
| C1 | HIGH | Pattern | `host/scheduleDaemon.ts` starts **workflow runs** (`:1-9`); host sweeps use `setInterval` + `claimOnce` (`cms/publishSweep.ts:47`). | D5 uses the `claimOnce` lease. |
| C2 | HIGH | Availability | An allowlist of `PUBLIC_BASE_URL` + CORS hosts misses the `*.run.app` SSE host (and possibly the Firebase-rewritten `Host`), so a store blip would 503 the platform. | D8: complete platform set, measured first, tested per member. |
| C3 | HIGH | Integration | The default `FIXED_RECORD` authorization needs `_acme-challenge.<host>` as the only record — it collides with MyndHyve's existing record on `pages.myndhyve.ai` and with customer CDNs. | D2: `PER_PROJECT_RECORD`. |
| C4 | MEDIUM | Abuse / quota | Creating authorizations at add time lets unproven claims consume project quota. | D2: after TXT verification; 5 pending per tenant; `anon:` refused. |
| C5 | MEDIUM | Security | The metadata host is SSRF-blocklisted (`webhookEgressGuard.ts:246`). | Token fetch direct; API calls through the guard (boundaries audit). |
| X1 | HIGH | Duplication | Four metadata-token helpers exist. | Shared `host/gcpAdc.ts` (ADR 0904 D12). |
| C6 | LOW | Accuracy | Add strips the trailing dot, resolve does not (`customDomains.ts:65-66` vs `:201`). | D8: resolve reuses `normalizeHostname`. |

**Boundaries:** one domain row (TLS is a sub-object), one serving middleware, a provider **port** so
non-GCP adopters keep `manual`. ADR 0424 / 0295 get correction notes when P2 lands.
**RFC (Track B):** confirmed host-extension.
**Verdict:** Accepted as a plan. P0–P3 merge with no new spend (provider defaults to `manual`); P4 (edge apply) and P5 (cutover) wait on David (spend, IAM, DNS).
