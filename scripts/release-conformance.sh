#!/usr/bin/env bash
#
# Lane 2 — release-candidate conformance (ADR 0550 P2).
#
# Builds the release IMAGE, boots it, and runs the conformance suite against the
# running container instead of against source through a special test runner.
#
# WHY A CONTAINER AND NOT THE SOURCE LANE. `conformance/run.ts` boots via
# `createApp`, so `index.ts main()` never runs. The harness therefore has to
# SIMULATE the entry point — it mounts vendored packs itself and drives the
# webhook drain itself, because `createApp` does neither. Every one of those
# compensations is a place where the thing measured can differ from the thing
# shipped. A container runs the real `main()`, so they are not needed and are
# skipped (`OPENWOP_CONFORMANCE_TARGET_URL` selects that path).
#
# SINGLE IMPLEMENTATION. `scripts/ci.sh` (under OPENWOP_CI_LIVE=1, i.e.
# `npm run ci:full`) and the deploy path both call THIS script. Two copies would
# drift, and the env partition below is exactly the kind of detail that drifts.
#
# Usage:
#   scripts/release-conformance.sh [--keep] [--filter <pattern>]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="openwop-app-release-conformance:local"
NAME="owp-release-conformance-$$"
PORT="${OPENWOP_RC_PORT:-18099}"
KEEP=0
FILTER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --filter) FILTER="${2:-}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

cleanup() {
  if [ "$KEEP" = "1" ]; then
    echo "[release-conformance] --keep: container $NAME left running on :$PORT"
    return
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || die "docker not found — this lane needs a daemon"
docker info >/dev/null 2>&1 || die "docker daemon not reachable"

# ── 1. Provenance BEFORE the build ────────────────────────────────────────────
#
# build-meta/commit.txt is gitignored and is what makes /api/readiness report
# build.commit. ADR 0518 treats `unknown` as a FAILED deploy because it is
# indistinguishable from stale — and a conformance witness against an artifact
# that cannot identify itself certifies nothing. The writer must run first.
say "stamping build provenance"
node "$ROOT/scripts/write-build-commit.mjs"
EXPECTED_COMMIT="$(cat "$ROOT/build-meta/commit.txt")"
[ -n "$EXPECTED_COMMIT" ] || die "build-meta/commit.txt is empty after writing it"
echo "[release-conformance] expecting build.commit=${EXPECTED_COMMIT:0:12}"

# ── 2. Build the release image ────────────────────────────────────────────────
say "building release image"
docker build -t "$IMAGE" "$ROOT"

# ── 3. Boot it ────────────────────────────────────────────────────────────────
#
# HOST-SIDE env only. These configure the HOST UNDER TEST and belong to the
# container; the harness must NOT set them locally (it would then describe a
# host that is not the one being measured). The DRIVER-side env
# (OPENWOP_REQUIRE_BEHAVIOR, OPENWOP_OPTED_OUT_PROFILES, OPENWOP_CONFORMANCE_ROOT)
# is set by conformance/run.ts in the harness process, where the suite reads it.
API_KEY="${OPENWOP_RC_API_KEY:-release-conformance-token}"

# ── Reserve the harness doubles' ports BEFORE the container boots ─────────────
#
# Ordering forces this. `docker run` fixes the host's environment, and that is
# where OPENWOP_TEST_COMPAT_ENDPOINT / OPENWOP_OIDC_ISSUER must land — but the
# suite (which starts the doubles) does not run until later, so an OS-chosen
# port does not exist yet.
#
# The first version of this lane skipped it and set those vars for the DRIVER
# only. The host never learned where to dispatch, and the three callback
# scenarios stayed red while reading as host defects. MEASURED: 16 -> 14, with
# compat/OIDC/webhook still failing for exactly this reason.
COMPAT_PORT="${OPENWOP_RC_COMPAT_PORT:-18101}"
OIDC_PORT="${OPENWOP_RC_OIDC_PORT:-18102}"
HARNESS_HOST="${OPENWOP_CONFORMANCE_HARNESS_HOST:-host.docker.internal}"
export OPENWOP_CONFORMANCE_COMPAT_PORT="$COMPAT_PORT"
export OPENWOP_CONFORMANCE_OIDC_PORT="$OIDC_PORT"
# EXPORT the name too, not just the ports. This line was missing, and the
# omission had the same shape as the one the comment above describes: the value
# was computed here, spliced into the CONTAINER's env below, and never handed to
# the DRIVER — so the harness advertised its doubles at whatever ITS default
# happened to be, and anything in the suite that needed the name saw nothing.
#
# It cost two conformance rows. `webhook-signed-delivery` and
# `replay-fanout-suppression` stand up their own HTTP receivers, and until suite
# 2.0.10 those hard-coded `127.0.0.1` — MEASURED from inside the container,
# `connect ECONNREFUSED 127.0.0.1:55469`, the container's own loopback. The
# suite now consults this variable (openwop/openwop#1312), and its default with
# the variable UNSET is loopback, byte-for-byte the old behaviour. So declaring
# it is not cosmetic: it is what makes those receivers bind `0.0.0.0` and
# advertise a name the container can resolve.
#
# Inert until backend/typescript pins @openwop/openwop-conformance >= 2.0.10 —
# harmless before that, because run.ts already defaults to this same value.
export OPENWOP_CONFORMANCE_HARNESS_HOST="$HARNESS_HOST"

say "booting container on :$PORT (doubles pinned: compat $COMPAT_PORT, oidc $OIDC_PORT)"
docker run -d --name "$NAME" -p "$PORT:8080" \
  `# Lets the CONTAINER reach the harness's test doubles (compat provider, OIDC` \
  `# issuer, webhook subscriber). Without it 127.0.0.1 names the container and` \
  `# every callback-shaped scenario fails as false non-conformance — which is` \
  `# exactly the 16 unattributed failures of the first full run. MEASURED on this` \
  `# box: a container reached a host-bound server this way (probe returned` \
  `# "reached-the-harness"). Portable on modern Docker including Linux.` \
  --add-host host.docker.internal:host-gateway \
  -e PORT=8080 \
  -e OPENWOP_API_KEY="$API_KEY" \
  -e OPENWOP_STORAGE_DSN='memory://' \
  `# The image runs as PRODUCTION and refuses to boot without a session secret` \
  `# (>=32 chars) — a config requirement the in-process source lane never hits,` \
  `# because it is not production. Surfacing exactly this kind of` \
  `# artifact-vs-source difference is why Lane 2 exists. Ephemeral and` \
  `# conformance-only: this boot is memory:// and is destroyed at the end.` \
  -e OPENWOP_SESSION_SECRET='release-conformance-ephemeral-session-secret-0000' \
  `# Same class: production refuses to auto-generate a throwaway BYOK disk key.` \
  `# Both of these are FINDINGS, not boilerplate — the source lane needs neither,` \
  `# so nothing before this phase exercised the release artifact's own startup` \
  `# preconditions. A deploy missing either fails closed, which is correct.` \
  -e OPENWOP_BYOK_ENCRYPTION_KEY='4f2a9c1e7b3d5086af12e4c69d70b8135ea6c2947f08d31b5c6e9a074d2f8b6e' \
  -e OPENWOP_RATELIMIT_DISABLED=true \
  -e OPENWOP_AUTH_DISABLE_COOKIES=true \
  -e OPENWOP_TEST_SEAM_ENABLED=true \
  `# RFC 0154 workload identity. The middleware is mounted UNCONDITIONALLY` \
  `# (index.ts:719) — this configures a profile the image already implements, it` \
  `# does not add one. Without these two the ten RFC 0154 scenarios fail at` \
  `# behaviorGate ("host MUST advertise the profile … or declare opt-out"),` \
  `# which is the gate refusing to let a capability-gated scenario skip silently.` \
  `# MEASURED 2026-09-09: gate-failing 10 -> 10 passed.` \
  `#` \
  `# BOTH are load-bearing and they answer different questions.` \
  `#   AUDIENCE turns the profile ON: readWorkloadIdentityConfigFromEnv()` \
  `#   (workloadIdentity.ts:457) returns null on an empty audience and nothing` \
  `#   else, registering the host's own issuer as a root by itself. The value is` \
  `#   not free: the scenarios present audience 'openwop-host'` \
  `#   (workload-identity-behavior.test.ts:88), and an invented one leaves every` \
  `#   case falling to identity_unverified instead of its specific closed reason.` \
  `#   TRUST makes them PASS: the presented issuer is spiffe://example (:85), an` \
  `#   EXTERNAL root, so it must be trusted explicitly. tenantId is mandatory —` \
  `#   parseTrustRoots (:344) refuses a root without one, because "a root that` \
  `#   binds to nothing is a root that binds to everything".` \
  -e OPENWOP_WORKLOAD_IDENTITY_AUDIENCE='openwop-host' \
  -e OPENWOP_WORKLOAD_IDENTITY_TRUST='[{"issuer":"spiffe://example","scheme":"spiffe","tenantId":"default"}]' \
  -e OPENWOP_ANON_ACTOR_ENABLED=true \
  -e OPENWOP_GOALS_ENABLED=true \
  -e OPENWOP_PROPOSALS_ENABLED=true \
  -e OPENWOP_PORTABILITY_ENABLED=true \
  -e OPENWOP_CHANNEL_PRESENCE_ENABLED=true \
  -e OPENWOP_I18N_LOCALES='en,pt-BR,es-419' \
  -e OPENWOP_MCP_SERVER_ENABLED=true \
  -e OPENWOP_TOOLCATALOG_COMPACTVIEW=true \
  -e OPENWOP_MULTI_AGENT_EXECUTION_MODEL=true \
  -e OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_2=true \
  -e OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_3=true \
  -e OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_4=true \
  -e OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_5=true \
  -e OPENWOP_SELF_HOSTED_RUNNER=true \
  -e OPENWOP_SELF_HOSTED_RUNNER_ACCEPTED=true \
  -e OPENWOP_A2A_SERVER_ENABLED=true \
  -e OPENWOP_A2A_DURABLE_TASKS=true \
  -e OPENWOP_DATA_RESIDENCY_ENABLED=true \
  -e OPENWOP_DATA_RESIDENCY_REGIONS=us \
  `# Host-side config the in-process boot also sets. Omitting these produced 13` \
  `# failures on the first full run that looked like host non-conformance and` \
  `# were MY configuration gap — the same misattribution ADR 0550 P1 made when` \
  `# it quarantined ten harness symptoms as protocol debt. The container image` \
  `# vendors conformance-fixtures/, so the fixtures flag is honest here.` \
  `# A PATH, not a boolean. run.ts:337 resolves it to` \
  `# <repo>/conformance-fixtures/form-content; the image COPYs that tree to` \
  `# /app/conformance-fixtures. Passing "true" made routes/formContentSeam.ts` \
  `# answer template_not_registered — exactly what run.ts's own comment predicts` \
  `# — and both instantiation legs went red. I copied the name out of run.ts's` \
  `# env list and assumed it was a boolean like every var around it.` \
  -e OPENWOP_FORM_CONTENT_CONFORMANCE_FIXTURES=/app/conformance-fixtures/form-content \
  -e OPENWOP_WEBHOOK_ALLOW_PRIVATE=true \
  `# The three MUST-AGREE vars from the ADR 0550 P2 env partition. The harness` \
  `# sets its own copies for the DRIVER; these are the HOST's, and without them` \
  `# the container has no idea where the doubles live.` \
  `# The container runs as PRODUCTION — which is why it demanded a session` \
  `# secret and a BYOK key above. conformanceNodesEnabled() is OFF by default` \
  `# under NODE_ENV=production so a fork cannot expose conformance.secret.echo` \
  `# & friends as live typeIds by accident; the reference deploy opts back in.` \
  `# Without it the fixture RUNS terminate with zero node.completed, which reads` \
  `# as six host defects and is a deliberate production posture.` \
  -e OPENWOP_ENABLE_CONFORMANCE_NODES=true \
  -e OPENWOP_COMPAT_PROVIDER_ENABLED=true \
  -e OPENWOP_TEST_COMPAT_ENDPOINT="http://${HARNESS_HOST}:${COMPAT_PORT}/v1" \
  -e OPENWOP_OIDC_ISSUER="http://${HARNESS_HOST}:${OIDC_PORT}" \
  -e OPENWOP_OIDC_AUDIENCE=openwop-conformance \
  `# DELIBERATELY NOT passing OPENWOP_BUILD_COMMIT. It was here, and it made the` \
  `# identity check VACUOUS: buildInfo.ts prefers the image stamp but falls back` \
  `# to the env var, so the lane read back the value it had just injected and` \
  `# passed against an image with NO stamp at all. Caught by sabotage — excluding` \
  `# build-meta/commit.txt still exited 0. Measured on that same image booted` \
  `# without the var: {"commit":"unknown","stamped":false,"commitSource":"none"}.` \
  `# The env var is deploy CONFIG (a claim); only the baked file is provenance.` \
  "$IMAGE" >/dev/null

BASE="http://127.0.0.1:$PORT"

# ── 4. Wait for readiness, then VERIFY THE ARTIFACT'S IDENTITY ────────────────
say "waiting for readiness"
ready=""
for _ in $(seq 1 60); do
  if body="$(curl -fsS "$BASE/api/readiness" 2>/dev/null)"; then ready="$body"; break; fi
  # A 503 still carries a body (managed-provider key unconfigured is expected here).
  if body="$(curl -sS "$BASE/api/readiness" 2>/dev/null)" && [ -n "$body" ]; then ready="$body"; break; fi
  sleep 1
done
[ -n "$ready" ] || { docker logs "$NAME" 2>&1 | tail -40; die "container never became reachable on $BASE"; }

read_build() {
  printf '%s' "$ready" | node -e '
    let s = "";
    const field = process.argv[1];
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { const j = JSON.parse(s); process.stdout.write(String(j?.build?.[field] ?? "")); }
      catch { process.stdout.write(""); }
    });
  ' "$1"
}
LIVE_COMMIT="$(read_build commit)"
LIVE_SOURCE="$(read_build commitSource)"
echo "[release-conformance] live build.commit=${LIVE_COMMIT:0:12} commitSource=${LIVE_SOURCE:-<absent>}"

# THE FALSIFIABLE CHECK — and the SOURCE assertion is the load-bearing half.
#
# Checking the commit VALUE alone is not enough, and this script shipped that
# weaker version first: it passed against an image carrying no stamp, because
# the boot above used to inject OPENWOP_BUILD_COMMIT and buildInfo.ts falls back
# to the env var. The lane was reading back its own input and calling it
# provenance — a gate that could not fail, in the phase whose whole subject is
# artifact identity.
#
# `commitSource: 'image'` is what proves the SHA travelled WITH the artifact.
# 'env' is a claim, 'none' is an unstamped build; both are refused.
[ -n "$LIVE_COMMIT" ] || die "the container reports NO build.commit — the image is unstamped and the witness would be meaningless"
[ "$LIVE_COMMIT" != "unknown" ] || die "the container reports build.commit=unknown — build-meta/commit.txt did not reach the image (check .dockerignore)"
[ "$LIVE_SOURCE" = "image" ] \
  || die "build.commitSource=${LIVE_SOURCE:-<absent>}, not 'image' — the SHA did not travel with the artifact, so this witness would certify an unidentified build"
[ "$LIVE_COMMIT" = "$EXPECTED_COMMIT" ] \
  || die "the container is running ${LIVE_COMMIT:0:12} but this checkout is ${EXPECTED_COMMIT:0:12} — a stale image would produce a witness for the wrong commit"

# ── 5. Run the suite against the container ────────────────────────────────────
say "running conformance against the release artifact"
cd "$ROOT/backend/typescript"

# Explicitly UNSET the two shared vars that the in-process boot points at
# loopback mocks. In this lane there is no local mock the container could reach,
# and run.ts REFUSES a loopback value here rather than producing false
# non-conformance. Unsetting is the honest state: the affected profiles are
# simply not witnessed at container level (recorded, never passed).
# NOTE: deliberately NOT unset any more. run.ts now starts the doubles bound to
# 0.0.0.0 and advertises them as host.docker.internal, which the --add-host above
# makes resolvable from inside the container. Unsetting them was the earlier,
# honest-but-narrow posture: it meant callback-shaped profiles were simply not
# witnessed at container level. They can be witnessed now.

# NOTE the expansion form below. macOS ships bash 3.2, where "${args[@]}" on an
# EMPTY array is an unbound-variable error under `set -u`. The filtered runs
# never caught it because `args` was populated; the first full run did.
args=()
[ -n "$FILTER" ] && args+=(--filter "$FILTER")
set +u

SUITE_LOG="$(mktemp -t owp-rc-suite)"
set +e
OPENWOP_CONFORMANCE_TARGET_URL="$BASE" \
OPENWOP_API_KEY="$API_KEY" \
  npm run test:conformance -- "${args[@]}" 2>&1 | tee "$SUITE_LOG"
SUITE_RC=${PIPESTATUS[0]}
set -eu

# ── 6. FLOOR on collected files — exit 0 is not evidence of coverage ──────────
#
# A scenario that throws at IMPORT takes down its whole file, and the run still
# exits 0 with a smaller total. Nothing reports which requirements went
# unverified: an unwitnessed requirement resolves to `blocked`, but a file that
# never loaded reports NEITHER. So a silently shrunken run looks like a green
# run.
#
# This is not hypothetical, and it is aimed squarely at THIS lane. The steward
# disclosed (2026-08-13) that six scenarios threw at import FROM THE NPM TARBALL
# — `spec/v1`, `RFCS` and `docs` sit above the package in a repo checkout but
# not in the tarball, and a null root was cast away. A release image has no
# sibling spec repo above the package, so the container lane runs in EXACTLY
# that layout, where run.ts's OPENWOP_CONFORMANCE_ROOT fallback cannot apply.
# The vendored 1.73.0 predates those six files, so this lane is currently safe
# by accident; the floor is what makes the next suite upgrade fail loudly
# instead of quietly certifying less.
#
# Only meaningful on a FULL run — a --filter deliberately narrows collection.
if [ -z "$FILTER" ]; then
  FLOOR="${OPENWOP_RC_FILE_FLOOR:-380}"
  # "Test Files  11 passed | 407 skipped (418)" → the parenthesised TOTAL is the
  # number COLLECTED, which is the quantity at risk. Passed/skipped counts move
  # legitimately with capability gating; collection does not.
  collected="$(grep -oE 'Test Files.*\(([0-9]+)\)' "$SUITE_LOG" | grep -oE '\(([0-9]+)\)$' | tr -d '()' | tail -1)"
  if [ -z "$collected" ]; then
    rm -f "$SUITE_LOG"
    die "could not read the collected-file count from the suite output — refusing to report a witness whose coverage is unknown"
  fi
  echo "[release-conformance] collected $collected scenario file(s) (floor $FLOOR)"
  if [ "$collected" -lt "$FLOOR" ]; then
    rm -f "$SUITE_LOG"
    die "only $collected scenario files collected, below the floor of $FLOOR — files are failing to LOAD (a collection error exits 0 and reports nothing). Raise OPENWOP_RC_FILE_FLOOR only when the suite legitimately shrinks."
  fi
fi

# ── EXECUTED, not merely collected — a green must witness something ─────────
#
# The floor above counts COLLECTED files, and the comment beside it states the
# assumption it rests on: "Passed/skipped counts move legitimately with
# capability gating; collection does not." Both halves are true, and together
# they are exactly why a 100%-SKIPPED run walks through: collection is intact,
# so the floor is satisfied, and the suite exits 0 because nothing failed.
#
# MEASURED 2026-09-09, and by accident, which is the point. A `--filter` whose
# pattern matched no TEST NAME (run.ts:994 maps --filter to vitest's
# --testNamePattern, so a FILE-shaped value matches nothing) produced:
#
#     Test Files  516 skipped (516)
#          Tests  1994 skipped (1994)
#     ✅ release-candidate conformance passed against <image> (commit 472fc151f0)
#
# Zero executed, exit 0, and the pass line NAMES THE IMAGE AND THE COMMIT. The
# entire output of this lane is a certification sentence, so a green that
# witnessed nothing is not a missing feature — it is a false claim about a
# shipped artifact. `check-conformance-major2.sh:9-11` already carries the rule
# this lane was missing: "a green here is never a witness of nothing: zero v2
# files executed is itself a failure."
#
# The general property, which is checkable by reading: A GATE IS SAFE IFF ITS
# PASS CONDITION CANNOT BE SATISFIED BY AN EMPTY INPUT. Sibling gates satisfy it
# three different ways — a literal input list (check-vendored-schemas), a
# cross-reference against an independent list (check-root-docs), or asserting an
# ABSENCE so that zero IS the assertion (check-entry-guard, which says so in its
# output). This lane satisfied it in none of them.
# `|| true` on EVERY grep here, not decoration. Under `set -e` a command
# substitution whose grep matches nothing exits 1 and aborts the script SILENTLY
# — which is how the first version of this guard behaved: it printed no refusal
# and exited 1, so the sabotage test looked like it passed while the guard had
# never run. A guard that dies before it can speak is the defect it exists to
# catch, one level down.
tests_line="$(grep -aoE 'Tests  +[0-9].*' "$SUITE_LOG" 2>/dev/null | tail -1 || true)"
t_passed="$(printf '%s' "$tests_line" | grep -oE '[0-9]+ passed' | grep -oE '^[0-9]+' | tail -1 || true)"
t_failed="$(printf '%s' "$tests_line" | grep -oE '[0-9]+ failed' | grep -oE '^[0-9]+' | tail -1 || true)"
executed=$(( ${t_passed:-0} + ${t_failed:-0} ))
rm -f "$SUITE_LOG"

if [ -z "$tests_line" ]; then
  die "could not read the executed-test count from the suite output — refusing to report a witness whose coverage is unknown (same refusal as the collected-count read above)"
fi

if [ "$SUITE_RC" != "0" ]; then
  say "container logs (last 40 lines)"
  docker logs "$NAME" 2>&1 | tail -40
  die "conformance FAILED against the release artifact (exit $SUITE_RC)"
fi

# TWO assertions, and they are deliberately NOT both inside the `-z "$FILTER"`
# block above. That exemption is right for COLLECTION — "a --filter deliberately
# narrows collection" — and wrong for EXECUTION: putting the new floor beside the
# old one would inherit the very exemption that let the measured 0-executed run
# through, since that run WAS filtered. (kicktodo-1's design input, and the clause
# most likely to be dropped later as "filters narrow things, so no floor applies".)
#
#   any run  → executed > 0      a filter legitimately executes FEW, never zero
#   full run → executed >= FLOOR same reasoning as the collected floor
if [ "$executed" -eq 0 ]; then
  die "the suite EXECUTED 0 tests ($tests_line) — exit 0 here means nothing ran, not that everything passed. This lane's only output is a certification claim naming the image and commit; it must not make one on an empty witness. If a --filter is set, its pattern matched no TEST NAME (--filter maps to vitest --testNamePattern, not a file glob)."
fi

if [ -z "$FILTER" ]; then
  EXEC_FLOOR="${OPENWOP_RC_EXECUTED_FLOOR:-1200}"
  # MEASURED 2026-09-09 on a full run at 472fc151f: 15 failed + 1779 passed =
  # 1794 executed, 200 skipped. The default sits well below that because skips
  # move legitimately with capability gating (the same property the collected
  # floor's comment names) — this catches a catastrophic drop, not a posture
  # change. Raise it only when the suite legitimately grows.
  if [ "$executed" -lt "$EXEC_FLOOR" ]; then
    die "only $executed test(s) executed on a FULL run, below the floor of $EXEC_FLOOR ($tests_line) — collection was intact, so the collected-file floor cannot see this. Lower OPENWOP_RC_EXECUTED_FLOOR only when the suite legitimately shrinks."
  fi
fi

# ── Disclose the non-default posture this witness was bought with ─────────────
#
# The lane relaxes real guards so the container can be exercised at all — most
# consequentially `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true`, without which no webhook
# scenario can reach the harness's own receiver. That is the documented purpose
# of that flag (`webhookEgressGuard.ts:32-36`, "so a loopback subscriber mock is
# reachable"), and the blast radius is bounded structurally rather than by our
# care: `:40-44` records that the pack-facing `safeFetch` guard is a SEPARATE
# flag precisely so relaxing the webhook worker cannot weaken it. The relaxed
# guard also keeps its own witness (`egress-policy.unit.test.ts:73`, `:84`, both
# at the flag's default), so waiving it here does not delete its only oracle.
#
# None of that makes the relaxation invisible, and a certification line that
# does not name it is claiming more than it measured. So: NAME THE WAIVER, not
# the posture. "test posture" is not checkable by the next reader;
# `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true` is. Same reasoning as the executed count
# above — a verdict carries its number, not an adjective.
#
# CALIBRATE THE LABEL TO THE INSTRUMENT. This block says "non-default posture
# flags", not "guard relaxations", because that is what the derivation can
# actually support: the pattern catches ALLOW/ENABLE/DISABLE/SKIP, and most of
# what it finds is feature enablement (goals, proposals, portability, presence,
# the MCP server) rather than a waived guard. Sorting the two apart would need a
# hand-maintained classification, which is the thing this block avoids — and a
# heading that claimed "relaxations" over a list that is mostly not would be the
# same overclaim the certification line itself is being fixed for.
#
# The reader still gets what matters. MEASURED on the first working run, the
# list named `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true` — and also
# `OPENWOP_TEST_SEAM_ENABLED=true` and `OPENWOP_RATELIMIT_DISABLED=true`, which
# nobody had been disclosing and which are larger posture claims than the
# waiver this block was written for.
#
# DERIVED, not hand-listed, twice over. The NAMES come from the lane's own `-e`
# lines (anything shaped like a relaxation), so a future flag is disclosed
# without anyone remembering to add it here; a hand-list would be stale the
# first time someone adds a switch in a hurry. The VALUES come from `docker
# inspect` on the container that actually ran — the script's intent is a mirror,
# the container's env is the oracle, and this file has already been bitten once
# by reading back a value it had just injected (see the OPENWOP_BUILD_COMMIT
# note in the run block above).
# `$ROOT/scripts/...`, NOT `$0`. `$0` is whatever path the caller typed, and
# line 224 `cd`s into backend/typescript to run the suite — so a relative
# invocation (`bash scripts/release-conformance.sh`, i.e. the normal one) makes
# `$0` unresolvable by the time this runs. MEASURED on the first live run of
# this block: `grep: scripts/release-conformance.sh: No such file or directory`,
# and the empty-list refusal below caught it. That refusal earning its keep
# against its own author's bug on day one is the argument for writing it that
# way rather than printing "no relaxations detected".
RELAX_NAMES="$(grep -oE '^\s+-e (OPENWOP_[A-Z0-9_]*(ALLOW|ENABLE|DISABLE|SKIP)[A-Z0-9_]*)=' "$ROOT/scripts/release-conformance.sh" \
  | grep -oE 'OPENWOP_[A-Z0-9_]+' | sort -u || true)"
RELAXED=""
for n in $RELAX_NAMES; do
  v="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NAME" 2>/dev/null \
       | grep -E "^${n}=" | head -1 | cut -d= -f2- || true)"
  [ -n "$v" ] && RELAXED="${RELAXED}${RELAXED:+, }${n}=${v}"
done
if [ -n "$RELAXED" ]; then
  printf '\n[release-conformance] witnessed with these non-default posture flags in force: %s\n' "$RELAXED"
else
  # An empty list is not "we changed nothing" — this lane demonstrably sets at
  # least the webhook egress waiver. Empty means the derivation or the inspect
  # failed, and an undisclosed waiver is the thing this block exists to prevent.
  # It has already earned this: the first live run of this block printed
  # `grep: scripts/release-conformance.sh: No such file or directory` and this
  # arm refused, catching its own author's `$0` bug rather than certifying.
  die "could not enumerate the lane's posture flags — refusing to certify without disclosing what the witness was bought with"
fi

# A filtered run is a developer convenience, not a certification. Saying so is
# the third verdict this vocabulary was missing: not pass, not fail, but "what
# was witnessed, and it is not the whole artifact". check-vendored-schemas.mjs
# does the same with its SKIPPED arm rather than collapsing into pass/fail.
if [ -n "$FILTER" ]; then
  printf '\n\033[1;33m◆ FILTERED run — %s test(s) executed under --filter %s. NOT a certification of %s.\033[0m\n' \
    "$executed" "$FILTER" "$IMAGE"
  exit 0
fi

printf '\n\033[1;32m✅ release-candidate conformance passed against %s (commit %s) — %s test(s) executed\033[0m\n' \
  "$IMAGE" "${LIVE_COMMIT:0:12}" "$executed"
