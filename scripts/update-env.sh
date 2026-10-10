#!/usr/bin/env bash
# update-env.sh — change the backend's environment WITHOUT a rebuild, and make
# the change actually reach requests (CE-16).
#
#   scripts/update-env.sh KEY=VALUE [KEY=VALUE ...]
#   scripts/update-env.sh --dry-run KEY=VALUE        # print the plan; change nothing
#   scripts/update-env.sh [KEY=VALUE ...] -- <other services-update flags>
#       e.g. `-- --update-secrets=FOO=foo:latest` or `-- --session-affinity`.
#       Region/project/account come from deploy.env — do not pass them. Refused:
#       --set-* / --clear-* / --env-vars-file (they REPLACE config) and --image
#       (that is a deploy: it would ship new code under the old commit stamp).
#
# WHY NOT `gcloud run services update --update-env-vars` ON ITS OWN. deploy.sh
# routes traffic BY NAME (ADR 0631), so the service's traffic spec pins one
# revision. An env update then creates a NEW revision that receives 0%: the change
# never reaches a request, and gcloud's success line does not say so. MEASURED
# 2026-10-05: `spec.traffic` was `[{revisionName: …-00857-6hq, percent: 100}]`
# with no `latestRevision` entry — the shape that strands every env update.
#
# What this does, in order, refusing at the first thing it cannot prove:
#   1. refuses while an evidence cut holds its lock (a new revision mid-cut makes
#      the cut's bundles describe a build they did not test — 2026-10-05);
#   2. records the SERVING revision (the traffic entry with a percent) and its
#      OPENWOP_BUILD_COMMIT;
#   3. runs `services update --update-env-vars` (merging; never --set-*);
#   4. reads `status.latestCreatedRevisionName` and proves it is Ready, carries
#      the SAME commit (an env update must not change the code — a different
#      commit means someone deployed in between) and has every KEY=VALUE;
#   5. shifts 100% to it BY NAME — never `--to-latest` (resolves by serial);
#   6. reads the serving revision back and checks it is that revision.
#
# OPENWOP_BUILD_COMMIT / OPENWOP_BUILD_DEPLOYED_AT are refused: they are the
# deploy provenance stamp (ADR 0518), written only by deploy.sh.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${UPDATE_ENV_ENV_FILE:-$ROOT/scripts/deploy.env}"
die() { echo "update-env: $*" >&2; exit 1; }

DRY_RUN=0; PAIRS=(); PASS=(); in_pass=0
for arg in "$@"; do
  if [ "$in_pass" -eq 1 ]; then
    case "$arg" in
      --set-*|--clear-*|--env-vars-file*)
        echo "update-env: $arg REPLACES config — use --update-* (merging) instead" >&2; exit 2 ;;
      --update-env-vars*) echo "update-env: pass env values as KEY=VALUE arguments (before --), so each one is verified on the new revision" >&2; exit 2 ;;
      --image*) echo "update-env: --image is a deploy; use scripts/deploy.sh (it stamps the commit)" >&2; exit 2 ;;
      --region*|--project*|--account*) echo "update-env: $arg comes from deploy.env; do not pass it" >&2; exit 2 ;;
    esac
    PASS+=("$arg"); continue
  fi
  case "$arg" in
    --) in_pass=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^#[[:space:]]\{0,1\}//'; exit 0 ;;
    *=*)
      k="${arg%%=*}"
      case "$k" in ''|*[!A-Za-z0-9_]*) echo "update-env: not an env-var name: $k" >&2; exit 2 ;; esac
      case "$k" in OPENWOP_BUILD_COMMIT|OPENWOP_BUILD_DEPLOYED_AT)
        echo "update-env: $k is the deploy provenance stamp (ADR 0518); only deploy.sh writes it" >&2; exit 2 ;; esac
      PAIRS+=("$arg") ;;
    *) echo "update-env: expected KEY=VALUE, got: $arg" >&2; exit 2 ;;
  esac
done
[ ${#PAIRS[@]} -gt 0 ] || [ ${#PASS[@]} -gt 0 ] || { echo "update-env: nothing to set (KEY=VALUE ... and/or -- <flags>)" >&2; exit 2; }

# The same strict parser deploy.sh uses: KEY=VALUE lines only, never sourced.
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found (cp scripts/deploy.env.example scripts/deploy.env)"
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in *=*) : ;; *) continue ;; esac
  key="${line%%=*}"; val="${line#*=}"
  key="${key#"${key%%[![:space:]]*}"}"; key="${key%"${key##*[![:space:]]}"}"
  case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
  case "$val" in \"*\") val="${val#\"}"; val="${val%\"}" ;; "'"*"'") val="${val#\'}"; val="${val%\'}" ;; esac
  export "$key=$val"
done < "$ENV_FILE"
for v in OPENWOP_DEPLOY_SERVICE OPENWOP_DEPLOY_PROJECT OPENWOP_DEPLOY_ACCOUNT; do
  [ -n "${!v:-}" ] || die "$v is not set in $ENV_FILE"
done
REGION="${OPENWOP_DEPLOY_REGION:-us-central1}"
GC=(--region "$REGION" --project "$OPENWOP_DEPLOY_PROJECT" --account "$OPENWOP_DEPLOY_ACCOUNT")
SVC="$OPENWOP_DEPLOY_SERVICE"

# ── 1. no evidence cut in progress ──────────────────────────────────────────
if [ -n "${OPENWOP_CERT_BUNDLE_ORIGIN:-}" ]; then
  . "$ROOT/scripts/lib/cut-lock.sh"
  lock_line=$(cut_lock_state "${OPENWOP_CERT_BUNDLE_ORIGIN%/}/.cut-lock.json" --project "$OPENWOP_DEPLOY_PROJECT" --account "$OPENWOP_DEPLOY_ACCOUNT")
  case "${lock_line%% *}" in
    absent|expired) : ;;
    held) die "an evidence cut is IN PROGRESS (${lock_line#* }). A new revision now would make its bundles describe a build they did not test — wait for it." ;;
    *) die "the cut lock could not be read (${lock_line#* }) — refusing to guess; that is not the same as a cut in progress." ;;
  esac
fi

# ── 2. what is serving now ──────────────────────────────────────────────────
# Prints "<serving-revision> <latest-created-revision>"; the serving one is the
# status.traffic entry carrying a percent (status.traffic[0] is NOT that).
svc_state() {
  gcloud run services describe "$SVC" "${GC[@]}" --format=json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const t=((j.status||{}).traffic||[]).filter(x=>x.percent>0);if(t.length!==1)process.exit(1);process.stdout.write(t[0].revisionName+" "+((j.status||{}).latestCreatedRevisionName||""))}catch{process.exit(1)}})'
}
# Prints "<Ready-status> <OPENWOP_BUILD_COMMIT>" then one KEY=VALUE per line.
rev_state() {
  gcloud run revisions describe "$1" "${GC[@]}" --format=json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);const env=((r.spec||{}).containers||[{}])[0].env||[];const c=env.find(e=>e.name==="OPENWOP_BUILD_COMMIT");const rd=((r.status||{}).conditions||[]).find(x=>x.type==="Ready");console.log((rd?rd.status:"?")+" "+((c&&c.value)||""));for(const e of env)if(e.value!==undefined)console.log(e.name+"="+e.value)}catch{process.exit(1)}})'
}
has_all_pairs() { # has_all_pairs <rev_state output>
  local p; for p in ${PAIRS[@]+"${PAIRS[@]}"}; do grep -qxF -- "$p" <<< "$1" || { echo "$p"; return 1; }; done
}

before=$(svc_state) || die "could not read the service's serving revision (gcloud run services describe)"
SERVING="${before%% *}"
serving_state=$(rev_state "$SERVING") || die "could not read the serving revision $SERVING"
COMMIT=$(printf '%s\n' "$serving_state" | head -1 | cut -d' ' -f2)
[ -n "$COMMIT" ] || die "the serving revision $SERVING carries no OPENWOP_BUILD_COMMIT — an unstamped revision cannot anchor an env update"
echo "serving: $SERVING  (commit ${COMMIT:0:12})"
echo "setting: ${PAIRS[*]:-(no env values)}${PASS[*]:+  plus: ${PASS[*]}}"
if [ "$DRY_RUN" -eq 1 ]; then echo "--dry-run: nothing changed"; exit 0; fi

# ── 3. the update (merging; gcloud splits on ',' unless told another delimiter) ─
UPD=()
if [ ${#PAIRS[@]} -gt 0 ]; then
  joined=$(IFS=$'\x1f'; printf '%s' "${PAIRS[*]}"); joined="${joined//$'\x1f'/@@}"
  UPD+=(--update-env-vars "^@@^$joined")
fi
gcloud run services update "$SVC" "${GC[@]}" ${UPD[@]+"${UPD[@]}"} ${PASS[@]+"${PASS[@]}"} --quiet \
  || die "gcloud run services update failed — nothing was shifted"

# ── 4. prove the revision it created ────────────────────────────────────────
after=$(svc_state) || die "could not re-read the service after the update"
CREATED="${after#* }"
if [ -z "$CREATED" ] || [ "$CREATED" = "$SERVING" ]; then
  # gcloud creates no revision when nothing changed. Then the values must
  # already be on the serving one, or the update did not happen.
  if missing=$(has_all_pairs "$serving_state"); then
    echo "update-env: no new revision — every value was already set on $SERVING (gcloud creates none for a no-op). Nothing to shift."; exit 0
  fi
  die "no new revision was created and $SERVING lacks '$missing' — the update did not take"
fi
created_state=$(rev_state "$CREATED") || die "could not read the created revision $CREATED"
read -r ready ccommit <<< "$(printf '%s\n' "$created_state" | head -1)"
[ "$ready" = "True" ] || die "$CREATED is not Ready (Ready=$ready) — NOT shifting traffic; $SERVING keeps serving"
[ "$ccommit" = "$COMMIT" ] || die "$CREATED carries commit '${ccommit:0:12}', not the serving ${COMMIT:0:12} — someone deployed in between. NOT shifting traffic."
missing=$(has_all_pairs "$created_state") || die "$CREATED lacks '$missing' — NOT shifting traffic"

# ── 5. shift by name ────────────────────────────────────────────────────────
echo "▶ traffic → $CREATED (by name; commit ${COMMIT:0:12} and every value verified on the revision)"
gcloud run services update-traffic "$SVC" --to-revisions "$CREATED=100" "${GC[@]}" --quiet \
  || die "update-traffic failed — $SERVING may still be serving; check: gcloud run services describe $SVC"

# ── 6. read it back ─────────────────────────────────────────────────────────
final=$(svc_state) || die "could not read the service after the shift"
[ "${final%% *}" = "$CREATED" ] || die "after the shift the serving revision is ${final%% *}, not $CREATED"
echo "update-env: OK — $CREATED serves 100% with ${PAIRS[*]:-}${PASS[*]:+ ${PASS[*]}}. The previous revision ($SERVING) keeps an instance until its last request ends (WHD-28)."
