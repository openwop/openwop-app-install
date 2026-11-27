# ADR 1166 — Build by day, release by night

Status: Accepted (2026-11-27, by the user, with the window moved to 23:00–06:00 ET and D8
added). User direction: "I want to spend 99% of my time creating
features and 1% of my time deploying to prod."

Daytime is development: sessions build and check work in the local browser and run each
PR's own checks. Full gates, merge trains and deploys move to one nightly release window,
with an on-demand lane for urgent work. No cloud CI is adopted; the cost analysis below is
for a later budget decision. Process and tooling only: no wire change, no RFC.

## Context

All gating runs locally on one MacBook Air (8 cores, 16 GB, swap often under 1 GB free). A
full gate (backend vitest, frontend vitest, date-bomb sweep, build, conformance) takes 45–110
minutes, and two gates at once starve each other into false reds, so only one runs at a time.
That single slot serves six repos (openwop-app, casavoga, bookai, decktalk, myndhyve,
kicktodo) and about 17 parallel sessions. Hosted CI is disabled (CLAUDE.md, decision
2026-07-21).

Measured 2026-11-26/27 (release queue log):

- About 20 full or partial gates ran in 24 hours.
- CasaVoga needed **6 gate runs** for one 5-PR batch (gate 2) and **4** for the next (gate
  A): roughly 8 extra gates and 6–10 hours of the only slot.
- **Every one of those reds was a PR's own new or changed test** (a mock missing a method,
  `import.meta.url` under jsdom, test pollution, a ratchet that had to shrink, an
  unclassified host write). Each would have failed in a 1–2 minute targeted run.
- Peers waited hours for slots. Three promised GOs slipped; one (MyndHyve #90+#114) was missed
  outright by about 13 hours.
- Memory: free swap fell to 300 MB several times. The Tracegate daemon started batches beside
  cross-repo gates 11 times, because it yields only to openwop-app's own gates and broker.
- Deploys waited on approvals: a deploy approval names a tip, and merges moved `main` past an
  approved tip, forcing a re-ask.
- The coordinating session spent a large share of its tokens resequencing slots.

## Industry practice (sources read 2026-11-27)

- **Keep `main` always green ("not rocket science", merge queues).** Test the merge before it
  lands: bors, Uber's SubmitQueue, GitHub's merge queue
  ([Hoare](https://eluvk.github.io/readings/nrsr.html),
  [Uber](https://www.uber.com/blog/research/keeping-master-green-at-scale),
  [GitHub](https://docs.github.com/en/enterprise-server@3.20/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)).
  `merge-train.sh` and batch branches (ADR 0976) already implement this. On one machine a
  merge queue cannot run speculative builds in parallel, so its throughput gain does not
  apply; its cost is a red, about log2(N)+1 extra gates per culprit.
- **Test impact analysis.** Google TAP selects by reverse dependency and batches commits into
  milestones about every 45 minutes; Meta's predictive selection catches over 99.9% of faulty
  changes while running under a third of the dependency-selected tests
  ([Memon et al.](https://research.google/pubs/taming-google-scale-continuous-testing/),
  [Meta](https://arxiv.org/pdf/1810.05286.pdf)). Tracegate (ADR 0880) is the TAP-style
  selector at our scale. The cheapest selection of all, a PR's own test files, is the one we
  were not running before the gate.
- **Light checks before merge, full runs after (TAP's hybrid).** A developer may wait one
  milestone to learn of a failure; the full run is batched. That is the shape adopted here.
- **Release trains.** Chrome departs every four weeks and a missed feature takes the next
  train; Facebook batches pushes every few hours behind alerts and an emergency stop
  ([Chromium](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/process/release_cycle.md),
  [Meta](https://engineering.fb.com/2017/08/31/web/rapid-release-at-massive-scale/)). A fixed
  departure time replaces slot negotiation with "missed tonight, ships tomorrow". Chrome's
  four-week stabilization branch does not apply: we deploy servers that roll back by revision.
- **DORA: small batches.** Small batches predict delivery performance, and any batch that takes
  over a week to complete and check is too big; AI adoption correlated with lower throughput
  and stability in 2024 ([DORA](https://dora.dev/capabilities/working-in-small-batches/),
  [2024 report](https://dora.dev/report/2024)). One day of work per repo per night is well
  inside that bound. The risk is many agents piling PRs into one batch, so batches are capped.

## Decision

### D1. Daytime is development

Sessions work in the local browser (`npm run dev` and the app on localhost) and run targeted
checks. **No full gate, train, certify cut or deploy runs in the daytime**, except the
on-demand lane (D4). The release manager hands out no daytime gate slots.

### D2. The per-PR bar

A PR is ready for a batch only when, at its head:

1. its own added and changed test files pass;
2. every `*ratchet*`, `*census*` and coverage test passes, plus `test/steward` and the named
   files the release manager lists (fenced-truncation, subject-erasure*,
   adr0464-host-subject-erasure, pack-surface-arg-parity);
3. `tsc` for each touched workspace is 0, and lint plus the static `check-*`/`gen-* --check`
   scripts pass;
4. for a frontend change, the canonical `npm run build`;
5. a security- or data-shaped change has a sabotage witness that was actually run.

This runs at 2–4 workers, nice 10, in minutes. **Heavy steps (npm ci, tsc, a frontend build,
a vitest of more than ~5 files) run one at a time across the whole Mac**, through the shared slot
`scripts/heavy.sh` (mirrored to `<main-checkout>/.git/probes/heavy.sh` on each machine), which
also waits for ≥ 1 GB free swap. Measured the first
hour: sessions started their per-PR checks together (two npm ci, a frontend tsc and a vitest) and
free swap fell to 718 MB. It is the check CasaVoga's pre-gate grew into
on 2026-11-27, and it is what keeps the night green.

> **Correction (2026-11-27, Phase 1).** The slot was originally written as an untracked
> `<main-checkout>/.git/probes/heavy.sh`, which no clone or worktree gets. It is now the
> tracked `scripts/heavy.sh` with `scripts/test-heavy.sh` asserting the arbitration
> (second step waits, `--max-wait` never runs the command, a dead holder is replaced), and
> `ci.sh` runs that test. The `.git/probes/heavy.sh` path stays as a per-machine mirror.

### D3. One nightly release window

**23:00–06:00 ET** (04:00–11:00 UTC while the US is on EST; 03:00–10:00 UTC on EDT), unattended,
on the machine that holds the deployment role (D10; by default the build machine, D8):

0. **The batch closes at 22:30 ET.** Only PRs whose owner sent "ready: <repo>#<PR> <sha>" by then
   go in. At launch every head is re-read; a head that moved after the cutoff drops to the next
   night rather than going in un-checked.
1. One full gate per repo, serially on the Air, in parallel on the build machine (D8).
   > **CORRECTED 2026-11-27 (review):** this said "riskiest first, so a bisect has the most
   > night left". On an overfull night that lets one risky batch starve every other repo. The
   > order is now **short and safe first, risky last**: the docs-only and small batches ship
   > for certain, and a bisect late in the night delays only the repo that caused it.
2. Cap each repo's batch at **8 PRs**, so one culprit costs at most about 4 sub-gates.
3. On red, `merge-train.sh` bisects, merges the green halves and leaves the culprit open.
4. Deploy each repo's gated tip (D5), verify each live site (`verify-deploy.sh` or the repo's
   equivalent), and run one certify cut per batch after its last deploy.
5. Keep the Mac awake (`caffeinate`, on AC; lid-close sleep reds a gate).
6. Leave a **morning report** for the user: what shipped (commit and revision per repo), what
   was pulled and why, and what needs the user.

Arithmetic: six repos at about 60 minutes is 6 hours of clean gates in a 7-hour night. One
red in an 8-PR batch costs 3–4 more gates. **The window works on the Air only if pre-gate reds
are near zero**, which is what D2 is for. If nights overflow, the work left over runs the next
night, and D7 is the remedy.

### D4. The on-demand lane: deploys wait for the window unless the user asks

User direction 2026-11-27: **a deploy runs in the nightly window, or immediately when the user
requests it. Otherwise it waits for the window.** A hotfix, a security fix or a dated deadline
is the usual reason to ask. A requested deploy (and the single-PR gate in front of it, if
needed) "kicks into action": it takes the machine's next free capacity ahead of every queued
job and preempts background work at once. It never interrupts a non-preemptible gate already
running; it goes next. In tracegate-ci this is an on-demand lease in the machine-scoped broker
(D9).

This is the user's schedule for their own sessions, not a freeze in the AGENTS.md #4762 sense.
It never blocks a deploy the user requested, never holds another machine's repos, and adds no
lock or ruleset to `main`. AGENTS.md and CLAUDE.md say so beside the no-freeze rule.

### D5. Approvals are unchanged

- A deploy still needs the user's yes **in the session that deploys**. Approvals never travel
  on the bus or through the release manager.
- A **standing nightly approval** ("each night, deploy each repo's gated tip, with a backup and
  the old revision kept") is valid only if the user gives it, in words, in the deploying
  session. It never covers an env or pin change, a registry publish or a public release.
- Without it, the night gates and merges, and the morning report lists the deploys awaiting a
  yes.
- A deploy approval names a tip. Nothing merges past an approved, unstarted deploy.

### D6. Background load is off

The Tracegate daemon is uninstalled on the Air (2026-11-27, user direction). It could not see
cross-repo gates. It may return only with a fix that makes it yield to any repo's gate and the
user's word. That fix is D9 point 1 (tracegate-ci #29, one broker per machine), which replaces
the "machine-wide marker" idea and P5.

### D7. No cloud CI without a budget decision

Gates stay local. The cost analysis below is for that decision. The user's AMD PC (D8) is
already the dedicated local runner that analysis recommends, at no new cost.

### D8. Where builds and deploys run: the build machine, with per-repo homes as the fallback (user direction 2026-11-27)

One machine's serial night cannot hold six repos (D3 arithmetic). So the repos are split across
machines, and each machine runs its own window, in parallel with the others:

1. **A repo's gates, merges and deploys run only on its home machine.** Any session on any
   machine may develop on any repo and run the per-PR bar there. When a PR is ready, it tells
   the home machine's coordinator.
2. **One coordinator session per machine** (`release-manager`), owning only that machine's
   repos. Coordinators talk over the release bus (ADR 0991), never through each other's queue
   files. Each one writes its part of the morning report to the bus as a `kind: note`; the
   deployment-role holder (D10) collects them into one report for the user (D15).
3. **Different repos deploy to different servers**, so the bus's per-target deploy wait
   (ADR 0991) never blocks one machine on another. Its lease is the only cross-machine guard
   needed. Shared state stays read-only across machines.
4. **Upstream before adopters.** openwop-app releases to adopters by version, and each
   adopter's sync is a PR in that adopter's repo, gated on the adopter's home. A same-night
   openwop-app deploy and adopter deploys never touch the same server.
5. **Each machine is ready before its window:** gcloud signed in (the 2026-11-27 expiry blocked
   both deploys for hours: check `gcloud auth print-access-token` at 22:30 ET), `deploy.env`
   present, on AC, sleep disabled for the window, and no full gate or deploy started outside it.

6. **A new machine introduces itself on the bus, then works independently** (user direction
   2026-11-27). Its coordinator's first act is one note to everyone:
   `node scripts/lib/release-bus.mjs publish '{"kind":"note","from":"<session>@<host>","to":"*","re":"hello","text":"machine <host>; coordinator <session>; home repos: <list>; night window 23:00–06:00 ET"}'`.
   After that it coordinates with another machine **only when their work can collide**:
   - **the same repo** (two machines with PRs or gates on one repo; the home machine merges);
   - **the same deploy target** (the bus's per-target lease already serializes these);
   - **an upstream openwop-app change adopters consume**: an openwop-app release or tag, a
     registry pack publish (`packs.openwop.dev`), a conformance or spec pin bump, or a
     white-label publish. The openwop-app home announces it on the bus before it runs, and
     each adopter home schedules its sync PR after it is live;
   - **shared outside state**: a shared GCP project, a shared Cloud SQL database, or the
     release bus itself.
   Otherwise a machine never waits for or messages another. No status chatter: a note goes on
   the bus only for a hello, a collision, a deploy (the scripts already publish those) or the
   morning report.

> **CORRECTED 2026-11-27, same day (user direction): the AMD PC becomes the build and deploy
> machine for ALL apps, overnight and on demand, where possible.** The per-machine split below
> is superseded as the target. It stays as the fallback plan if the PC cannot hold every repo.
> The Macs become development machines: they write code, run the per-PR bar (D2) and send
> "ready", and they gate or deploy nothing routinely.

**The build machine (target).** One always-on AMD PC (Windows 11, Ubuntu 24.04 under WSL2) is the
home of every repo: openwop-app, casavoga, bookai, myndhyve, kicktodo and decktalk. Its coordinator
owns every night window and every requested deploy. Points 1–6 above still apply, with one home.

- **Parallel gates, capped.** "One full gate at a time" was the Air's memory limit, not a rule of
  the method. On the PC, gates run in containers with hard CPU and memory caps (`docker run
  --cpus N --memory M`), as many at once as the machine holds, under the machine-scoped
  tracegate-ci broker (D9). The first real gate per repo on the PC sets each one's cap.
- **Capacity.** Six repos at 45–110 minutes each need roughly 7 serial hours, the whole window.
  At two or three parallel gates the night fits with room for bisects. **The PC's cores and RAM
  decide this**: as a rule of thumb, 16 cores and 64 GB run three gates at once. To be measured.
- **Deploys.** Each app deploys to its own GCP or Firebase project, so deploys may run at once;
  the bus's per-target wait still guards a server. A deploy the user requests goes next (D4).
- **Credentials.** One machine now holds deploy rights for every app. Use one least-privilege
  service account per app project (not one broad account), keep `deploy.env` per repo at mode
  600, keep BitLocker on, and keep the PC on its own Windows account.
- **Migration, one repo at a time.** Each repo moves after an acceptance check: one commit gated
  on its current machine and on the PC with the same verdict, one requested deploy verified, one
  unattended night. Order: **decktalk** (it gains native x86 and drops Cloud Build), then **bookai**
  (the smallest gate), **myndhyve**, **kicktodo**, **casavoga** (the heaviest batches), and
  **openwop-app** last (certify cuts, conformance, the white-label publish).
- **Fallback.** While the PC is down, any Mac can still gate and deploy a repo by hand on the
  user's request, using the same scripts. Nothing on the PC is required by the scripts.

Fallback split, if the PC cannot hold every repo:

| Machine | Repos (gates, merges, deploys) | Why |
|---|---|---|
| The CasaVoga machine (new, dedicated) | casavoga | The user's choice. CasaVoga has the heaviest suite and the most batches. |
| MacBook-Pro-48 | openwop-app (openwop-dev deploys, certify cuts, the white-label release) | The largest suite and the upstream; it already runs openwop-app gates. |
| Davids-MacBook-Air | bookai, myndhyve, kicktodo | Smaller suites (Book AI's gate is about 5 minutes); they fit one serial night. |
| An AMD PC (Windows 11, Ubuntu 24.04 under WSL2, always on) | decktalk | Native x86: its pinned visual baselines render as in Cloud Build (the Air renders them wrong under Rosetta). User direction 2026-11-27: DeckTalk moves from Cloud Build gates to local builds here. |

**The AMD PC setup** (the shareable release page has the full checklist): BIOS virtualization on; a
never-sleep power plan; Windows Update active hours 06:00–23:00 with no automatic restarts in the
window; Tailscale for remote access; WSL2 Ubuntu 24.04 with systemd, most of the RAM and cores,
started at boot, repos on the Linux disk; Node 22 with `npx -y npm@10.9.8 ci`, gh, gcloud,
firebase-tools, Docker, Postgres 15 and DeckTalk's pinned Playwright Chromium; a deploy service
account scoped to `decktalk-prod` (the user's choice) and `deploy.env` at mode 600; a systemd timer
on America/New_York time for the window; one bus hello. Acceptance: one DeckTalk commit gated in
Cloud Build and on the PC with matching verdicts and screenshots, one requested deploy verified,
one unattended night with its morning report, and a reboot that recovers by itself. An optional AI
coordinator there (OpenCode with DeepSeek) runs a shadow week first, merging and deploying nothing,
and never holds deploy approvals of its own. Until the PC passes its acceptance gate, DeckTalk's
Cloud Build gates continue only if the user approves that spend (about $0.70 a gate).

### D9. tracegate-ci changes upstream (davidscotttufts/tracegate-ci)

Measured cause of the daemon collisions: the broker's socket and queue are keyed by **ledger
path** (`src/broker/paths.mjs`), so each repo's vendored copy runs its own broker. A CasaVoga
gate and openwop-app's daemon never saw each other. Upstream changes, in order:

1. **One broker per machine.** Default the socket and queue to a host-scoped path (for
   example `$HOME/.tracegate/broker-<host>.sock`), with per-ledger state kept inside it, so
   every repo's gates, daemons and per-PR checks share one queue. This replaces this ADR's
   stopgap `heavy.sh` slot. The daemon can come back once it holds.
2. **A per-PR mode** (`tracegate pr <base>..<head>`): the PR's own changed and added tests,
   its must-run set and the always-run ratchets, as one command that prints a ready verdict.
   This is D2 as a tool, the same in every repo.
3. **Recurring window reservations** in the broker (it already has one-off reservations with
   backfill): a `night` class that starts only inside a configured window and runs serially.
4. **Not in tracegate-ci:** deploys, merges and approvals. Those stay in each repo's scripts
   and with the user.

### D10. Any machine can take over as the deployment machine (user direction 2026-11-27)

"Deployment machine" is a **role**, not a property of one host. Any machine may take it at any
time; tracegate-ci holds it (a second PR, after #29's machine-scoped broker):

1. **A cross-machine role with fencing.** `tracegate role claim|renew|release|handover|take|status|check`.
   Each change bumps a monotonically increasing **epoch** and leaves an audit record: who, which host,
   when, why, and the previous holder. A role is global (`deployer`) or per repo
   (`deployer:casavoga`, which overrides the global one for that repo).
2. **Stored where every machine reaches it, with compare-and-swap:** a GCS object with a generation
   precondition (the release bus bucket), a git ref pushed with `--force-with-lease` (no cloud
   account needed), or a file store for tests. When two machines race, exactly one wins.
3. **Planned or forced.** `handover --to <host>` is the clean move. `take --reason "…"` works even
   from a live holder: a machine that is down or unreachable never blocks the deploy role.
4. **Fencing protects production.** A deploy runs under `tracegate lease --class deploy --role <role>`,
   which refuses unless this host holds the role at the current epoch, and exports
   `TRACEGATE_ROLE_EPOCH`. Right before its irreversible step (the traffic shift), the deploy calls
   `tracegate role check <role> --epoch N`, so a machine that lost the role mid-deploy stops before
   shipping. A takeover never kills the old holder's running deploy; it just cannot start another.
5. **Readiness before taking.** `claim`, `take` and `handover` run the role's `preflight` on the
   claiming machine (sign-ins valid, `deploy.env` present, tools at the pinned versions) and refuse on
   failure. `--skip-preflight` exists, is loud, and is audited.
6. **The night follows the role.** The night run starts only on the role holder. The repo homes
   in D8 are the default holders, not a fixed assignment.
7. **Holding the role is never an approval.** Deploys still need the user's yes in the deploying
   session, or a standing approval the user wrote on that machine.

### D11. Sign-ins on the deployment machine (user direction 2026-11-27)

Expired sign-ins blocked two deploys for hours on 2026-11-27. On an unattended machine:

1. **Check before the window.** At 22:30 ET the deployment machine runs the role's preflight (D10
   point 5; tracegate-ci ships `examples/preflight-signins.sh`). It checks Google Cloud
   (`gcloud auth print-access-token`), Firebase (`firebase projects:list`) and GitHub
   (`gh auth status`), and posts a bus note naming any that failed.
2. **Renew from the Mac, headless.** Connect over Tailscale SSH, then on the deployment machine:
   - **Firebase:** `firebase login --reauth --no-localhost`. Open the printed link on the Mac,
     sign in, and paste the code back.
   - **Google Cloud:** `gcloud auth login <account> --no-browser`. It prints a
     `gcloud auth login --remote-bootstrap=…` command: run that on the Mac, sign in, and paste the
     output back. If a tool needs application-default credentials, repeat with
     `gcloud auth application-default login --no-browser`.
   - **GitHub:** `gh auth login`, entering the printed code at `github.com/login/device`.
3. **Stop renewing by hand.** Give each app project its own least-privilege service account key on
   the deployment machine, at mode 600, wired in through `GOOGLE_APPLICATION_CREDENTIALS` for that
   app's deploy. Those keys don't expire overnight. Rotate them on a schedule, and revoke at once
   if the machine is lost. Which accounts and roles is the user's decision.

## Proposed amendments (review, 2026-11-27; each needs the user's yes)

A review of D1–D11 found five gaps an unattended night exposes. Each is **Proposed** until the
user accepts it.

### D12. Verify or roll back (Proposed)

A night deploy has no one watching. If its verify step fails (the commit stamp, readiness, the
site bundle's content types), the deployer shifts traffic back **by name** to the kept previous
revision at once (`update-traffic --to-revisions <previous>=100`), confirms the old commit is
serving, and reports. It never retries a failed deploy in the same night. Today's deploys
already keep the previous revision, so this adds a rule, not a mechanism.

### D13. A deploy cutoff (Proposed)

No production deploy **starts** after 05:00 ET. A deploy needs about 30 minutes to build,
shift and verify, and a problem found at 05:55 would sit unnoticed until the user wakes. A
batch that merges after the cutoff deploys the next night, or on request.

### D14. Migrations need their own yes (Proposed)

A deploy that runs a schema or app migration, or any other irreversible data change, is never
covered by a standing nightly approval. It needs the user's yes for that deploy, naming the
migration, and a database backup first. Rollback (D12) cannot undo a migration, which is why.

### D15. The morning report reaches the user (Proposed)

A bus note is invisible to the user. At 06:00 ET the deployment-role holder writes the morning
report to the shared release page: per repo, what merged (PR, sha), what deployed (revision,
verified), what was pulled and why, what spilled to the next night, and what needs the user. It
also sends one phone notification with the headline. The bus keeps the machine-readable copy.

### D16. One automatic rerun for an infrastructure-shaped red (Proposed)

A red whose failing files pass when run alone at the same tree, and whose output shows a timeout
or a memory or worker error (the tracegate recheck already classifies this), gets **one**
automatic rerun of the whole gate before any bisect. A second red bisects as usual. A red that
fails alone is never rerun. Every rerun is recorded in the morning report, so a recurring flake
gets fixed rather than tolerated.

### How we'll know it works

Measured from the queue log and the morning reports, reviewed after two weeks:

- **The user's release time:** a few minutes a day reading the morning report and giving yeses.
- **Reds per night:** at most one across all repos. More means the D2 bar is being skipped.
- **Ready to live:** a PR that is ready by 22:30 ET is live by 06:00 ET the next morning, on at
  least 9 nights in 10.
- **Spill:** at most one repo's batch spills per night. More means the build machine needs more
  parallel slots (D8).
- **Daytime contention:** no false reds from memory pressure in per-PR checks (`heavy.sh`, then
  the machine broker).

## Cost analysis (prices read 2026-11-27)

Unit prices: Cloud Build e2-highcpu-8 **$0.0156/min**, e2-highcpu-32 **$0.0624/min**; the free
2,500 min/month covers only e2-standard-2 in the default pool
([pricing](https://cloud.google.com/build/pricing)). GitHub Actions Linux 8-core
**$0.022/min**; larger runners need the Team plan
([GitHub](https://docs.github.com/en/billing/reference/actions-runner-pricing)). Refurbished
Mac mini M4 Pro 48 GB **$2,039** ([Apple](https://www.apple.com/shop/product/g1kzcll/a)); a
64 GB Ryzen mini PC about **$799** (unverified sale price).

Scenarios, 60-minute gates, 30 nights: **(a)** the nightly window, 6 gates a night = 10,800
min/month; **(b)** (a) plus 3 on-demand gates a day = 16,200; **(c)** today's pattern, 20 a
day = 36,000.

| Monthly | (a) | (b) | (c) |
|---|---|---|---|
| Cloud Build e2-highcpu-8 | $168 | $253 | $562 |
| Cloud Build e2-highcpu-32 (assumed 24-min gates) | $270 | $404 | $899 |
| GitHub 8-core runner, Team plan | ~$220 | ~$338 | ~$774 |
| Mac mini M4 Pro 48 GB, over 24 months | $85 | $85 | $85 |
| Ryzen mini PC 64 GB, over 24 months | $33 | $33 | $33 |
| The Air (today) | $0 | $0 | $0 (paid in waiting and false reds) |

Cross-check: DeckTalk's Cloud Build gates (about 45 min on e2-highcpu-8) should cost about
$0.70 each. Its real bill is a better number than this table. The faster-machine speedups are
assumptions until one real gate is measured.

**Conclusion:** D1–D4 cost nothing and should remove about half or more of the daily gate
demand. When there is budget, a dedicated local runner is cheaper than cloud CI in every
scenario above about 5,400 gate-minutes a month, and it frees the Air for development. Cloud
Build fits only as overflow.

## Alternatives considered

- **Keep daytime trains, just add the per-PR bar.** Fewer reds, but the Air stays busy all
  day and the user still waits. Rejected as the default; it is what the on-demand lane is for.
- **Cloud Build for every gate now.** About $170–$560 a month at our volumes. Rejected for now
  by the user (no budget).
- **Hosted GitHub Actions.** Needs the Team plan and costs more per minute than Cloud Build
  here. Rejected.
- **A dedicated runner now.** The best value when budget exists (D7). Deferred to the user.

## Implementation plan

| Phase | What | Status |
|---|---|---|
| P0 | Tracegate daemon uninstalled on the Air; release-manager skill §0b; this ADR | done 2026-11-27 |
| P1 | Announce the model to every session and other machines (bus note + shared page) | done 2026-11-27 |
| P2 | First nightly window, on the Air: Book AI #399 #400, MyndHyve #114 #90, KickTodo sync, openwop-app (#6300 #6278 #6302 #6304 #6305 #6306 #6303), CasaVoga gate B (two trains), DeckTalk #108 merge | tonight, 2026-11-27/28 |
| P2b | The AMD PC as the build machine for all apps (D8): set it up, then move repos one at a time (decktalk, bookai, myndhyve, kicktodo, casavoga, openwop-app), each after its acceptance check | as the PC comes up |
| P2c | tracegate-ci: a machine-scoped broker (#29), then the deployer role (#30, D10), then a `pr` mode and night windows (D9) | #29 MERGED 00659b9f2d, #30 MERGED 0233e14533 (2026-11-27, all GitHub checks green); the repos' vendored copies still need the upgrade; `pr` mode and night windows open |
| P3 | The D2 bar as one command in every repo | merged into D9 point 2 (`tracegate pr`): one tool, not two |
| P4 | A night driver: runs the window's queue serially, bisects, deploys where approved, writes the morning report | open |
| P5 | Daemon fix | superseded by D9 point 1 (#29) |
| P6 | A dedicated runner | the user's AMD PC (D8); measure one real gate on it first |

## Open decisions (the user's)

- [ ] A standing nightly approval per repo (D5), given in each deploying session.
- [x] The window's hours: 23:00–06:00 ET (user, 2026-11-27).
- [x] The AMD PC builds and deploys all apps, where possible (user, 2026-11-27).
- [ ] The PC's cores, RAM and disk, which set how many gates run at once.
- [ ] One service account per app project for the PC's deploys, or the user's own sign-in.
- [ ] DeckTalk's Cloud Build spend until it has a home machine (D8).
- [ ] A budget for a dedicated runner (D7, P6). Likely moot: the AMD PC is that runner.
- [ ] D12–D16, the review's proposed amendments.
