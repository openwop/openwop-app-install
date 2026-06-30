# ADR 0169 — RFC 0120 pack-declarable provider `apiHosts`: host witness

Status: implemented

## Context

RFC 0120 (connection-pack provider `apiHosts`) is `Active` on `openwop/openwop` (RFC + the
schema/register changes merged as openwop#794). It adds an **additive** field to the connection
provider on `connection-pack-manifest.schema.json`: `provider.apiHosts` — the bare registrable
hostname(s) the host MAY send this provider's resolved credential to for connector egress
(RFC 0045), with a provider-level `allOf` making it **conditionally required**: a provider whose
`reach` is `openapi` (i.e. it performs credentialed HTTP egress) MUST declare `apiHosts`; an
`mcp`/metadata-only provider MAY omit it.

openwop-app already enforces the *consuming* half of this: `host/brokeredEgress.ts` pins every
credential-bearing call to `getProvider(provider).apiHosts` (eTLD+1 floor, dot-anchored in
`host/connectionInjection.ts::hostMatchesApi`) and **fails closed off-host** (the RFC 0079
audience-binding / confused-deputy guard). But that allow-list could only be read from a
**built-in** `ProviderManifest`. A *pack-delivered* provider had no way to declare its hosts, so
the loader's `toProviderManifest` never populated `apiHosts` → a pure ad pack
(`meta-ads`/`google-ads`/`tiktok-ads`) failed closed on egress. That is exactly why ADR 0167's
real-ad-dispatch leaned on dedicated built-in manifests and why the Meta cascade-delete DELETE
no-opped. RFC 0120 closes the gap: the pack declares `apiHosts`, the loader reads it, brokeredFetch
just works.

openwop-app is the reference connection host, so it is the natural **witness #1** toward
`Active → Accepted`. This is host work riding an `Active` RFC (no new RFC needed) — the same
reference-witness posture as ADR 0165 (RFC 0118). The host advertises/honors the field **only**
because it genuinely serves it, so the claim survives `OPENWOP_REQUIRE_BEHAVIOR=true`.

## Decision

Land the witness as a self-contained change — no new egress model, no parallel allow-list:

1. **Vendored schema (`schemas/connection-pack-manifest.schema.json`).** Synced to openwop#794:
   `provider.properties.apiHosts` (array of bare hostnames, `format:hostname` + a registrable-domain
   `pattern`, `uniqueItems`, `minItems:1`) plus the provider-level `allOf` conditional-MUST
   (`reach.openapi` ⇒ `apiHosts` required). The provider object is `additionalProperties:false`, so
   without this sync a pack carrying `apiHosts` would be **rejected** — vendoring is load-bearing.

2. **Loader reads it (`features/connections/connectionPackLoader.ts`).** The `ConnectionPackManifest`
   provider type gains `apiHosts?: string[]`, and `toProviderManifest` copies it into the registered
   `ProviderManifest` (`...(p.apiHosts ? { apiHosts: p.apiHosts } : {})`). This is THE load-bearing
   change — the single gap that made pack-delivered providers fail closed. **No change to
   `brokeredFetch`** (`host/brokeredEgress.ts`) or `hostMatchesApi` — they already pin via the
   eTLD+1, dot-anchored matcher; once the loader populates `apiHosts`, egress just works.

3. **Every in-tree `openapi`-reach pack declares `apiHosts`** (eTLD+1, one entry = all subdomains):
   `meta-ads → facebook.com`, `google-ads → googleapis.com`, `tiktok-ads → tiktok.com`,
   `linkedin-ads → linkedin.com`, `microsoft365 → microsoft.com`, `netsuite → netsuite.com`,
   `salesforce → salesforce.com`, `workday → workday.com`. The `mcp`-reach packs (`github`, `jira`,
   `notion`) correctly omit it. This is not optional cleanup: the conditional-MUST means **any**
   openapi pack without `apiHosts` now fails to load, so completing the data for all of them is
   required to keep boot honest (a regression caught by `connection-packs.test.ts` and fixed here).

### Honesty note — eTLD+1 over-breadth is accepted, not hidden

`hostMatchesApi` collapses to an eTLD+1 floor: `apiHosts:['microsoft.com']` admits *all*
`*.microsoft.com`, and `googleapis.com` admits BigQuery from an ads pack. This is the locked UQ
disposition (eTLD+1 floor; a tighter exact-host entry can't actually narrow without a matcher
change). It is the documented trade-off, not an oversight — credentialed egress is still pinned to
the provider's own registrable domain and fails closed everywhere else.

## Verification

- `tsc --noEmit` clean.
- New behavioral test `test/connection-pack-apihosts.test.ts` (the egress-allow-list leg): the loader
  reads `apiHosts` into the manifest; an `openapi` pack omitting `apiHosts` is rejected
  (`validation_error`, never registered → fails closed); an `mcp` pack with no `apiHosts` loads; and
  `hostMatchesApi` permits the api host + its subdomains while failing closed on look-alikes
  (`notfacebook.com`, `facebook.com.evil.com` — no substring/suffix/prefix escape).
- Full connection/egress/ads sweep green: **116 tests across 14 files** (connection-packs, the three
  ads adapters, bigquery/workday connectors, connector-invoker, readonly-gate, injection, outbound-mcp).

| Phase | Status |
|---|---|
| Vendored schema (`apiHosts` + provider `allOf` conditional-MUST) | implemented |
| Loader reads `apiHosts` into `ProviderManifest` (`toProviderManifest`) | implemented |
| All 8 in-tree `openapi` packs declare eTLD+1 `apiHosts` | implemented |
| Egress-allow-list behavioral test | implemented |

## Conformance-witness arm — `egress-check` seam + published 1.46.0 leg

The steward published the scenario in `@openwop/openwop-conformance@1.46.0`
(`connection-pack-apihosts.test.ts` + two SECURITY invariants:
`connection-pack-api-host-shape`, `connection-pack-egress-host-bound`). This arm wires the host
half so the behavioral leg runs non-vacuously.

1. **`egress-check` seam (`routes/connectionPackSeam.ts`).** Added
   `POST .../connection-packs/egress-check` `{provider, requestHost} → {allowed, code?}` — a pure
   DECISION probe reporting the verdict of the SAME `host/connectionInjection.ts::hostMatchesApi`
   matcher `brokeredEgress` pins credentialed egress with (no credential read, no outbound request).
   Fails closed for an unresolved provider (`connection_provider_unresolved`), a provider with no
   declared apiHosts (`no_api_hosts`), and any non-matching host (`egress_host_not_allowed`).
2. **Product + spec-canonical aliasing.** Every connection-pack seam handler
   (`install`/`resolve`/`consent-plan`/`egress-check`) now registers at BOTH
   `/v1/host/openwop-app/connection-packs/*` and `/v1/host/sample/connection-packs/*` — the
   dispatch-fanout (ADR 0165) product+alias posture. The published suite drives the `sample` path;
   without the alias the behavioral leg 404-soft-skips instead of running (a latent gap this also
   closes for the pre-existing install/consent-plan legs). Whole family stays env-gated on
   `OPENWOP_TEST_SEAM_ENABLED` (404 in production).
3. **Deterministic in-repo pin (`test/connection-pack-egress-seam.test.ts`).** Under
   `OPENWOP_REQUIRE_BEHAVIOR=true` the suite's behavioral leg still 404-soft-skips an *unwired* seam
   (passing vacuously), so the seam contract is pinned here instead — 13 host-boot cases (permit
   `graph.facebook.com`/`facebook.com`; fail-closed `evil.com`/`notfacebook.com`/`facebook.com.evil.com`;
   unresolved + no-apiHosts; 400s; 404-when-disabled).

**Witness finding (filed to the steward).** `connection-pack-reach-exclusive.test.ts` in 1.46.0 is
self-inconsistent: its always-on, server-free positive case mutates the mcp `github` fixture to
`reach: openapi` without adding `apiHosts`, which 1.46.0's own schema (the conditional MUST this RFC
added) now rejects — so it fails for every host on 1.46.0. Not a host defect; suite-side fix expected
in 1.46.1. Recorded in `conformance.md` and on the 0117 crosstalk queue.

| Conformance-arm phase | Status |
|---|---|
| `egress-check` seam wired to `hostMatchesApi` | implemented |
| Connection-pack seams aliased to spec-canonical `sample` base | implemented |
| Deterministic host-boot pin (`connection-pack-egress-seam.test.ts`, 13) | implemented |
| `connection-pack-apihosts.test.ts` 8/8 green under `OPENWOP_REQUIRE_BEHAVIOR=true` | implemented |
| `conformance.md` witness evidence (suite 1.46.0) | implemented |

## Status toward graduation

openwop-app is **witness #1** for RFC 0120, now with the published-suite (1.46.0) behavioral leg
passing non-vacuously and `conformance.md` evidence recorded. Per openwop-1 (crosstalk 0117), with
myndhyve-1 honestly opted out of the brokered-egress arm, this graduates RFC 0120 `Active → Accepted`
as a **single-witness** (tier-2 + reference-host) pass once the evidence lands upstream — no second
independent witness is being withheld; there simply is no second brokered-egress host.
