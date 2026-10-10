# ADR 0669 — v1 retirement is one flag, and it is rehearsed before it is needed

Status: Accepted (implemented; see § Implementation record)

## Context

The operator directive is "deprecate v1 immediately and move fully to v2."
Deprecation shipped (ADR 0654): every `/v1` response and the v1 discovery
document carry RFC 9745 `Deprecation`, and production serves it today.

Retirement cannot follow immediately, and not for want of readiness.
`versioning.md` §1.1 binds `preferredVersion` to a 1.x member for as long as
`protocolVersions[]` carries one, and §5 makes retirement **atomic**: dropping
`1.x`, moving `preferredVersion` to `2.0`, and withdrawing the `/v1` path space
are one act, at the corpus EOS clock (leg (a) `notBefore` **2026-12-04**). The
steward's ruling (crosstalk `4ad9`) is the same: deprecation now, `Sunset` only
against a held date, **no early drop ever**.

`scripts/check-v1-reliance.mjs` states the same thing from inside the repo, and
its note is the sharpest version of it: *"zero is not the target today …
removing v1 before the EOS overlap ends would be non-conformant. This ratchets,
it does not cut."*

So the question this ADR answers is not *when*. It is: **when the day comes,
is retirement a flag flip or a migration?** Before this change it was a
migration — and worse, an unrehearsed one. Three constants would have had to be
edited by hand, under time pressure, with the overlap already gone, and nothing
in the repo had ever executed the resulting configuration.

## Decision

**One predicate, three derived values, and a rehearsal that runs in CI.**

`v1Retired()` reads `OPENWOP_V1_RETIRED` and everything else derives from it:

| | pre-cut | post-cut |
| --- | --- | --- |
| `protocolVersions()` | `['1.1','2.0']` | `['2.0']` |
| `preferredVersion()` | `1.1` | `2.0` |
| `minClientVersion()` | `1.0` | `2.0` |
| inbound `/v1/…` | served | **410 Gone** |
| header-less default major | 1 | 2 (§1.3 follows `preferredVersion`) |
| `Deprecation` header | emitted | withheld |

They are **derived, not set**, because the failure mode of retirement is doing
part of it. A host listing `1.1` while preferring `2.0` violates §1.1; one
withdrawing `/v1` while listing `1.1` advertises a contract it refuses to
serve. Deriving them from a single predicate means there is no half to flip.

Three details that are load-bearing rather than incidental:

1. **The flag is read at CALL time, never captured at import.** The rehearsal
   boots the host both ways inside one process; a module-level snapshot would
   let the second boot silently inherit the first, and the test would pass while
   measuring one app twice.
2. **The `/v1` refusal is checked against the INBOUND path, before any rewrite.**
   This host serves major 2 by rewriting `req.url = /v1${req.url}` onto the v1
   handlers — an implementation detail, not a wire claim. Refusing after the
   rewrite would refuse every major-2 request. The rehearsal pins this pair
   directly: the vendor twin `/v1/host/<org>/…` must 410 while the canonical
   `/host/<org>/…` keeps working, and it is the canonical form that rewrites
   onto the twin internally.
3. **`410 Gone`, not `404`.** The resource existed, its withdrawal is permanent
   and dated, and a client holding a cached `/v1` URL should stop rather than
   retry. The body names the surviving address.

**This flag is not a tuning knob.** Setting it before the EOS clock is a
conformance violation, not a configuration choice.

## The rehearsal, and what sabotage found in it

`test/adr0669-v1-retirement-rehearsal.test.ts` boots pre-cut and retired hosts
in one process and pairs every retired-side assertion with its pre-cut control —
an assertion that passes in both states measures nothing.

Four sabotages, run against the mechanism rather than a call site:

| sabotage | caught |
| --- | --- |
| `preferredVersion()` ignores the flag (breaks atomicity) | **yes** — 2 tests |
| remove the inbound 410 | **yes** — 2 tests |
| refuse `/v1` *after* the rewrite (kills the canonical vendor root) | **yes** — 1 test |
| keep emitting `Deprecation` post-cut | **NO — passed** |

**The fourth is the finding.** The assertion fetched `/.well-known/openwop`
with `OpenWOP-Version: 2` and checked for no `Deprecation` header. It passed
with the guard deleted, because on that path the header was never going to be
set: the middleware sets it only for a versioned path or `major === 1`, and
post-cut neither can occur. The assertion was **true for a reason unrelated to
the code it claimed to test** — vacuous in exactly the way a green result hides.

The guard is not dead, though: `v1DeprecationHeaders()` is exported and called
directly elsewhere. So the invariant moved to where it is reachable — a unit
assertion around the function, plus an HTTP assertion that the **410 itself**
carries no `Deprecation`, which is reachable because that exact path *does*
carry one pre-cut. Both redden under the sabotage that previously passed.

The transferable half: **three green sabotages do not make the fourth green one
safe to assume.** Each sabotage proves one assertion, and the one that survives
is the one worth reading.

## Consequences

Retirement day becomes `--update-env-vars OPENWOP_V1_RETIRED=true` against a
configuration CI has already executed, rather than an edit. The remaining work
before the clock is unchanged and is listed in the readiness report: the eleven
packs, three undeclared families, two ledgered reader gaps, the SPA's 591
references to the versioned twin, and moving deploy-day certify onto major 2.

ADR 0646's content negotiation is what makes the flip survivable at all — it
exists because retirement changes the header-less default, which would
otherwise turn three shared-name SPA pages into JSON on cutover day. The
rehearsal asserts that directly rather than trusting the reasoning.

## Implementation record

| phase | what | where |
| --- | --- | --- |
| 1 | `v1Retired()` + three derived accessors | `middleware/protocolVersion.ts` |
| 2 | inbound `/v1` → 410, default major follows `preferredVersion()` | same |
| 3 | `Deprecation` withheld post-cut | same |
| 4 | consumers moved off the constants | `routes/discovery.ts` |
| 5 | rehearsal + 4 sabotages | `test/adr0669-v1-retirement-rehearsal.test.ts` |

## Addendum (2026-09-30): what the rehearsal could not see

The rehearsal proved the flag flips. It never exercised the host's calls **to
itself**, or the addresses it **hands out**, and both would have broken on the
day:

- **Self-calls.** The sub-run dispatcher and the messaging bridge reached this
  host at `${baseUrl}/v1/runs…`. Every sub-workflow and every messaging-started
  run would have failed with a 410. Both now use unversioned paths plus
  `selfCallHeaders()`, which is derived from `protocolVersions()` and names the
  newest major, so the next major is a no-op for self-callers.
- **Advertised addresses.** `advertisedPath()` / `runLinks()` own every address
  a response hands out: the OpenAPI keys, example-data-summary links, workflow
  author and creative-brief run links, MCP `serverUrls`, the A2A card URL and
  the partner-portal link. Host extensions are always unversioned. A protocol
  path is spelled `/v1` only in a pre-cut major-1 response, and an operation with
  no v2 address is omitted after the cut rather than advertised dead.
- **Measurement.** `deprecated_major_request` logs every request served under a
  deprecated major, with route family and caller class and nothing identifying.
  It shows who still depends on v1 before the cut, not as 410s after it.
- **Ratchet.** `backendVersionedOwnUrls` in `check-v1-reliance.mjs` counts URLs
  this host builds to its own paths through `/v<N>/`. It is version-neutral, and
  its "own paths" are derived from the v2 path manifest.

Rehearsed in `test/adr0669-self-calls-survive-cut.test.ts`, with every leg
paired with its pre-cut control and sabotage-proven.

> **CORRECTED 2026-10-03 (ADR 0806).** The list below under-counted the class.
> Every unauthenticated vendor address (public pages, feeds, shared cards, form
> and booking pages, email links, the widget's `embed.js`, and the provider
> webhooks) answered `410` on the day. ADR 0806 generalises the asset forward
> below to READS of all of them and keeps writes `410`, with an operator
> re-point step for webhooks. Status of the three items: OAuth callbacks are
> handled by ADR 0806 (`redirect_uri` moves with the cut). Federation now reads
> canonical-first (`test/adr0669-federation-canonical-first.test.ts`). The
> `runs.ts` run links were never a hazard: the major-2 projector and the
> closed v2 snapshot own their spelling, pinned by
> `test/adr0669-run-links-survive-cut.test.ts`.

**Still open before the cut** (tracked in the re-root plan):
- ~~persisted asset URLs (`/v1/host/openwop-app/assets/…` in drawings, slides,
  CAD and signing certificates), which need a data migration;~~ **closed
  2026-10-01 without a migration** — see "Stored asset addresses" below;
- OAuth callback URIs, which need an operator step at each provider first;
- `runs.ts` run links (the runs family PR);
- federation to peers (ADR 0656 class 5), canonical first with a `/v1`
  fallback.

### Stored asset addresses (decided 2026-10-01): redirect, do not rewrite

> **CORRECTION to the bullet above.** It said persisted asset URLs "need a data
> migration". A migration was built (a raw-text compare-and-swap rewrite of
> every `hostext:` row) and **not shipped**, because it breaks rows that sit
> under an integrity hash. MEASURED: an audit-chain entry whose payload carried
> a `/v1` asset URL verified before the job ran and reported
> `{ ok: false, brokenAt: 1 }` after. E-sign content hashes, assistant action
> approvals and the compensation-recovery chain have the same shape. A sweep
> that "covers every collection, including future ones" also covers every
> future hashed one.

**Decision.** Stored content is left alone. After the cut,
`GET`/`HEAD /v<N>/host/openwop-app/assets/<token>` answers `308` to the
unversioned address instead of `410` (`retiredAssetServePath`, at the one 410
site in `middleware/protocolVersion.ts`). It is the only `/v1` address that
survives.

> *Superseded in scope by ADR 0806 (2026-10-03): every READ of an unauthenticated vendor address now forwards the same way; writes and authenticated addresses still answer `410`.*

**Why this and not the alternatives.**
- *An allowlist of collections to rewrite* is safe for hashed rows but fails
  silently: a collection left off the list breaks on the day.
- *A generic sweep with an opt-out for hashed collections* fails the other way:
  the first hashed store that forgets to opt out is corrupted.
- A redirect also reaches copies no rewrite can: run event logs (append-only),
  sent emails, exported files, anything pasted elsewhere.

**Why it does not weaken the cut.** The asset address is a host-extension path,
not a major-1 protocol operation. Only reads redirect; the token shape admits
nothing but an asset address; writes, longer paths, the rest of the vendor
space and every protocol path still answer `410`.

**With it.** New assets are minted unversioned (#4289), so the old form stops
growing. The SPA canonicalises any versioned asset URL where it renders or
fetches one (`client/assetServePath.ts`), which saves the redirect hop. The
Illustrator agent's prompt names the unversioned address too (drawings agent
pack 1.0.3), pinned to `ASSET_SERVE_PATH` by the drawings prompt-parity test, so
the model is no longer taught an address the host only honours by redirect.

**Tests.** `adr0669-v1-retirement-rehearsal.test.ts`: pre-cut control (served
directly), retired (308, query kept, bytes served on follow), and that nothing
else rides the exception. Sabotage: disabling the exception fails the retired
leg. `asset-serve-path.test.ts` pins that the exception's pattern agrees with
`host/assetServePath.ts`.

## Addendum (2026-10-03): the rehearsal on production infrastructure

The procedure is now `docs/runbooks/V1-RETIREMENT-CUT.md`. A 0%-traffic revision with the flag on, certified at major 2, found four host defects the in-process rehearsal could not. The in-process rehearsal exercised the flag's own legs, not the corpus scenarios a retired host meets:
1. `protocolVersion` is `preferredVersion`'s twin and was the v1 constant;
2. the 406 check hard-coded the served majors;
3. a bare run id was admitted after the overlap;
4. a double-projected id answered 404, not 400.

All four are fixed and pinned by `test/adr0669-cut-rehearsal-findings.test.ts`. A fifth (`v2-advertised-path-space-served`) was a scenario defect, fixed in suite 2.45.12.

**The lesson:** a cut switch is rehearsed against the SUITE, not only against its own tests. The flag's tests proved the flag flips. Only the corpus proved what a retired host must then answer.

