# ADR 0651 — Analytics: the public beacon cannot forge identity, verdicts, or success

Status: implemented (2026-09-10; reserved as 0649, renumbered to 0651 at PR time — a peer's `0649-v1-path-prefix-single-owner` and `0650-worker-contract-explicit` were on unmerged branches, and `check-adr-refs --next` found them where `ls docs/adr` could not)
Date: 2026-09-10
Feature: Analytics (ADR 0191 beacon; ADR 0236 page experiments; ADR 0381 subject resolver) · FEATURES.md ordinal 9 of 71
Composes ADR 0020 (consent), ADR 0464 (erasure), ADR 0582 (measurement honesty), ADR 0645/0648 (the refuse-not-coerce precedents)
Source: `/grade-workflows` re-grade 2026-09-10 (`WORKFLOWS-ASSESSMENT.md`, `ANLWF-1..15`)

## Context

`POST /public-analytics/:orgId/collect` is unauthenticated by design (`middleware/auth.ts:389`,
CSRF-exempt at `csrf.ts:21`). Tenant is derived from the org, consent runs through the one
ADR 0020 helper, the visitor hash is server-computed and never read from the body. Those are
right. What the re-grade found is that three *other* body fields are trusted where they
should be derived or refused, and each one reaches a durable, downstream-consumed fact.

### The boundaries audit

- Click tokens are owned by `email/engagementService.ts`; identity links by
  `analytics/identityLinkService.ts`; experiment assignment by
  `cms/pageExperimentsService.ts` (`assignVariantForVisitor`, deterministic and pure). D1–D3
  **compose** those owners; nothing is restated.
- The throwing input helper `requireString` (`featureRoute.ts:145`) and the consent surface's
  `requireSubjectKey()` (`consent/surface.ts:703-728`) are the refuse-at-the-surface
  precedents D2 copies.
- RFC verdict: host-extension, **NO RFC**. The beacon's wire shape is unchanged; the server
  ignores or refuses fields it previously trusted.

## Decision

### D1 — an identity link requires the token's first-seen session, and tokens are consumed for linking (`ANLWF-1`, Blocker)

`recordEvent` links `body.sessionKey` to the contact behind `body.owx` whenever the token
resolves in-tenant. The token row binds to nothing but tenant and contact, never expires, and
is never consumed; the session key is caller-chosen. A forwarded newsletter is enough: the
forwardee's beacon carries the recipient's token onto the landing page and durably links the
forwardee's session to the recipient's CRM contact — and the ADR 0381 resolver then expands
the recipient's DSAR to the forwardee's history.

Two composed changes, both in the engagement owner:

1. **First-click binding.** On the first `linkSession` from a given token, `engagementService`
   stamps the token row with the `sessionKey` that claimed it (`claimedBySession`), via CAS.
   Every later beacon carrying that token links **only if its `sessionKey` equals the
   claimant's**; a mismatch records the event (capture-before-effect) and writes no link. A
   forwarded token can still count a *click*; it can no longer re-point *identity*.
2. **The DSAR resolver stays as it is** — it is correct given honest links; the fix is to
   make the links honest.

A token's claimant is the visitor who first landed on it, which is the only binding the
email lane can assert. This is stated as the limit: if the *first* landing is the forwardee,
the link is wrong in the same way it is today, but it is now wrong **once** rather than
unboundedly, and a subsequent DSAR from the true recipient no longer sweeps strangers in
by the dozen.

> **Correction notes, 2026-09-10 (adversarial `/grade-code` on this diff, before merge):**
> - **`ANL-20` — the claim planted a subject key in a store whose eraser could not see it.**
>   `claimedBySession` is an analytics session key, and the ADR 0381 resolver erases in
>   exactly that key space; `deleteSubjectEngagement` matched only `contactId`/`email`, so
>   a DSAR by session deleted nothing in `email:engagement-token` and the receipt was
>   green — a fresh instance of the ANL-2/ANL-3 family D5 was closing, one file over.
>   Fixed: the eraser deletes rows whose `claimedBySession` is the subject (deletes, not
>   un-claims — an un-claimed token would re-open to the next holder and link the erased
>   subject's contact to a stranger), and `declarePiiFields('email.engagement-token',
>   ['email','contactId','claimedBySession'])` classifies the store. Witness: the D1 test's
>   erasure leg (`analytics-identity-link.test.ts`).
> - **`ANL-23` — the residual this decision ACCEPTS, now stated:** first-click binding
>   (a) denies the legitimate multi-device recipient — phone claims, desktop gets no link —
>   and (b) lets anyone holding a forwarded token, before its first landing, claim it with
>   a junk session and permanently deny the real recipient's link. Both are the price of
>   "wrong once, not unboundedly"; a per-contact device fan-out needs an authenticated
>   signal the email lane does not have. Recorded, not fixed.
> - **`ANL-24`** — the unclaimed `resolveClickToken` had zero callers after D1 and was the
>   exact shape the next caller would reach for; it is deleted, not kept.

### D2 — the analytics surface refuses a missing org; the node fails typed (`ANLWF-2`, Blocker)

`WF-ANL-1` bound `orgId` on the two chains that were broken and left the node able to
report `success` with `summary.total: 0` on `orgId: ''`. `buildAnalyticsSurface` now uses
`requireString` for `orgId` on `summary` and `events`, so a missing org is a typed
`validation_error` at the surface — reached identically by the HTTP route, a chain node, and
the chat tool. The node needs no change: a throwing surface makes it fail typed, which is the
shape ADR 0645 D5 and ADR 0648 D2 both settled on.

### D3 — the experiment stamp is re-derived at ingest, never trusted (`ANLWF-3`, Blocker)

`recordEvent` accepts `experiment.{id,variant}` verbatim; `experimentResults` counts sessions
and conversions per variant from those fields and emits `significant`. The render side already
derives the variant deterministically from `(sessionKey, experimentId, salt)`. Ingest now does
the same: given `experiment.id`, it looks up the running experiment **for this org**, re-derives
`assignVariantForVisitor(experiment, sessionKey)`, and stamps **that** variant — dropping the
stamp entirely (not the event) if the experiment is unknown, not running, or not this org's.
The client's `variant` is ignored. A forged conversion can still be *counted* under the
caller's own deterministic assignment (that is the per-IP budget's problem, `ANLWF-13`); it
can no longer be placed on a variant the caller was never assigned.

> **Correction notes, 2026-09-10 (adversarial `/grade-code` on this diff, before merge):**
> - **`ANL-18` (Blocker) — D3 fixed INGEST and left the STORE.** Every pre-fix row still
>   carried the client's claimed variant and `experimentResults` read it unconditionally,
>   so last week's forgery still decided `significant` (and the promote that follows).
>   Fixed: a derived stamp carries `derived: true`; the projection counts ONLY derived
>   stamps and reports what it refused on the results shape —
>   `unattributed: { legacy, dropped }` — which the experiments panel renders as a warning
>   (`ANL-UX-29`). Client-claimed rows are quarantined, never backfilled (there is no
>   trustworthy variant to backfill them to).
> - **`ANL-21` — the resolver was fail-open on measurement.** A thrown read or a missing
>   resolver dropped legitimate stamps with no signal. Fixed: the seam returns a typed
>   outcome (`unknown | not_running | no_session | no_resolver | resolver_error`), the
>   reason rides the row (`experimentDropped`, with the experiment id ONLY when it is known
>   to this tenant+org — a fabricated id never reaches durable state), and every drop is
>   logged (`analytics_experiment_stamp_dropped`; this feature had zero log calls, `ANL-11`).
> - **`ANL-22` — `status === 'running'` deflated late conversions.** A visitor assigned
>   while running who converts after Stop got a stamped pageview and an unstamped
>   conversion, so the verdict depended on stop timing. Fixed: `stopped` is accepted
>   alongside `running` (assignment is deterministic per session; the visitor saw that
>   variant); `draft`/`promoted` never assigned this session and stay refused. The
>   `expStopped` copy ×4 was corrected in the same change (`ANL-UX-30`).
> - **`ANL-19` (Blocker, ACCEPTED RESIDUAL) — the public renderer is an assignment oracle.**
>   `vk` is client-chosen, so a caller can fetch the page under many keys, observe the
>   variant served, and beacon conversions on a key assigned to the variant they want. D3
>   raised the forgery cost from one request to two; it did not remove it. There is no
>   unforgeable assignment on an unauthenticated beacon. The control is a **per-ORG write
>   budget** (`ANL-7`, `OPENWOP_ANALYTICS_BEACON_ORG_REQS_PER_MIN`, default 600, per
>   instance like the IP limiter, 429 + `Retry-After` after the org resolved so the uniform
>   404 is untouched) plus the honesty fields above. Stated in the results panel's copy by
>   omission only — a future "verdict confidence" surface should name it.

### D4 — say what the consent gate does by default (`ANLWF-4`)

`isAllowed` returns `true` when the `consent` toggle is off, and the reference app ships
`analytics` ON and `consent` OFF. The beacon is therefore ungated out of the box while four
headers and ADR 0020 call it "consent-gated". The posture stays (it is a product decision
recorded in `feature.ts:77`); the four claims are corrected to say *"consent-gated when the
`consent` feature is enabled; permissive by default"*, and the operator-facing `FEATURES.md`
row says the same.

### D5 — the identity-link eraser is pinned and its store is classified (`ANLWF-5`, `ANLWF-6`)

`identityLinkEraser` becomes a named `async function` and is added to
`host/subjectEraserManifest.ts`, so a never-imported module reads as a missing eraser rather
than as `failed: 0`. `identityLinkService.ts` declares `['sessionKey','contactId']` as
`confidential-pii` on `analytics.identity-link` with `maskGloballyByFieldName: false`,
matching the analytics header's own reasoning for why `sessionKey` must not mask globally.

> **CORRECTION, 2026-09-10 — the `ANLWF-5` half of this decision was PREMISE-WRONG.**
> `host/subjectEraserManifest.ts` has listed `identityLinkEraser` since the consent batch
> (`32319c52e`, 2026-08), and the manifest pins by `fn.name`, which a `const identityLinkEraser
> = async () => {}` already satisfies. My `/grade-workflows` pass asserted "not pinned" from
> the arrow shape without grepping the manifest; the adversarial code review caught it. The
> arrow→declaration change is cosmetic and kept; the `declarePiiFields` half (`ANLWF-6`) is the
> real change. The false claim is corrected in place in `identityLinkService.ts`, in
> `WORKFLOWS-ASSESSMENT.md` and here rather than deleted — three documents repeated it, and
> the lesson (grep the MECHANISM, not the shape) is the same one `past-tense-claims-outlive-code`
> records.

### D6 — `exec-ops.board-update` gets the dual-leg gate and declared verbs (`ANLWF-7`, owner exec-ops)

The reject leak is closed; the shape is the outlier. `{falsy approved} → core.flow.noop` and
`"actions": ["approve","reject"]` bring it to the corpus shape (`csm-ops/pack.json:46-66`),
so a rejection completes down a named branch and *Defer* is refused rather than recorded as a
decline. Bumped in the exec-ops pack because this ADR is already editing analytics' bound
chains; recorded here rather than in a separate exec-ops ADR to keep the reasoning trail in
one place.

## Alternatives weighed

- **Bind links to `visitorHash` instead of the first session.** Rejected — the hash rotates
  daily by design (`visitorIdentity.ts`), so a legitimate returning visitor would lose their
  own link; the session key is the stable per-browser identity the beacon contract defines.
- **Expire click tokens (TTL) instead of claiming them.** Considered and worth doing as
  hygiene (`WF-ANL-7`-adjacent), but a TTL does not stop a forward within the window and
  does not stop the *first* forged claim; binding does. Not the fix.
- **Reject the beacon when the stamp cannot be re-derived.** Rejected — the event itself is
  still a real page view; dropping only the stamp keeps capture-before-effect and stops the
  verdict poisoning.
- **Fix `ANLWF-2` in the node by throwing on `''`.** Rejected — the surface is the one place
  the route, the node and the tool all traverse; that is where `WF-CONS-3` was closed.
- **Make the consent gate fail-closed when `consent` is off.** Rejected as this ADR's call —
  it is a product decision that would dark-fail every analytics tenant that never enabled
  consent; D4 makes the claim honest instead.

## Open questions

- `ANLWF-8` (declared `outputs` vs terminal primary on all four exec-ops/lighthouse chains)
  is a chain-format question — the loader picks the terminal by declaration order — and
  belongs with the RFC 0013 `outputRole` discussion, not here.
- `ANLWF-11` (`resolveReadOrgScope` skips entitlement) is cross-cutting; it needs the
  `TenantEntitlementCheck` seam adopted in `agentToolKit`, which affects every feature's tool.

## Phased plan

| Phase | Decision | Gap ids |
|---|---|---|
| P1 | D3 — re-derive the stamp (smallest fix, largest verdict) | `ANLWF-3` |
| P1 | D2 — refuse at the surface | `ANLWF-2` |
| P2 | D1 — first-click token binding | `ANLWF-1` |
| P3 | D5, D4 | `ANLWF-5`, `-6`, `-4` |
| P4 | D6 + the missing witnesses | `ANLWF-7`, `-9`, `-10` |

## Implementation record (2026-09-10, feature loop it.9, one PR)

| Phase | Landed | Witness |
|---|---|---|
| P1 D3 | `experimentStampResolver.ts` (outcome-typed, logged), `pageExperimentsService.ts` resolver + `unattributed` projection, `analyticsService.ts` `derived`/`experimentDropped` | `cms-page-experiments.test.ts` ANLWF-3 (forged variant lands on the assigned one) + ANL-18 (legacy quarantined / dropped counted / stopped still attributes); sabotage-proved: removing the re-derivation turns 3 tests red |
| P1 D2 | `surface.ts` `requireString(orgId)` | `analytics-route.test.ts` ANLWF-2 (surface + node polarity) |
| P2 D1 | `engagementService.ts` `claimClickTokenForSession` (4-attempt CAS) + erasure leg + `declarePiiFields`; `analyticsService.ts` claim call + refusal log; `resolveClickToken` deleted | `analytics-identity-link.test.ts` D1 witness (born red: `expected 'ct-owx' to be null`) + ANL-20 erasure leg |
| P3 D4 | 6 backend/doc sites + 12 user-facing strings ×4 locales (cms `expLede`, email `lede`) | copy; `FEATURES.md:176` routes column too (`ANL-25`) |
| P3 D5 | `identityLinkService.ts` `declarePiiFields` (+ the corrected comment) | `subject-erasure-feature-stores.test.ts` 26/26 |
| P4 D6 | `exec-ops/pack.json` board-update 1.1.0→1.2.0 (`config.actions`, `gate-reject` noop, falsy edge), pack 1.2.0→1.3.0 | `workflow-chain-exec-ops*.test.ts` 22/22 |
| P4 witnesses | `analytics-node-replay.test.ts` (new, 5 legs); ANLWF-9 legs (uniform-404 byte-identity, 413 props cap, limiter mount order) | green in the sequential run |
| grade-code fold | `ANL-7` org budget · `ANL-9` metric-sync skip · `ANL-12` query/fragment strip · `ANL-15` declared projection · `ANL-4` real purger witness (+ the fake fixture renamed) · `ANL-11` logger | `analytics-route.test.ts` ANL-7/-12/-15/-UX-15, `analytics-retention-purger.test.ts`, `strategy-analytics-conversions.test.ts` |

Still open from the same review (recorded in `CODEBASE-ASSESSMENT.md`): `ANL-6`/`ANL-8` (six full tenant scans + the D3 read per stamped hit — index work), `ANL-13` (commerce writes bypass the analytics toggle), `ANL-14` (salt put-then-re-read convergence), `ANL-16` (nav-counts age-out), `ANL-23` (accepted residual above).
