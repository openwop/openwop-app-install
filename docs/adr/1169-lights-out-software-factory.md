# ADR 1169 — The lights-out software factory

Status: Accepted (2026-11-27, user: "Write up the ADR, code, commit, pr, and merge across the apps asap"). Open decisions take their stated defaults until the user changes them. User direction: "Capping at 8 code PRs per repo per night isn't
going to cut it, it could be 100s of PRs per repo. My 'yes' for migration won't cut it either,
this is a lights out software factory, we need to auto patch issues by sending notes back out
over the bus and have migrations happen automatically for healthy deploys."

This ADR builds on ADR 1166 (build by day, release by night). It replaces three of 1166's
human steps with machinery: the "ready" message, the human yes for migrations, and the human
fix after a red. Where it conflicts with 1166, this ADR wins once Accepted: the 8-PR cap (D3.2),
migrations under a per-deploy yes (proposed D14), and the human review label for risky PRs.
Process and tooling only: no wire change, no RFC.

## Context

ADR 1166 assumes a person or a coordinator session in the loop: sessions message "ready", the
coordinator builds the batch, the user approves migrations, and a red waits for its owner to
notice. On 2026-11-27 that loop consumed most of the coordinator's time and tokens at about 30
PRs a day. At hundreds of PRs per repo per night it cannot work at all.

Two limits are physical, and the design has to respect them rather than wish them away:

- **Compute.** A full gate is 45–110 minutes. Gating each PR alone is impossible at this volume,
  and one huge batch is too: a red in an N-PR batch costs about log2(N)+1 more gates, and with
  hundreds of PRs several reds a night are certain.
- **Data.** Code rolls back by shifting traffic; a database migration does not. Automatic
  migrations are safe only if every migration is reversible by construction or proven against a
  copy of production before it runs.

## Decision

### F1. Readiness is a commit status, not a message

The per-PR bar (ADR 1166 D2) runs as one command, `tracegate pr` (ADR 1166 D9.2). On success it
posts a GitHub commit status, `local/pr-bar = success`, on the PR's exact head sha, with the
counts in the description. A new commit has no status, so a PR that changes must pass again.
Nothing is messaged to a coordinator; any machine can read the status.

### F2. Continuous integration into partitioned batches

An **integrator** on the build machine (light; every 10 minutes) collects every open, non-draft
PR whose current head has `local/pr-bar = success` and that is not labelled `hold`. It sorts them
into **sub-batches by footprint**: Tracegate already knows which files and tests each PR can
affect, so PRs with disjoint footprints go into separate sub-batches, and PRs that touch the same
area go together. Sub-batch size adapts (the Zuul-style window): it shrinks after a red and grows
after greens, starting at about 25.

- There is **no fixed per-night cap**. The limit is compute, and the night report says how many
  PRs were left queued and why.
- Sub-batches gate **in parallel** on the build machine, each in its own capped container
  (ADR 1166 D8), under the machine-wide broker. A red bisects only its own sub-batch.
- Under Tracegate enforce, a sub-batch runs only what its PRs can affect plus the audit sample.
  The FULL lane still runs at least once every 24 hours (ADR 0880), so selection cannot hide a
  regression for long.
- Each green sub-batch merges to `main` at once (its tree is checked, as `merge-train.sh` does),
  so later sub-batches are built on the new main. This is a merge queue: main is always the
  tree that was gated.
- Merging runs all night and through the day, as long as PRs are ready. Deploys stay in the
  window (F5), unless the user asks.

**Throughput, honestly.** On the user's PC with three to four parallel slots and gates cut to
about 20–30 minutes by Tracegate selection, a night holds roughly 40–80 sub-batch gates. At 25
PRs a sub-batch that is 1,000–2,000 PRs across all repos, if almost every PR arrives green. Each
red costs its sub-batch about 5 more gates. The levers, in order: the per-PR bar (fewer reds),
Tracegate selection (shorter gates), more parallel slots (a bigger machine). The morning report
measures all three.

### F3. Reds patch themselves over the bus

A red sub-batch bisects to its culprit (`batch.sh bisect` / `merge-train.sh`), merges the green
rest, and sends a **fix request** for the culprit:

- `kind: "fix-request"` on the bus, to the PR's owning session if it is alive, else to `*` for
  the repo's fixer pool. It carries the PR, the head sha, the failure packet's id (the failing
  test, its output, the re-run-alone result, the diff) and the attempt number. No secrets.
- The fixer pushes a fix to the PR's branch and re-runs `tracegate pr`. The new status puts the
  PR back in the queue by itself.
- **Bounded:** at most two fix attempts per PR per night. A third red, or a red the fixer judges
  to be in someone else's code, becomes `needs-human` in the morning report. A fix may never
  weaken or delete a test to pass; that is checked by the review lane (F4).
- A red caused by the machine, not the code (a timeout or memory error whose files pass alone),
  gets one automatic re-run first (ADR 1166 D16) and no fix request.

### F4. An automated review lane replaces the review label

PRs that quick checks cannot vouch for (security, authentication, erasure and tenant data,
payments, migrations, lockfiles, the gate's own scripts, very wide diffs; `batch.sh` already
detects most of these) go through a **review agent** before the integrator takes them. It reads
the diff against the repo's rules (AGENTS.md, CLAUDE.md, the relevant ADRs), checks that each
risky change has a sabotage witness that actually ran, and either passes the PR (a commit status,
`local/review = success`) or sends it back with a fix request. It can block, and it can pass only
with the witness evidence present. Its decisions are logged in the morning report so they can be
audited.

### F5. Healthy deploys deploy themselves

After the last green merge of the window (and before the 05:00 ET start cutoff, ADR 1166 D13),
each repo whose main moved deploys automatically under the user's standing nightly approval
(given in the deploying session). A deploy is **healthy** only if all of these hold:

1. preflight passes (the tip is main's gated tree; production does not move backwards);
2. the new revision serves the new commit (`verify-deploy.sh`: readiness and build-info stamps,
   bundle content types);
3. a **canary window**: the error rate, 5xx rate and p95 latency over 15 minutes stay within the
   previous revision's baseline;
4. the deploy machine still holds the deployer role at the deploy's epoch (ADR 1166 D10).

Any failure shifts traffic back to the kept previous revision by name (ADR 1166 D12), confirms
the old commit is serving, and sends fix requests to the owners of the PRs in that deploy.

### F6. Migrations run themselves, under three guardrails

Replaces ADR 1166's proposed D14 (a human yes per migration). A migration runs automatically
when every guardrail holds; otherwise its deploy is held and a fix request goes to its owner.

1. **Expand, then contract.** Every migration is classified from `releases.json`
   (`rollingSafe`, `requiredStop`) and the migration itself:
   - **Expand** (additive: new tables or columns, new indexes built concurrently, backfills that
     keep the old shape). The previous binary still works, so a code rollback stays safe. These
     run automatically.
   - **Contract** (drop, rename, type change, destructive backfill). It runs automatically only
     in a release **after** the matching expand has been live and healthy for at least 7 days,
     and only when no deployed revision still reads the old shape.
   - A migration that is neither (expand and contract in one step) is refused by the review lane
     and sent back to be split.
2. **A backup first, verified.** A fresh database backup (Cloud SQL on-demand backup or the
   app's own export) completes successfully before the migration starts. No backup, no
   migration.
3. **A rehearsal on a copy.** The migration runs first against a restore of the newest backup in
   a scratch instance, with the migration-integrity check and the app's boot-time checks. It must
   succeed and finish within a time budget. Then it runs on production.

If a migration fails on production, the deploy rolls back its code (safe, because expand-only
leaves the old binary working), the scratch copy is kept for the fixer, and a fix request goes
out. Restoring the backup over production is NOT automatic. It loses writes since the backup,
so it is the one step that stays with the user.

### F7. The user's controls

- **One off switch for automation**, owned by the user: a `factory: paused` note on the bus (or
  a file on the build machine) stops new merges and deploys at the next step. It is the user's
  own control over the user's own automation, not a freeze on any other machine or session.
- **What stays out of automation unless the user extends it:** production env and pin changes
  (`update-env.sh`), registry pack publishes, the public white-label release, and restoring a
  backup over production.
- **The morning report** (ADR 1166 D15) adds per repo: PRs merged, sub-batches gated, reds and
  their fix requests, PRs left queued, migrations run (expand or contract, backup id, rehearsal
  time), deploys and canary results, and every review-lane decision.

## Alternatives considered

- **Raise the cap and keep one batch per repo.** At hundreds of PRs, each red costs about 8
  gates and the night overflows by morning. Rejected.
- **Merge straight to main on the per-PR bar, gate at night.** Main would be untested in the day,
  and every session would build on it. Rejected: the merge queue keeps main gated at the same
  throughput.
- **Run every migration automatically after a backup.** A destructive migration with a code
  rollback leaves the old binary on the wrong schema, and restoring the backup loses data.
  Rejected in favour of expand/contract plus the rehearsal.
- **Keep a human review label.** It does not scale, and it is the opposite of lights-out.
  Replaced by the review lane, which can block but needs evidence to pass.

## Implementation plan

| Phase | What | Where |
|---|---|---|
| F1 | `tracegate pr` posts `local/pr-bar` | tracegate-ci (ADR 1166 D9.2) |
| F2a | The integrator: collect by status, footprint sub-batches, adaptive size | openwop-app `batch.sh auto`, then the adopters via sync |
| F2b | Parallel sub-batch gates under the machine broker | the build machine (ADR 1166 D8) |
| F3 | Fix requests on the bus; bounded attempts; the fixer pool | `release-bus.mjs` note kind + the batch failure packet |
| F4 | The review agent and `local/review` | an agent definition + status, per repo |
| F5 | The canary window and auto-rollback in `deploy.sh` | openwop-app, then the adopters |
| F6 | Migration classification, verified backup, scratch rehearsal | openwop-app migration tooling, then the adopters |
| F7 | The off switch and the extended morning report | the night driver (ADR 1166 P4) |

Build order: F1 → F2a → F3 first (they remove the "ready" messages and the human fix loop), then
F5 and F6 (the riskiest, behind the canary and the rehearsal), then F4 and F7.

## Open decisions (the user's)

- [x] Accept this ADR (user, 2026-11-27).
- [ ] The canary thresholds (default: within the previous revision's 15-minute baseline).
- [ ] The contract wait (default: 7 days healthy after the expand).
- [ ] The fixer pool: which sessions or machines fix orphaned PRs for each repo.
- [ ] Whether the review lane may pass security PRs on its own, or only block them.
