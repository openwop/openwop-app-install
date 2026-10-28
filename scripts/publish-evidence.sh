#!/usr/bin/env bash
# Cut, verify and PUBLISH the signed post-deploy certification evidence for the
# revision that is serving right now (WHD-18, ADR 0735 decision 2).
#
# WHAT IT DOES, in order — and stops at the first thing that is not true:
#   1. reads the SERVING commit from $BASE/api/readiness (full 40-hex);
#   2. refuses unless that commit is origin/main's tip (--allow-any-commit);
#   3. fetches the bundle-signing key from Secret Manager into a 0600 temp file
#      (never printed; deleted on exit) and proves its public half is the key
#      the live host publishes under OPENWOP_BUNDLE_SIGNING_KEY_ID;
#   4. fetches the conformance client key(s) from the host's api-key binding;
#   5. starts a cloudflared quick tunnel for the suite's webhook receiver (the
#      ADR 0735 run-side remedy — NEVER relax the SSRF guard instead);
#   6. per major (2, then 1): runs the suite CLI against the deployed origin with
#      --bundle-version 3 --require-behavior, signed; verifies the bundle with the
#      suite's --verify under the LIVE key AND with the host's own serving rules;
#      uploads it to <OPENWOP_CERT_BUNDLE_ORIGIN>/<commit>/major-<m>.json;
#   7. deletes every webhook subscription the run left in the conformance tenant
#      and reports the counts before/after;
#   8. polls the served pointer until the host serves the uploaded bytes
#      (sha256 equal), or reports that it has not yet.
#
# NOT wired into deploy.sh: it is an operator step, run AFTER a deploy has been
# verified. It writes to a production bucket and runs a ~10-minute load against
# the live service; neither belongs inside the deploy's critical path.
#
# Config comes from scripts/deploy.env (the same strict KEY=VALUE parser as
# deploy.sh). Required there:
#   BASE, OPENWOP_DEPLOY_PROJECT, OPENWOP_DEPLOY_ACCOUNT,
#   OPENWOP_CERT_BUNDLE_ORIGIN   gs://<bucket>/<prefix> — the SAME value the service has
#   OPENWOP_BUNDLE_SIGNING_KEY_ID the keyId the host publishes for the signing key
# Optional:
#   OPENWOP_BUNDLE_SIGNING_KEY_SECRET  (default openwop-app-bundle-signing-key)
#   OPENWOP_CONFORMANCE_KEY_SECRET     (default openwop-conformance-api-key)
#   OPENWOP_CONFORMANCE_BIN            (default backend/typescript/node_modules/.bin/openwop-conformance)
#
# Usage:
#   scripts/publish-evidence.sh                    # both majors, 2 then 1
#   scripts/publish-evidence.sh --major 2          # one major (repeatable)
#   scripts/publish-evidence.sh --allow-any-commit # the live commit is not origin/main's tip
#   scripts/publish-evidence.sh --print-config     # parse + print the plan; touch nothing
#   scripts/publish-evidence.sh --max-workers 1    # suite concurrency (default 1 — a CERTIFICATION cut MUST run single-worker)
#   scripts/publish-evidence.sh --break-lock       # take over a dead holder's cut lock (see below), then cut
#   scripts/publish-evidence.sh --allow-superseded-instances  # cut although an OLD revision still has a live instance, or that could not be checked
#
# One cut at a time. Two cuts against the same host at once contaminate
# each other: each is a single-worker load test, and the other's traffic
# lands inside it. The last upload wins the bucket. MEASURED 2026-09-28: two
# sessions' overlapping cuts published disturbed bundles for c3d06c29.
# Before any secret or load test, the cut creates <ORIGIN>/.cut-lock.json
# atomically (--if-generation-match=0) and removes that same generation on
# any exit. A held lock refuses the cut and names its holder. A lock past its
# expiresAt (2 h) is taken over. --break-lock takes over an unexpired one, and
# is only for a holder you've confirmed is dead.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${PUBLISH_EVIDENCE_ENV_FILE:-$ROOT/scripts/deploy.env}"
HELPERS="$ROOT/scripts/lib/publish-evidence-helpers.mjs"
VERIFY="$ROOT/scripts/lib/bundle-v3-verify.mjs"
OPTOUTS="$ROOT/scripts/lib/conformance-opt-outs.mjs"

die() { echo "publish-evidence: $*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in -h|--help) sed -n '2,45p' "$0" | sed 's/^#[[:space:]]\{0,1\}//'; exit 0 ;; esac
done

# ── arguments ────────────────────────────────────────────────────────────────
# MAX_WORKERS defaults to 1 (2026-09-25). It was 2 ("it is a load test"), but the
# suite's pinned fixture ports (webhook receiver, effect receiver, front-mux) are
# owned by ONE worker process, and its per-process routing registry is by design:
# a certification cut MUST run `--max-workers 1` (conformance effect-receiver.ts;
# the corpus cut-bundle.sh passes it). At 2, a scenario in the other worker
# registered a nonce nobody served — MEASURED: 0173 durable-delivery and 0187
# webhook-emitted timed out on every prod cut while the host retried correctly.
ALLOW_ANY_COMMIT=0; PRINT_CONFIG=0; BREAK_LOCK=0; ALLOW_SUPERSEDED=0; MAX_WORKERS=1; MAJORS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --allow-any-commit) ALLOW_ANY_COMMIT=1 ;;
    --print-config) PRINT_CONFIG=1 ;;
    --break-lock) BREAK_LOCK=1 ;;
    --allow-superseded-instances) ALLOW_SUPERSEDED=1 ;;
    --major)
      [ $# -ge 2 ] || { echo "publish-evidence: --major needs 1 or 2" >&2; exit 2; }
      case "$2" in 1|2) MAJORS+=("$2") ;; *) echo "publish-evidence: --major must be 1 or 2 (got $2)" >&2; exit 2 ;; esac
      shift ;;
    --max-workers)
      [ $# -ge 2 ] && [[ "$2" =~ ^[1-9][0-9]*$ ]] || { echo "publish-evidence: --max-workers needs a positive integer" >&2; exit 2; }
      MAX_WORKERS="$2"; shift ;;
    *) echo "publish-evidence: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
# Major 2 FIRST: it is the evidence the corpus declaration waits on, and a run
# that fails partway should have produced the one that matters most.
MAJORS_DEFAULTED=0
[ ${#MAJORS[@]} -gt 0 ] || { MAJORS=(2 1); MAJORS_DEFAULTED=1; }

# ── config (strict parse, never `source` — same reasoning as deploy.sh) ─────
[ -f "$ENV_FILE" ] || { echo "publish-evidence: $ENV_FILE not found (cp scripts/deploy.env.example scripts/deploy.env)" >&2; exit 2; }
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in *=*) : ;; *) continue ;; esac
  key="${line%%=*}"; val="${line#*=}"
  key="${key#"${key%%[![:space:]]*}"}"; key="${key%"${key##*[![:space:]]}"}"
  case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
  case "$val" in \"*\") val="${val#\"}"; val="${val%\"}" ;; "'"*"'") val="${val#\'}"; val="${val%\'}" ;; esac
  export "$key=$val"
done < "$ENV_FILE"

missing=()
for v in BASE OPENWOP_DEPLOY_PROJECT OPENWOP_DEPLOY_ACCOUNT OPENWOP_CERT_BUNDLE_ORIGIN OPENWOP_BUNDLE_SIGNING_KEY_ID; do
  [ -n "${!v:-}" ] || missing+=("$v")
done
(( ${#missing[@]} )) && { echo "publish-evidence: unset in $ENV_FILE: ${missing[*]}" >&2; exit 2; }
[[ "$OPENWOP_CERT_BUNDLE_ORIGIN" =~ ^gs://[a-z0-9][a-z0-9._-]+[a-z0-9](/.*)?$ ]] \
  || { echo "publish-evidence: OPENWOP_CERT_BUNDLE_ORIGIN must be gs://<bucket>[/<prefix>] (got $OPENWOP_CERT_BUNDLE_ORIGIN)" >&2; exit 2; }
ORIGIN="${OPENWOP_CERT_BUNDLE_ORIGIN%/}"
BASE="${BASE%/}"
# ADR 0827 — the protocol origin off the CDN. `BASE` is shared with deploy.sh,
# whose SPA checks need the Firebase front door (app.openwop.dev). Certification
# measures the PROTOCOL, so it may target a direct origin (api.openwop.dev, a
# Cloud Run domain mapping) where the edge cannot drop `If-None-Match`.
BASE="${OPENWOP_EVIDENCE_BASE:-$BASE}"
BASE="${BASE%/}"
SIGNING_SECRET="${OPENWOP_BUNDLE_SIGNING_KEY_SECRET:-openwop-app-bundle-signing-key}"
CONF_SECRET="${OPENWOP_CONFORMANCE_KEY_SECRET:-openwop-conformance-api-key}"
BIN="${OPENWOP_CONFORMANCE_BIN:-$ROOT/backend/typescript/node_modules/.bin/openwop-conformance}"
GC=(--project "$OPENWOP_DEPLOY_PROJECT" --account "$OPENWOP_DEPLOY_ACCOUNT")
LOCK="$ORIGIN/.cut-lock.json"

if [ "$PRINT_CONFIG" -eq 1 ]; then
  # The whole plan, from the parsed inputs alone — no network, no secrets.
  echo "base=$BASE"
  echo "origin=$ORIGIN"
  echo "majors=${MAJORS[*]}"
  [ "$MAJORS_DEFAULTED" -eq 1 ] && echo "major_1=only-if-advertised (dropped at run time when discovery offers no 1.x protocol)"
  echo "max_workers=$MAX_WORKERS"
  echo "allow_any_commit=$ALLOW_ANY_COMMIT"
  echo "lock=$LOCK"
  echo "break_lock=$BREAK_LOCK"
  echo "allow_superseded_instances=$ALLOW_SUPERSEDED"
  echo "signing_key_id=$OPENWOP_BUNDLE_SIGNING_KEY_ID"
  echo "signing_secret=$SIGNING_SECRET"
  echo "conformance_secret=$CONF_SECRET"
  for m in "${MAJORS[@]}"; do echo "object[$m]=$ORIGIN/<serving-commit>/major-$m.json"; done
  exit 0
fi

for tool in node gcloud cloudflared curl git; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not on PATH"
done
[ -x "$BIN" ] || die "suite CLI not found at $BIN — run 'npx -y npm@10.9.8 ci' in backend/typescript, or set OPENWOP_CONFORMANCE_BIN"

# ── scratch space: 0600 files, removed on ANY exit, tunnel killed ────────────
umask 077
WORK="$(mktemp -d)"
TUNNEL_PID=""
LOW_SCOPE_KEY_ID=""
LOCK_GEN=""
UNPUBLISHED=""
cleanup() {
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
  # Release OUR lock only: the generation match means a lock someone broke and
  # re-took is left alone.
  if [ -n "$LOCK_GEN" ]; then
    if gcloud storage rm "$LOCK" --if-generation-match="$LOCK_GEN" "${GC[@]}" >/dev/null 2>&1; then
      echo "cut lock released"
    else
      echo "cut lock NOT released (gen $LOCK_GEN) — check $LOCK" >&2
    fi
  fi
  # The low-scope key minted for the cut is revoked on ANY exit (it also carries a
  # 2 h expiry, so a hard kill leaves nothing usable for long).
  if [ -n "$LOW_SCOPE_KEY_ID" ]; then
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X DELETE -H "Authorization: Bearer $OPENWOP_API_KEY" "$BASE/api/host/openwop-app/developer-keys/$LOW_SCOPE_KEY_ID" || true)"
    echo "low-scope key revoked: $code"
  fi
  # A bundle the suite WROTE but this script did not upload (auth expired at
  # `gcloud storage cp`, a verify refusal, the host stopped serving) is the only
  # record of what that run saw, and the rm below would destroy it. Keep it:
  # 2026-10-14 cut 74c built a `certified: none` bundle, the upload then died on
  # an expired gcloud token, and the rows that explained NONE were lost.
  # NOT a certification artifact — it was never verified into the bucket.
  if [ -n "$UNPUBLISHED" ] && [ -s "$UNPUBLISHED" ]; then
    KEEP_DIR="${OPENWOP_REJECTED_EVIDENCE_DIR:-$HOME/.cache/openwop-app/rejected-evidence}"
    keep="$KEEP_DIR/${COMMIT:-unknown}-$(basename "$UNPUBLISHED" .json).unpublished.json"
    mkdir -p "$KEEP_DIR" && cp "$UNPUBLISHED" "$keep" \
      && echo "  kept the UNPUBLISHED bundle for diagnosis: $keep (not a certification artifact)" >&2
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# ADR 0991 — the cross-machine release bus: a `certify` lease and start/end
# events. D9: a cut LOADS the backend, so it takes the service's run: target and
# queues (bounded, fail-open) behind a live deploy to that same service, and a
# deploy queues behind it. Acquired BEFORE the cut lock and before the serving
# commit is read: a cut that waited must label its bundles with what serves
# AFTER the wait. When deploy.sh runs this (--publish-evidence) it exports its
# own id as OPENWOP_RELEASE_BUS_PARENT, so the cut does not queue behind its
# parent. The EXIT hook chains onto `cleanup` without changing the exit status.
if [ -f "$ROOT/scripts/lib/release-bus.sh" ]; then
  # shellcheck source=lib/release-bus.sh
  . "$ROOT/scripts/lib/release-bus.sh"
  CUT_TARGET="$(release_bus_targets backend)"
  cut_bus_end() {
    printf '{"kind":"certify","phase":"end","exit":%s,"commit":"%s","result":"%s"}' "$1" "${COMMIT:-}" "$([ "$1" -eq 0 ] && echo PUBLISHED || echo "FAILED rc=$1")"
  }
  release_bus_acquire_hold "certify-$(hostname -s 2>/dev/null || hostname)-$$" certify cut_bus_end ${CUT_TARGET:+--targets "$CUT_TARGET"}
fi

# ── 0. the cut lock: one cut at a time, across every session and machine ────
# Taken before the first request to the host: the harm is two concurrent load
# tests, not only last-write-wins in the bucket. A lock past its expiresAt
# (a SIGKILL or a closed lid skips the release) is taken over, and the
# takeover is itself generation-matched.
LOCK_TTL_S=$((2 * 3600))   # two single-worker majors under load fit inside this
LOCK_TOKEN="$(hostname -s 2>/dev/null || echo host):$$:$(date -u +%Y%m%dT%H%M%SZ)"
lock_holder() { gcloud storage cat "$LOCK" "${GC[@]}" 2>/dev/null || echo '(unreadable)'; }
lock_gen() { gcloud storage objects describe "$LOCK" --format='value(generation)' "${GC[@]}" 2>/dev/null; }
lock_expired() {  # stdin: the lock JSON. Unparseable counts as NOT expired: refuse, never guess.
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const e=JSON.parse(s).expiresAtEpoch;process.exit(Number.isFinite(e)&&e<Date.now()/1000?0:1)}catch{process.exit(1)}})'
}
g="$(lock_gen)"
if [ -n "$g" ]; then
  held="$(lock_holder)"
  if [ "$BREAK_LOCK" -eq 1 ] || printf '%s' "$held" | lock_expired; then
    echo "taking over the cut lock (gen $g, $([ "$BREAK_LOCK" -eq 1 ] && echo '--break-lock' || echo 'expired')): $held"
    gcloud storage rm "$LOCK" --if-generation-match="$g" "${GC[@]}" >/dev/null 2>&1 \
      || die "could not take over the cut lock: it changed under us, so someone else holds it now"
  fi
fi
iso() { node -e 'console.log(new Date(process.argv[1] * 1000).toISOString().replace(/\.\d+Z$/, "Z"))' "$1"; }
now="$(date +%s)"
printf '{"holder":"%s","user":"%s","host":"%s","pid":%d,"startedAt":"%s","expiresAt":"%s","expiresAtEpoch":%d}\n' \
  "$LOCK_TOKEN" "${OPENWOP_CUT_OWNER:-${USER:-unknown}}" "$(hostname -s 2>/dev/null || echo host)" "$$" \
  "$(iso "$now")" "$(iso "$((now + LOCK_TTL_S))")" "$((now + LOCK_TTL_S))" > "$WORK/lock.json"
if ! gcloud storage cp "$WORK/lock.json" "$LOCK" --if-generation-match=0 --content-type=application/json "${GC[@]}" >/dev/null 2>"$WORK/gcloud.err"; then
  [ -n "$(lock_gen)" ] || die "could not create the cut lock $LOCK: $(tail -1 "$WORK/gcloud.err")"
  die "another evidence cut holds $LOCK: $(lock_holder)
  Two cuts at once contaminate BOTH bundles. Wait for it to finish (it expires at its
  expiresAt). If its holder is confirmed dead before then, re-run with --break-lock."
fi
LOCK_GEN="$(lock_gen)"
case "$(lock_holder)" in *"\"$LOCK_TOKEN\""*) ;; *) LOCK_GEN=""; die "the cut lock changed hands right after it was taken, so not cutting" ;; esac
echo "cut lock held: $LOCK (gen $LOCK_GEN, expires in $((LOCK_TTL_S / 60)) min)"

# ── 1–2. which revision is serving, and is it the one we mean? ───────────────
curl -sS --connect-timeout 5 --max-time 20 "$BASE/api/readiness?cb=$(date +%s%N)" > "$WORK/readiness.json" \
  || die "could not read $BASE/api/readiness"
COMMIT="$(node "$HELPERS" discovery-field build.commit < "$WORK/readiness.json")" || die "/api/readiness carries no build.commit"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "the serving commit is '$COMMIT', not a full sha — an unstamped deploy has no key to publish under"
# ADR 0916 (P5) — the same release branch the deploy preflight checks.
DEPLOY_BRANCH="${OPENWOP_DEPLOY_BRANCH:-main}"
[[ "$DEPLOY_BRANCH" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$ && "$DEPLOY_BRANCH" != *..* ]] || die "OPENWOP_DEPLOY_BRANCH '$DEPLOY_BRANCH' is not a branch name"
git -C "$ROOT" fetch -q origin "$DEPLOY_BRANCH" || die "git fetch origin failed"
TIP="$(git -C "$ROOT" rev-parse "origin/$DEPLOY_BRANCH")"
if [ "$COMMIT" != "$TIP" ] && [ "$ALLOW_ANY_COMMIT" -eq 0 ]; then
  die "the serving commit ${COMMIT:0:12} is not origin/$DEPLOY_BRANCH's tip ${TIP:0:12}. Evidence is published for what is SERVING; if that is really what you want, pass --allow-any-commit."
fi
echo "serving: ${COMMIT:0:12}  (origin/$DEPLOY_BRANCH ${TIP:0:12})"

# ADR 0991 — the start event, now that the commit is known (the lease was
# acquired before the cut lock, above).
if declare -F release_bus >/dev/null; then
  release_bus publish "{\"kind\":\"certify\",\"phase\":\"start\",\"commit\":\"$COMMIT\",\"targets\":\"${CUT_TARGET:-}\"}"
fi

# The commit is read ONCE, above, and every bundle is labelled with it. So it must
# still be the serving commit when each major's suite has finished, and again just
# before its upload: a deploy that lands mid-cut sends the suite's requests to a
# different build. MEASURED 2026-10-05: this read saw 08886603d at 04:12:13Z, a
# deploy shifted traffic to 800722836 at 04:12:25Z, and both bundles were uploaded
# under 08886603d (pulled by hand). Unreadable counts as changed: the label is a
# claim, and an unread commit supports none. A deploy AND a rollback both inside
# one major's run would still slip past; preflight-deploy.sh Gate 8 refuses to
# deploy while this cut's lock is held, which closes that from the other side.
assert_still_serving() {
  local now
  now="$(curl -sS --connect-timeout 5 --max-time 20 "$BASE/api/readiness?cb=$(date +%s%N)" 2>/dev/null \
    | node "$HELPERS" discovery-field build.commit 2>/dev/null)" || now=""
  [ "$now" = "$COMMIT" ] && return 0
  die "$1: the serving commit is now '${now:-unreadable}', not ${COMMIT:0:12}, which this cut is labelled with. A deploy landed during the cut, so its requests reached a different build — not uploading."
}

# ── 2b. is anything ELSE still running? (WHD-28) ─────────────────────────────
# A superseded revision keeps an instance for as long as a request holds it open
# (an hour-long SSE stream does), and that instance keeps running its background
# workers against the same database: sweeper, schedule daemon, webhook delivery.
# MEASURED 2026-10-02: revision 00825-t4n stayed alive for the first 18 minutes
# of the 278b8d9ce cut; three runs stalled in that bundle. Traffic and tags say
# nothing about it — only the instance count does.
# Fail-closed: a check that could not run refuses too. An empty answer is a
# broken query, never "nothing else is running" (the helper insists on seeing
# the SERVING revision alive before it vouches for the others).
superseded_note=""
if [ -z "${OPENWOP_DEPLOY_SERVICE:-}" ]; then
  superseded_note="OPENWOP_DEPLOY_SERVICE is unset in $ENV_FILE, so the serving revision cannot be named"
else
  REGION="${OPENWOP_DEPLOY_REGION:-us-central1}"
  SERVING_REV="$(gcloud run services describe "$OPENWOP_DEPLOY_SERVICE" --region "$REGION" "${GC[@]}" --format=json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=(JSON.parse(s).status.traffic||[]).filter(x=>x.percent>0).sort((a,b)=>b.percent-a.percent)[0];if(t&&t.revisionName)console.log(t.revisionName)}catch{}})')"
  if [ -z "$SERVING_REV" ]; then
    superseded_note="could not read the serving revision of $OPENWOP_DEPLOY_SERVICE"
  else
    end="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; start="$(node -e 'console.log(new Date(Date.now()-10*60e3).toISOString().replace(/\.\d+Z$/,"Z"))')"
    curl -sS --max-time 30 -G "https://monitoring.googleapis.com/v3/projects/$OPENWOP_DEPLOY_PROJECT/timeSeries" \
      -H "Authorization: Bearer $(gcloud auth print-access-token "${GC[@]}" 2>/dev/null)" \
      --data-urlencode "filter=metric.type=\"run.googleapis.com/container/instance_count\" AND resource.labels.service_name=\"$OPENWOP_DEPLOY_SERVICE\"" \
      --data-urlencode "interval.startTime=$start" --data-urlencode "interval.endTime=$end" \
      --data-urlencode "aggregation.alignmentPeriod=60s" --data-urlencode "aggregation.perSeriesAligner=ALIGN_MAX" \
      > "$WORK/instances.json" 2>/dev/null || true
    live="$(node "$HELPERS" superseded-live "$SERVING_REV" < "$WORK/instances.json" 2>"$WORK/instances.err")"; rc=$?
    case "$rc" in
      0) echo "instances: only $SERVING_REV is alive" ;;
      1) superseded_note="a superseded revision still has a live instance (revision, count, as of):
$live
It runs its background workers against the same database while it lives. Wait for it to drain (it holds until its last open request ends), or delete the revision" ;;
      *) superseded_note="could not tell whether a superseded revision is alive: $(tail -1 "$WORK/instances.err" 2>/dev/null)" ;;
    esac
  fi
fi
if [ -n "$superseded_note" ]; then
  if [ "$ALLOW_SUPERSEDED" -eq 1 ]; then
    echo "WARNING (--allow-superseded-instances): $superseded_note"
  else
    die "$superseded_note. Pass --allow-superseded-instances to cut anyway."
  fi
fi

curl -sS --max-time 20 "$BASE/.well-known/openwop?cb=$(date +%s%N)" > "$WORK/discovery.json" || die "could not read discovery"
# CE-20 — does the host still offer major 1 at all? After the v1 sunset
# (2026-10-04) discovery advertises only `2.0`, the major-1 discovery document is
# gone, and with it the only place the major-1 bundle pointer was ever advertised
# (`capabilities.conformance.certificationBundleUrl`). A default run then skips
# major 1: it is the bigger load test (2165 rows), it can certify nothing, and no
# client can find its result. `--major 1` still cuts it, and step 8 then checks the
# route directly and says the bundle is served but NOT advertised.
ADVERTISES_V1="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s).protocolVersions;process.stdout.write(Array.isArray(v)&&v.some(x=>String(x).startsWith("1."))?"1":"0")}catch{process.stdout.write("?")}})' < "$WORK/discovery.json")"
if [ "$ADVERTISES_V1" = "0" ]; then
  if [ "$MAJORS_DEFAULTED" -eq 1 ]; then
    MAJORS=(2)
    echo "major 1: SKIPPED — discovery advertises no 1.x protocol (v1 retired); pass --major 1 to cut it anyway"
  elif [[ " ${MAJORS[*]} " == *" 1 "* ]]; then
    echo "major 1: cutting as asked, but discovery advertises no 1.x protocol — the bundle will be served at its route and NOT advertised"
  fi
elif [ "$ADVERTISES_V1" = "?" ]; then
  die "discovery has no readable protocolVersions — cannot tell which majors this host offers"
fi
IMPL_NAME="$(node "$HELPERS" discovery-field implementation.name < "$WORK/discovery.json")" || IMPL_NAME="openwop-workflow-engine"
IMPL_VERSION="$(node "$HELPERS" discovery-field implementation.version < "$WORK/discovery.json")" || IMPL_VERSION="0.0.0"

# ── 3. the signing key (never printed) ──────────────────────────────────────
gcloud secrets versions access latest --secret="$SIGNING_SECRET" "${GC[@]}" > "$WORK/signing.pem" 2>"$WORK/gcloud.err" \
  || die "could not read secret $SIGNING_SECRET ($(head -1 "$WORK/gcloud.err"))"
node "$HELPERS" key-matches "$OPENWOP_BUNDLE_SIGNING_KEY_ID" "$WORK/signing.pem" < "$WORK/discovery.json" \
  || die "refusing to cut: the signing key does not match what the host publishes (see above)"
PUB="$(node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const k=(d.signingKeys||[]).find(x=>x.keyId===process.argv[1]);process.stdout.write(k.publicKey)' "$OPENWOP_BUNDLE_SIGNING_KEY_ID" < "$WORK/discovery.json")"
node "$VERIFY" --pem "$PUB" > "$WORK/host.pem"

# ── 4. the conformance client key(s) ────────────────────────────────────────
gcloud secrets versions access latest --secret="$CONF_SECRET" "${GC[@]}" > "$WORK/binding" 2>"$WORK/gcloud.err" \
  || die "could not read secret $CONF_SECRET ($(head -1 "$WORK/gcloud.err"))"
node "$HELPERS" client-keys < "$WORK/binding" > "$WORK/client-keys" || die "the api-key binding in $CONF_SECRET holds no key"
OPENWOP_API_KEY="$(sed -n 1p "$WORK/client-keys")"; export OPENWOP_API_KEY
SECONDARY="$(sed -n 2p "$WORK/client-keys")"
if [ -n "$SECONDARY" ]; then export OPENWOP_TEST_SECONDARY_API_KEY="$SECONDARY"; else echo "note: no second key in the binding — cross-tenant legs will record their own disposition"; fi
# The suite's cross-tenant legs read TENANT_B, not SECONDARY (10 scenario files);
# exported only when the binding's two keys are on DIFFERENT tenants — see
# tenantBKeyFromBinding. Never printed.
if TENANT_B_KEY="$(node "$HELPERS" tenant-b-key < "$WORK/binding" 2>/dev/null)" && [ -n "$TENANT_B_KEY" ]; then
  export OPENWOP_TEST_TENANT_B_API_KEY="$TENANT_B_KEY"
  echo "tenant-B: set (the binding's second key is on a different tenant)"
else
  echo "note: no second key on a DIFFERENT tenant — tenant-B legs will record blocked"
fi

# ── 4b. is the key's run quota spent? (free: a refusal is never charged) ─────
# A cut starts hundreds of runs, and the conformance key has a per-UTC-day run
# quota. Once that is spent, every run-creating row is a 429, and the cut
# publishes a bundle of throttling rather than conformance. MEASURED
# 2026-09-29: the c3d06c29 bundles were 108 of 110 non-pass rows
# `session_runs_per_day`, blamed at first on overlapping cuts. Probe with a
# workflow that does not exist: the quota runs first, so a spent quota is
# a 429. Otherwise it is a 4xx, and nothing is charged either way.
#
# CORRECTED 2026-10-04: the probe POSTed to `$BASE/v1/runs` (and without the `/api`
# prefix every other call here uses). Since the v1 retirement (RFC 0234) that
# answers 410, and the check only refused on 429, so it printed "open" whatever the
# quota state: inert, and silently so. It now probes the major-2 surface and
# FAILS CLOSED: only the expected no-such-workflow refusal (400/404/422) reads as
# open; anything else means the probe could not see the quota, which is not "open".
code="$(curl -sS -o "$WORK/quota.json" -w '%{http_code}' --max-time 20 -X POST \
  -H "Authorization: Bearer $OPENWOP_API_KEY" -H 'content-type: application/json' -H 'OpenWOP-Version: 2' \
  -d '{"workflowId":"openwop-evidence-quota-probe-no-such-workflow"}' "$BASE/api/runs" || echo 000)"
case "$code" in
  429)
    reason="$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(0,"utf8"));const d=j.details||{};process.stdout.write(`${d.reason||"?"}, retry in ${Math.round((d.retryAfterMs||0)/60000)} min`)}catch{process.stdout.write("unparseable 429")}' < "$WORK/quota.json")"
    die "the conformance key is rate-limited on run creation ($reason). A cut now would publish 429s as evidence. Wait for the quota to reset." ;;
  400|404|422)
    echo "run quota: open (probe answered $code)" ;;
  *)
    die "the run-quota probe answered $code, not a no-such-workflow refusal (400/404/422) or 429 — it cannot see the quota, so a spent quota would go unnoticed. Fix the probe before cutting." ;;
esac

# The low-scope Subject (0200.challenge-403-scope, the approvals:respond leg of
# interrupt-auth-required-resume, RFC 0249's unscoped apply): a SHORT-LIVED owk_
# key holding `runs:read`, `proposals:read` and `proposals:write` (ADR 0972 D10), minted
# through the production developer-keys route in the conformance key's own tenant,
# revoked in `cleanup`. Never printed.
EXPIRES="$(node -e 'process.stdout.write(new Date(Date.now()+2*3600e3).toISOString())')"
if curl -sS --max-time 20 -X POST -H "Authorization: Bearer $OPENWOP_API_KEY" -H 'content-type: application/json' \
     -d "{\"name\":\"conformance low-scope (runs:read, proposals:read/write, evidence cut)\",\"scopes\":[\"runs:read\",\"proposals:read\",\"proposals:write\"],\"expiresAt\":\"$EXPIRES\"}" \
     "$BASE/api/host/openwop-app/developer-keys" > "$WORK/lowscope.json" \
   && LOW_SCOPE_KEY_ID="$(node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write((j.key&&j.key.keyId)||"")' < "$WORK/lowscope.json")" \
   && [ -n "$LOW_SCOPE_KEY_ID" ]; then
  OPENWOP_TEST_LOW_SCOPE_KEY="$(node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(j.token||"")' < "$WORK/lowscope.json")"
  export OPENWOP_TEST_LOW_SCOPE_KEY
  echo "low-scope key: minted (runs:read, proposals:read/write, expires $EXPIRES)"
else
  echo "note: could not mint a low-scope key — its legs will record blocked"
fi

webhook_ids() {
  # Major 2: since the v1 retirement (RFC 0234) `/v1/*` answers 410, and a 410
  # body is not a list, so the old v1 path made this die before any cut ran.
  curl -sS --max-time 20 -H "Authorization: Bearer $OPENWOP_API_KEY" -H 'OpenWOP-Version: 2' "$BASE/api/webhooks" > "$WORK/webhooks.json" || return 1
  node "$HELPERS" webhook-ids < "$WORK/webhooks.json"
}
BEFORE="$(webhook_ids)" || die "could not list webhook subscriptions (is the client key valid?)"
BEFORE_N="$(printf '%s' "$BEFORE" | grep -c .)"

# Trigger subscriptions are swept twice: here, BEFORE the suite, and again after
# the run (§ 7). The end sweep alone hands a crashed run's subscriptions to the
# next cut — 2026-10-14 cut 74c died at the upload and left 10, which the next
# cut then ran beside. The filter and the kept set are the same both times.
trigger_sweep_ids() {
  curl -sS --max-time 30 -H "Authorization: Bearer $OPENWOP_API_KEY" -H 'OpenWOP-Version: 2' "$BASE/api/trigger-subscriptions" > "$WORK/triggers.json" || return 1
  node "$HELPERS" trigger-sweep-ids < "$WORK/triggers.json"
}
sweep_trigger_subs() {
  local label="$1" ids seg code tdeleted=0 tfailed=0
  ids="$(trigger_sweep_ids)" || ids=""
  for seg in $ids; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X DELETE -H "Authorization: Bearer $OPENWOP_API_KEY" -H 'OpenWOP-Version: 2' "$BASE/api/host/openwop-app/trigger-subscriptions/$seg")"
    case "$code" in 2*) tdeleted=$((tdeleted+1)) ;; *) tfailed=$((tfailed+1)) ;; esac
  done
  echo "$label: swept=$(printf '%s' "$ids" | grep -c .) deleted=$tdeleted failed=$tfailed (paused and OPENWOP_EVIDENCE_KEEP_TRIGGER_SUBS kept)"
}
sweep_trigger_subs "trigger subscriptions (before the suite: a crashed earlier cut's leftovers)"

# ── 5. the tunnel ───────────────────────────────────────────────────────────
PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"
cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" > "$WORK/tunnel.log" 2>&1 &
TUNNEL_PID=$!
TUNNEL_URL=""
for _ in $(seq 1 60); do
  TUNNEL_URL="$(node "$HELPERS" tunnel-url < "$WORK/tunnel.log" 2>/dev/null)" && break
  kill -0 "$TUNNEL_PID" 2>/dev/null || die "cloudflared exited: $(tail -3 "$WORK/tunnel.log")"
  sleep 1
done
[ -n "$TUNNEL_URL" ] || die "cloudflared printed no trycloudflare URL within 60s"
export OPENWOP_WEBHOOK_RECEIVER_PORT="$PORT" OPENWOP_WEBHOOK_RECEIVER_URL="$TUNNEL_URL"
export OPENWOP_IMPLEMENTATION_NAME="$IMPL_NAME" OPENWOP_IMPLEMENTATION_VERSION="$IMPL_VERSION"
# A quick tunnel's URL appears before its DNS + edge route are live. MEASURED on the
# 0f9c447c8 cut: every tunnel-borne row (0173 durable delivery, 0201 rotation) saw
# NOTHING reach the listener, while the same rows passed on the cut before. Settle,
# then require the edge to answer SOMETHING (the suite's receiver is not up yet, so
# a 502/530 from the edge is the success signal; 000 = not routable).
sleep 20
up=0
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$TUNNEL_URL" || true)"
  if [ -n "$code" ] && [ "$code" != "000" ]; then up=1; break; fi
  sleep 4
done
[ "$up" -eq 1 ] || die "the tunnel $TUNNEL_URL never became routable — every webhook row would be starved"
echo "tunnel: $TUNNEL_URL -> 127.0.0.1:$PORT (routable)"

# ── 6. cut, verify, upload — per major ──────────────────────────────────────
published=()
for m in "${MAJORS[@]}"; do
  OUT="$WORK/major-$m.json"
  # WHD-23 — the production-posture opt-outs are checked against the TARGET's own
  # discovery; the helper refuses (non-zero) if the target advertises any of them.
  OPENWOP_OPTED_OUT_PROFILES="$(node "$OPTOUTS" --major "$m" --discovery-url "$BASE/.well-known/openwop")" \
    || die "could not derive the opt-out ledger (a posture opt-out may contradict live discovery — see above)"
  echo "  opt-outs (major $m): $OPENWOP_OPTED_OUT_PROFILES"
  export OPENWOP_OPTED_OUT_PROFILES
  echo "▶ major $m: cutting against $BASE (this is a load test; --max-workers $MAX_WORKERS)"
  "$BIN" --base-url "$BASE" --certify "$OUT" --target-major "$m" --bundle-version 3 --require-behavior \
    --max-workers "$MAX_WORKERS" --host-build "commit:$COMMIT" \
    --signing-key "$WORK/signing.pem" --signing-key-id "$OPENWOP_BUNDLE_SIGNING_KEY_ID"
  cut_exit=$?
  # A non-zero exit with a bundle written means "the host did not certify
  # everything" — that IS the evidence, honestly recorded. No bundle is fatal.
  # A bundle the suite REFUSED (its self-verification failed) is written beside
  # $OUT as `.rejected.json`, and $WORK is deleted on exit. Keep a copy first:
  # the refusal is an emitter defect report, and without the bytes it cannot be
  # diagnosed (openwop#1735: a 2.43.0 major-1 witness-digest refusal whose
  # bundle this cleanup destroyed). It is NOT a certification artifact.
  if [ ! -s "$OUT" ] && [ -s "$OUT.rejected.json" ]; then
    KEEP_DIR="${OPENWOP_REJECTED_EVIDENCE_DIR:-$HOME/.cache/openwop-app/rejected-evidence}"
    mkdir -p "$KEEP_DIR" && cp "$OUT.rejected.json" "$KEEP_DIR/$COMMIT-major-$m.rejected.json" \
      && echo "  kept the REFUSED bundle for diagnosis: $KEEP_DIR/$COMMIT-major-$m.rejected.json (not a certification artifact)"
  fi
  [ -s "$OUT" ] || die "major $m: the suite wrote no bundle (exit $cut_exit)"
  UNPUBLISHED="$OUT"
  assert_still_serving "major $m, after the suite"
  echo "  suite exit $cut_exit (non-zero = some rows are not passes; the bundle records which)"

  "$BIN" --verify "$OUT" --host-key "$WORK/host.pem" > "$WORK/verify-$m.txt" 2>&1
  v=$?
  if [ "$v" -ne 0 ]; then
    cat "$WORK/verify-$m.txt"
    die "major $m: the suite's --verify did not return VERIFIED (exit $v) — not uploading"
  fi
  node "$HELPERS" discovery-field signingKeys < "$WORK/discovery.json" > "$WORK/keys.json"
  node "$VERIFY" "$OUT" --commit "$COMMIT" --major "$m" --keys-json "$WORK/keys.json" \
    || die "major $m: the host would REFUSE this bundle (above) — not uploading"

  assert_still_serving "major $m, before the upload"
  DEST="$ORIGIN/$COMMIT/major-$m.json"
  gcloud storage cp "$OUT" "$DEST" --content-type=application/json "${GC[@]}" \
    || die "major $m: upload to $DEST failed"
  echo "  uploaded → $DEST  (sha256 $(shasum -a 256 "$OUT" | cut -c1-12))"
  published+=("$m")
  UNPUBLISHED=""
done

# ── 7. leave the conformance tenant as we found it ──────────────────────────
AFTER="$(webhook_ids)" || AFTER=""
AFTER_N="$(printf '%s' "$AFTER" | grep -c .)"
deleted=0
for id in $AFTER; do
  # $id is the projected bound id (`tenant~2Fuuid`, see webhookIds): one segment.
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X DELETE -H "Authorization: Bearer $OPENWOP_API_KEY" -H 'OpenWOP-Version: 2' "$BASE/api/webhooks/$id")"
  case "$code" in 2*) deleted=$((deleted+1)) ;; *) echo "  webhook $id: DELETE answered $code" ;; esac
done
FINAL="$(webhook_ids)" || FINAL="?"
FINAL_N="$(printf '%s' "$FINAL" | grep -c .)"
echo "webhook subscriptions: before=$BEFORE_N after-run=$AFTER_N deleted=$deleted remaining=$FINAL_N"

# Trigger subscriptions: every cut's trigger-bridge legs register some and the
# corpus defines no delete, so they accumulated in the conformance tenant (~278
# by 2026-10-04). Swept through the host-extension DELETE (ADR 0805 § Follow-up)
# — ALL of them, not only this run's, so the backlog clears on the first cut.
# Kept: anything PAUSED (a person parked it) and OPENWOP_EVIDENCE_KEEP_TRIGGER_SUBS
# (comma-separated ids). Non-fatal, like the webhook sweep: evidence is already
# uploaded, and a host without the route answers 404 per id.
# (sweep_trigger_subs is defined, and first run, before the suite — § 4.)
sweep_trigger_subs "trigger subscriptions"

# ── 8. is it served? ────────────────────────────────────────────────────────
# The host re-reads a withheld key at most every 60 s, so allow a little over
# that. Compare DIGESTS of the bytes, which is what a third party would do.
for m in ${published[@]+"${published[@]}"}; do
  want="$(shasum -a 256 "$WORK/major-$m.json" | cut -d' ' -f1)"
  got=""
  for _ in $(seq 1 10); do
    hdr=(); [ "$m" = 2 ] && hdr=(-H 'OpenWOP-Version: 2')
    curl -sS --max-time 20 ${hdr[@]+"${hdr[@]}"} "$BASE/.well-known/openwop?cb=$(date +%s%N)" > "$WORK/disco-$m.json"
    ptr="$(node "$HELPERS" discovery-field "$([ "$m" = 2 ] && echo conformance.certificationBundleUrl || echo capabilities.conformance.certificationBundleUrl)" < "$WORK/disco-$m.json" 2>/dev/null)"
    if [ -n "$ptr" ]; then
      path="${ptr#http*://*/}"
      got="$(curl -sS --max-time 20 "$BASE/${path}?cb=$(date +%s%N)" | shasum -a 256 | cut -d' ' -f1)"
      [ "$got" = "$want" ] && break
    elif [ "$m" = 1 ] && [ "$ADVERTISES_V1" = "0" ]; then
      # CE-20 — no major-1 discovery document exists to carry a pointer, so check
      # the route itself. Only an exact digest match counts, so trying the
      # Firebase-door spelling and the bare one cannot pass on the wrong bytes.
      for path in api/host/openwop-app/conformance/certification-bundle host/openwop-app/conformance/certification-bundle; do
        got="$(curl -sS --max-time 20 "$BASE/${path}?cb=$(date +%s%N)" | shasum -a 256 | cut -d' ' -f1)"
        [ "$got" = "$want" ] && { ptr="(route, not advertised) $BASE/$path"; break; }
      done
      [ "$got" = "$want" ] && break
    fi
    sleep 10
  done
  if [ "$got" = "$want" ]; then
    case "$ptr" in
      "(route, not advertised)"*) echo "  major $m: SERVED at ${ptr#(route, not advertised) } — bytes sha256 ${want:0:12} (equal to the upload); NOT advertised, discovery offers no major-1 document" ;;
      *) echo "  major $m: SERVED  pointer → bytes with sha256 ${want:0:12} (equal to the upload)" ;;
    esac
  else
    echo "  major $m: NOT YET SERVED (pointer ${ptr:-absent}; got ${got:0:12}, want ${want:0:12}) — check the service has OPENWOP_CERT_BUNDLE_ORIGIN=$ORIGIN and the logs for certification_evidence_withheld"
  fi
done
