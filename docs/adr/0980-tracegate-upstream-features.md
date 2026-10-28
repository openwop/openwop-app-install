# ADR 0980 — Bring tracegate-ci's newer Tracegate features into this repo's gate

Status: Accepted (P0 done, P1 built). The user approved writing this proposal (2026-10-25), then P0 and P1 (2026-10-26). Each later phase changes what the gate runs, so each needs its own go from the user before it is built or trained.

## Context

Tracegate (ADR 0880) began in this repo as `scripts/tracegate.mjs` and `scripts/lib/tracegate-recorder.mjs`. Its core was later extracted into the standalone project **tracegate-ci**, and work continued there. Some of that work came back already:
- the broker and the capacity sampler are vendored as byte copies under `scripts/vendor/tracegate-ci/` (ADR 0971, ADR 0974), with a hash manifest that `scripts/test-broker-observe.mjs` checks;
- two fixes were back-ported by hand into `scripts/test-tracegate.mjs`.

tracegate-ci v0.5.0 (local commit `450c2ac`, not yet public) adds three things this repo's gate does not have.

1. **Red Reader escalation (tracegate-ci Phase 1b).**
   - On a red run, Tracegate writes a *red packet*: the failing text, the prediction and its reason, the MISS and re-run-alone results, history, and the change.
   - An agent session can attach an opinion to it. The opinion is a closed-world record: a verdict enum, `escalate`, confidence, bounded reasons.
   - An opinion of `real`, escalated, with confidence ≥ 0.7, on a file that was a MISS, writes an `escalations-` row. The entry bar reads that row as a `hole`.
   - It can only make a lane stricter. The latest verdict wins, so a person's later `flake` overrides it.
   - This would have caught `systemSiteScope` (#4807) sooner: it "passed alone" and was a real wrong-scope read.
2. **Conductor (Phase 2).**
   - A deterministic fail-first *order* for the files a lane must run, which never changes *which* files run. It is shadow by default and scored per red run.
   - *Train advice*: which PRs to train alone and which pairs are disjoint.
3. **The dependency rule (Phase 3).**
   - Today a lockfile change runs the whole lane.
   - Under the rule, only files that loaded a changed package re-run.
   - Native packages, packages the Vitest main process loaded, and nested copies are treated as global.
   - It enforces only after its own bar: 3 lockfile runs over 1 day with no failure among the files it would have reused.
   - This is the only one of the three that skips work.

The two code bases share a lineage, and it shows in the ledger: both write the same `shadow-`, `misses-`, `triage-` and `full-` TSV logs in `$(git rev-parse --git-common-dir)/tracegate/`. The new features add `escalations-`, `deps-` and `conductor-` logs beside them. The fork has also grown things upstream does not have:
- per-KEY i18n invalidation (`scripts/lib/tracegate-i18n.mjs`);
- the date-bomb sweep coupling (ADR 0918);
- the >24 h full-lane backstop that runs the STALE checks;
- the daemon nightly (`scripts/tracegate-daemon.sh`);
- two lanes with different entry bars (ADR 0880 D4 correction, ADR 0918).

## Decision

**D1. Vendor, don't hand-port.** Bring each feature in as byte copies of tracegate-ci modules under `scripts/vendor/tracegate-ci/src/`, as the broker already is.
- Extend the existing `VENDORED.md` manifest, and the test that checks it, to cover the new files.
- The fork's predictor calls into them through narrow hooks.
- Hand-porting would make a second copy of each feature that drifts from the first. The broker vendoring shows the alternative works: one upstream, one `re-copy + regenerate manifest` step.

**D2. Keep the fork's predictor; do not replace it with upstream's yet.** Replacing `scripts/tracegate.mjs` wholesale with tracegate-ci's predictor would drop per-key i18n, the date-bomb coupling and the lane-specific bars. Those would first have to become upstream extension points, a project of its own (see P4). The new modules need only `config.mjs` (already vendored) and `ledger.mjs`, so they can sit beside the fork.

**D3. One feature per phase, in order of risk.** Each phase is its own PR, its own train and its own user go:
- P1, escalation, can only make the gate stricter;
- P2, conductor ordering, cannot change the set;
- P3, the dependency rule, skips work, so it comes last.

**D4. Same guardrails as upstream, with the same witnesses.** The upstream sabotage witnesses for each feature are vendored with its tests and run in the gate's self-test lane. Examples: an escalation re-suspends a lane, only a MISS escalates, the predictor does not read the Conductor, and a native package is global. A feature lands only when its witnesses go red against a sabotaged copy here too, not just upstream.

**D5. Agents are the model.** As upstream decided, no CI step calls a model provider. Opinions come from agent sessions already working in the repo (Claude Code, Codex, Cursor), through the packet files and the MCP tools. The `red-reader` agent procedure is vendored beside AGENTS.md's Tracegate rules. CI never waits on a session.

## Plan

| Phase | What | Changes the gate how | Status |
|---|---|---|---|
| P0 | Make tracegate-ci v0.5.0 public: the full sabotage sweep and `examples/e2e.sh`, then push `450c2ac`. Nothing is vendored from an unpublished commit. | none | done 2026-10-26: tracegate-ci `450c2ac` + `e696708` public; npm test 309, sabotage 78/78, e2e green |
| P1 | Vendor `ledger.mjs`, `red.mjs`. The gate writes a red packet for every red lane run, and the entry bar reads `escalations-` rows as `hole`. Add `node scripts/tracegate.mjs red …` (list, read, annotate, score), plus the agent procedure. | stricter only: an escalated MISS suspends enforcement until triaged | built (this PR): packets on every red lane via `tg_red_packet`; `red` CLI; entry bar latest-verdict-wins over `triage-` + `escalations-`; escalations sync to the other Mac; 13 self-test checks (one pins the gate wiring) |
| P2 | Vendor `conductor.mjs` and the sequencer. In shadow, write `order.txt` and score the first-failure rank. Then, on a separate go with data, `conductor.mode: order`. Wire `conductor train` advice into `merge-train.sh` and `batch.sh merge` (the batch-branch mode in #5214, its P3) as advice only. | shadow first: none; `order` mode reorders, never changes the set | proposed |
| P3 | Vendor `deps.mjs` and the main-process reporter. The dependency rule applies behind its own bar, and lockfile gates run the rule's selection plus audits. | skips work, after its bar | proposed |
| P4 | Upstream extension points for the fork's own features: i18n per-key, a pre-select hook for the date-bomb coupling, lane bars as config. Then retire the fork's predictor. | none by itself | later; its own ADR |

## Alternatives

| Option | Why not |
|---|---|
| Hand back-port into `scripts/tracegate.mjs` | Two copies of every feature that drift apart. The two hand back-ports done so far stayed small for this reason. |
| Replace the fork with the published tracegate-ci package now | Loses per-key i18n, the date-bomb coupling and the lane bars on day one, and swaps the most-used gate component at once. |
| Do nothing | Leaves three measured gaps open. A MISS that "passed alone" can still be triaged as a flake with nothing to object. Red runs start in the order files were found, not the order most likely to fail. Every lockfile PR runs both lanes whole. |

## Risks

- **Ledger compatibility.** The new rows sit beside the old ones in a ledger the other Mac syncs. Its older code must ignore unknown files, which the readers do because they filter by prefix. P1 must verify that against the synced copy before merging.
- **A wrong escalation** costs a lane running whole until someone triages it. `red score` counts each override as a false escalation.
- **The dependency rule's known gaps:** a package a test only spawns as a process, and a native addon loaded with dlopen. The audit, the >24 h full lane and the rule's own bar are the backstops.
- **Vendored code ages.** Each re-vendor is a PR through a train. The manifest check makes an edit in place a red gate.

## Open questions

- [ ] P1: should an escalation also post on the PR that ran the gate, or only write the row?
- [ ] P2: does fail-first order shorten time-to-red here enough to justify `order` mode? Decide from the shadow scores, not before.
- [ ] P3: is 3 lockfile runs over 1 day the right bar for this repo, which merges several dependency PRs a week?
- [ ] P4: is the fork's predictor worth retiring at all, or is "vendor leaves, keep the trunk" the steady state?
