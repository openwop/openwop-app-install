# ADR 0976 — Batch branch mode: merge features on quick checks, gate them once

Status: Accepted (P1). The user asked for the mode (2026-10-25) and approved this plan the same day ("proceed with the full plan"). The defaults in D2–D5 are this ADR's choices and the user may change any of them.

## Context

Every PR reaches `main` through a full gate (`npm run ci`, 15–45 minutes). One gate runs at a time on a machine, and trains queue behind each other through the advisory release queue. When several features are being built together, and especially when one builds on another, each waits for its own gate before the next can build on it.

The user asked for a mode where a set of features can be written and merged quickly, then tested, built and deployed together at the end.

### Prior art (researched 2026-10-25)

Three families exist.

1. **Merge first, test after.** Code lands on the main branch with little gating, and a post-merge suite plus a revert rule keeps it usable.
   - Firefox autoland: sheriffs close the tree and back out the cause, with no fix-forward ([tree closures](https://firefox-source-docs.mozilla.org/testing/automated-testing/tree-closure.html), [backouts](https://wiki.mozilla.org/Sheriffing/How_To/Backouts)).
   - LLVM: post-commit buildbots and a prompt-revert norm ([code-review policy](https://llvm.org/docs/CodeReview.html)).
   - PostgreSQL: the buildfarm tests after the push, a practice its own contributors questioned in 2025 ([thread](https://www.postgresql.org/message-id/CAGECzQRys8t8ig7eN26rbvop%2Bzgw06oP11L5HpYuUtA%3D6j_WZA%40mail.gmail.com)).
   - Google TAP: narrow presubmit, batched postsubmit and an automatic culprit finder ([flake-aware culprit finding](https://hackthology.com/flake-aware-culprit-finding.html)).
2. **Batch inside the merge queue.** Nothing reaches the main branch untested, but many PRs share one run, and a red batch is split.
   - Rust bors: `rollup=always` ([Forge](https://forge.rust-lang.org/release/rollups.html)).
   - Mergify: two-step CI and `skip_intermediate_results` ([two-step](https://docs.mergify.com/merge-queue/two-step.md)).
   - Trunk.io: batching with bisection ([batching](https://docs.trunk.io/merge-queue/optimizations/batching)).
   - Kubernetes Tide: pool batches ([Tide](https://docs.prow.k8s.io/docs/components/core/tide/maintainers/)).
   - Uber SubmitQueue: speculation ([paper](https://arxiv.org/pdf/2501.03440v2)).
   - Our `merge-train.sh` is already one of these.
3. **Integration branch, then stabilise.** Work merges freely into a separate branch and is tested when that branch is promoted.
   - Linux: the merge window and `-rc` stabilisation, with linux-next ([process](https://elixir.bootlin.com/linux/v4.12.12/source/Documentation/process/2.Process.rst)).
   - git-flow's `develop` branch.
   - Perl's `smoke-me/` branches.

Every working version keeps the same four things:
- a cheap check on every merge;
- automatic culprit-finding;
- a revert rule while the branch is red;
- deploying only a commit that passed the full gate.

## Decision

**D1. Batch branches (family 3), with `main` still gated.** A batch is a branch `batch/<name>` cut from `origin/main`.
- Feature PRs target it and merge after quick checks only.
- The batch reaches `main` as ONE PR through `merge-train.sh`, so `main` keeps its gate and its tree check, and other sessions and the other machine keep their normal path.
- Nothing is frozen, held or locked (CLAUDE.md; AGENTS.md #4762).

Family 1 is rejected. Many sessions on two machines branch from and deploy from `main`, and a red `main` reaches all of them before anyone can revert. Every project that works that way has a dedicated person watching the tree.

Family 2 alone does not give the user what they asked for. PRs in a queue cannot build on each other until they land.

**D2. The per-merge check is `npm run ci:quick`** (`OPENWOP_CI_QUICK=1 scripts/ci.sh`). It runs:
- the dependency guards;
- the static `check-*`/`gen-* --check` scripts;
- the gate-tooling and custom-domain script tests;
- the backend typecheck, distribution checks and esbuild build, plus the shutdown and e2e-wiring probes;
- the frontend lint, build and test-types.

It then STOPS.
- No test suite runs.
- It skips the contention wait and broker registration, because it is not a suite.
- It skips the gate's self-test lane.
- It writes no e2e ledger row, Tracegate footprint or full-run marker, so a quick pass can never be read later as a gated commit.

The list is the gate's own, cut at a point, rather than a copy of it, so it cannot drift from the gate.

**D3. At most 10 features per batch** (`OPENWOP_BATCH_MAX`). A batch is only cheap if it is usually green. If each PR has a 10% chance of being red, a batch of 10 is red about 65% of the time, and each culprit costs about log2(N) extra gates. Our backend lane was red in 5 of 11 full-width runs in the week before this ADR (the ADR 0971 width report), so the cap errs low.

**D4. A red close bisects and reverts.** `batch.sh close` runs one train on the batch PR. If that train is red:
1. The batch's first-parent commits are probed one full gate at a time with the new `merge-train.sh --gate-ref=<sha>`. It gates `origin/main` plus that commit under the train's lock, worktree and installs, and merges nothing.
2. The first red commit, if it is a feature merge, is reverted on the batch (`git revert -m 1`). This is Firefox's backout rule: revert, don't fix forward. Its PR gets a comment saying why.
3. Close runs again, up to `OPENWOP_BATCH_CLOSE_ROUNDS` (default 2) times.

Close stops and says so if:
- the first red commit is a sync with `main` or a direct commit (an interaction, not one feature);
- a revert conflicts because later features build on the culprit;
- no single commit is red (a flake).

**D5. Batch mode never deploys.** A deploy is a release-queue slot. Close prints the deploy step for the commit the train landed on `main`, which is the only kind of commit a deploy may come from. This narrows the user's "deploy at the end": the deploy still happens at the end, but as its own slot, which keeps deploy coordination where it is today.

**D6. Tracegate is unchanged.** The close gate and every probe are ordinary gates: they record footprints, re-run misses and enforce as usual. Quick checks record nothing (D2).

**D7. Agents drive it, and the script asks them for judgment explicitly.** The user asked (2026-10-25) that the whole flow be LLM-assisted, because Claude Code, Codex or Cursor will run it, not a person at a terminal. So:
- **One procedure for every harness.** The `batch` skill (`.claude/skills/batch/SKILL.md`, byte-mirrored to `.agents/skills/` by `check-agent-skill-mirror`) is the procedure. AGENTS.md, which Codex and Cursor read, and CLAUDE.md both point to it.
- **Every stop says what to do next.** Each refusal or failure ends with a `next:` line naming the command or the decision, and `status --json` gives the batch's state and its `next`. An agent never has to infer the next step from prose.
- **Judgment is requested, not guessed.**
  - Quick checks cannot vouch for some changes: lockfiles and `package.json`, the gate's and the deploy's own scripts, migrations, vendored wire schemas, and diffs over 60 files (`OPENWOP_BATCH_WIDE_FILES`). For those, `merge` lists the reasons and refuses until the agent re-runs it with `--accept-risk="<reason>"`. This is Rust's `rollup=never` decision made explicitly instead of forgotten.
  - The reason is posted on the PR so a reviewer can check it.
  - The skill's rubric says when to accept, and which areas never ride a batch: authorization and tenancy, billing, BYOK, replay, wire changes and the gate itself.
- **A red close leaves evidence to fix from.** For each culprit, the script writes a failure packet to `<git-common-dir>/batch/<name>/red-<pr>.md` and posts it on the PR. The packet holds the culprit, its diff stat, the red gate's failing lines and the full log's path. Each probe's full log stays beside it. The agent fixing it starts from the failures, not from "the batch was red".

## Usage

```
scripts/batch.sh open   <name>        # batch/<name> from origin/main
gh pr create --base batch/<name>      # feature PRs target the batch
scripts/batch.sh merge  <name> <pr> [--accept-risk="<why>"]   # quick checks, then merge (retargets a PR based on main)
scripts/batch.sh sync   <name>        # merge origin/main into the batch (quick checks, push)
scripts/batch.sh status <name> [--json]
scripts/batch.sh close  <name>        # one train; red → bisect, revert, packet, re-close
scripts/batch.sh bisect <name>        # the bisection on its own
```

Ask the release manager for a slot before `close`: it is a train, and its probes are gates.

## Trade-offs and risks

- **Quick checks are not tests.** A feature built on another feature's unmerged-to-main code may be built on a bug, and the rework comes later. This is the cost the mode buys speed with. Keep batches to features that are expected to be green, and keep risky PRs (wide reach, lockfile changes) out of them. tracegate-ci's Conductor train advice names such PRs.
- **Flakes can mislead bisection.** The gate already re-runs a Tracegate miss alone and triages a pass as a flake. A bisection that finds no red commit stops rather than reverting anything.
- **Batches drift from `main`.** `sync` merges `main` in, and `close` syncs first. A long-lived batch still pays in conflicts, so close batches within days.
- **One worktree per batch.** Each batch gets one worktree (`<checkout>-batch-<name>`) with its own `node_modules`. `batch.sh` serialises commands per batch with a lock beside the train lock. Remove the worktree after the batch lands, then run `npm run packs:prune`.

## Plan

| Phase | What | Status |
|---|---|---|
| P1 | `scripts/batch.sh` (with `next:`, `status --json`, `--accept-risk`, failure packets); `ci.sh` quick mode + `npm run ci:quick`; `merge-train.sh --gate-ref`; the `batch` skill (both mirrors); `scripts/test-batch.sh`, 38 checks, with 11 sabotage witnesses all red, wired into the gate's self-test lane; CLAUDE.md and AGENTS.md | this PR |
| P2 | First real batch. Measure gates per landed feature, wall time from first merge to `main`, and close rounds, against the same features trained one by one | — |
| P3 | If P2 shows red closes are common, have `merge` consult the Conductor's train advice and refuse wide-reach PRs by default | — |

## Open questions

- [ ] Is 10 the right cap (D3)? Revisit with P2's data.
- [ ] Should `close` also be allowed to deploy when the release manager grants it (D5)?
- [ ] Is the risk list in D7 right? P2 should record each `--accept-risk` reason next to whether that PR was later a culprit.
- [ ] Should batch branches get a GitHub ruleset that blocks direct pushes except `batch.sh`'s sync and revert? Today, convention is all that stops a direct push.
