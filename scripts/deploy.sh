#!/usr/bin/env bash
# The whole deploy, in the mandated order, with the stamp and both checks (ADR 0530).
#
#   preflight (ADR 0530) → backend → frontend → verify (ADR 0518)
#
# WHY A WRAPPER. ADR 0518 made a clobbering deploy visible, but left two ways to
# get no protection at all: forget `--update-env-vars OPENWOP_BUILD_COMMIT` and
# the deploy reports `unknown`; forget `verify-deploy.sh` and nobody looks. Both
# were "remember to". This makes them structural — the stamp is computed here and
# cannot be omitted, and the verify is a step, not a suggestion.
#
# It also encodes the two orderings that have each caused a real incident:
#   - BACKEND FIRST. A new SPA calling a route the backend lacks 404s until the
#     backend catches up. That happened on 2026-08-03.
#   - PREFLIGHT BEFORE THE 8-MINUTE BUILD, not after.
#
# WHAT IT DELIBERATELY DOES NOT DO. It passes no `--set-env-vars` / `--set-secrets`
# (those REPLACE and would wipe the live secret + env binding); only the merge
# form `--update-env-vars`. It takes no lock: see preflight-deploy.sh for why
# serialising deploys does not fix a deploy that ships older code.
#
# Config comes from `scripts/deploy.env` (gitignored — copy deploy.env.example).
# There are NO defaults: a wrong-but-plausible default deploys your code to
# someone else's project, while an implicit distribution can build the wrong
# product surface and enforce the wrong bundle budget.
#
# Usage:
#   scripts/deploy.sh                 # both halves
#   scripts/deploy.sh --backend-only
#   scripts/deploy.sh --frontend-only
#   scripts/deploy.sh --allow-unverified-live    # passed through to preflight
#   scripts/deploy.sh --allow-tagged             # passed through (Gate 5b)
#   scripts/deploy.sh --preflight-only           # stamp + gate, deploy nothing
#   scripts/deploy.sh --publish-evidence         # after a VERIFIED backend deploy,
#                                                # also run publish-evidence.sh (~10 min
#                                                # load test) so the §D pointer is not
#                                                # left PENDING for the new commit
#   scripts/deploy.sh --skip-certify             # skip the major-2 ratchet (emergency
#                                                # only; ADR 0869: no image bundle is built)
#   scripts/deploy.sh --retire-previous          # delete the superseded revision
#                                                # after verify (ADR 0802; opt-in)
#   scripts/deploy.sh --ignore-hour-window       # do NOT hold a backend build that
#                                                # would boot near the top of an hour

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# When THIS deploy began. `verify-deploy.sh`'s peer-build window is anchored to
# it (ADR 0691) — the question that check asks is "did anyone else build during
# MY deploy", and only this script knows how long that was.
DEPLOY_START_EPOCH="$(date -u +%s)"
export DEPLOY_START_EPOCH
ENV_FILE="$ROOT/scripts/deploy.env"

# --help BEFORE the config check. Asking a script what it does is the first thing
# anyone types, and answering "your config file is missing" is a non-answer to
# the question actually asked — especially for the reader most likely to ask it,
# who has not configured anything yet.
for arg in "$@"; do
  case "$arg" in -h|--help) sed -n '2,42p' "$0" | sed 's/^#[[:space:]]\{0,1\}//'; exit 0 ;; esac
done

if [ ! -f "$ENV_FILE" ]; then
  echo "deploy: $ENV_FILE not found." >&2
  echo "        cp scripts/deploy.env.example scripts/deploy.env  and fill it in." >&2
  exit 2
fi
# Parse strictly; do NOT source. `set -a; . "$ENV_FILE"` executes whatever the
# file contains — a config file becomes an arbitrary-code surface, and the failure
# is silent (a stray backtick runs). It is the operator's own gitignored file, so
# the risk is low, but a config parser that cannot execute is simply the right
# shape: only `KEY=VALUE` lines, `#` comments, and optional surrounding quotes.
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in *=*) : ;; *) continue ;; esac
  key="${line%%=*}"; val="${line#*=}"
  # TRIM surrounding whitespace; do NOT strip interior whitespace. The first cut
  # used `tr -d '[:space:]'`, which turned `export FOO=bar` into a variable named
  # `exportFOO`. That is NOT a live defect — both forms leave FOO unset and the
  # required-var check below fails closed either way, which a sabotage check
  # confirmed. It is fixed because a parser should reject what it does not
  # understand rather than silently invent a name for it.
  key="${key#"${key%%[![:space:]]*}"}"; key="${key%"${key##*[![:space:]]}"}"
  # Only a plain env-var name survives — no `export FOO`, no substitution,
  # nothing that could smuggle a command through.
  case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
  # Strip one layer of matching quotes; keep inner content verbatim.
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    "'"*"'") val="${val#\'}"; val="${val%\'}" ;;
  esac
  export "$key=$val"
done < "$ENV_FILE"

DO_BACKEND=1; DO_FRONTEND=1; PREFLIGHT_ONLY=0; DO_CERTIFY=1; DO_PUBLISH_EVIDENCE=0; PREFLIGHT_ARGS=()
RETIRE_PREVIOUS=0; HOLD_FOR_HOUR=1
for arg in "$@"; do
  case "$arg" in
    --backend-only)  DO_FRONTEND=0; PREFLIGHT_ARGS+=("$arg") ;;
    --frontend-only) DO_BACKEND=0; PREFLIGHT_ARGS+=("$arg") ;;
    # Preflight exceptions the OPERATOR states. Both are forwarded, never
    # implied: preflight owns the gate, deploy.sh only carries the word
    # through. `--allow-pin-drift` was unreachable through this wrapper until
    # 2026-09-11 — the gate gained an exception its only supported entry point
    # could not pass, so the documented escape hatch existed on paper and
    # `deploy: unknown argument` in practice.
    --allow-unverified-live|--allow-pin-drift|--allow-tagged) PREFLIGHT_ARGS+=("$arg") ;;
    # Stamp + gate, then stop. Exists so the ordering above is testable without
    # an 8-minute build or a network round trip.
    --preflight-only) PREFLIGHT_ONLY=1 ;;
    # ADR 0550 P4. Ship WITHOUT re-deriving the certification stamp. The field
    # then ships ABSENT (write-build-commit.mjs has already deleted any stale
    # copy), which RFC 0089 §D makes fully conformant. There is deliberately no
    # flag that ships a stale one.
    --skip-certify) DO_CERTIFY=0 ;;
    # WHD-18 / ADR 0735. In origin mode every deploy leaves the §D pointer
    # ABSENT (verify-deploy: PENDING) until scripts/publish-evidence.sh cuts and
    # uploads the signed post-deploy bundle for the NEW commit. That step stays
    # out of the default path on purpose (a ~10-minute load test against the
    # live service), so it is opt-in here and never implied.
    # MEASURED 2026-09-28: three deploys in two hours each left the pointer
    # absent, because nobody ran the separate step after them.
    --publish-evidence) DO_PUBLISH_EVIDENCE=1 ;;
    # ADR 0802. The hour hold is on by default; `--ignore-hour-window` skips it.
    # Retiring the superseded revision is OPT-IN since the 2026-10-02 correction:
    # deleting a revision removes it from routing but does NOT stop its running
    # instance (measured), so by default the rollback target is kept.
    --retire-previous) RETIRE_PREVIOUS=1 ;;
    --keep-previous) RETIRE_PREVIOUS=0 ;;   # the default; kept so old commands still parse
    --ignore-hour-window) HOLD_FOR_HOUR=0 ;;
    -h|--help) ;;  # handled before the config check above
    *) echo "deploy: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

missing=()
for v in OPENWOP_DEPLOY_SERVICE OPENWOP_DEPLOY_PROJECT OPENWOP_DEPLOY_REGION \
         OPENWOP_DEPLOY_ACCOUNT OPENWOP_DEPLOY_HOSTING_TARGET \
         OPENWOP_DEPLOY_FIREBASE_PROJECT OPENWOP_DISTRIBUTION BASE; do
  [ -n "${!v:-}" ] || missing+=("$v")
done
if (( ${#missing[@]} )); then
  echo "deploy: unset in $ENV_FILE: ${missing[*]}" >&2
  exit 2
fi
export BASE
# verify-deploy.sh needs these for the H90 peer-build check; without them it
# reports SKIPPED (never OK), which is honest but blind.
export OPENWOP_DEPLOY_PROJECT OPENWOP_DEPLOY_REGION

cd "$ROOT"
SHA="$(git rev-parse HEAD)"

# Bake the commit into the IMAGE before the source upload. The
# --update-env-vars stamp later still runs, but it is no longer the only
# provenance: a bare `gcloud run deploy` preserves the env var from the PREVIOUS
# deploy, so an env-only stamp can report the wrong SHA with `stamped: true`
# (measured 2026-08-10). See host/buildInfo.ts.
#
# ORDERING — this MUST precede preflight, and it used to not.
# Preflight gate 4 FAILS on a missing or stale build-meta/commit.txt. Writing the
# stamp afterwards deadlocked this script against its own gate: from the CLEAN
# detached worktree the deploy recipe prescribes, the file does not exist, so
# `scripts/deploy.sh` could never once get past its own preflight. Both scripts
# carried a comment asserting the other's behaviour and both were wrong —
# preflight said deploy.sh "passes this trivially"; deploy.sh said the gitignored
# file "would not trip it". Found 2026-08-11 during a real deploy.
#
# The earlier rationale — do not mutate before the gate that decides whether to
# proceed — is answered rather than ignored: the mutation is one gitignored
# provenance file this script is about to require, it is rewritten every run, and
# nothing outside the deploy reads it. In exchange gate 4 stops being a deadlock
# and becomes a real VERIFICATION that the write landed and matches HEAD.
if [ "$DO_BACKEND" -eq 1 ]; then
  # OPENWOP_STAMP_DEPLOYER — also write build-meta/deployer.json (which checkout +
  # session made this build). Only a deploy stamps it; see write-build-commit.mjs.
  if ! OPENWOP_STAMP_DEPLOYER=1 node "$ROOT/scripts/write-build-commit.mjs" "$SHA"; then
    echo "deploy: could not stamp the image commit — aborting before preflight." >&2
    exit 1
  fi
fi

# ADR 0974 — observe only (records what the broker would have done; waits for nothing).
# shellcheck source=lib/broker-observe.sh
# (Guarded: a test fixture may copy this script without the helper.)
if [ -f "$ROOT/scripts/lib/broker-observe.sh" ]; then . "$ROOT/scripts/lib/broker-observe.sh"; broker_observe deploy 2 "deploy $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null)"; fi

FE_BUILD_PID=""; FE_BUILD_LOG=""; CERT_BUILD_PID=""
cancel_owned_builds() {
  local pid
  for pid in "$FE_BUILD_PID" "$CERT_BUILD_PID"; do
    [ -z "$pid" ] || kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in "$FE_BUILD_PID" "$CERT_BUILD_PID"; do
    [ -z "$pid" ] || wait "$pid" 2>/dev/null || true
  done
  FE_BUILD_PID=""; CERT_BUILD_PID=""
}
trap cancel_owned_builds EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# ADR 0991 — the cross-machine release bus: a lease of our own and start/end
# events. D9 (user decision 2026-10-27): the lease is per TARGET — the Cloud Run
# service and/or the Hosting site this run will touch — and `acquire` QUEUES
# behind a live deploy or certify on the same target, so two deploys to the
# same server run one after the other while deploys to different servers run
# at once. Bounded and fail-open (release-bus.mjs). It runs BEFORE preflight on
# purpose: a deploy that waited must check the live commit AFTER the wait, when
# the deploy it queued behind has just shipped. --preflight-only claims nothing.
# Its EXIT hook chains onto the one above without changing this script's exit
# status. (Guarded for fixtures.)
BUS_HALVES=()
[ "$DO_BACKEND" -eq 1 ] && BUS_HALVES+=(backend)
[ "$DO_FRONTEND" -eq 1 ] && BUS_HALVES+=(frontend)
if [ -f "$ROOT/scripts/lib/release-bus.sh" ]; then
  # shellcheck source=lib/release-bus.sh
  . "$ROOT/scripts/lib/release-bus.sh"
  BUS_TARGETS="$(release_bus_targets "${BUS_HALVES[@]}")"
  RUN_TARGET="$(release_bus_targets backend)"
  if [ "$PREFLIGHT_ONLY" -eq 0 ]; then
    deploy_bus_end() {
      printf '{"kind":"deploy","phase":"end","exit":%s,"commit":"%s","revision":"%s","targets":"%s","result":"%s"}' \
        "$1" "$SHA" "${CREATED:-}" "$BUS_TARGETS" "$([ "$1" -eq 0 ] && echo VERIFIED || echo "FAILED rc=$1")"
    }
    DEPLOY_BUS_ID="deploy-$(hostname -s 2>/dev/null || hostname)-$$"
    # The certify this deploy may run (--publish-evidence) must not queue behind
    # its own parent. Exact id, never a prefix.
    export OPENWOP_RELEASE_BUS_PARENT="$DEPLOY_BUS_ID"
    # The lease outlives a slow deploy (certify + the ADR 0802 hour hold + build):
    # a STALE lease never blocks, so a short one would let a second deploy in.
    release_bus_acquire_hold "$DEPLOY_BUS_ID" deploy deploy_bus_end --commit "$SHA" \
      --targets "$BUS_TARGETS" --expected-min 30 --ttl-min 75
    release_bus publish "{\"kind\":\"deploy\",\"phase\":\"start\",\"commit\":\"$SHA\",\"backend\":$DO_BACKEND,\"targets\":\"$BUS_TARGETS\"}"
  fi
else
  release_bus() { return 0; }
  RUN_TARGET=""
fi

echo "▶ preflight"
if ! bash "$ROOT/scripts/preflight-deploy.sh" "${PREFLIGHT_ARGS[@]+"${PREFLIGHT_ARGS[@]}"}"; then
  echo "deploy: aborted by preflight." >&2
  exit 1
fi

if [ "$PREFLIGHT_ONLY" -eq 1 ]; then
  echo "preflight-only: stamped and gated; deploying nothing."
  exit 0
fi

# ── Both halves must be BUILDABLE before either half SHIPS ────────────────────
# The deploy recipe says to run from a clean detached worktree, which by
# definition has no node_modules — and the frontend build is the SECOND half, so
# a missing dep is discovered only after Cloud Run has already taken the new
# backend. That is a half-deploy: new backend, old SPA, and no way to finish
# without a fresh `npm ci` you did not plan for.
#
# MEASURED 2026-08-11: exactly this. Backend shipped revision 00637-pm2, then
# `sh: tsc: command not found` and "nothing uploaded". Backend-first ordering is
# the SAFE direction (an old SPA against a new backend still works, the reverse
# 404s), so it was recoverable — but it should never have got that far.
#
# Checked here rather than in preflight-deploy.sh because only this script knows
# which halves were requested; a backend-only deploy has no business demanding
# frontend deps.
# H42 (2026-08-17). The RFC 0146 `contractProvenance.suiteVersion` stamp is
# DERIVED from the installed `@openwop/openwop-conformance` (a backend
# devDependency) by write-build-commit.mjs. A detached deploy worktree that only
# ran `npm ci` in frontend/react cannot derive it, so the field ships ABSENT —
# honest, but it drops a claim this host can make. And the failure mode that
# actually happened is worse: a checkout WITH a stale gitignored
# `corpus-suite.txt` shipped `1.66.0` while the pin was 1.135.0. Require the
# backend deps so the value is derived from the pinned package every time.
if [ "$DO_BACKEND" -eq 1 ] && [ ! -d "$ROOT/backend/typescript/node_modules/@openwop/openwop-conformance" ]; then
  echo "deploy: backend/typescript/node_modules/@openwop/openwop-conformance is missing —" >&2
  echo "        the RFC 0146 contractProvenance.suiteVersion stamp is DERIVED from the" >&2
  echo "        installed conformance package (build-meta/corpus-suite.txt); without it the" >&2
  echo "        deploy ships the field absent. Install first (npm ci, never npm install):" >&2
  echo "          ( cd \"$ROOT/backend/typescript\" && npm ci )" >&2
  exit 1
fi

# Presence is not parity. A long-lived checkout can contain a valid but stale
# conformance install; measured 2026-09-20, package-lock resolved 2.31.0 while
# node_modules still held 2.1.5, so deploy certified against the wrong suite and
# stamped the wrong contractProvenance.suiteVersion. Fail before certification
# or any production write; `npm ci` is the only supported repair.
if [ "$DO_BACKEND" -eq 1 ] && ! node "$ROOT/scripts/check-deploy-conformance-install.mjs" "$ROOT"; then
  exit 1
fi

if [ "$DO_FRONTEND" -eq 1 ] && [ ! -d "$ROOT/frontend/react/node_modules" ]; then
  echo "deploy: frontend/react/node_modules is missing — the frontend half could not" >&2
  echo "        build, and finding that out AFTER the backend ships leaves a" >&2
  echo "        half-deploy. Install first:" >&2
  echo "          ( cd \"$ROOT\" && npm ci ) && ( cd \"$ROOT/frontend/react\" && npm ci )" >&2
  echo "        Or deploy the halves deliberately: --backend-only / --frontend-only." >&2
  exit 1
fi

# Wait for the background frontend build (ADR 0863) and refuse on failure. Safe
# to call more than once: the second call is a no-op.
await_frontend_build() {
  [ -n "${FE_BUILD_PID:-}" ] || return 0
  local rc=0
  wait "$FE_BUILD_PID" || rc=$?
  FE_BUILD_PID=""
  if [ "$rc" -ne 0 ]; then
    tail -40 "$FE_BUILD_LOG" >&2
    echo "deploy: frontend build FAILED (exit $rc) — nothing uploaded. Full log: $FE_BUILD_LOG" >&2
    exit 1
  fi
  echo "  frontend build: done (log $FE_BUILD_LOG)"
}

# ── ADR 0863 — build the frontend WHILE certify runs ─────────────────────────
# The frontend build (~3 min of tsc + vite + gates) reads nothing certify writes:
# certify writes build-meta/, which only the backend IMAGE copies. So it starts
# here, in the background, and is AWAITED before the backend ships. That is
# stronger than the old order as well as faster. Before, only the frontend's
# DEPS were proven before the backend shipped, and the build itself could still
# fail after Cloud Run had the new backend (the 2026-08-11 half-deploy shape).
# Now a failed frontend build ships nothing.
#
# The image cannot be built in parallel the same way: the Dockerfile COPYs
# build-meta/, so it has to follow certify.
#
# OPENWOP_DEPLOY_FRONTEND_PARALLEL=0 runs the build to completion right here
# instead, e.g. when certify is flaking on a loaded machine.
# Bash defers signal traps while a foreground external command runs. Waiting
# on our own background supervisor keeps the trap responsive during certify.
run_owned_certification() {
  local rc=0
  node "$ROOT/scripts/lib/owned-process.mjs" "$@" &
  CERT_BUILD_PID=$!
  wait "$CERT_BUILD_PID" || rc=$?
  CERT_BUILD_PID=""
  return "$rc"
}
if [ "$DO_FRONTEND" -eq 1 ]; then
  FE_BUILD_LOG="$(mktemp "${TMPDIR:-/tmp}/owp-deploy-frontend.XXXXXX")"
  echo
  echo "▶ frontend → build (distribution: $OPENWOP_DISTRIBUTION) — in the background while certify runs; log: $FE_BUILD_LOG"
  # The commit is exported so write-build-info.mjs stamps the same SHA the
  # backend carries, rather than re-deriving it. Pass the distribution on the
  # build command as well as exporting it from deploy.env: this makes the
  # artifact identity visible at the mutation point and prevents a refactor of
  # config parsing from silently falling back to the default distribution.
  OPENWOP_BUILD_COMMIT="$SHA" \
      OPENWOP_DISTRIBUTION="$OPENWOP_DISTRIBUTION" \
      node "$ROOT/scripts/lib/owned-process.mjs" "$ROOT/frontend/react" npm run build > "$FE_BUILD_LOG" 2>&1 &
  FE_BUILD_PID=$!
  [ "${OPENWOP_DEPLOY_FRONTEND_PARALLEL:-1}" = "0" ] && await_frontend_build
fi

# ── ADR 0550 P4 — PRODUCE the certification stamp, or ship without it ─────────
# `write-build-commit.mjs` above has already DELETED any pre-existing bundle: it
# cannot re-derive one, and a stale bundle is a public claim about a different
# commit's behaviour. This step is what puts a fresh one back.
#
# It runs the full conformance lane in strict, no-quarantine mode against a
# booted host and derives the claim from the RFC 0148 §A ledger. That costs
# ~10 MINUTES on top of the deploy, and that cost is the point: the only thing
# that can substantiate "this build passes profile X" is this build being made
# to pass profile X. A cheaper stamp would be a cheaper claim.
#
# THREE OUTCOMES, and none of them is "ship something stale":
#   run succeeds → fresh bundle + claims, pointer advertised
#   --skip-certify → no run, files absent, pointer omitted (RFC 0089 §D: fully
#                    conformant; clients MUST tolerate its absence)
#   run fails or produces nothing → REFUSE to ship. A deploy that silently
#                    degraded to "no claim" would teach nobody anything, and the
#                    operator asked for a certified build.
#
# CORRECTED 2026-10-10 (ADR 0869): this lane no longer runs in either mode. The
# stamp it produced was served only at MAJOR 1, which is retired; see the branch
# below. What still gates the deploy is the major-2 ratchet. The rationale above
# is kept for the record: it was right while major 1 was served.
if [ "$DO_BACKEND" -eq 1 ]; then
  if [ "$DO_CERTIFY" -eq 0 ]; then
    echo
    echo "▶ certify: SKIPPED (--skip-certify) — the RFC 0089 §D pointer will be ABSENT, not stale"
  else
    # ADR 0869 — NO image bundle is built, in EITHER evidence mode. The image
    # stamp is served and advertised only by the MAJOR-1 discovery builder
    # (`certificationBundleUrl` → `servedBundle(1)`), and v1 is retired (ADR 0812
    # P3c), so a stamp built here reaches no client. Origin mode already skipped
    # it (the served bundle is publish-evidence's v3 cut). Image mode kept it,
    # and its in-process emitter claims no profile at major 2, so every adopter
    # deploy without --skip-certify REFUSED to ship (the minItems-1 failure).
    # The pointer is absent, which RFC 0089 §D calls fully conformant. An adopter
    # who wants served evidence sets OPENWOP_CERT_BUNDLE_ORIGIN and runs
    # scripts/publish-evidence.sh after the deploy. The gate this build needs is
    # the major-2 ratchet below, which still runs in both modes.
    echo
    if [ -n "${OPENWOP_CERT_BUNDLE_ORIGIN:-}" ]; then
      echo "▶ certify: image bundle NOT built — origin mode (the served bundle comes from publish-evidence; ADR 0812 P3c)"
    else
      echo "▶ certify: image bundle NOT built — image mode serves no major-2 evidence (ADR 0869); pointer absent, conformant."
      echo "  To serve evidence: set OPENWOP_CERT_BUNDLE_ORIGIN in deploy.env, then run scripts/publish-evidence.sh after this deploy."
    fi
  fi
  # Runs in BOTH evidence modes (ADR 0812 P3c moved it out of the image-certify
  # branch, so origin mode keeps it); only --skip-certify, the emergency escape,
  # skips it, exactly as before.
  if [ "$DO_CERTIFY" -eq 1 ]; then
    # ── major 2, as a SECOND gate rather than a different claim (ADR 0687) ─────
    # The obvious version of "move deploy-day certify to major 2" is to set
    # OPENWOP_TARGET_MAJOR=2 on the line above. That would be wrong, and the
    # suite says why: `--target-major` DEFAULTS to the host's own
    # `preferredVersion` (RFC 0179), else max(protocolVersions[]). So the certify
    # bundle already certifies the major this host ADVERTISES — forcing 2 would
    # make the public claim disagree with the advertisement while `/v1` is still
    # served and preferred until the EOS clock (2026-12-04, ADR 0669's cut
    # switch). Certifying a major you do not prefer is the same class of
    # dishonest claim as advertising a capability you do not honour.
    #
    # What deploy day actually needs is that no build ships with an unlisted v2
    # red. That is the ratchet, and it became meaningful the moment the known-red
    # list emptied (ADR 0687): before that it admitted two real MUST violations,
    # so a green here proved only that the gaps were the gaps we knew about.
    echo
    echo "▶ conformance@major2 ratchet — no unlisted v2 red may ship"
    if ! run_owned_certification "$ROOT" bash "$ROOT/scripts/check-conformance-major2.sh"; then
      echo "deploy: the major-2 lane regressed — refusing to ship." >&2
      echo "        Either fix the scenario, or admit it with a reason in" >&2
      echo "        scripts/conformance-v2-known-red.txt (an admission is a" >&2
      echo "        wire gap this host declares; keep it short and dated)." >&2
      exit 1
    fi
  fi
fi

# The frontend must have BUILT before the backend ships (ADR 0863, above).
await_frontend_build

if [ "$DO_BACKEND" -eq 1 ]; then
  # ── ADR 0802 — do not BOOT near the top of an hour ──────────────────────────
  # The hourly scheduled jobs queue the 4-connection pool for ~10 minutes
  # (MEASURED 2026-10-02 18:00Z: 449 queued callers, 0.5 s reads on one idle
  # instance). A boot landing in that window stacks its own burst, and a second
  # copy of every daemon, on top. Held HERE — after certify, before the build —
  # because a revision built and left at 0% keeps a live instance of its own.
  if [ "$HOLD_FOR_HOUR" -eq 1 ]; then
    HOLD_S=$(node "$ROOT/scripts/lib/deploy-timing.mjs" hour-wait "$(date -u +%s)")
    if [ "${HOLD_S:-0}" -gt 0 ]; then
      echo
      echo "▶ hold: this build would boot inside the top-of-hour window — waiting $(( HOLD_S / 60 ))m $(( HOLD_S % 60 ))s (ADR 0802; --ignore-hour-window to skip)"
      node -e 'setTimeout(() => {}, Number(process.argv[1]) * 1000)' "$HOLD_S"
    fi
  fi
  # ── the evidence-cut lock, read AGAIN right before the build ──────────────
  # preflight-deploy.sh (Gate 8) reads it once, at the start. The certify run and
  # the hour hold above can take 25 min between that read and this build, and a
  # cut that starts in that gap was never seen. MEASURED 2026-10-14: a deploy
  # passed preflight before 21:09Z, held to 21:15Z, and built while cut 82c
  # (lock taken 21:09Z) was still running. The bundle came out sound only
  # because the new revision was created 40 s after the bundle was written.
  # A held lock is a short, task-owned hold (one ~10 min cut), so WAIT for it
  # rather than fail. An unreadable lock still refuses, as Gate 8 does.
  if command -v gcloud >/dev/null 2>&1 && [ -n "${OPENWOP_CERT_BUNDLE_ORIGIN:-}" ]; then
    # shellcheck source=lib/cut-lock.sh
    . "$ROOT/scripts/lib/cut-lock.sh"
    CUT_LOCK_URL="${OPENWOP_CERT_BUNDLE_ORIGIN%/}/.cut-lock.json"
    cut_waited=0
    while :; do
      lock_line=$(cut_lock_state "$CUT_LOCK_URL" --project "$OPENWOP_DEPLOY_PROJECT" --account "$OPENWOP_DEPLOY_ACCOUNT")
      case "${lock_line%% *}" in
        absent|expired) break ;;
        held)
          if [ "$cut_waited" -eq 0 ]; then
            echo; echo "▶ hold: an evidence cut started after preflight — waiting for it to finish before the build (${lock_line#* })"
          fi
          cut_waited=$((cut_waited + 1))
          sleep "${OPENWOP_DEPLOY_CUT_POLL_S:-30}" ;;
        *) echo "deploy: the cut lock could not be read (${lock_line#* }) — refusing to guess; that is not the same as a cut in progress." >&2; exit 1 ;;
      esac
    done
    if [ "$cut_waited" -gt 0 ]; then echo "  cut lock released — building now"; fi
  fi
  # ── ADR 0802 — remember what serves NOW, to retire it after verify ──────────
  # Read before the deploy: afterwards the same field names the new revision.
  PREV_REVISION=""; PREV_IMAGE=""
  if [ "$RETIRE_PREVIOUS" -eq 1 ]; then
    PREV_REVISION=$(gcloud run services describe "$OPENWOP_DEPLOY_SERVICE" --region "$OPENWOP_DEPLOY_REGION" \
      --project "$OPENWOP_DEPLOY_PROJECT" --account "$OPENWOP_DEPLOY_ACCOUNT" --format=json \
      | node "$ROOT/scripts/lib/deploy-timing.mjs" previous-serving "" || true)
    if [ -n "$PREV_REVISION" ]; then
      PREV_IMAGE=$(gcloud run revisions describe "$PREV_REVISION" --region "$OPENWOP_DEPLOY_REGION" \
        --project "$OPENWOP_DEPLOY_PROJECT" --account "$OPENWOP_DEPLOY_ACCOUNT" --format='value(status.imageDigest)' || true)
    fi
  fi
  echo
  echo "▶ backend → Cloud Run ($OPENWOP_DEPLOY_SERVICE)"
  # --update-env-vars MERGES. Never --set-env-vars: that replaces the whole map
  # and would drop the live secret bindings, OIDC/KMS config and Cloud SQL attach.
  if ! gcloud run deploy "$OPENWOP_DEPLOY_SERVICE" \
      --source . \
      --region "$OPENWOP_DEPLOY_REGION" \
      --project "$OPENWOP_DEPLOY_PROJECT" \
      --account "$OPENWOP_DEPLOY_ACCOUNT" \
      --update-env-vars "OPENWOP_BUILD_COMMIT=$SHA,OPENWOP_BUILD_DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --quiet; then
    echo "deploy: backend FAILED — not deploying the frontend." >&2
    # Hard stop. A new SPA against an un-updated backend is the exact skew that
    # took production down on 2026-08-03.
    exit 1
  fi
  # ── ADR 0631 / MEASURED 2026-09-05 — "deployed, serving 100%" can be a lie ──
  # `gcloud run deploy` built, created revision 00668-224, and printed
  # "revision [00691-hay] has been deployed and is serving 100 percent" —
  # naming YESTERDAY's revision, because the service's traffic was pinned to
  # it by name and Cloud Run picks "latest" by revision SERIAL, which is not
  # monotonic on this service (00668 was created after 00691). The new
  # revision sat at 0%, Retired, and only `verify-deploy.sh`'s commit stamp
  # noticed. So: read the revision this deploy CREATED, prove it carries this
  # commit and is Ready, and route 100% to it BY NAME — immune to both the
  # pinned-spec and the serial trap. Never `--to-latest` (resolves by serial).
  CREATED=$(gcloud run services describe "$OPENWOP_DEPLOY_SERVICE" --region "$OPENWOP_DEPLOY_REGION" \
    --project "$OPENWOP_DEPLOY_PROJECT" --account "$OPENWOP_DEPLOY_ACCOUNT" \
    --format='value(status.latestCreatedRevisionName)')
  REV_COMMIT=$(gcloud run revisions describe "$CREATED" --region "$OPENWOP_DEPLOY_REGION" \
    --project "$OPENWOP_DEPLOY_PROJECT" --account "$OPENWOP_DEPLOY_ACCOUNT" --format=json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);const e=(r.spec.containers[0].env||[]).find(x=>x.name==="OPENWOP_BUILD_COMMIT");const ready=(r.status.conditions||[]).find(c=>c.type==="Ready");process.stdout.write(((e&&e.value)||"")+" "+(ready?ready.status:"?"))})')
  if [ "${REV_COMMIT%% *}" != "$SHA" ] || [ "${REV_COMMIT##* }" != "True" ]; then
    echo "deploy: the revision this deploy created ($CREATED) carries commit '${REV_COMMIT%% *}' Ready=${REV_COMMIT##* }; expected $SHA True — NOT shifting traffic." >&2
    exit 1
  fi
  echo "▶ traffic → $CREATED (by name; commit $SHA verified on the revision)"
  gcloud run services update-traffic "$OPENWOP_DEPLOY_SERVICE" --to-revisions "$CREATED=100" \
    --region "$OPENWOP_DEPLOY_REGION" --project "$OPENWOP_DEPLOY_PROJECT" --account "$OPENWOP_DEPLOY_ACCOUNT" --quiet
fi

if [ "$DO_FRONTEND" -eq 1 ]; then
  echo
  # Built above, in the background while certify ran (ADR 0863). Already awaited
  # before the backend, so this is a no-op unless the backend half was skipped.
  await_frontend_build
  echo
  echo "▶ frontend → Firebase Hosting ($OPENWOP_DEPLOY_HOSTING_TARGET)"
  # --account is NOT optional here. Without it the Firebase half takes its
  # identity from AMBIENT CLI state (whatever `firebase login:use` last selected,
  # globally, possibly in another project) while the four gcloud calls above take
  # theirs from deploy.env — so deploy.env reads as the complete deployment
  # identity and is not. MEASURED 2026-09-09 by the kicktodo-1 adopter session:
  # the ambient account could not see their Firebase project at all, and the
  # failure surfaced as a project-ACCESS error during the frontend phase — after
  # the backend had already shipped, pointing at a cause (permissions) that was
  # not the cause (identity selection). That is the shape that gets "fixed"
  # wrongly, by granting access nobody needed.
  if ! firebase deploy --only "hosting:$OPENWOP_DEPLOY_HOSTING_TARGET" \
      --project "$OPENWOP_DEPLOY_FIREBASE_PROJECT" \
      --account "$OPENWOP_DEPLOY_ACCOUNT"; then
    echo "deploy: frontend deploy FAILED." >&2
    exit 1
  fi
fi

echo
echo "▶ verify"
VERIFY_ARGS=("$SHA")
[ "$DO_FRONTEND" -eq 0 ] && VERIFY_ARGS+=(--backend-only)
[ "$DO_BACKEND" -eq 0 ]  && VERIFY_ARGS+=(--frontend-only)
# H92 — tells the peer-build window arm that a backend build JUST happened, so
# "0 builds in the window" is provably a broken query rather than a quiet
# region. Passed only when this run actually deployed the backend; a
# frontend-only deploy produces no build and must not be held to it.
[ "$DO_BACKEND" -eq 1 ]  && VERIFY_ARGS+=(--after-deploy)
# Size the peer-build window to cover THIS deploy, start to finish, plus a
# 5-minute margin (ADR 0691). The fixed 20m default was calibrated before
# certify (~10 min) and the major-2 ratchet (~2 min) ran ahead of the build, and
# before the frontend half ran after it: measured 2026-09-15, the backend build
# landed at 16:03:38Z and verify ran at 16:24:30Z — 21 minutes, one minute
# outside the window. So the check reported "0 builds, but your own build must
# be here" and failed a deploy that was correct on every substantive leg.
#
# That failure mode is the dangerous one, not a harmless miscalibration: a gate
# that cannot pass teaches everyone to ignore it, which is how a gate that CAN
# fail stops being read.
if [ -z "${PEER_BUILD_WINDOW_MIN:-}" ]; then
  VERIFY_ARGS_ELAPSED_MIN=$(( ( $(date -u +%s) - DEPLOY_START_EPOCH ) / 60 + 5 ))
  export PEER_BUILD_WINDOW_MIN="$VERIFY_ARGS_ELAPSED_MIN"
  echo "  peer-build window: ${PEER_BUILD_WINDOW_MIN}m (this deploy took $(( VERIFY_ARGS_ELAPSED_MIN - 5 ))m)"
fi
if ! bash "$ROOT/scripts/verify-deploy.sh" "${VERIFY_ARGS[@]}"; then
  echo "deploy: DEPLOYED BUT NOT VERIFIED — see above." >&2
  exit 1
fi
# ADR 0991 — verified: tell the other machines what serves (advisory).
if [ "$DO_BACKEND" -eq 1 ]; then release_bus set-production --commit "$SHA" --revision "${CREATED:-}" ${RUN_TARGET:+--target "$RUN_TARGET"}; fi

# ── ADR 0802 — retire the revision this deploy superseded ───────────────────
# A superseded revision keeps an instance for as long as a request holds it
# open — an hour-long SSE stream does — and that instance keeps running every
# background daemon against the same database. MEASURED 2026-10-02: revision
# 00829 stayed alive 47 minutes after traffic left it; on db-f1-micro reads
# were 0.5–1.3 s for all of them and normal within five minutes of its shutdown.
#
# CORRECTED 2026-10-02 (the first real retire): deleting the revision did NOT
# stop its instance — 00830's kept logging and firing schedules for 14+ minutes
# after DeleteRevision. So this step removes routing and the rollback target and
# nothing else, and it is OPT-IN (`--retire-previous`). On db-custom-1-3840 the
# overlap measured harmless (p50 26 ms with both instances alive).
#
# Only after VERIFY: until the new revision is proven, the old one is the
# rollback. Only the ONE revision that was serving, never by pattern. Deleting
# a revision does not delete its image, so rollback stays one command — printed
# below — at the cost of a ~1 minute boot instead of an instant traffic shift.
if [ "$DO_BACKEND" -eq 1 ] && [ "$RETIRE_PREVIOUS" -eq 1 ]; then
  echo
  if [ -z "$PREV_REVISION" ]; then
    echo "  retire    SKIPPED  — could not name exactly one untagged serving revision before the deploy; nothing deleted"
  elif [ "$PREV_REVISION" = "$CREATED" ]; then
    echo "  retire    SKIPPED  — the serving revision did not change"
  else
    # Re-read: it must hold no traffic and no tag NOW. A revision that still
    # routes is not superseded, whatever it was ten minutes ago.
    STILL=$(gcloud run services describe "$OPENWOP_DEPLOY_SERVICE" --region "$OPENWOP_DEPLOY_REGION" \
      --project "$OPENWOP_DEPLOY_PROJECT" --account "$OPENWOP_DEPLOY_ACCOUNT" --format=json \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=(JSON.parse(s).status.traffic||[]).filter(x=>x.revisionName===process.argv[1]&&(Number(x.percent)>0||x.tag));process.stdout.write(String(t.length))})' "$PREV_REVISION" || echo unknown)
    if [ "$STILL" != "0" ]; then
      echo "  retire    SKIPPED  — $PREV_REVISION still holds traffic or a tag (read: $STILL); nothing deleted" >&2
    elif gcloud run revisions delete "$PREV_REVISION" --region "$OPENWOP_DEPLOY_REGION" \
        --project "$OPENWOP_DEPLOY_PROJECT" --account "$OPENWOP_DEPLOY_ACCOUNT" --quiet; then
      echo "  retire    OK       $PREV_REVISION deleted from routing. Its RUNNING instance is NOT stopped by this —"
      echo "                     it lives until its open requests end (up to an hour) and keeps running its daemons."
      echo "            rollback, if needed (no rebuild):"
      echo "              gcloud run deploy $OPENWOP_DEPLOY_SERVICE --image ${PREV_IMAGE:-<image digest unavailable>} \\"
      echo "                --region $OPENWOP_DEPLOY_REGION --project $OPENWOP_DEPLOY_PROJECT   # then update-traffic --to-revisions <new>=100"
    else
      echo "  retire    FAILED   — $PREV_REVISION was NOT deleted. The deploy itself is verified; its instance will linger" >&2
      echo "            until its open streams end (up to an hour). Delete it by hand, or expect slow reads until then." >&2
    fi
  fi
fi

# ── publish the post-deploy evidence (opt-in; see --publish-evidence) ────────
# Only after a VERIFIED backend deploy: the evidence describes the BACKEND's
# commit, and publishing for a deploy that did not verify would sign a claim
# about something unconfirmed. A frontend-only deploy leaves the backend (and
# its evidence) as it was.
if [ "$DO_PUBLISH_EVIDENCE" -eq 1 ]; then
  if [ "$DO_BACKEND" -ne 1 ]; then
    echo "  evidence  SKIPPED  (--publish-evidence: no backend was deployed, so its evidence did not change)"
  elif ! bash "$ROOT/scripts/publish-evidence.sh"; then
    echo "deploy: DEPLOYED AND VERIFIED, but the evidence was NOT published — the §D pointer stays PENDING. Re-run scripts/publish-evidence.sh." >&2
    exit 1
  fi
elif [ "$DO_BACKEND" -eq 1 ] && [ -n "${OPENWOP_CERT_BUNDLE_ORIGIN:-}" ]; then
  # The opt-in stays opt-in, but it is no longer SILENT. In origin mode a
  # backend deploy that did not publish leaves the new commit with no evidence
  # at all. MEASURED 2026-09-28: production served commits with no evidence
  # after four consecutive deploys, because the separate step was never run.
  # Say so where the deployer is already looking, with the exact command.
  echo
  echo "  evidence  PENDING  — this deploy did not publish certification evidence for $(git -C "$ROOT" rev-parse --short=12 HEAD)."
  echo "            Its §D pointer stays absent until someone runs:"
  echo "              scripts/publish-evidence.sh        (~10 min load test; or deploy with --publish-evidence)"
fi
