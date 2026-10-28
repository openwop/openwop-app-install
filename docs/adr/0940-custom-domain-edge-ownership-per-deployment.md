# ADR 0940 — Custom domains: each deployment owns its edge (D-D5)

**Status:** Accepted (2026-10-19, David: "proceed with your recommendations"). Phases P1–P2 are
host code; P3–P5 are operations that run through the release coordinator.
**Date:** 2026-10-19
**Feature:** `custom-domains` (extends ADR 0295 and ADR 0906). No new toggle.
**Decides:** MyndHyve cutover decision **D-D5** (`myndhyve-app` `myndhyve/docs/cutover/dns.md`):
which backend MyndHyve's customer domains reach through the ADR 0906 edge.
**RFC verdict:** **host-extension — no RFC.** Edge routing, response headers on published pages and
the Domains page are host infrastructure and host UI. No wire field, capability or event changes.
The `OpenWOP-Version` header stays on every protocol route; P1 drops it only from published-page
responses served to a custom hostname, which are not protocol responses.

## Context (measured 2026-10-19)

1. **The edge fronts openwop-dev.** ADR 0906 P4 built one EXTERNAL_MANAGED load balancer in
   `myndhyve-prod` (`owp-edge-*`, IP `34.149.148.86`, cert map `myndhyve-pages-certmap`). Its only
   backend is the serverless NEG `owp-edge-neg` in **openwop-dev**, pointing at
   `openwop-app-backend`. openwop-dev has no edge of its own (Certificate Manager is not enabled
   there).
2. **A domain lives in one backend's database.** The custom-domain host guard resolves a hostname
   against the domain rows of the backend that receives the request. The MyndHyve install runs its
   own Cloud Run backend and Cloud SQL database in `myndhyve-prod` (`myndhyve-app`
   `myndhyve/docs/deploy-runbook.md` § 2). A domain added in MyndHyve is unknown to openwop-dev, so
   through today's edge it would 404.
3. **The edge works end to end.** `edge-test.myndhyve.ai` went from add → TXT verified → DNS
   authorization → certificate ACTIVE (20:17:50Z, Google Trust Services WR3) → HTTPS 200 at
   20:21:09Z, about 19 minutes after the records were published. Every resource the app created is
   named `owp-cd-*`, so the IAM condition on `owpCustomDomainsEdge` held. `pages.myndhyve.ai`
   (classic LB `34.117.48.29`) was unchanged throughout.
4. **What legacy MyndHyve taught customers** (read-only, `myndhyve` repo at `51dae3c89`): CNAME
   subdomains to `pages.myndhyve.ai`, an A record to `34.117.48.29` for apex domains, and a TXT at
   `_myndhyve-verify.<domain>` (`functions/src/seeding/seed-data/tutorialSeeds.json`). It issued
   certificates through the same Certificate Manager map (`functions/src/domain/ssl.ts`).
5. **No customer domain is live today.** The map holds only `pages-myndhyve-ai-entry` and the new
   `owp-cd-…-entry` for `edge-test`; the DNS authorizations are the same two. Nothing needs migrating.
6. **Responses are not white-label.** `https://edge-test.myndhyve.ai/` returns
   `x-powered-by: Express` and `openwop-version: 2.0`.
7. **The Domains page help text is stale.** `howItWorks` still says "TLS and routing for the hostname
   are configured by your operator", which ADR 0906 automated.
8. **A branded CNAME target is already supported but unset.** `OPENWOP_CUSTOM_DOMAIN_EDGE_HOSTNAME`
   (`host/edgeCertificates/config.ts`) makes the routing record a CNAME to that hostname instead of an
   A record to the IP.

## What customers expect

Measured against what an agency buying MyndHyve is used to:

| Expectation | Market reference | Today | After this ADR |
|---|---|---|---|
| The client's domain shows the site from the product the agency pays for | All of them | Reaches the OpenWOP demo backend | Reaches MyndHyve's backend (P3) |
| Client sites isolated from another product's deploys, data and incidents | All of them | Shares openwop-dev, which deployed several times on 2026-10-19 alone | Own backend and database |
| White-label responses | GoHighLevel, Unbounce | Platform headers present | Removed on custom hosts (P1) |
| One routing record to a branded hostname, not an IP | GoHighLevel and Unbounce: one CNAME | A record to `34.149.148.86` | CNAME to `pages.myndhyve.ai`, A only for apex (P4) |
| HTTPS within minutes, with no downtime when a live site moves | Automatic SSL everywhere | About 19 minutes; DNS authorization lets the certificate issue before traffic moves | Unchanged: keep DNS authorization |
| Proof of ownership, so nobody can attach a domain they don't own | Usually implicit in the CNAME | TXT `_openwop-verify` | Unchanged: keep the TXT |
| One-click setup for common registrars | Leadpages, Unbounce (GoDaddy) | Manual records | Recorded follow-on (Domain Connect), not in this ADR |

**Why keep DNS authorization even though it adds a record.** Load-balancer authorization would drop
the certificate CNAME, but a certificate is then issued only after the domain's traffic already
reaches the load balancer, so a live site moving to MyndHyve would show certificate errors until
issuance finishes. DNS authorization issues ahead of the move. For agencies migrating client sites,
no downtime is worth one extra record.

## Decision

**Each deployment owns its own custom-domain edge. MyndHyve's customer domains reach MyndHyve's
backend, through the edge already built in `myndhyve-prod`.**

- At the MyndHyve backend deploy, the existing edge is handed to MyndHyve. A serverless NEG and
  backend service in `myndhyve-prod` point at MyndHyve's Cloud Run service and become the URL map's
  default. The routing is then same-project, so no cross-project `loadBalancerServiceUser` grant is
  needed.
- The five `OPENWOP_CUSTOM_DOMAIN_*` settings move from openwop-dev's backend to MyndHyve's, and are
  **removed** from openwop-dev in the same change. Two backends must never write one certificate map.
- If the OpenWOP demo later needs customer domains, it gets its own edge in openwop-dev from the
  same `custom-domain-edge.sh` (parameterised by `OPENWOP_EDGE_APPLY_PROJECT` / `OPENWOP_EDGE_PREFIX`).
  Not built until there is a real need.

### Alternatives rejected

| Option | Why not |
|---|---|
| Keep fronting openwop-dev | MyndHyve's domain rows are not in openwop-dev's database, so it only works if MyndHyve customers live inside the demo app. That contradicts the deployment plan, and their client sites would ride the demo's deploy schedule. |
| One edge, per-hostname host rules to two backends | Every new domain would need a URL-map edit, so the app's service account would need URL-map write access. Two products would share one blast radius and one certificate map. |
| Load-balancer authorization to drop the certificate CNAME | A certificate issues only after traffic arrives, so moving a live site causes certificate errors. Also no wildcards. |

## Implementation plan

| Phase | What | Owner | Gate |
|---|---|---|---|
| **P1** | White-label custom hosts: responses the custom-domain host guard serves omit `x-powered-by` and `OpenWOP-Version` (protocol routes keep `OpenWOP-Version`). Rewrite the Domains page `howItWorks` text in all four locales to match the automated flow, and show the routing record as a CNAME when an edge hostname is configured. Route-level tests, sabotage-witnessed. | `build-0906-domains` | merge train |
| **P2** | `custom-domain-edge.sh repoint`: creates the NEG and backend service for a named Cloud Run service in the edge's own project and swaps the URL map default. Dry-run by default, read-only snapshot before, written rollback (swap back to the previous default), idempotent. The old cross-project backend is left in place until P3 verifies. | `build-0906-domains` | merge train; not run |
| **P3** | At the MyndHyve backend deploy (staging at M2 if the 2026-11-02 demo shows a custom domain; otherwise at the M4 cutover): remove `edge-test.myndhyve.ai` from openwop-dev, run `repoint` against MyndHyve's service, set the five settings on MyndHyve's backend, and unset them on openwop-dev. Verify with a fresh test domain added in MyndHyve. | release coordinator (`openwop-app-0b`) with `openwop-app-66` | David's go for the run |
| **P4** | After `pages.myndhyve.ai` moves to the new edge (D-D3, ADR 0906 P5): set `OPENWOP_CUSTOM_DOMAIN_EDGE_HOSTNAME=pages.myndhyve.ai`, so customers CNAME subdomains to `pages.myndhyve.ai` as legacy MyndHyve taught them. | release coordinator | D-D3 |
| **P5** | Retire the classic `myndhyve-pages` LB and IP `34.117.48.29` (CDE-1), and delete the now-unused cross-project backend and NEG in openwop-dev. | release coordinator | P4 verified; David |

The P3 step order is the runbook. It also goes into `myndhyve-app`
`myndhyve/docs/cutover/dns.md` and `deploy-runbook.md`.

## Open questions

1. **P3 timing.** At M2 staging (so the demo can show a client domain) or at the M4 cutover?
   Recommended: M2 if the demo needs it, because the swap is reversible by `repoint` to the previous
   default.
2. **Domain Connect.** One-click setup for GoDaddy and other registrars is a follow-on ADR.

## References

- ADR 0295 (custom domains), ADR 0906 (edge certificate automation) and its implementation record.
- `myndhyve-app` `myndhyve/docs/cutover/dns.md` (D-D3, D-D5) and `deploy-runbook.md` § 2.
- Google Cloud, [Certificate Manager domain authorization](https://docs.cloud.google.com/certificate-manager/docs/domain-authorization).
- [Unbounce: connecting your domain](https://documentation.unbounce.com/hc/en-us/articles/203661044);
  [Leadpages: custom domains](https://leadpages.com/product/custom-domains); GoHighLevel domain setup
  ([third-party guide](https://consultevo.com/gohighlevel-add-domain-dns-setup/)).


## Recovery correction — P2 concurrency and recovery (2026-10-21)

The initial P2 implementation recorded a fingerprint but then used
`set-default-service`, whose own fresh read could overwrite a newer operator
change. The same unconditional command made its saved rollback unsafe.

P2 now captures one JSON snapshot and changes only `defaultService` with a
Compute API PATCH carrying that original fingerprint. A 412 stops the handoff.
The helper verifies the exact project/region/serverless NEG service, HTTP
backend scheme and sole group, including the already-target path. It waits
for the asynchronous operation and compares the full writable map before
issuing a rollback receipt. Rollback uses the saved post-apply fingerprint;
a newer change is preserved.

A private recovery directory records the pinned context before sending.
A fully written immutable request record is published create-if-absent;
concurrent resumes all use its winning nonzero request ID and body. Ambiguous
responses resume through `repoint --resume <directory>` with that same request.
No new fingerprint is adopted to force success. Already-restored rollback
reports its observed state without another write. Credentials remain only in
process memory and HTTPS headers.

The source and mocked-cloud witnesses received independent review. Execution
and the combined merge gate are still pending; no live edge was repointed.
P3–P5 remain the operations in the original plan.
