# ADR 0919 — Pack pins live in one table and are resolved lazily, not in each feature descriptor

Status: implemented (#4971 `5877630d3`, train 152; correction #4990 `ecb85e8aa`, train 154; P2 measured 2026-10-19)

## Context

ADR 0918 measured why slow gates stay slow. Of the 23 backend Tracegate
selections wider than 800 files (2026-10-16 → 10-18), 6 were a
**descriptor-constant** change in a `features/*/feature.ts`. The clearest case
was `8e77d8c3f`, which changed only `version: '1.36.0'` → `'1.37.0'` and
selected 1,151 of ~2,640 backend files.

That is not a recorder bug. Every `createApp()` test references every
`BackendFeature` descriptor: `BACKEND_FEATURES` is a top-level array in
`features/index.ts`, and `registerBackendFeatures` passes `feature.requiredPacks`
to `registerFeaturePacks` at boot. So to Tracegate (ADR 0880) an edit anywhere
inside a descriptor literal is an edit to a constant every boot reads, and that
is correct.

**Measured, the 7 days to 2026-10-18:** 44 commits touched a
`backend/typescript/src/features/*/feature.ts`. **20 of them changed only pin
lines** (213 of the 457 changed lines were `version: '…'` pins). Each of those
20 re-ran ~1,150 backend files that could not have been affected, because
nothing at boot uses a pin's VERSION:

| Reader of the version | When |
|---|---|
| `main()` → `ensureRegistryPacksInstalled(featurePackRefs())` | entry-point boot only, never in vitest |
| `buildFeatureConsole` (`GET` feature-toggles console) → `getFeaturePacks` | request |
| `kicktodo-core/readinessService` → `buildFeatureConsole` | request |
| `marketplace/listingService` (`requiredBy` index) | request |
| the pin-parity tests | test |

> **CORRECTED 2026-10-18 (P2 measured) — the saving was NOT realized by #4971,
> and the table above is why: its first row is wrong.** It says the boot install
> set is "entry-point boot only, never in vitest". In fact
> `ensureRegistryPacksInstalled(featurePackRefs())` sits at `index.ts:506`,
> **inside `createApp()`** (lines 211–821), so every test that boots the app
> resolved every pin.
>
> **Measured** on `main` `5877630d3` (#4971 merged), with a local, never-pushed
> commit bumping only `feature.kicktodo.nodes` in `packPins.ts`, then
> `tracegate.mjs select --lane backend` against train 152's 1,567 footprints at
> `dff75d50f`: **1,255 must run** (1,175 "constant in packPins.ts", 67 "read
> input", 13 "no footprint"). The baseline was 1,151. 1,165 of the 1,567
> footprints executed `featureRequiredPacks` and `pinnedPackRef`, for example
> `run-acting-user.test.ts`.
>
> **The fix:** the installer already tested presence by NAME before reading a
> version (`missingFeaturePacks`). So `createApp()` now passes
> `{ names: featurePackNames(), resolve: pinnedPackRef }`, and a pin is resolved
> only for a pack absent on disk. The witnesses:
> - `test/pack-pins-boot.test.ts`: a boot with its packs present resolves 0 pins
>   (the `pinResolutionCount` seam);
> - `registry-install-boot.test.ts`: by name, a present pack's pin is never read.
>
> A consequence for D2's "fail closed": a missing pin on a PRESENT pack is no
> longer a boot error. `required-packs-pin-parity.test.ts`, which resolves every
> feature's pins, is where it fails. P2 is re-measured after this lands, against
> that gate's footprints.

## Decision

### D1 — Descriptors declare pack NAMES

`BackendFeature.requiredPacks?: readonly string[]`, e.g.
`requiredPacks: ['feature.kicktodo.nodes', 'vendor.openwop-app.kicktodo.agents']`.
Adding or removing a required pack still edits the descriptor, and re-runs every
boot, correctly, because that changes what boots.

### D2 — One pins table, `features/packPins.ts`

`PACK_PINS` is a plain `as const` object literal, pack name → version, sorted:
119 entries, moved verbatim. `pinnedPackRef(name)` and
`featureRequiredPacks(feature)` resolve against it. It must stay a pure literal
(no call, no spread): that is what makes it a CONSTANT to Tracegate, re-run only
by tests whose executed code names it, rather than a module-load statement
re-run by everything that loads it.

- **One version per pack name.** The migration found no pack pinned at two
  versions, and `pack-pin-parity.test.ts` already failed on a split pin.
- **Central, not per feature.** A per-feature pins module would have to be
  imported by an aggregator. That aggregator would statically import every
  feature, which defeats the ADR 0366 distribution tree-shake, the only
  mechanism that drops an excluded feature's code. A table of strings imports
  nothing. An excluded feature leaves its pin line behind as an inert string,
  and the boot install set (`featurePackRefs`) resolves only the names that
  composed features declare.
- **Fail closed.** A required name with no pin throws `pack_pin_missing`.
  `main()` resolves every pin at boot, so the error is a loud boot failure, and
  `required-packs-pin-parity.test.ts` catches it before that.

### D3 — The registry takes a thunk

`registerFeaturePacks(id, refs | () => refs)` still accepts plain refs, which the
kicktodo readiness test uses. Boot passes `() => featureRequiredPacks(feature)`,
and `getFeaturePacks` resolves it on each call. So registration names a function
and never reads a pin. The registry stays in `host/` and still imports no
feature module.

## Alternatives considered

- **Make Tracegate property-level** (track which descriptor properties a test
  reads). Rejected: `registerBackendFeatures` reads `requiredPacks` whole for
  every feature, so it would select the same ~1,150 files (ADR 0918, measured).
  The version has to stop being read at boot, which is a code change.
- **Keep the pins in `feature.ts`, but as a separate constant beside the
  descriptor.** Rejected: the descriptor must still reach them. The constant
  rule pulls in what a referenced constant's initializer names, and a call
  inside the literal makes it a `<top>` statement, so either way every boot
  references the pins again.
- **A JSON pins file.** Rejected: Tracegate records a statically imported JSON
  file as a read input of every importer, which puts it back on every boot. A
  `readFileSync` at use time would work, but it adds I/O and an error path for
  no gain over a typed literal.

## Consequences

- **A pin bump is now a one-line edit to `features/packPins.ts`, plus the
  pack's `pack.json`.** The parity tests fail until both agree, as before:
  `required-packs-pin-parity`, the per-feature ones, and `pack-pin-parity`,
  which now scans the table too, keeping its population floor.
- **Expected:** a pin-only change selects the tests that resolve a pin, which is
  the console, readiness, marketplace and parity tests. That is not every
  `createApp()` test. **Not yet measured:** the footprints that would show it do
  not exist until a gate records them for this tree. Today's ledger has no test
  that loads `packPins.ts`, so a simulation now would select almost nothing and
  prove nothing.
- Commits that change a pin AND other descriptor fields still re-run every
  boot. The gain is the pin-only class: 20 commits in a week.

## Rebasing a branch that edits `requiredPacks` (open PRs on 2026-10-18)

A branch cut before this ADR that adds or bumps a pin conflicts in that
`feature.ts`. Measured on 2026-10-18, nine open PRs gain a `feature.ts`
conflict from this one:

| Descriptor | PRs |
|---|---|
| `email/feature.ts` | #4929, #4932, #4933, #4942 |
| `campaign-connectors/feature.ts` | #4935, #4936, #4937, #4938 |
| `kb/feature.ts` | #4940 |

#4940 is the only one of them that merges cleanly with `main` today; the
others already conflict with it elsewhere. #4928, #4920 and #4939 gain no
`feature.ts` conflict. To resolve:

1. In `feature.ts`, keep `main`'s names-only form, and add the pack's name if
   your branch added a pack: `requiredPacks: ['feature.email.nodes', …]`.
2. Put your branch's version for each pack you added or bumped in
   `backend/typescript/src/features/packPins.ts`. That is one line per pack,
   kept in sorted order.
3. Run `test/required-packs-pin-parity.test.ts`, `test/pack-pin-parity.test.ts`
   and `test/pack-pins-lazy.test.ts`. They fail on a missed pin, on a version
   left in a descriptor, and on a pin that disagrees with `pack.json`.

## Implementation

| Phase | Change | Witness |
|---|---|---|
| P1 | D1–D3; 77 `feature.ts` rewritten mechanically (129 entries → names); `packPins.ts`; `types.ts`, `registry.ts`, `features/index.ts`, `marketplace/{routes,listingService}.ts`; 12 tests read pins via `featureRequiredPacks`; 10 tests that grepped `feature.ts` text for `{ name, version }` now check the name in the descriptor and the version via `pinnedPackRef`; `pack-pin-parity` scans the table | backend `tsc --noEmit` clean; targeted run 2026-10-18 20:00Z: 61 files, 1 red (a text scan this change broke), which found the 10-test class; after the fix 9/9 + 1/1. Sabotage: cms pin 1.6.0 → 1.6.999 reds `cms-node-replay-classification` |
| P2 | After the merging gate records footprints for this tree: simulate a pin-only bump against the ledger (`tracegate.mjs select`, no run) and record must-run / total | 1,255 after #4971 (not realized); **114** after #4990 (2026-10-19) |

## Open questions

- [x] P2 measurement. **First reading 2026-10-18: NOT realized** (1,255 must run;
  the cause and fix are in the correction under Context). **Re-measured
  2026-10-19 after #4990** on `main` `3566445be`. The probe was the same as
  before: a local, never-pushed commit bumping only `feature.kicktodo.nodes`,
  then `tracegate.mjs select --lane backend` (selection only) against train
  154's full-lane footprints (2,639 at `f5a506ef9`). **114 of 2,651 must
  run**:
  - 68 are "read input" (the tests that read `packPins.ts` as a file: the
    parity and source scanners);
  - 34 are "constant in packPins.ts" (the tests that resolve a pin);
  - 12 have no footprint.

  Against **1,151** before ADR 0919 and **1,255** after #4971 alone, that is
  about a 90% cut for a pin-only bump. In the 7 days to 2026-10-18 that class
  was 20 of 44 `feature.ts` commits.
- [ ] Node `bindings` in toggle variants also carry versions (`crm/feature.ts`,
  2 entries). They are node refs, not pack pins, and rarely move, so they are
  out of scope.
