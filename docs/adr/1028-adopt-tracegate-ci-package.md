# ADR 1028 — Adopt the tracegate-ci package and retire the fork's predictor

Status: Accepted (2026-11-03); **P0 implemented** (see § Implementation record). P1–P4 are
still open. Written at the user's request ("proceed through all steps").
Nothing here changes the gate. Each phase below changes what the gate runs, so each needs
the user's go before it is built, as in ADR 0980 D3.

## Context

Tracegate (ADR 0880) began here as `scripts/tracegate.mjs` (about 1,200 lines) and
`scripts/lib/tracegate-recorder.mjs`. Its core was extracted into tracegate-ci, which is
now on npm. This repository runs:
- its own predictor, recorder and per-key i18n tracker;
- vendored byte copies of the package's v0.5.0 broker and Red Reader (ADR 0974,
  ADR 0980 P1).

ADR 0980 P4 named the reason the fork stays: the package could not express four
features this repository depends on. tracegate-ci 0.10.0 adds them.

| Fork feature | Where it lives here | tracegate-ci 0.10.0 |
|---|---|---|
| Lane entry: ≥ 1 day, 20% audit until day 14 (ADR 0880 D4, ADR 0918) | `LANE_ENTRY` in `scripts/tracegate.mjs` | Same rule: `lanes.<l>.entryBar: { "days": 1, "earlyAudit": 0.2 }`. It predates 0.10.0. |
| Per-KEY i18n invalidation | `scripts/lib/tracegate-i18n.mjs`, `frontend/react/src/test/tracegate-i18n-recorder.ts` | **Keyed inputs.** The recorder calls `recordKeyRead(tablePath, key)` from `tracegate-ci/recorder`. The lane's `keyedExtract` command turns a `messages` table module into a JSON object of its values; this repository's existing literal parser can be that command. Only edits to a table's data are narrowed; an edit to its code follows the module rule. A whole-table or whole-store read is the key `*`. |
| Date-bomb sweep coupling (ADR 0918) | `ci.sh` and the frontend lane's selection | **`lanes.<l>.preSelect`**: a command that receives the enforce selection as JSON and prints test files that must run too. It can only add; a failing hook runs the lane whole. |
| > 24 h full-lane backstop that runs the STALE checks | `FULL_RUN_MAX_HOURS` | Same rule: `fullRunMaxHours` (default 24). |
| Daemon nightly and PR pre-gating (ADR 0974 P2) | `scripts/tracegate-daemon.sh` | **`tracegate daemon`**: the nightly full lane, and pre-gating each PR queued for `tracegate train`, in throwaway worktrees under a preemptible `daemon` broker lease. It does **not** pre-gate open PR heads from GitHub; see Gaps. |
| Ledger sync with the other Mac | `tracegate.mjs sync` (5 logs) | `tracegate sync` now carries every evidence log, red and dependency packets included, over rsync or a `gs://` prefix. |

The same feature also exists twice and is drifting. The fork's `sync` carries five logs,
so red-opinion files and packets stay on the Mac that wrote them; the package's `sync`
had the same gap until 0.10.0. ADR 0980 already named "ledger compatibility with the
other Mac" as a risk.

## Decision (proposed)

**D1. Replace the fork's predictor with the package's, one lane at a time, frontend
first.** The frontend lane has 31 enforce runs and one untriaged miss in the published
report card (tracegate-ci `docs/evidence/openwop-app-2026-10.md`). The backend lane is
still in shadow. Starting with the frontend tests the keyed-i18n port where it matters
most.

**D2. Keep the ledger.** Both write the same `shadow-`, `misses-`, `triage-`, `full-`,
`escalations-` and `reasons-` logs, so the evidence and the entry-bar history carry over.
Footprints (`fp/`, `blobs/`) are a cache. They are rebuilt by the first recorded runs and
deleted as CLAUDE.md already allows. They are not converted.

**D3. Port the fork's features as the package's extension points, not as package code.**
- The i18n literal parser becomes the frontend lane's `keyedExtract` command.
- The i18n recorder calls `recordKeyRead`: `*` for a whole-table or whole-store read, and
  `en` for the derived `en-XA` pseudo-locale.
- The date-bomb coupling becomes the frontend lane's `preSelect` command.

**D4. Keep this repository's own merge train, bus and remote gate.** `merge-train.sh`
(bisect, batch branches), the ADR 0991 release bus (per-target deploy queue, notes) and
the ADR 0863 SSH gate stay. The package's bus and train are simpler, and moving to them
is not needed to retire the predictor.

**D5. The vendored broker and Red Reader follow the package.** Once the predictor comes
from the package, `scripts/vendor/tracegate-ci/` and its manifest are replaced by the
package's own modules at the pinned version.

## Plan

| Phase | What | Changes the gate how | Status |
|---|---|---|---|
| P0 | Run the pinned package read-only: `scripts/tracegate-package.sh` (`report-card`, `status`, `savings`) runs `tracegate-ci@0.10.1` through `npx` with `scripts/tracegate-package.config.json`, reached only via `TRACEGATE_CONFIG`. Nothing is installed and nothing calls it. Check: its report card matches the published card. | none | built |
| P1 | Port the i18n parser to a `keyedExtract` script, and make the i18n recorder also call `recordKeyRead`. In **shadow beside the fork**: both predict on every frontend gate, and a script compares their selections. Exit: 20 gates where the package selects a superset of the fork, or the differences are explained. | none: shadow only | proposed |
| P2 | Port the date-bomb coupling to a `preSelect` script, and switch the frontend lane's selection to the package. | frontend selection | proposed |
| P3 | The same for the backend lane, after its own 20 compared gates. | backend selection | proposed |
| P4 | Retire `scripts/tracegate.mjs`, the recorder, the i18n tracker and the vendored copies. `tracegate-daemon.sh` keeps its open-PR pre-gating (Gaps), calling the package. | none by itself | proposed |

> **CORRECTED 2026-11-03 (before P0) — three changes to the plan, found while building P0.**
>
> 1. **P0 installs nothing.** The root `package.json` and `package-lock.json` are global
>    inputs for both lanes, so adding the package as a devDependency would run both lanes
>    whole on its train for nothing. P0 pins `tracegate-ci@0.10.1` (which adds the git-history input) in
>    `scripts/tracegate-package.sh` and runs it through `npx`. The install moves to P1,
>    where the recorder actually needs it.
> 2. **The package's config is not a root `tracegate.config.json`.** The vendored broker
>    and Red Reader read that file through their own `config.mjs`, including its `ledger`
>    key; the fork overrides the ledger only on the paths it calls itself (`TRACEGATE_LEDGER`),
>    not for the broker server or the daemon. The package's config is
>    `scripts/tracegate-package.config.json`, reached only through `TRACEGATE_CONFIG`.
> 3. **P1 records into its own ledger, outside the gate.** Two recorders in one Vitest
>    worker would share V8's coverage session and the `vm` seam, and the package's
>    footprints would land in the fork's live ledger. Instead, P1 sets `"ledger"` to
>    `<git common dir>/tracegate-package/` in the package config, records with the
>    package's recorder through `tracegate daemon` in a worktree, and the gate only runs a
>    read-only `tracegate select` and logs how its selection compares with the fork's.

> **CORRECTED 2026-11-04 — P1 lands as two PRs** (the release coordinator's call, so the
> risky half settles on its own).
>
> - **P1a** installs `tracegate-ci@0.10.1` as a root devDependency (lockfile: one entry
>   added, none removed). It adds the frontend lane's `keyedExtract`
>   (`scripts/tracegate-package-i18n-extract.mjs`, the fork's parser printing the table
>   nested, so a test that read a sub-object sees a change inside it). And
>   `tracegate-i18n-recorder.ts` reports each lookup to the package's `recordKeyRead`
>   when the package's recorder is the one loaded, through `tracegate-package-keys.ts`;
>   under the fork's recorder it does nothing new. The gate changes only in that both
>   lanes run whole once, for the lockfile.
> - **P1b** adds the read-only `tracegate select` step to `scripts/ci.sh`. It never
>   fails the gate, has a timeout, and comes with a sabotage test showing a failing or
>   hanging package leaves the gate green and bounded. d8 reviews it, and it waits for
>   d8's ci.sh changes (slot 215). P1b also records through `tracegate daemon` into the
>   package's own ledger.
>
> > **CORRECTED 2026-11-08 (building P1b) — recording is on demand, not a daemon, for
> > now.**
> > - **The gate step:** after the fork's frontend selection, `scripts/ci.sh` calls
> >   `tracegate-package.sh shadow-compare frontend "$TG_RUN" || true`. The package
> >   selects into `<git common dir>/tracegate-package/`. One row per gate goes to
> >   `compare-frontend.tsv`: status, seconds, both counts, the files only the fork
> >   runs, the files only the package runs, and whether the package's selection is a
> >   superset. It always exits 0 and is killed with its process group after 60 s.
> >   It uses only the installed package: where the root node_modules predates P1a it
> >   logs `not-installed` and skips, never fetching with npx inside a gate (d8's
> >   review). Both selections are compared as absolute paths.
> >   `scripts/test-tracegate-package-shadow.sh` witnesses a selecting, a failing and a
> >   hanging package, and goes red without the timeout. Measured: about 1 s with an
> >   empty ledger.
> > - **Recording:** `tracegate-package.sh record frontend` is a whole shadow run of
> >   the lane, recorded by the package's recorder into that ledger. Vitest loads the
> >   package's recorder only when `TRACEGATE_RECORD` is set without
> >   `OPENWOP_TRACEGATE_RECORD`, so the two recorders never share a worker. It's a full
> >   suite, so it runs only in a window from the release manager.
> > - **What's still open:** a nightly package daemon would load the machine every
> >   night, so it waits for the user's call. Until recordings exist, the package
> >   selects every file, and the comparison shows a superset with no information. The
> >   P1 exit, 20 compared gates, counts only gates after a recording.

## Implementation record

| Phase | Commit | What landed |
|---|---|---|
| P0 | f19108d2e (#5539) | `scripts/tracegate-package.sh` and `scripts/tracegate-package.config.json`: the pinned package, read-only. No gate change. |
| P1a | 3e553e4dc (#5586) | Root devDependency `tracegate-ci@0.10.1`; `scripts/tracegate-package-i18n-extract.mjs` + the frontend `keyedExtract`; the i18n recorder reports keyed reads to the package. Gate: both lanes whole once (lockfile). |
| P1b | 356e8b92e (#5691) | `ci.sh` calls `tracegate-package.sh shadow-compare` after the fork's frontend selection (never fails, 60 s cap, `compare-frontend.tsv`); `record` on demand; vitest loads the package's recorder under `TRACEGATE_RECORD` alone. Test: `test-tracegate-package-shadow.sh`. |

## Gaps (what 0.10.0 does not cover)

- **Pre-gating open PR heads.** The package's daemon pre-gates what is queued for
  `tracegate train`, which needs no forge API. This repository lands through
  `merge-train.sh`, not `tracegate train`, so `tracegate-daemon.sh` keeps that part.
- **The two lanes' different date-bomb handling** reaches the package only as the
  frontend's `preSelect` hook. The backend needs none today.
- **The ADR 0991 release bus has a different format** from the package's. They don't
  read each other, and D4 keeps this repository's.

## Alternatives

| Option | Why not |
|---|---|
| Keep the fork and keep vendoring (ADR 0980 P4's "vendor leaves, keep the trunk") | Every package fix is a hand back-port or a re-vendor. The sync gap shows the drift is already real. |
| Switch both lanes at once | Swaps the most-used gate component on both lanes in one PR, with no comparison data. |
| Move the train and bus to the package too | Not needed to retire the predictor, and this repository's versions do more (bisect, batches, per-target deploy queue). |

## Risks

- **Keyed-i18n parity.** The fork's tracker falls back to the constant rule in cases its
  parser does not understand: spreads, identifiers, computed keys, `${…}`. As a
  `keyedExtract` command, the same parser must exit non-zero in those cases (the package
  then treats the table as changed). P1's comparison is the check.
- **A cold footprint cache.** After D2 deletes `fp/`, the first gates on each lane run
  more than they do today, until footprints are recorded again. The entry-bar history is
  unaffected.
- **Two predictors in P1.** Running both doubles the selection time (seconds, not
  minutes) and must never change what the gate runs. The fork's selection still decides.

## Open questions

- [ ] P1: is "a superset of the fork, or explained" the right exit, or should it be
  exact equality on the 20 gates?
- [ ] P4: should `tracegate-daemon.sh` move to `tracegate daemon` plus `train add` for
  open PRs, or keep its own PR loop?
