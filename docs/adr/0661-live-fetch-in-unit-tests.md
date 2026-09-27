# ADR 0661 — a live `fetch` in a jsdom unit test is a silent defect; make it loud, on a ratchet

Status: **implemented** (verified 2026-09-17, #3761)

## Context

`emailRound2.test.tsx` mocked `emailClient.js` with a factory that spreads
`importOriginal()` and overrides eleven functions. `getProviderStatus` was not one
of them, so the **real** one ran and issued a live `fetch` out of jsdom. It
rejected, the page rendered its provider-status failure card, and a **second**
button named `common:retry` appeared beside the one the test selects with a
singular `getByRole({ name: /retry/i })`. `EmailPage` carries ten such buttons, so
that selector is unambiguous only while exactly one panel is in a failed state.

The cost was not the bug. The cost was that **the bug had no symptom**:

- in the normal vitest lane it is **load-sensitive** — green at load1 7, red at
  load1 72, green in isolation every time;
- in the `OPENWOP_CI_CLOCKSHIFT=1` date-bomb lane it is **deterministic** — 100%,
  isolated, on a quiet machine.

One cause, two exposures. It consumed roughly a day across two sessions, during
which it was attributed in turn to worker starvation, cross-session contention,
missing `cleanup()`, `isolate: false`, and test-file ordering. Every one of those
was measured competently and none was the variable. Isolation, both pairwise
orders, and the whole directory serially all came back green **because a quiet
machine loses the race in the test's favour** — the conditions chosen to get a
clean read were the conditions under which the defect is least visible.

### The measurement

`globalThis.fetch` was stubbed in the frontend vitest setup to record every real
call, and the full suite was run (755 files):

| measure | count |
|---|---|
| test files **observed** issuing a real network fetch in jsdom | **87** |
| of those, also using a singular `getByRole(/retry/i)` | **10** |

**CORRECTION, before this ADR was even merged: 87 is a LOWER BOUND, not a
census.** Arming the guard on an unchanged tree immediately surfaced an 88th
file (`src/__tests__/failedReadDecisions.test.tsx`) that had not fetched during
the measurement run. Nothing in the dashboard or approvals code changed between
the two — the call is a fire-and-forget effect that races the end of the test,
so whether it happens at all is the same non-determinism this ADR is about.

That is worth stating plainly rather than quietly bumping a number: **a single
run cannot enumerate a set whose membership is itself racy.** Expect the guard
to surface further files for a while; each is a one-line allowlist addition and
is the mechanism working, not a regression. It is also the one real cost of this
design — a contributor may meet a red caused by a file they did not touch — and
the alternative (leaving all of them silent) is how a day was lost to the first
one.

The ten: `brandRound2`, `listingsReadHonesty`, `operatorReachability`,
`secondaryReadHonesty`, `documentsP2P3`, `failedReadStates`, `strategyR3`,
`strategyR4`, `eventReadHonesty`, `runRefreshHonesty`. Same loaded gun,
currently unfired. The other 77 have no known failure mode today — which is a
statement about what has been observed, not about what is safe.

These calls go to `http://localhost:8080/...` and simply fail. Nothing is
exfiltrated and no external host is contacted. The defect is entirely about
**signal**: a component under test silently enters a failure branch that the test
did not ask for, and whether it does so before or after the assertion is a race.

## Decision

**Make an unmocked `fetch` from a jsdom unit test throw**, and gate the existing
87 behind a **shrink-only allowlist** rather than fixing or breaking them all at
once.

1. A setup file (`src/test/no-live-fetch.ts`, in `setupFiles`) replaces
   `globalThis.fetch` with one that throws a message naming the URL, the test
   file, and the likely cause (a `vi.mock` factory that spread `importOriginal()`
   and missed an export).
2. `frontend/react/test-live-fetch-allowlist.txt` lists the 88 known files permitted to
   make real calls. A file on the list keeps today's behaviour exactly.
3. A file **not** on the list that calls `fetch` fails immediately, with the
   message above. New instances cannot land.
4. The list is **shrink-only**: `scripts/check-live-fetch-allowlist.mjs` fails if
   an entry names a file that no longer exists. Burning entries down is a
   normal PR; adding one requires editing the file deliberately, in review.

### Why an allowlist and not a flag day

Turning this on unconditionally reds 87 files in one run. That is 87 diagnoses,
most of them in features nobody is currently working in, made by whoever happens
to be holding the branch — which is how a correct guard gets reverted rather than
adopted. The repo already has this pattern working in three places
(`conformance/quarantine.json`, `scripts/conformance-v2-known-red.txt`, the
`check:test-types` shrink-only ratchet), and the property that matters — **a new
instance cannot land** — is delivered on day one either way.

### Why not msw, or a global network block

An HTTP interception layer (msw) would answer these calls instead of failing
them. That is a larger change, it introduces a second mocking system beside
`vi.mock` for the same concern, and it would make the existing 87 pass *without
their authors ever learning what they were relying on*. The value here is the
diagnosis, not the silence. A process-level network block is worse still: it
fails the call without attributing it to a test.

## Consequences

- New tests that forget a mock fail **immediately and legibly**, in the file that
  caused it, instead of surfacing as a flake in an unrelated file weeks later.
- The 87 become a visible, countable, shrinking number instead of an invisible
  property of the suite.
- A test that genuinely wants a live call (there may be none; `useChatSession.integration.test.tsx`
  is the most plausible candidate) stays on the list, deliberately and in writing.
- **Residue, CLOSED 2026-09-12 by phase 2** (`scripts/check-live-fetch-stale.mjs`).
  Kept below as written because the reasoning is why the check exists, and because
  the gap bit in the interval: phase 3's first burn-down fixed three files and left
  all three lines in place, and the phase-1 ratchet reported a healthy 88.
  ~~the allowlist cannot detect a listed
  file that has *stopped* fetching~~ — a stale entry is a lie about the tree, the
  same species as the stale-quarantine-entry problem #3644 solved for the v2
  conformance ratchet. Closing it needs per-file runtime attribution aggregated
  across workers (the instrumentation used for the measurement above already does
  this). Deferred to phase 2 deliberately, because it is worth building against a
  short list, not an 87-entry one.

## Phases

| phase | content |
|---|---|
| 1 | the guard, the 88-entry allowlist, the existence ratchet, and this ADR |
| 2 | **DONE** — `scripts/check-live-fetch-stale.mjs`; the guard witnesses, the checker judges |
| 3 | burn-down — see the correction below; it is NOT a per-file march |

### CORRECTION 2026-09-12 — phase 3 as written was the wrong shape

Phase 3 said "burn down, the 10 armed files first". Starting it produced a
measurement that invalidates the plan. Grouping the census by endpoint rather
than by file:

| distinct files | endpoint |
|---|---|
| **37** | `access/effective` |
| 9 | `.well-known/openwop` |
| 6 | `reviews` |
| 4 | `operations/runs/:id/compensation` |
| 4 | `memory` |
| 4 | `commerce-connect/orders` |

**One shared, module-cached read — `getEffectiveAccess` via `client/useEffectiveAccess.ts`
— accounts for 37 of the 88 entries.** None of the four armed files that hit it
mock it, or refer to it at all; it arrives through whatever component the page
under test happens to render.

A per-file march would therefore make ~37 near-identical edits for one cause, and
each would be a local patch of a shared problem — the "copy-pasted helper drifts"
shape this repo already treats as a boundary defect. The list is not 88
independent problems; it is a handful of shared reads and a long tail.

**Revised phase 3**, in dependency order:
1. one shared test seam for `getEffectiveAccess` (~37), then `.well-known/openwop`
   (~9) — each retiring a block of entries with one reviewable decision;
2. the long tail per-file, where the cause really is local — a `vi.mock` factory
   that spread `importOriginal()` and missed an export.

**A second shape, found while fixing the first three and not described above.**
The ADR's stated cause is a factory that misses an export. `strategyR4` is not
that: its live read came from `orgs/orgMembers.ts`, a **shared cross-feature
module the test never mentions at all**, reached through a component the page
renders. The guard's message names only the factory cause, which would have sent
a reader looking in the wrong file. Both shapes are now named there.

## Alternatives considered

- **Fix all 87 now.** Rejected: 87 speculative edits to currently-green tests with
  no reproducer for 86 of them. Being right about the mechanism does not convert a
  guess into evidence, and this ADR exists because a day was lost to exactly that
  kind of confident reasoning.
- **Do nothing; fix them as they bite.** Rejected: they bite as flakes in other
  people's files, which is the most expensive possible way to learn about them.
- **Warn instead of throw for non-allowlisted files.** Rejected: a warning in a
  755-file run is indistinguishable from silence. This repo's recurring finding is
  that a check which cannot fail is worse than no check, because it is read as
  evidence.

## Implementation record

| phase | commit | evidence |
|---|---|---|
| 1 | this PR | guard + allowlist + ratchet; a deliberate non-allowlisted fetch fails, an allowlisted one passes, and both arms are pinned |

## Status correction (2026-09-17)

This record read `Status: Proposed` while its decision was already merged in **#3761**. It was on the steward staleness baseline (`backend/typescript/test/steward/adr-status-not-stale.test.ts`) as *flagged but unverified*; the status above was established by reading the code, not the commit message.

**Evidence.** Phase 1 guard `frontend/react/src/test/no-live-fetch.ts:41,69,94-109`, wired unconditionally in `frontend/react/vitest.config.ts:37-39`; phase-1 ratchet `scripts/check-live-fetch-allowlist.mjs:38,54`; phase 2 (#3774) `scripts/check-live-fetch-stale.mjs`. All three in the merge gate at `scripts/ci.sh:508,511,521`.

**Phase 3 is an open-ended burn-down, which this ADR frames as ongoing rather than as a completion criterion** — `frontend/react/test-live-fetch-allowlist.txt` is at 58 entries, from 88.
