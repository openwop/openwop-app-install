# 0634 — Mount the RFC 0168 §C.1 conformance seams at their v2 addresses, and derive the advert from the mount

Status: Accepted

## Context

`api/seams-v2.yaml` declares **13 conformance-seam operations** under
`/conformance/seams/…`. They are the addresses a major-2 conformance suite drives
to set up the states it cannot reach through the product wire: seed an era-2 event
log, fire an effect, force a transport retry, receive a webhook.

Two things were true before this change, and the second is the reason the first
was invisible:

1. **Nine of the thirteen already existed here** — under their *v1* addresses
   (`/v1/host/sample/…`, `/v1/host/workspace/files…`, `/v1/packs-test/…`). The
   suite's `lib/seams.ts` maps three v1 prefixes onto the v2 space, so the shapes
   matched; only the addresses did not.
2. **My first count of them was zero.** I grepped for quoted route literals, and
   `routes/packs-test.ts` registers its four tarball operations as *regex* routes
   (`app.get(/\.tgz$/)` and friends). A literal-string probe cannot see a regex
   route, so it reported "not implemented" for code sitting in the tree. The probe
   ran, printed a clean answer, and the answer was an artifact of the probe — the
   same shape as an empty `gcloud builds list` reading as "nobody else built".
   Both peers on the bus had made a version of this error; one had posted 11
   missing, the truth was 9.

The advert was gated on `process.env.OPENWOP_V2_SEAMS_MOUNTED === 'true'` — a
promise a human keeps, made in a different file from the thing it describes.

## Decision

**Three parts, and the third is the load-bearing one.**

1. **Alias, do not re-implement.** `routes/conformanceSeams.ts` rewrites three v2
   prefixes onto the v1 handlers that already serve them. Nine operations become
   reachable at their v2 addresses without a second copy of any handler — the
   thing that would have drifted.

2. **Mount before the routers, not inside the route table.** Express matches in
   registration order, so an alias registered where routes are registered runs
   *after* the routers it feeds. Measured: all nine served operations answered
   404. It is now mounted in `index.ts` beside the protocol negotiator, ahead of
   everything.

3. **Derive the advert from the mount.** `seamsMounted()` returns
   `seamsFloorServed()` — computed from the operation manifest, true only when
   every floor operation is actually served. Today four are not
   (`seedEra2EventLog`, `fireEffectSeam`, `forceEffectTransportRetry`,
   `receiveWebhookDelivery`), so **the advert stays off**, and the env var can no
   longer turn it on. A test asserts exactly that.

This is the same move as RFC 0146's `contractProvenance`: make the claim
structurally true rather than agreed to. It also matches the corpus ruling posted
on the bus the same day — RFC 0148 §B, that advertising in order to un-skip a
floor scenario is never legitimate. An advert is earned by the surface being real.
A `conformance.seamsProfile` on a 9/13 mount would be exactly the move the rule
forbids.

## The origin half, which cannot be deferred

`spec/v2/path-manifest.json` says in its own `$comment` that it is generated with
"no seam or test-mode operation". So the seam space is **outside** the v2 path
space the ADR 0631 hosting rewrites are derived from. Mounting on the backend
alone would leave `/conformance/**` answering the SPA shell at the front door —
the precise ADR 0631 shape, one path space over. The Firebase rewrite therefore
lands with the mount.

The ADR 0614 guard pins `/conformance/**` as a **literal**, because no file that
script can read supplies these addresses (this host vendors no `api/seams-v2.yaml`).
One literal is only sufficient while every seam lives under that prefix, so the
derivation moves to where the data is: a test asserts every `SEAM_OPERATIONS[].v2Path`
sits under `SEAMS_PREFIX`. Add a seam at another root and that test goes red,
rather than the guard passing while the new address serves text/html.

## Testing note — why the obvious probe was rewritten

The mount check started as "the v2 address does not answer 404". That is not a
witness: 404 is ambiguous between *no route* and *no resource*, and every seam
read for a resource that does not exist answers 404 whether or not the alias is
mounted. It was replaced with an **equivalence** probe — the v2 address must
answer identically to its v1 twin, since the alias is a rewrite onto that very
handler — plus one liveness leg on an operation whose v1 twin returns a real 200.

Stated honestly: removing the mount reddens **3 of the 9** equivalence rows; the
other six answer 404 at both addresses with and without it. The liveness leg is
what makes the mount falsifiable. An all-404 equivalence would otherwise read as
a pass, which is the failure mode this repo keeps finding.

## What this does not do

It does not make the seams floor witnessable. Four floor operations are still
absent, and `receiveWebhookDelivery` is a deliberate omission rather than a to-do:
this host is a webhook **sender**, and mounting a receiver here would witness
nothing real about it.

## Verification

| Claim | Sabotage | Result |
|---|---|---|
| The alias is what makes v2 addresses answer | remove `registerConformanceSeamAlias` | 3 red |
| Registration order is behaviour, not style | move it after the routers | same 3 red |
| The advert cannot outrun the mount | mark a floor seam served in the manifest | 1 red |
| The hosting rewrite is required | delete `/conformance/**` | guard exits 1 |
| Rewrite order is behaviour | move it after the SPA catch-all | guard exits 1 |

## What the four missing seams actually gate (measured after the fact)

Reading `schemas/v2/capabilities.schema.json` rather than reasoning about the
family names, the remaining v2 work is smaller than it looks, because the items
are not independent:

| family | required beyond `status`/`since`/`witness` | blocked here by |
|---|---|---|
| `replay` | `modes`, `effectSeamsManifest` | **no effect-seams manifest is served** |
| `interrupt` | `tokenAlgs` (items enum: `hs256` only) | this host mints opaque store-backed interrupt tokens |
| `idempotency` | — | nothing structural |
| `eventLog` | — | nothing structural |

`replay.effectSeamsManifest` is the **same surface** as the missing
`fireEffectSeam` seam. So the effect-seam work unlocks three things at once: that
seam, `forceEffectTransportRetry` (which needs a manifest row to name), and the
`replay` advert — which in turn makes the corpus's `v2-run-fork-prefix` leg
applicable here instead of `inapplicable`. That leg targets the exclusive-cursor
boundary ADR 0633 had just fixed in three places, one of them production code, so
the family being unadvertised is what kept a real defect outside the reach of any
external check.

Recorded here because the ordering is invisible from a flat list of "four seams
plus four adverts", and because I argued the opposite on the record first: I
claimed `replay` was merely under-advertised and could simply be turned on. The
rule was right and the example was wrong, and only measuring the schema separated
them. A closed root with `additionalProperties: false` does not protect against
this — it would have accepted a record whose required facet was false.

## Correction — 2026-09-24 (WS0): a declared-but-unserved seam must 404, not alias

The `sample/` prefix rule rewrote EVERY `/conformance/seams/sample/…` address onto
its v1 twin, including operations this host never built. `emitA2uiSurface`
(RFC 0209) landed on the RFC 0114 `/v1/host/openwop-app/a2ui/emit-surface`
handler, which answered 400 to the v2 `{runId, envelope}` body — and
`v2-a2ui-v09-surface` reads any non-404/405 as "seam wired", so it would record
fails instead of `inapplicable`. `SEAM_OPERATIONS` also omitted three of the
pinned yaml's sixteen operations. Now: the manifest lists every operation (parity
test against `@openwop/spec-artifacts/api/seams-v2.yaml`), the three unbuilt ones
are `served: false`, and the alias answers the canonical 404 for a
`served: false` method+path instead of rewriting. WS5 flips `emitA2uiSurface`
when the real seam lands.
