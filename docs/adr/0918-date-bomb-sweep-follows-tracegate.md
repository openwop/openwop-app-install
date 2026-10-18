# ADR 0918 — The frontend lane enters Tracegate early, and the date-bomb sweep follows its selection

Status: Accepted (user decision 2026-10-18) — implementation in this PR

## Context

The user asked why the gate had not sped up after Tracegate (ADR 0880). From
the step offsets of the full gates in trains 129–144 on 2026-10-18:

| Gate kind | Total | Backend vitest | Seen in |
|---|---|---|---|
| Fast (backend verdicts reused) | 18–20 min | ~5 min | 135, 139 (later sub-gates), 136 sub-gates |
| Slow | 35–49 min | 21–29 min | 130, 136, 139 (first), 141, 144 |

The frontend half is the same in both rows, because it never shortens:

- **frontend vitest, 5–8 min.** The lane is in `shadow`: day 5.4 of the 14-day
  bar, with 102 observations and 0 misses. Its shadow lines read 97–100%
  reusable on most gates: 1030/1056 at 144, 1054/1055 at 141, 1053/1055 at 139,
  1021/1040 at 130.
- **the date-bomb sweep, 3.5–6 min.** A second, whole frontend run with the
  clock shifted 365 days. ADR 0880 kept it whole.

Together that is about 9–14 min a gate that does not depend on the diff. (The
slow backend half has its own cause, which is not this ADR's: see Open questions.)

## Decision

### D1 — The frontend lane enters early, on the backend's terms

`LANE_ENTRY.frontend = { days: 1, earlyAudit: 0.2 }` (`scripts/tracegate.mjs`).
That is the same rule the user set for the backend on 2026-10-13: ≥ 20 clean
observations over ≥ 1 day, no miss in the last 14 days, and a **20%** audit
until the default 14-day bar would have been met. A miss still suspends the
lane for 14 days, and the gate still runs it FULL once its last complete full
run is > 24 h old (ADR 0880 D5 correction).

The record it rests on: 102 observations over 5.4 days, 0 misses. It also has
per-KEY i18n tracking (2026-10-14), which removed the frontend's widest false
selections.

### D2 — The date-bomb sweep runs the frontend lane's selection

Under `enforce`, the sweep shifts the clock for the files Tracegate selected
for the frontend lane (must-run + audit), not all ~1,055. If the selection is
empty, it says so and shifts nothing. In `shadow` (including the daily FULL
lane) and `off` it runs whole, exactly as before. The isolation re-check of a
red, the fail-closed rules and the non-vacuity floor are unchanged.

**ADR 0880 rejected this ("selection must not narrow it: that scope-miss is
what it exists to catch"), so here is the case it has to answer.** A footprint
does not see the clock. So the class a narrowed sweep can miss is a bomb in an
**unchanged** file, which enters the sweep's 365-day window on some day D.

- **Under the old rule**, the first gate after D reds. That gate's PRs did not
  arm the bomb.
- **Under this rule**, the first gate after D that runs the frontend lane FULL
  reds, and one does within 24 h. That gate's PRs did not arm it either.

So the difference is **at most 24 hours** of detection delay, against a bomb
that is still ~364 days from going off. The attribution is the same either way:
unrelated. A bomb that a PR **arms** is a change a footprint sees: a new or
edited test file, code a test executes, or a constant it reads. So it is in the
selection and reds that PR's own gate, as before.

### D3 — `full-done` for the frontend means the whole sweep passed too

A frontend `full-done` now licenses 24 h of narrowed sweeps, so it must not be
recorded on a run that skipped or failed the whole sweep.

- **`ci.sh`** used to write it right after the live-fetch stale check, before
  the sweep. It now writes it after the sweep passes. Under `set -e` a red sweep
  exits first, so a red full gate records nothing and the next gate runs FULL
  again.
- **`tracegate-daemon.sh`'s nightly** runs no sweep, so it no longer records
  `full-done` for the frontend. That nightly has rarely completed (ADR 0880 D5
  correction), so the gate's own daily FULL lane was already the backstop in
  practice.

## Alternatives considered

- **Run the sweep nightly only.** Rejected: a PR that arms a bomb would merge
  green and red the next morning's run, implicating nobody. D2 keeps a newly
  armed bomb on the gate that arms it.
- **Run the sweep only when date-touching code changes (a grep for `Date`,
  timers, `setSystemTime`).** Rejected: that is a ratchet on a spelling, and a
  date bomb does not have to spell `Date`. A fixture string compared against an
  injected clock is enough.
  Tracegate's footprints are the measured version of the same idea.
- **Keep the frontend on the 14-day bar.** That would cost ~5–8 min a gate for
  another 8.6 days, to collect evidence the lane already shows (0 misses in 102).
  The backend made the same trade on 2026-10-13 and has had 0 real misses since
  (one triaged flake, `voice-approval-oneshot`, at train 139).

## Consequences

- **Expected saving, not yet measured:** on a gate whose frontend selection is
  ~1–3% (the usual shadow reading), frontend vitest goes from 5–8 min to well
  under a minute, plus the 20% audit. The sweep shrinks by the same factor. The
  20% audit is about 200 files, so the honest early figure is roughly a 60–70%
  cut in the frontend half, not 97%. That still saves ~6–9 min a gate. The FULL
  day still pays the whole cost, once.
- The live-fetch STALE check is now skipped on most frontend gates, as it
  already is under enforce. It runs in the daily FULL lane (ADR 0880 D5).
- A frontend miss suspends the lane for 14 days, and the sweep goes back to
  whole with it, automatically.

## Implementation

| Phase | Change | Witness |
|---|---|---|
| P1 | D1 `LANE_ENTRY.frontend`; D2 sweep selection in `ci.sh`; D3 `full-done` order + daemon | `scripts/test-tracegate.mjs` (the old pin "frontend does NOT enter early" went red on the change; it now asserts early entry at 20% and the 1-day floor) |
| P2 | Measure: frontend vitest + sweep minutes on the first 5 enforce gates vs the shadow gates above | gate logs |

## Open questions

- [ ] P2 measurement (above).
- [ ] **The slow backend half, ADR TBD.** On the slow gates, 1,000–1,260 of
  2,640 backend files ran because the diff touched code every `createApp()` test
  evaluates at boot: 144 `features/index.ts` (1,043); 136 `bootstrap/nodes.ts`
  (1,193); 139 kicktodo `circleService.ts` top-level (1,262); 130
  `agent-author/feature.ts` constant (921). Footprints record those as
  module-load or whole-constant dependencies. Finer-grained boot footprints
  would attack the larger cost, but it is recorder work with its own soundness
  argument, so it gets its own ADR.

  **Measured for that ADR (the reasons logs, 2026-10-16 13:42Z → 10-18 15:08Z).**
  There were 23 backend selections wider than 800 files. By top reason:

  | Class | Count | What changed | Narrowable? |
  |---|---|---|---|
  | lockfile | 3 | `package-lock.json` | no (global input, correct) |
  | top-level statement | 8 | 6 in kicktodo `circleService.ts`, 2 in `entitlementService.ts` | rarely: e.g. `1d3d2110f` added a module-load `registerKvAgeOut({...})`, a real global registration |
  | descriptor constant | 6 | a `features/*/feature.ts` `BackendFeature` literal: kicktodo-accountability ×3, computer-use, agent-author, kicktodo-core | **likely**: `8e77d8c3f` changed only a pack pin, `version: '1.36.0'` → `'1.37.0'`, and selected 1,151 files |
  | executed hub function | 6 | `routes/agents.ts` ×2, `podcasts/publicRoutes.ts`, `task-deck/agentTools.ts`, `bootstrap/nodes.ts`, `features/index.ts` | no (every `createApp()` test runs it, correct) |

  So the lever is the descriptor class. Every `createApp()` test references
  each feature's descriptor whole, so a pack-pin bump re-runs ~1,150 files.
  Property-level tracking, or moving pack pins out of the descriptor into data
  only the pack loader reads, would narrow it only if most tests do not read
  `packs[].version` at boot. Measure that first.

  **Measured statically, 2026-10-18: they do read it.** The field is
  `requiredPacks`. `features/index.ts:359` passes it whole to
  `registerFeaturePacks(feature.id, feature.requiredPacks ?? [])` inside the
  registration loop every `createApp()` runs. So property-level tracking alone
  would select the same ~1,150 files. What would narrow it is a refactor: the
  registry keeps pack NAMES at boot, and the pinned VERSION is resolved lazily,
  from data only the pack-mount and install paths read. Then a pin bump re-runs
  only the tests that mount or install that pack. Whether that is worth it
  depends on how often pins move: 5 bumps of the kicktodo pin in the 3 days to
  2026-10-18.
