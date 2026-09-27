# ADR 0518 — A running deploy must be able to say which commit it is

Status: implemented

## Context

On 2026-08-03, deploying ADR 0517 went wrong twice in one hour, in the same way
both times.

The backend was deployed from a clean `origin/main` worktree and verified: the new
route answered, readiness was 200. Minutes later a **parallel session redeployed
the backend** from a pre-merge source. The route vanished. Production was briefly
serving a new SPA against a backend that did not have the endpoint the SPA called.
The same thing then happened to the frontend.

What makes this worth an ADR is not the collision — that is a coordination
problem — but that **the standard verification could not see it.** `DEPLOY.md`
prescribes comparing the local `dist/assets/index-*.js` hash to the served one.
That check passed throughout. It passes for *any* clobbering deploy, because the
clobbering build's hashes are internally consistent with each other. A hash proves
"these bytes were built together". It does not prove **which source they came
from**, which is the only question a deploy verification is actually asking.

Detecting the second clobber required downloading a served code-split chunk
(`assets/byokClient-<hash>.js`) and grepping it for a string that only the new
code contained. That is not a check anyone runs routinely, so in practice the
regression was invisible.

Nothing in the running app could answer "which commit is this?":

- `/.well-known/openwop` reports `implementation.version: "0.1.0"` — hand-maintained,
  unchanged for the app's lifetime, so it cannot distinguish two deploys.
- `/health` returns `{"status":"ok"}`.
- `/readiness` reports `version: APP_VERSION` — the same static string.
- The SPA exposed nothing at all.

## Decision

**Both halves stamp the git commit they were built from, and expose it at a fixed,
unauthenticated location. One command verifies a deploy.**

- **Backend** — `host/buildInfo.ts` reads `OPENWOP_BUILD_COMMIT` and surfaces
  `build: { commit, deployedAt, stamped }` on `/readiness`, beside the existing
  `version`. The stamp rides `gcloud run deploy --update-env-vars`, which has merge
  semantics and so is safe under the standing rule that `--set-*` flags wipe the
  live config.
- **Frontend** — `scripts/write-build-info.mjs` emits `dist/build-info.json` after
  `vite build`, wired into the build chain so it cannot be forgotten. It reads
  `OPENWOP_BUILD_COMMIT`, else git.
- **`scripts/verify-deploy.sh`** asserts both halves report the expected commit,
  and exits non-zero otherwise.

### The honesty rule (the part that makes it trustworthy)

An absent or malformed stamp reports `unknown` and **`verify-deploy.sh` treats
`unknown` as a FAILURE, not a pass.**

This is the whole design. A verification that quietly passes when it has no
evidence is worse than none — it manufactures exactly the false assurance that
made the original incident invisible. So:

- `buildCommit()` accepts only a 7–40 character hex string. A branch name, an
  uninterpolated `$COMMIT_SHA`, or an empty string are `unknown` — never echoed
  back as if they were provenance.
- Nothing is ever substituted for a missing commit: not `APP_VERSION`, not a
  timestamp.
- The frontend additionally records `dirty: true` when built from a modified tree,
  and the verifier fails on it. A SHA does not describe a tree with uncommitted
  changes on top, and treating it as if it did is the same lie in miniature.

## Alternatives weighed

| Option | Why not |
| --- | --- |
| Keep comparing asset hashes | The defect. It reports success for the exact failure it is supposed to catch — proven live. |
| Bump `APP_VERSION` per deploy | Hand-maintained, so it drifts the moment someone forgets, and it cannot express "which commit". Deploys are far more frequent than releases. |
| Read the revision's source from Cloud Run metadata | Cloud Run records the image, not the commit — `--source` builds carry no git identity — and it says nothing about the SPA half at all. |
| Have the deploy write to a ledger doc | We already have one (`docs/steward/`), and it was wrong: peers deploy without recording. The lesson learned there was to trust the live service over the ledger; this makes the live service answerable. |
| A CI/CD lock preventing concurrent deploys | Addresses the collision, not the blindness — and hosted CI is deliberately disabled here. Worth revisiting separately; a deploy you cannot verify is the more fundamental gap. |

## Trade-offs accepted

- **The stamp is passed at deploy time, not baked at build time.** `gcloud run
  deploy --source` gives the Dockerfile no reliable git context (`.git` is not part
  of the upload), so a `--build-arg` path would be fragile. An env var is
  supplied by the deployer, which means it CAN be omitted — and that is precisely
  why omission fails the verifier loudly rather than passing.
- **`/build-info.json` is public.** It reveals a commit SHA of a public repository.
  No new exposure.
- **`/build-info.json` cannot be "missing"** — the SPA rewrite serves `index.html`
  for unknown paths, so a pre-ADR-0518 deploy yields HTML rather than a 404. The
  verifier finds no `commit` field and reports UNSTAMPED, which is the correct
  conclusion by a slightly indirect route.

## Implementation record

| What | Where | Test |
| --- | --- | --- |
| Backend stamp + honesty rule | `src/host/buildInfo.ts`, `src/routes/health.ts` | `test/build-info.test.ts` |
| Frontend stamp | `frontend/react/scripts/write-build-info.mjs` (+ build chain) | build-chain gate |
| One-command verification | `scripts/verify-deploy.sh` | — |
| Deploy recipe | `DEPLOY.md` | — |
| Upload-set packaging contract | `.gcloudignore`, `.dockerignore`, `Dockerfile` | `test/build-meta-packaging.test.ts` |

> **CORRECTION 2026-08-15 — the packaging contract was written per-FILE, and the
> second file broke it.**
>
> `build-meta/` is gitignored on purpose (so `preflight-deploy.sh`'s dirty-tree
> gate does not trip on a file every deploy regenerates), and `.gcloudignore`
> does `#!include:.gitignore`, so each stamp needs an explicit negation to reach
> Cloud Build. That negation read `!build-meta/commit.txt` — **one filename**.
>
> When RFC 0146 added `build-meta/corpus-suite.txt`, it inherited the gitignore
> and was silently dropped from the upload. MEASURED with the same tool this
> ADR's own note cites, `gcloud meta list-files-for-upload`: the file was on
> disk and not in the upload set. The image carried a `build-meta/` without it,
> `contractProvenance` was absent from `/.well-known/openwop` for the second
> deploy running, and **every gate passed** — the commit stamp matched HEAD,
> `verify-deploy.sh` was green, and `test/build-meta-packaging.test.ts` (which
> exists specifically to catch this) stayed green because its assertions named
> `commit.txt`.
>
> Two things are worth separating. The negation is now directory-wide
> (`!build-meta/**`), which makes the NEXT stamp safe by construction rather
> than by remembering. That is the small fix. The larger one is that **a
> tripwire written against an instance is indistinguishable from one written
> against the class until the second instance arrives** — so the test now
> derives the stamp list from `write-build-commit.mjs` instead of naming files,
> and carries a vacuity guard so a parse that stops matching fails loudly rather
> than covering nothing.
>
> Verified by reproducing the shipped configuration: with `!build-meta/commit.txt`
> restored, the generalized test fails and names `corpus-suite.txt`.
>
> RFC 0146 makes this class especially quiet: absence of `contractProvenance` is
> LEGITIMATE (absent ⇒ unspecified), so a broken derivation and an honest
> omission are the same bytes. Nothing downstream of the wire can tell them
> apart — which is why `scripts/check-wire-claims.mjs` now asserts the field
> against the build's own stamp. The deployer is the only party that knows what
> it built against.

## Open questions

1. **Concurrent deploys are still unserialised.** This makes a clobber *visible*;
   it does not prevent one. A lock (a Cloud Run label CAS, or an advisory lock in
   the shared DB) is the obvious follow-up. Not done here because visibility was
   the blocking gap and a lock is a materially different decision.
2. **Nothing yet fails a deploy that omits the stamp.** `verify-deploy.sh` must be
   run. Folding it into a deploy wrapper script would close that, at the cost of
   putting a wrapper between operators and `gcloud`.

## Correction 2026-09-07 — `verify-deploy.sh` reported a healthy deploy as UNREACHABLE

`scripts/verify-deploy.sh` read `/api/readiness` with `curl -f`. The route
answers **503 while `status: degraded`** — a serving state (a managed AI key not
seeded is the usual cause) that carries the commit stamp this ADR introduced.
`-f` discarded the body, so a fully successful deploy printed `backend
UNREACHABLE` and exited 1 while the backend was answering the request (MEASURED
2026-09-06 on a white-label host: frontend OK, v2 origin OK, backend
"UNREACHABLE"). The script now reads the body whatever the status, fails only
when the body has no commit (a load-balancer error page, a pre-ADR-0518 build)
or the commit is `unknown`, and labels a non-200 pass with the observed status
(`OK  0930146 (HTTP 503 degraded — serving, not ready)`). Pinned in
`scripts/test-deploy-gates.sh` by a stub that answers 503 with a stamped body
and by one that answers 503 with an HTML body.
