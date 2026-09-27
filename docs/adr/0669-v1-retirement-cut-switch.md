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
