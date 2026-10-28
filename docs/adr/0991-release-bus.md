# ADR 0991 — The cross-machine release bus

Status: Accepted (P1 implemented 2026-10-26; P2, notes between sessions, implemented 2026-10-27; P3, the per-target deploy queue, implemented 2026-10-27)

## Context

The release queue (`<git-common-dir>/release-queue.md`) lives in one
checkout's `.git` directory. A session on the other Mac, or a cloud session,
cannot see it, so it cannot tell that a gate or a deploy is running.

On 2026-10-12, a second machine merged five PRs and deployed production while a
merge-train gate ran here. The gate went green and then had to refuse to merge,
because main had moved. Code that had not passed a full gate reached
production. The release-manager skill (§ 0a) asks other machines to comment on
PRs. That reaches a person, but no script reads it.

The user approved a shared, readable record on GCS, relayed by the release
manager (openwop-app-14). It must stay **advisory**: AGENTS.md (#4762) forbids
any freeze, hold or lock that stops another session or machine from merging or
shipping.

## Decision

**D1 — One bucket, two shapes.** `gs://openwop-dev-release-queue` (openwop-dev,
us-central1, public access prevented, uniform access) holds:
- `queue.json`: `{version, coordinator, slots[], active[], production, updatedAt}`.
  `active[]` holds one lease per running gate, deploy or certify cut. An entry
  carries `host`, `session` (`CLAUDE_CODE_SESSION_ID`), `kind`, `prs`, `base`,
  `tree`, `commit`, `startedAt`, `expectedEndAt` and `leaseUntil`.
  `production` is `{commit, revision}`.
- `events/<YYYYMMDDTHHMMSSZ>-<host>-<rand>.json`: one JSON object per start,
  rebuild, result or end. Written create-only (`--if-generation-match=0`).
  A lifecycle rule deletes `events/` after 90 days.

The infrastructure was created by the release manager. This ADR covers only the
code that reads and writes it.

**D2 — Optimistic concurrency, no lock.** `queue.json` is read pinned to its
generation (`describe`, then `cat queue.json#<gen>`). It is written with
`--if-generation-match=<gen>`. A 412 means another machine wrote in between:
re-read, re-apply the change, retry until the deadline. Nothing ever waits on
another machine's entry.

**D3 — A lease is about twice the typical duration, and an expired lease is
STALE.** The typical durations are gate 45 min, deploy 16 min and certify 10
min. A crashed train or a closed laptop lid leaves an entry that reads `STALE`,
never held. Writes drop entries more than a day past their lease.

**D4 — Never block, never fail the caller.**
- `scripts/lib/release-bus.mjs` has one overall deadline
  (`OPENWOP_RELEASE_BUS_TIMEOUT_MS`, default 10 s) enforced in Node: this
  machine has no `timeout(1)`.
- It always exits 0. No gcloud, no login, offline, a hung call or a malformed
  `queue.json` all print `release-bus: unavailable (<reason>)`.
- `OPENWOP_RELEASE_BUS=off` makes it call nothing. `OPENWOP_RELEASE_BUS_BUCKET`
  selects the bucket.
- The shell side (`scripts/lib/release-bus.sh`) returns 0 from every function
  and writes to stderr. Its EXIT hook **chains** onto the caller's existing
  EXIT trap, which is where the train lock and `deploy.sh`'s build cancel
  live, and never calls `exit`, so the caller's exit status is unchanged.

**D5 — Who writes.**
- `merge-train.sh` holds a `gate` lease while it gates. It publishes `start`,
  `rebuild` (main moved) and `result`, with the merged PRs, the red PRs,
  `RED #N` or `GREEN`, base, tree and the new main. `--dry-run` publishes
  nothing.
- `deploy.sh` holds a `deploy` lease and publishes `start` and `end`, with
  commit, revision and `VERIFIED` or `FAILED`. It calls `set-production` only
  after `verify-deploy.sh` passes.
- `publish-evidence.sh` holds a `certify` lease and publishes `start` and
  `end`.

> **CORRECTED 2026-10-27 (D9, user decision): a deploy, certify cut or
> update-env now ACQUIRES its targets rather than claiming.** See D9. A gate
> still claims and never waits.

**D6 — Who reads, and only to warn.**
- `preflight-deploy.sh` (after its gates) and `merge-train.sh` (before gating)
  print `WARN release-bus: another machine holds a live lease — …` for another
  host's live gate or deploy lease. They never refuse.
- The release-manager skill's `status.sh` prints `release-bus status` for the
  last two hours.

**D7 — Tests never write to the real bucket.** `ci.sh` and every test that runs
a hooked script export `OPENWOP_RELEASE_BUS=off`. The bus's own test turns it
back on against a fake `gcloud`.

**D8 — Notes: any session may talk to any other (user rule, 2026-10-27).** The
user widened the bus beyond coordinators: every agent on every machine may post
to and read from sessions on the other machine when its work needs it.
- A note is an event: `{kind: "note", from, to, re, text}`, written create-only
  like every other event. That is the shape the release manager's stopgap
  `~/.openwop-bus/note.sh` already wrote, so its notes stay readable.
- `release-bus.mjs note --to <session|*> --re <PR-or-slot> [--from <name>] -- <text>`
  posts one. The sender is `--from`, else `NOTE_FROM`, else `USER`, with
  `@<host>`.
- `notes [--for <name>] [--minutes N]` reads them. A note is for `<name>` when
  it is to `*`, to `<name>`, or to `<name>` without its `@host`. `status`
  prints each note with its sender, recipient, subject and text.
- **A note asks or tells. It never approves and never holds.** Approval comes
  only from the user in the session that acts.
- **No secrets, DSNs or PII.** A note whose text matches a credential or
  connection-string shape (private keys, `sk-`/`sk_live_`, AWS, GitHub, Slack
  and Google key shapes, `scheme://user:password@host`) is not sent, and the
  refusal says why. That is a guard, not a scanner: the rule binds the author.
  Text over 2,000 characters is refused, so link the PR instead.
- It stays advisory like the rest (D4). An unreachable bus prints `unavailable`
  and exits 0.

> **CORRECTED 2026-10-27 (D9):** `preflight-deploy.sh` now passes its deploy's
> targets, so another machine's release to a DIFFERENT server is an `INFO`
> line, and only a lease on one of ours is a `WARN`. It still never refuses.

**D9 — Deploys queue per TARGET (user decision, 2026-10-27).** The user's
words, relayed by the release manager (openwop-app-14): *"each server has its
own setting in the message queue, so we only queue deploys if there is an
active deploy already on a given server"*. That narrows the advisory-only rule
(D4, AGENTS.md #4762) for exactly one case: two releases to the SAME server.
Releases to different servers run at the same time; gates never wait.

> **CORRECTION NOTE to D2 and D4, 2026-10-27.** D2 said "nothing ever waits on
> another machine's entry" and D4 said the bus never blocks. Both still hold for
> gates, notes, status and every other command. They no longer hold for
> `acquire`, which waits, bounded and fail-open as below. No freeze, ruleset or
> hold stops a merge, and nothing waits indefinitely.

- **Targets are derived, never typed.** `release_bus_targets` (in
  `release-bus.sh`) reads `deploy.env`: the backend is
  `run:<OPENWOP_DEPLOY_PROJECT>/<OPENWOP_DEPLOY_REGION>/<OPENWOP_DEPLOY_SERVICE>`
  and the frontend is
  `hosting:<OPENWOP_DEPLOY_FIREBASE_PROJECT>/<OPENWOP_DEPLOY_HOSTING_TARGET>`.
  A release claims only the targets it touches (`--backend-only` and
  `--frontend-only` drop one). A half whose values are unset contributes
  nothing, and nothing waits on it.
- **Who acquires.**
  - `deploy.sh` acquires its targets.
  - `publish-evidence.sh` acquires `run:` only: a cut LOADS the backend, so a
    cut and a deploy on the same service collide.
  - `update-env.sh` acquires `run:` only: it mints a revision and shifts
    traffic (CE-16).
  - A lease from an older checkout that has no `targets` is read as the app's
    own backend (`OPENWOP_RELEASE_BUS_LEGACY_TARGET`, default
    `run:openwop-dev/us-central1/openwop-app-backend`), so a mixed fleet still
    collides correctly.
- **The queue is FIFO and its first place is decided atomically.**
  - A waiter writes a `waiting` entry. The entry has a fixed `queuedAt` and a
    short lease (the larger of 2 min and 3 polls), which it renews once per
    poll (`OPENWOP_DEPLOY_QUEUE_POLL_S`, default 30 s).
  - It becomes `running` only inside the generation-matched write (D2), checked
    against the snapshot that write replaces. It must find no live running
    lease on a shared target, and no live waiter ahead of it by (`queuedAt`,
    id).
  - So two simultaneous acquirers cannot both go first, and a later arrival
    cannot jump an earlier waiter.
  - A running lease always counts as ahead.
  - A crashed waiter holds nobody up for longer than its short lease.
- **Bounded and fail-open.**
  - After `OPENWOP_DEPLOY_QUEUE_MAX_MIN` (default 60) the release PROCEEDS with
    a `WARN` that names the holder.
  - An unavailable bus proceeds.
  - A STALE lease never blocks.
  - `OPENWOP_DEPLOY_QUEUE=off` claims without waiting.
  - A 412 storm (other writers) keeps the release queued rather than reading as
    "unavailable, proceed". Each bus call keeps its own 10 s deadline; the wait
    does not.
- **Where the deploy waits.** `deploy.sh` acquires BEFORE `preflight-deploy.sh`.
  A deploy that waited must check that the live commit is an ancestor of its
  own AFTER the wait, when the deploy it queued behind has just shipped. Its
  lease is `--ttl-min 75`: certify, the ADR 0802 hour hold and the build can
  outrun twice 16 minutes, and a lapsed lease would let a second deploy in.
  `--preflight-only` claims nothing.
- **A certify run by a deploy does not queue behind it.** `deploy.sh` exports
  its lease id as `OPENWOP_RELEASE_BUS_PARENT`, and `acquire` exempts that
  exact id. It never matches a prefix.
- **Production is per target.** `set-production --target t` writes
  `productions[t]`. The legacy `production` key is still written for the app's
  own backend, so older checkouts read it. `status` prints each target's
  production and its live leases.

## Alternatives weighed

- **A GCS lock that a deploy or train waits on.** Rejected by AGENTS.md (#4762).
  A lock would also not have prevented 2026-10-12: that deploy shipped OLDER
  code, and serialising it changes nothing (the ADR 0530 lesson).
- **GitHub (PR comments, a pinned issue) as the bus.** It is already the human
  channel (§ 0a). As a machine record it is rate-limited, slower to read, and
  has no conditional write, so two writers would lose each other's updates.
- **A database row in production.** That puts release coordination on the
  thing being released: a broken deploy would hide its own state.
- **One object per lease instead of one `queue.json`.** That needs no CAS, but
  a reader must list and fetch every lease, and `production` would need its
  own object anyway. A single small document with a generation precondition
  is simpler, and contention is a handful of writes an hour.

## Implementation

| Phase | What | Evidence |
| --- | --- | --- |
| P1 | `scripts/lib/release-bus.mjs` (`publish`, `claim`, `release`, `set-production`, `status`, `warn-others`); `scripts/lib/release-bus.sh` (`release_bus`, `release_bus_hold`); hooks in `merge-train.sh`, `deploy.sh`, `publish-evidence.sh`; advisory reads in `preflight-deploy.sh`, `merge-train.sh` and the release-manager `status.sh`; skill § 0a rule 6 (and its `.agents` mirror) | `scripts/test-release-bus.sh` (gate-tooling lane, fake `gcloud`, offline), 49 checks: a 412 retries; an endless 412 gives up at the deadline with exit 0; events are create-only; no login, a hung gcloud and no gcloud are each `unavailable` with exit 0 and within the deadline; `off` calls nothing; stale vs live, other host vs ours; the hook keeps the caller's exit status and its previous EXIT trap under every bus mode; `merge-train.sh` exits the same, green and red, with the bus working, unauthenticated, hung or off, and releases its train lock and lease. Six sabotage witnesses, each red |
| P2 | D8 notes: `note`, `notes`, and notes in `status`; skill § 0a rule 7; retires the stopgap `~/.openwop-bus/note.sh` (after the merge it forwards to this script) | `scripts/test-release-bus.sh`, 60 checks. New: a note is posted; `notes --for` reads notes to that session with or without `@host` and to `*`, never another's; `status` prints a note's sender, recipient and text; three secret shapes are NOT sent; a note without text is refused; an unreachable bus exits 0. Three new sabotage witnesses, each red |

| P3 | D9 per-target deploy queue: `acquire`, `targets[]`, `waiting`/`running` states, per-target `productions`, `warn-others --targets`; `release_bus_targets` and `release_bus_acquire_hold` in `release-bus.sh`; `deploy.sh` (acquire before preflight, parent id, per-target production), `preflight-deploy.sh`, `publish-evidence.sh` (acquire before the cut lock), `update-env.sh` | `scripts/test-release-bus.sh`, 92 checks. New: different targets proceed at once; the same target queues, says on whom and which target, then proceeds; two simultaneous acquirers, exactly one runs (the fake `gcloud`'s conditional write is now atomic, as GCS's is); FIFO; a stale lease never blocks; the max wait proceeds with a WARN; the parent exemption is the exact id; `OPENWOP_DEPLOY_QUEUE=off`; a pre-targets lease blocks only the app's backend; an unavailable bus proceeds; a 412 storm keeps queueing; per-target production with the legacy key; WARN vs INFO by target; target derivation. Five sabotage witnesses, each red: no shared-target collision, waiters never block (FIFO), stale leases block, a prefix parent match, a 412 timeout read as unavailable. The last one was a real bug found by the test before the fix |

### Correction — an interrupted train must report an interrupted result (2026-10-27)

The Air's PR #5330 merge gate was terminated by its memory guardian at
20:56:47Z (4:56:47 PM ET), exit 143, before a full verdict. Its EXIT hook
nevertheless published GREEN. A controlled Bash reproduction terminated with
SIGTERM while the hook observed `$? == 0`. The immutable event is retained;
a correction note was posted. The earlier candidate preflight remains separate
evidence and does not make this interrupted composition green.

`merge-train.sh` now handles TERM and INT with explicit exits 143 and 130,
respectively, before its existing bus, claim and train-lock cleanup hooks.
The offline bus fixture checks both signals: no merge, no GREEN event, the
matching STOPPED result, and lease/lock cleanup. Before integrating D9, all 72
bus checks passed; removing only those signal handlers made four checks fail, including
the reproduced false GREEN on TERM. After integrating D9 from #5319, all 104
bus checks passed with the interruption regressions retained. The full application
gate remains required before this repair lands.

## Open questions

1. **CLAUDE.md note.** The § "Working in parallel sessions" note was requested
   by the release manager. A session does not edit CLAUDE.md on a peer's
   request, so the text is in the PR description for the user to apply or
   approve.
2. **CLAUDE.md, again (D9).** The "release bus" bullet must say deploys now
   queue per target. The user asked the release manager directly, so that
   session lands the bullet. The text is in this PR's description.
3. **Cloud sessions without gcloud.** They read nothing until they have a
   credential with `storage.objects.get` on the bucket. A read-only service
   account for them is a separate decision (no account creation here).
