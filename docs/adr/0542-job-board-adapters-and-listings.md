# ADR 0542 — job boards: adapters as connection packs, listings as kernel entities

Status: implemented

Parent: [ADR 0539](0539-job-search-vertical-strategy.md). Composes: Connections (ADR 0033 /
RFC 0095), `entities` content kernel (ADR 0257, and the ADR 0409/0410 system-type façade
precedent), `computer-use` (ADR 0541's gate), Publishing, `capability-firewall`.

Module: `features/job-search/boards/` · Toggle: **`job-search`** (the ONE vertical flag — ADR 0539 D0). No toggle of its own.

## Context

A job-search vertical reaches several public boards plus user-added ones, then publishes what
it finds into a **public job index deduped across every user's campaigns**
(`JobListing` + `JobListingSource`). Two distinct concerns hide in that sentence: *how you
reach a board* and *what you do with what you find*.

## Decision

### D1 — A board adapter is a connection pack, not code

Per `ARCHITECTURE.md`'s seam table, "New third-party provider → RFC 0095 connection pack
under `examples/connection-packs/<id>/pack.json` (ADR 0033) — **no code**." A job board is a
third-party provider. Each board ships as a connection pack declaring its origin, auth
shape, and search/detail entry points; credentials resolve through the existing BYOK/
Connections broker.

This is what makes "add your own board" a **data** change rather than a deploy, which is
the prior art's feature and this host's existing pattern. It also means board credentials get the
Connections lifecycle free — revocation cascades through `connectionLifecycle` (ADR 0285)
instead of stranding a dead credential ref.

*(Correction, recorded at P2 by architecture review — read this before implementing D1.)*

**Two halves of D1 do not survive contact with the schema, and the review found both
before any code was written.**

1. **"declaring its … search/detail entry points" is not expressible.** The connection-pack
   manifest is `schemas/connection-pack-manifest.schema.json`, whose `$id` is
   `https://openwop.dev/spec/v1/…` — it is the **canonical spec corpus**, vendored here by
   `scripts/sync-schemas.sh`, not this app's file. `provider` sets
   `additionalProperties: false` over a fixed key set (`id, displayName, category, auth,
   reach, apiHosts, consumerNodes, docsUrl, vendor`). Adding entry points would therefore
   need an **RFC in `../openwop`**, and any local edit would be erased by the next sync.

2. **The Tier-1 four have no credentials to broker.** `auth.kind` is a closed enum —
   `oauth2 | api_key | bearer | basic`. Greenhouse, Lever, Ashby and Workable expose
   **public, unauthenticated** job-board endpoints, so a connection pack for them would
   declare an auth model that is never exercised and would put a meaningless Connection in
   the operator's broker. That is "advertise only what is honored" broken, in the one place
   this ADR is otherwise careful about it.

**Revised D1.** A board adapter is a **descriptor** owned by `job-search`
(`boards/adapters.ts`) carrying the origin, the search/detail entry points, and the response
mapping. Its `auth` field is either `public` or a **reference to a connection-pack provider
id** — so a board that genuinely needs credentials still rides the ONE existing BYOK/
Connections broker and inherits the ADR 0285 revocation cascade, and no second credential
model appears. Tier-1 ships descriptors only.

The **no-code claim survives intact**, which is what D1 was actually protecting: adding a
board remains a data change, not a deploy. What changes is *which* data file — a job-search
descriptor rather than a spec-corpus connection pack whose schema cannot hold the fields.

### D2 — A job listing is a kernel entity, not a bespoke table

`entities` already models user-defined content types with reference fields, taxonomies,
server-filtered query, publish-gating and NDJSON export, and ADR 0409/0410 established the
**system-type façade** precedent (company/deal/product are already modelled that way). A
`job.listing` system type gets: dedupe by canonical URL, skill taxonomy terms, publish
gating, the query API, and a public surface — none of which needs writing.

The **digest** stays in `job-search` (ADR 0540 D2): the listing is the public, shared,
deduped artifact; the digest is one applicant's structured read of it.

### D3 — Board content is UNTRUSTED, and that is enforced, not instructed

A posting is attacker-authored text that reaches a model holding tools and credentials.
The prior art's untrusted-content doctrine is excellent *prose*; here it must be **mechanism**:

- Fetched board content is `<UNTRUSTED>`-fenced before it reaches any model context, and the
  tools that return it declare `contentTrust: 'untrusted'` — the RFC 0137 §F1 ratchet makes
  that an explicit act rather than a default. *(This exact mistake was made and caught in
  ADR 0534: a tool returning user-authored card titles was marked `trusted` on the reasoning
  that the caller could already see them — conflating access with injectability.)*
- Outbound reach is bounded by the `capability-firewall` + egress rules; a posting cannot
  cause a fetch to an origin the adapter did not declare.
- The failure posture is the prior art's, and it is the right one: **an injection attempt is a
  skipped listing with a recorded reason, never a stopped campaign.**

### D4 — Publishing a listing is a deliberate, gated act

The prior art publishes every scraped posting into a cross-user public index. Here that is a
bigger claim: this is a multi-tenant host, and one tenant's scrape becoming another's public
content needs an explicit decision. Listings are **tenant-private by default**; the public
index is an opt-in publish through the existing Publishing gate, and the public route derives
tenant from the resource, never the request.

Deduping across tenants is therefore only possible for *published* listings — which is the
honest scope, and avoids a cross-tenant read path existing merely to make a count look bigger.

### D5 — A source LADDER, and the browser tier is not in the product

*(Revised after research; this is what closes OQ-1 rather than deferring it.)*

The framing "how do we scrape safely" was wrong. **Most job data is already published as
machine-readable, first-party JSON by the employers themselves**, so the risky tier is
largely unnecessary:

| Tier | Source | Posture | Coverage |
|---|---|---|---|
| **1** | **ATS public APIs** — Greenhouse, Lever, Ashby, Workable publish documented JSON endpoints (e.g. `api.greenhouse.io/v1/boards/{co}/jobs?content=true`) | First-party, published *for* consumption. No auth, no proxies, no anti-bot arms race. | Nearly every company whose careers page runs on one of these — i.e. most of the tech market |
| **2** | **`schema.org/JobPosting` JSON-LD** on career pages (Google for Jobs requires `title`, `description`, `datePosted`, `hiringOrganization`, `jobLocation`) | Structured data published expressly to be read by machines | Any employer wanting Google visibility |
| **3** | **Licensed aggregator APIs** (Adzuna, USAJOBS, ATS aggregators) | Contractual, terms accepted deliberately per connection | Broad |
| **4** | **Authenticated browser session** | **Contract risk** — the tier that gets accounts restricted | The walled gardens |

**Tiers 1–3 only in the sellable bundle. Tier 4 is not shipped.**

This is not a compromise on capability. Tier 1 is *better* data than scraping — first-party,
no parse drift, no proxy infrastructure, no breakage when a page redesigns. And because D1
already made an adapter a **connection pack rather than code**, a new Tier-1 ATS is a small
pack file, so "add your own board" is unaffected.

**Why Tier 4 is excluded rather than gated.** The legal line is *authentication*, not
publicness: accessing public data survived CFAA scrutiny in the leading case, but the same
litigation was ultimately lost on **breach of contract** — the theory that attaches when you
log in under accepted terms. A hosted, multi-tenant, **sold** service doing that at scale is
a materially worse posture than an individual doing it on their own machine, because the
operator becomes a party to it at scale. Shipping it in a paid bundle would be selling the
risk to the buyer and keeping it on ourselves simultaneously.

A self-hosting adopter retains the ability to author a Tier-4 connection pack for their own
deployment. That is their contract to accept, not ours to sell.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package** | `src/features/job-search/boards/` — a MODULE: adapter registry + listing façade + search orchestration. Composes Connections, `entities`, `computer-use`. |
| 2 | **Toggle** | **`job-search`** — no toggle of its own (ADR 0539 D0). |
| 3 | **Workflow surface** | `ctx.features['job-boards']`: `search(board, query)` (read), `getListing(id)` (read), `publishListing(id)` (write, Publishing-gated). |
| 4 | **Node pack** | `feature.job-boards.nodes` — `board.search`, `listing.get`, `listing.publish`. |
| 5 | **Envelopes** | **None.** |
| 6 | **Agent pack** | **None** — the persona is ADR 0543's. |
| 7 | **Public surface** | The published job index: `PUBLIC_PATH_PREFIXES` entry, tenant from the resource, published-only, uniform 404, rate-limited + payload-capped. |
| 8 | **RBAC** | Search/read `workspace:read`; publish `workspace:write` + the Publishing gate. Board credentials never leave the resolver; never echoed in a listing, an event, or an error. |
| 9 | **Replay/fork** | A search records its result set; replay reads the recording and never re-scrapes (both determinism and courtesy to the board). Listing ids are stable and content-derived so a re-scrape collides rather than duplicating. |
| 10 | **Frontend** | A board-management page (add/authorise a board via Connections) + listing browse. Reuses the existing Connections UI for auth — no second credential form. |

## Phased plan

| Phase | Scope | Verification |
|---|---|---|
| **P1** | The `job.listing` system-type façade over `entities` + content-derived stable ids. | Dedupe: the same posting scraped twice collides; two different postings never do. |
| **P2** | Adapter registry + Tier-1 packs for the major ATS platforms (proving the no-code path). | Packs load + validate; a revoked connection disables the board (ADR 0285 cascade). Tier 1 needs no credentials at all — which is itself the evidence that this tier is the right default. |
| **P3** | Tier 2 (JSON-LD extraction) + Tier 3 (one licensed aggregator). | A career page with valid `JobPosting` markup yields a listing with zero HTML parsing; a page without it degrades honestly to "not supported" rather than guessing. |
| **P4** | Untrusted-content enforcement (D3) + the publish gate (D4). | The headline test is an **injection fixture**: a posting whose body instructs the agent to fetch an off-origin URL or reveal an env var must produce a *skipped listing with a reason* and zero egress. |
| **P5** | Public index + frontend. | Public-route tests: cross-tenant 404, unpublished 404, rate limit. |

## RFC gate

**Host work, no RFC.** Board adapters ride the **already-Accepted RFC 0095** connection-pack
shape (the ADR 0033 precedent), so no new RFC even though a new provider class appears. The
public index is CMS/Publishing-shaped and non-normative.

## Open questions

- **OQ-1 — scraping posture. RESOLVED (D5).** The answer is a source ladder with the
  authenticated-browser tier **excluded from the product**: the legal line is authentication,
  not publicness, and that is precisely where the leading scraping case was lost on contract.
  Tiers 1–3 cover the market with better data anyway. Self-hosters may author a Tier-4 pack
  for their own deployment — their contract to accept, not ours to sell.
- **OQ-2 — cross-tenant dedupe. DROPPED, deliberately.** Under D5 a Tier-1 listing is
  canonical at source, so dedupe by ATS job id is exact and works entirely *within* a tenant.
  Cross-tenant sharing would add a privacy surface and a publish workflow to buy a
  duplicate-detection improvement of approximately zero. The public index stays possible for
  its own sake; it is no longer justified by dedupe.
- **OQ-3 — listing freshness. RESOLVED: lazy + visible age + a re-check at apply time.**
  Scheduled re-fetching is continuous cost for no user-visible benefit. The moment that
  matters is submission: a Tier-1 fetch returning 404/closed right before applying means the
  role is gone — mark it closed and do **not** submit. That single check removes the
  embarrassing failure (applying to a filled role) without any background sweep.

## Implementation record

| Phase | Evidence |
|---|---|
| P1 | `job.listing` as a system-type façade on the `entities` kernel; content-derived id so cross-board dedupe is structural. Architect review chose the kernel seam over a private store and recorded the inherited tenant-fold key exposure rather than dodging it. |
| P2 | Board-adapter descriptors + the Tier-1 four. **D1 corrected**: the pack schema is the canonical spec corpus and cannot hold entry points; its `auth.kind` enum has no credential-free option, so a pack for a PUBLIC board would advertise unused auth. |
| P3 | Tier-2 JSON-LD extraction (pure, bounded) routed through the host egress guard; Tier 3 ships the shape + licence gate and NO aggregator. |
| P4 | Injection screening before the row exists; publish gate reusing the kernel's `publicRead`. Zero egress asserted structurally. |
| P5 | Public index verified over the EXISTING `public-entities` path (no second public surface); listings + publish UI. |

**A recurring pattern worth naming.** Four of the five phases were changed by the
pre-phase architecture review, and in three of them the change was *less* code:
the kernel already owned the store (P1), the publish gate (P4) and the public read
path (P5). The phase that added the most new code, P3, is the one where the review
found the existing seam had to be reused for *security* reasons rather than
convenience.
