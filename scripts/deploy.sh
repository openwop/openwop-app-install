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
#   scripts/deploy.sh --preflight-only           # stamp + gate, deploy nothing
#   scripts/deploy.sh --skip-certify             # ship with the RFC 0089 §D
#                                                # pointer ABSENT (never stale)

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
  case "$arg" in -h|--help) sed -n '2,33p' "$0" | sed 's/^#[[:space:]]\{0,1\}//'; exit 0 ;; esac
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

DO_BACKEND=1; DO_FRONTEND=1; PREFLIGHT_ONLY=0; DO_CERTIFY=1; PREFLIGHT_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --backend-only)  DO_FRONTEND=0; PREFLIGHT_ARGS+=("$arg") ;;
    --frontend-only) DO_BACKEND=0 ;;
    # Preflight exceptions the OPERATOR states. Both are forwarded, never
    # implied: preflight owns the gate, deploy.sh only carries the word
    # through. `--allow-pin-drift` was unreachable through this wrapper until
    # 2026-09-11 — the gate gained an exception its only supported entry point
    # could not pass, so the documented escape hatch existed on paper and
    # `deploy: unknown argument` in practice.
    --allow-unverified-live|--allow-pin-drift) PREFLIGHT_ARGS+=("$arg") ;;
    # Stamp + gate, then stop. Exists so the ordering above is testable without
    # an 8-minute build or a network round trip.
    --preflight-only) PREFLIGHT_ONLY=1 ;;
    # ADR 0550 P4. Ship WITHOUT re-deriving the certification stamp. The field
    # then ships ABSENT (write-build-commit.mjs has already deleted any stale
    # copy), which RFC 0089 §D makes fully conformant. There is deliberately no
    # flag that ships a stale one.
    --skip-certify) DO_CERTIFY=0 ;;
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
  if ! node "$ROOT/scripts/write-build-commit.mjs" "$SHA"; then
    echo "deploy: could not stamp the image commit — aborting before preflight." >&2
    exit 1
  fi
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
if [ "$DO_BACKEND" -eq 1 ]; then
  BUNDLE="$ROOT/build-meta/certification-bundle.json"
  CLAIMS="$ROOT/build-meta/conformance-claims.json"
  if [ "$DO_CERTIFY" -eq 0 ]; then
    echo
    echo "▶ certify: SKIPPED (--skip-certify) — the RFC 0089 §D pointer will be ABSENT, not stale"
  else
    echo
    echo "▶ certify (ADR 0550 P4) — full conformance lane, strict, no quarantine (~10 min)"
    # WHD-18: deploy.env's OPENWOP_CERT_BUNDLE_ORIGIN is exported above for the
    # verify step, and the in-process host this lane boots would inherit it — and
    # then try to read evidence from GCS (no metadata server here: a bounded 2 s
    # stall per discovery read per minute) and serve none of its own. The gate
    # measures the CODE, not the deployment's evidence origin, so unset it here.
    if ! ( cd "$ROOT/backend/typescript" && unset OPENWOP_CERT_BUNDLE_ORIGIN && npm run test:conformance -- --certify ); then
      echo "deploy: the certify lane FAILED — refusing to ship." >&2
      echo "        A certification stamp is a public claim; shipping without saying so" >&2
      echo "        would degrade silently. Re-run, or ship deliberately unclaimed:" >&2
      echo "          scripts/deploy.sh --skip-certify" >&2
      exit 1
    fi
    # Belt AND braces, because the lane's exit code is not the artifact. It
    # exits non-zero for a failing scenario too, and it can succeed while
    # writing nothing if the emitter refuses (schema rejection, emitter defect).
    # The only question that matters here is whether the files exist.
    if [ ! -f "$BUNDLE" ] || [ ! -f "$CLAIMS" ]; then
      echo "deploy: the certify lane exited 0 but produced no stamp — refusing to ship." >&2
      echo "        expected: $BUNDLE" >&2
      echo "                  $CLAIMS" >&2
      exit 1
    fi
    echo "  certified: $(node -e 'const c=require(process.argv[1]);process.stdout.write(`${c.claimedProfiles.length} profile(s) — ${c.claimedProfiles.join(", ")||"(none)"}`)' "$CLAIMS")"

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
    if ! bash "$ROOT/scripts/check-conformance-major2.sh"; then
      echo "deploy: the major-2 lane regressed — refusing to ship." >&2
      echo "        Either fix the scenario, or admit it with a reason in" >&2
      echo "        scripts/conformance-v2-known-red.txt (an admission is a" >&2
      echo "        wire gap this host declares; keep it short and dated)." >&2
      exit 1
    fi
  fi
fi

if [ "$DO_BACKEND" -eq 1 ]; then
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
  echo "▶ frontend → build (distribution: $OPENWOP_DISTRIBUTION)"
  # The commit is exported so write-build-info.mjs stamps the same SHA the
  # backend carries, rather than re-deriving it. Pass the distribution on the
  # build command as well as exporting it from deploy.env: this makes the
  # artifact identity visible at the mutation point and prevents a refactor of
  # config parsing from silently falling back to the default distribution.
  if ! ( cd "$ROOT/frontend/react" && \
      OPENWOP_BUILD_COMMIT="$SHA" \
      OPENWOP_DISTRIBUTION="$OPENWOP_DISTRIBUTION" \
      npm run build ); then
    echo "deploy: frontend build FAILED — nothing uploaded." >&2
    exit 1
  fi
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
