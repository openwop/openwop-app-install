# ADR 0530 — Deploys are gated on freshness, not serialised by a lock

Status: implemented

## Context

ADR 0518 closed with two open questions, both from the 2026-08-03 incident where
two sessions deployed within minutes of each other and the second silently
reverted the first, once per half:

1. Concurrent deploys are still unserialised — visibility is not prevention.
2. Nothing forces the commit stamp or the verification to actually run.

The obvious answer to (1) is a lock, and four mechanisms were weighed:
a Postgres advisory lock on the app's own Cloud SQL, a CAS on a Cloud Run
service label, a GCS object with generation-match preconditions, and a local
file lock.

**All four are the wrong tool, and the framing that produced them was wrong.**

Replay the incident under a lock. Session A takes the lock, deploys commit X,
releases. Session B takes the lock, deploys commit Y — which is *behind* X. B
still clobbers A; it just does so politely, one at a time. Mutual exclusion was
never the violated property.

The violated property is **monotonicity**: production moved backwards. And the
rule that would have caught it already existed, in `CLAUDE.md`: *"Deploy from a
CLEAN `origin/main` checkout."* Session B was deploying a worktree whose HEAD was
not `origin/main`'s tip, after the newer commit had already merged. The rule was
written; nothing enforced it.

Three further findings made the lock options worse than merely useless:

- **A lock owner already exists.** `backend/typescript/src/host/seedLock.ts`
  implements exactly this pattern — `kvCompareAndSwap` claim, TTL-based steal of
  an orphaned lock, a `withSeedLock()` wrapper, 409 on contention. Building a
  second one would have been the "parallel system" violation `ARCHITECTURE.md`
  exists to prevent. (It also settles the stale-lock question for free: if a lock
  is ever genuinely needed here, extend that module.)
- **The advisory-lock option is disqualified on its own terms.**
  `pg_advisory_lock` pins a pooled connection for the ~8-minute duration of a
  Cloud Build, against a budget of `PG_POOL_MAX=4 × max-instances 5 ≈ 20`. It
  would risk a real availability incident to buy a property we do not need.
- **Every lock adds an outage mode we do not have today** — a crashed session or
  an agent that never releases wedges all deploys, including the deploy that
  would fix it.

## Decision

**Gate deploys on freshness, and make the ADR 0518 stamp + verification
structural. No lock.**

### `scripts/preflight-deploy.sh` — three gates, run *before* the 8-minute build

1. **HEAD == `origin/main`'s tip** (after `git fetch`). This is the gate that
   catches the real incident; everything else is defence in depth.
2. **Working tree clean.** A SHA does not describe a tree with uncommitted
   changes on top. ADR 0518 detects this after the fact via `dirty:true`; this
   moves it before the build.
3. **The live commit is an ancestor of HEAD.** Production never moves backwards.
   Reads `build.commit` from `/api/readiness` — the surface ADR 0518 shipped.

### `scripts/deploy.sh` — the wrapper, which answers (2) by construction

`preflight → backend → frontend → verify`, in that order, with the stamp
computed rather than remembered. It encodes the two orderings that have each
caused a real incident: backend before frontend, and preflight before the build.
It passes only the merge flag `--update-env-vars`, never `--set-*`.

### The anti-lockout rule (the part that is easy to get wrong)

Gate 3 **must not hard-block** when the live commit is unreachable or `unknown`.
A broken backend is very often *why* you are deploying, and a preflight that
walls the operator out of the fix would be the tool causing the outage it exists
to prevent. Those cases warn and require an explicit `--allow-unverified-live`,
so the exception is stated rather than silently assumed in either direction.

> **CORRECTED 2026-09-07 — the "unreachable" branch was reachable by a HEALTHY
> backend.** Gate 3 read `/api/readiness` with `curl -f`, and `/api/readiness`
> answers **503 whenever `status: degraded`** — a normal serving state (no
> managed AI key seeded is the usual cause) whose body still carries
> `build.commit`. `-f` discarded that body, so a degraded-but-serving backend
> landed in this branch and the message named two causes ("backend down, or
> pre-ADR-0518") that were both wrong. MEASURED by the first white-label adopter
> to run the gate: forced onto `--allow-unverified-live` on every deploy. The
> gate now reads the body whatever the status code, branches on the PARSED
> commit, and says what it observed when nothing parses. A degraded backend is
> exactly when the live commit matters most — it is the state you deploy to fix.
> The anti-lockout rule above is unchanged; it now applies only to the cases it
> was written for.

## Adopter safety — why the wrapper carries no defaults

`scripts/build-whitelabel-zip.sh` builds the adopter bundle with
`git archive HEAD`, stripping `.claude/`, `.agents/`, `.github/`,
`docs/steward/`, `docs/research/`, a root-markdown allowlist, and steward report
families. **`scripts/` is not stripped**, and `publish-install-repo.sh` pushes
the same tree to the public install repo. A `deploy.sh` with
`openwop-app-backend` / `openwop-dev` / `admin@myndhyve.ai` baked in would ship
our deploy topology to every adopter.

So the topology lives in `scripts/deploy.env`, which is **gitignored** — and
therefore invisible to `git archive` — with `deploy.env.example` shipped
alongside. This is the mechanism the repo already uses for `.env` / `.env.example`.
`deploy.sh` has **no defaults** and refuses to run on an unset variable: a
wrong-but-plausible default deploys someone's code to someone else's project.

## Alternatives weighed

| Option | Prevents the actual failure | New infra | New outage mode | Adopter-safe |
| --- | --- | --- | --- | --- |
| pg advisory lock | No | none | stale lock + **pool exhaustion** | No (assumes Cloud SQL) |
| Cloud Run label CAS | No | yes | stale lock | No (assumes Cloud Run) |
| GCS object lock | No | yes | stale lock | No (assumes GCS) |
| Local file lock | No | none | — | No (does not cross machines) |
| Visibility only (ADR 0518) | No | — | — | Yes |
| **Freshness preflight** | **Yes** | **none** | **none** | **Yes** |

## Trade-offs accepted

- **A wrapper sits between operators and `gcloud`.** Mitigated by keeping
  `preflight-deploy.sh` independently runnable and leaving the raw recipe in
  `DEPLOY.md`; the wrapper is a convenience that cannot forget, not a gate you
  must pass through.
- **The preflight is advisory unless run.** `deploy.sh` runs it; a hand-typed
  `gcloud run deploy` still bypasses everything. Closing that fully needs a
  server-side admission check, which is a materially larger decision.
- **A real TOCTOU window remains.** Two sessions both at the tip, both starting
  before either lands, still race — gate 1 passes for both. This is now the
  *only* surviving path to the original failure, and it requires both sessions to
  be current, which makes the outcome a no-op rather than a revert. If it ever
  bites for real, that is the evidence that justifies a lock — and `seedLock.ts`
  is the module to extend.

## Implementation record

| What | Where | Test |
| --- | --- | --- |
| Freshness gates | `scripts/preflight-deploy.sh` | `scripts/test-deploy-gates.sh` |
| Deploy wrapper | `scripts/deploy.sh`, `scripts/deploy.env.example`, `.gitignore` | — |
| Gate suite in CI | `scripts/ci.sh` | self |
| Recipe | `DEPLOY.md`, `CLAUDE.md` | — |

`scripts/test-deploy-gates.sh` runs against fixture git repos and a local stub,
touching nothing real, and is wired into `npm run ci` before the backend build
(~2s, no build needed). It asserts the incident case (`HEAD` behind
`origin/main`) refuses, and — equally important — that an unreadable live commit
does **not** silently pass and does **not** wall the operator out.

Three harness defects were found and fixed while writing it, each worth recording
because each produced a convincing FALSE failure — the failure mode a test suite
can least afford:

1. Copying the script under test *into* the fixture repo tripped the dirty-tree
   gate on the harness's own contamination.
2. Capturing `$!` of a subshell rather than the stub server left an orphan
   squatting the port; it then 404-ed every subsequent run and looked exactly
   like three real gate failures.
3. The stub bound a HARD-CODED port. On this machine, where parallel sessions run
   `npm run ci` concurrently, a peer's own static server was already listening on
   it — so the suite refused to run at all. A test that competes for a fixed port
   is flaky by construction.

The stub now binds an **ephemeral** port and reports it back, so it can neither
collide with a peer nor inherit an orphan. Defect 3 is the one that generalises:
this repo is routinely worked by several sessions at once, and any new test that
needs a port must not pick one.

## Open questions

1. **Server-side admission.** Nothing stops a hand-typed `gcloud run deploy`.
   A Cloud Deploy approval step, or a Cloud Build trigger that is the only
   principal with `run.admin`, would make the gate unbypassable. Larger change,
   and it interacts with the deliberately-disabled hosted CI.
2. **Wire:** none. `/readiness` appears nowhere as a path in `../openwop/spec/v1/`
   or `api/openapi.yaml`, and `production-profile.md` mandates no health-endpoint
   shape — so this is host-local tooling and needs no RFC. Verified, not assumed.
