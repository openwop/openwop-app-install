#!/usr/bin/env bash
# Verify BOTH deployed halves are running a known commit (ADR 0518).
#
# WHY THIS EXISTS. On 2026-08-03 two sessions deployed within minutes of each
# other. The second was built from a pre-merge source and silently reverted the
# first — twice, once per half. Prod briefly served a new SPA against a backend
# without the route it called, and the standard check (compare the built asset
# hash to the served one) REPORTED SUCCESS throughout, because the clobbering
# build's own hashes were internally consistent. Catching it actually required
# downloading a served code-split chunk and grepping it for a string only the
# new code contained.
#
# A hash proves "these bytes were built together". It does not prove WHICH
# SOURCE they came from. This asserts the source.
#
# Usage:
#   scripts/verify-deploy.sh                 # expect the current git HEAD
#   scripts/verify-deploy.sh <commit-sha>    # expect a specific commit
#   scripts/verify-deploy.sh --backend-only  # when only one half was deployed
#   BASE=https://staging.example scripts/verify-deploy.sh
#
# Exit 0 only when BOTH halves report the expected commit.

set -uo pipefail

BASE="${BASE:-https://app.openwop.dev}"
# Which halves to assert. A single-half deploy must not fail on the half it
# deliberately did not touch — that would train people to ignore a red verify,
# which is worse than not having one.
CHECK_BACKEND=1; CHECK_FRONTEND=1
AFTER_DEPLOY=0
ALLOW_REGISTRY_FAILURES=0
ALLOW_CHAIN_PACK_FAILURES=0
EXPECTED=""
for arg in "$@"; do
  case "$arg" in
    --backend-only)  CHECK_FRONTEND=0 ;;
    --frontend-only) CHECK_BACKEND=0 ;;
    # Set by deploy.sh when a backend deploy JUST ran. It is the only condition
    # under which "zero builds in the window" is provably wrong rather than
    # merely uninformative — see the H92 note on the window arm.
    --after-deploy)  AFTER_DEPLOY=1 ;;
    # NP-V2 P7 — a NAMED waiver for the one known window (a canon/chain publish
    # still pending, ADR 0766/0767): the failures are printed and the line reads
    # WAIVED, never OK. Without it a hotfix deploy in that window would fail verify
    # every time, which trains people to ignore a red verify.
    --allow-registry-failures) ALLOW_REGISTRY_FAILURES=1 ;;
    # grade-code C-1 — the same named-waiver discipline for chain packs the
    # loader REFUSED (each is a template missing from the gallery).
    --allow-chain-pack-failures) ALLOW_CHAIN_PACK_FAILURES=1 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^#[[:space:]]\{0,1\}//'; exit 0 ;;
    -*) echo "verify-deploy: unknown option: $arg" >&2; exit 2 ;;
    *) EXPECTED="$arg" ;;
  esac
done
[ -n "$EXPECTED" ] || EXPECTED="$(git rev-parse HEAD 2>/dev/null || echo '')"

if [ -z "$EXPECTED" ]; then
  echo "verify-deploy: no expected commit (pass one, or run inside a git repo)" >&2
  exit 2
fi

cb="cb=$(date +%s%N)"
fail=0

# Read a JSON string field without assuming jq is installed.
field() { grep -oE "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" <<<"$1" | head -1 | sed 's/.*"\([^"]*\)"$/\1/'; }

short() { printf '%.12s' "$1"; }

echo "expecting: $(short "$EXPECTED")  (base: $BASE)"

# Bounded reads. Without --max-time a hung endpoint (LB black-hole, half-open
# TCP) blocks the gate forever — and a deploy gate that hangs is worse than one
# that fails: it stalls the fix with no signal. A timeout falls through to the
# UNREACHABLE branch, which is already handled honestly.
# ── backend ────────────────────────────────────────────────────────────────
if [ "$CHECK_BACKEND" -eq 1 ]; then
# NO `-f`: `/api/readiness` answers 503 while `status: degraded`, which is a
# normal serving state that still carries `build.commit`. With `-f` that body
# was discarded and a fully successful deploy reported "UNREACHABLE" — MEASURED
# 2026-09-06 (a white-label run: frontend OK, v2 origin OK, backend "UNREACHABLE"
# while it was answering the request). Read the body whatever the code; only a
# body WITHOUT a commit is a failure, and the message says what was observed.
be_raw=$(curl -sS --connect-timeout 5 --max-time 15 -w '\n%{http_code}' "$BASE/api/readiness?$cb" 2>/dev/null) || be_raw=""
be_code="${be_raw##*$'\n'}"; be_body="${be_raw%$'\n'*}"; [ "$be_body" = "$be_raw" ] && be_body=""
be_state=$(field "$be_body" status)
be_tag=""; [ "$be_code" != "200" ] && be_tag=" (HTTP $be_code${be_state:+ $be_state} — serving, not ready)"
if [ -z "$be_raw" ] || [ "$be_code" = "000" ]; then
  echo "  backend   UNREACHABLE (/api/readiness) — no response within 15s"
  fail=1
else
  be_commit=$(field "$be_body" commit)
  if [ -z "$be_commit" ]; then
    echo "  backend   NO COMMIT — /api/readiness answered HTTP $be_code with no commit field (a load-balancer error page, or a backend older than ADR 0518)"
    fail=1
  elif [ "$be_commit" = "unknown" ]; then
    # Not a pass. An unstamped deploy is indistinguishable from a stale one,
    # which is the condition this script exists to eliminate.
    echo "  backend   UNSTAMPED — deploy did not pass OPENWOP_BUILD_COMMIT (see DEPLOY.md)"
    fail=1
  elif [ "${EXPECTED#"$be_commit"}" != "$EXPECTED" ] || [ "${be_commit#"$EXPECTED"}" != "$be_commit" ]; then
    echo "  backend   OK       $(short "$be_commit")$be_tag"
  else
    echo "  backend   MISMATCH $(short "$be_commit")  ← someone else's deploy is live"
    fail=1
  fi
  # NP-V2 P7 — boot-time registry installs that FAILED on this revision. Survivable
  # by design (the vendored copy serves), which is why 16 refusals went unseen for
  # eight days behind a warn line. Absent = a backend that predates the report;
  # said so, never read as "none failed".
  reg=$(BODY="$be_body" node -e '
    let b; try { b = JSON.parse(process.env.BODY); } catch { process.stdout.write("unparseable"); process.exit(0); }
    const r = b && b.checks && b.checks.registryPacks;
    if (!r) { process.stdout.write("absent"); process.exit(0); }
    // Fail CLOSED on a malformed or inconsistent report (review): a non-array
    // `failed`, or counts that do not add up, is not evidence of "none failed".
    if (!Array.isArray(r.failed) || typeof r.installed !== "number" || typeof r.attempted !== "number") { process.stdout.write("unparseable"); process.exit(0); }
    const f = r.failed;
    if (r.installed + f.length !== r.attempted) { process.stdout.write(`inconsistent installed=${r.installed} failed=${f.length} attempted=${r.attempted}`); process.exit(0); }
    process.stdout.write(f.length === 0 ? `ok ${r.installed}/${r.attempted}` : `failed ${f.map((x) => `${x.name}@${x.version}[${x.code || "unknown"}${x.lane === "feature" ? ",feature" : ""}]`).join(" ")}`);
  ' 2>/dev/null)
  case "$reg" in
    ok*)     echo "  registry  OK       ${reg#ok } registry pack(s) installed at boot" ;;
    absent)  echo "  registry  NOT REPORTED — backend predates the NP-V2 P7 readiness report" ;;
    failed*)
      if [ "$ALLOW_REGISTRY_FAILURES" -eq 1 ]; then
        echo "  registry  WAIVED   ${reg#failed } — --allow-registry-failures (publish + re-pin, then re-verify without it)"
      else
        echo "  registry  FAILED   ${reg#failed } — see the boot log (registry pack install failed); a known publish window: --allow-registry-failures"; fail=1
      fi ;;
    inconsistent*) echo "  registry  INCONSISTENT ${reg#inconsistent } — the report does not add up"; fail=1 ;;
    *)       echo "  registry  UNREADABLE — /api/readiness registryPacks did not parse"; fail=1 ;;
  esac
  # grade-code C-1 — chain packs the boot load REFUSED (workflow_chain_unpinned,
  # workflow_chain_pin_invalid, a schema failure): readiness stays 200 while a
  # template silently leaves the gallery — the registry-refusal class one layer
  # down. Absent = a backend that predates the report; said so, never "none".
  cp_rep=$(BODY="$be_body" node -e '
    let b; try { b = JSON.parse(process.env.BODY); } catch { process.stdout.write("unparseable"); process.exit(0); }
    const r = b && b.checks && b.checks.chainPacks;
    if (!r) { process.stdout.write("absent"); process.exit(0); }
    if (!Array.isArray(r.refused) || typeof r.loaded !== "number") { process.stdout.write("unparseable"); process.exit(0); }
    process.stdout.write(r.refused.length === 0 ? `ok ${r.loaded}` : `refused ${r.refused.map((x) => `${x.pack}(${x.code})`).join(" ")}`);
  ' 2>/dev/null)
  case "$cp_rep" in
    ok*)      echo "  chains    OK       ${cp_rep#ok } chain pack(s) loaded, none refused" ;;
    absent)   echo "  chains    NOT REPORTED — backend predates the chain-pack readiness report" ;;
    refused*)
      if [ "$ALLOW_CHAIN_PACK_FAILURES" -eq 1 ]; then
        echo "  chains    WAIVED   ${cp_rep#refused } — --allow-chain-pack-failures"
      else
        echo "  chains    REFUSED  ${cp_rep#refused } — the loader refused these packs (see workflow_chain_pack_rejected); a known window: --allow-chain-pack-failures"; fail=1
      fi ;;
    *)        echo "  chains    UNREADABLE — /api/readiness chainPacks did not parse"; fail=1 ;;
  esac
fi
fi

# ── frontend ───────────────────────────────────────────────────────────────
# WHY THIS POLLS (#5228). Right after `firebase deploy` releases, the CDN can
# still serve the PREVIOUS /build-info.json for a few seconds. MEASURED
# 2026-10-25 (MyndHyve cutover): verify read "frontend UNSTAMPED" straight
# after the release and the stamped commit a few seconds later — a healthy
# deploy reported as broken. Only the states that propagation can explain are
# re-read (unreachable, unstamped, another commit); DIRTY is a property of the
# build and never retried. The budget is bounded, so a real mismatch still
# reds, just FRONTEND_CONVERGE_S later.
FRONTEND_CONVERGE_S="${FRONTEND_CONVERGE_S:-45}"
FRONTEND_POLL_S="${FRONTEND_POLL_S:-5}"
probe_frontend() {
  fe_state=""; fe_line=""
  local body commit dirty
  body=$(curl -fsS --connect-timeout 5 --max-time 15 "$BASE/build-info.json?cb=$(date +%s%N)" 2>/dev/null)
  if [ -z "$body" ]; then
    fe_state=retry; fe_line="  frontend  UNREACHABLE (/build-info.json) — pre-ADR-0518 build, or hosting not deployed"
    return
  fi
  commit=$(field "$body" commit)
  dirty=$(grep -oE '"dirty"[[:space:]]*:[[:space:]]*(true|false)' <<<"$body" | grep -oE '(true|false)')
  if [ -z "$commit" ] || [ "$commit" = "unknown" ]; then
    fe_state=retry; fe_line="  frontend  UNSTAMPED — built without git or OPENWOP_BUILD_COMMIT"
  elif [ "${EXPECTED#"$commit"}" != "$EXPECTED" ] || [ "${commit#"$EXPECTED"}" != "$commit" ]; then
    if [ "$dirty" = "true" ]; then
      fe_state=fail; fe_line="  frontend  DIRTY    $(short "$commit")  ← built from a modified tree; the SHA does not describe it"
    else
      fe_state=ok; fe_line="  frontend  OK       $(short "$commit")"
    fi
  else
    fe_state=retry; fe_line="  frontend  MISMATCH $(short "$commit")  ← someone else's deploy is live"
  fi
}
if [ "$CHECK_FRONTEND" -eq 1 ]; then
  fe_waited=0
  while :; do
    probe_frontend
    [ "$fe_state" != retry ] && break
    [ "$fe_waited" -ge "$FRONTEND_CONVERGE_S" ] && break
    sleep "$FRONTEND_POLL_S"; fe_waited=$((fe_waited+FRONTEND_POLL_S))
  done
  if [ "$fe_state" = ok ] && [ "$fe_waited" -gt 0 ]; then
    echo "$fe_line (converged after ${fe_waited}s — CDN propagation)"
  elif [ "$fe_state" = retry ] && [ "$fe_waited" -gt 0 ]; then
    echo "$fe_line (still after ${fe_waited}s)"
  else
    echo "$fe_line"
  fi
  [ "$fe_state" = ok ] || fail=1
fi

# ── which evidence mode the LIVE service is in (WHD-18 / ADR 0735) ─────────
# WHY. The wire-claims arm below checks the certification evidence one of two
# ways, chosen by OPENWOP_CERT_BUNDLE_ORIGIN: set ⇒ ORIGIN mode (the signed
# post-deploy bundle bound to THIS commit; PENDING until publish-evidence.sh
# runs), unset ⇒ IMAGE mode (the in-image pointer). That variable used to come
# only from the operator's scripts/deploy.env. The service is the authority:
# openwop-app-backend carries OPENWOP_CERT_BUNDLE_ORIGIN, and in that mode the
# host deliberately withholds the in-image pointer. MEASURED 2026-09-27/28:
# three production deploys from a deploy.env without the line each reported
# "certificationBundleUrl MISSING" and "claims document STALE" — image-mode
# expectations applied to an origin-mode host. That is a false red on every deploy,
# and a standalone run could never check the evidence at all.
#
# So the mode is READ FROM THE DEPLOYED SERVICE when gcloud and the deploy scope
# are available. When deploy.env also sets it and the two DISAGREE, that is a
# failure: the checker would be verifying against a source the host does not
# use. When the service cannot be asked, the local value (if any) is used and the
# line says so. It is never a silent default.
if [ "$CHECK_BACKEND" -eq 1 ]; then
  ev_local="${OPENWOP_CERT_BUNDLE_ORIGIN:-}"
  ev_service="${OPENWOP_DEPLOY_SERVICE:-openwop-app-backend}"
  GC_ID=()
  [ -n "${OPENWOP_DEPLOY_ACCOUNT:-}" ] && GC_ID=(--account "$OPENWOP_DEPLOY_ACCOUNT")
  if ! command -v gcloud >/dev/null 2>&1 || [ -z "${OPENWOP_DEPLOY_PROJECT:-}" ] || [ -z "${OPENWOP_DEPLOY_REGION:-}" ]; then
    echo "  evidence mode ${ev_local:+origin ($ev_local, from deploy.env — the service was not asked: gcloud or OPENWOP_DEPLOY_PROJECT/REGION unavailable)}${ev_local:-image (OPENWOP_CERT_BUNDLE_ORIGIN unset locally; the service was not asked: gcloud or OPENWOP_DEPLOY_PROJECT/REGION unavailable)}"
  else
    ev_err=$(mktemp)
    ev_json=$(gcloud run services describe "$ev_service" --project "$OPENWOP_DEPLOY_PROJECT" --region "$OPENWOP_DEPLOY_REGION" \
                ${GC_ID[@]+"${GC_ID[@]}"} --format=json 2>"$ev_err")
    ev_rc=$?
    # The variable's value, or empty when the service does not carry it; exit 3
    # when the description is not the JSON a service describe returns.
    [ "$ev_rc" -eq 0 ] && { ev_live=$(node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try {
          const env = JSON.parse(s).spec.template.spec.containers[0].env ?? [];
          const e = env.find((x) => x.name === "OPENWOP_CERT_BUNDLE_ORIGIN");
          process.stdout.write((e && e.value) || "");
        } catch { process.exit(3); }
      });' <<<"$ev_json"); ev_rc=$?; }
    if [ "$ev_rc" -ne 0 ]; then
      echo "  evidence mode UNREADABLE — could not describe $ev_service: $(head -c 200 "$ev_err" | tr '\n' ' ')"
      [ -n "$ev_local" ] && echo "                using deploy.env's origin ($ev_local)"
    elif [ -n "$ev_local" ] && [ -n "$ev_live" ] && [ "$ev_local" != "$ev_live" ]; then
      echo "  evidence mode MISMATCH — deploy.env says $ev_local, the live service says $ev_live"
      fail=1
    elif [ -n "$ev_local" ] && [ -z "$ev_live" ]; then
      echo "  evidence mode MISMATCH — deploy.env sets an origin ($ev_local), the live service carries none (image mode)"
      fail=1
    elif [ -n "$ev_live" ]; then
      echo "  evidence mode origin ($ev_live, read from the live service)"
      export OPENWOP_CERT_BUNDLE_ORIGIN="$ev_live"
    else
      echo "  evidence mode image (the live service carries no OPENWOP_CERT_BUNDLE_ORIGIN)"
    fi
    rm -f "$ev_err"
  fi
fi

# ── wire claims ────────────────────────────────────────────────────────────
# The commit checks above prove WHICH SOURCE is running. They do not prove WHAT
# IT CLAIMS, and a capability claim is what peers rely on.
#
# MEASURED 2026-08-15: this host served `replay.sideEffectSuppression:
# "recorded-outcome"` for FOUR DAYS after the withdrawal merged. The seam fix
# that shipped in between was an ENV change (no image), so the code change never
# reached the wire — and this script passed the whole time, correctly, because
# the commit was never the thing in question. Found by the spec steward reading
# the document while checking something else. Nothing was watching.
#
# Backend-only by construction: the capability document is the backend's.
if [ "$CHECK_BACKEND" -eq 1 ] && [ "$fail" -eq 0 ]; then
  # `$BASE/api` — NOT `$BASE`. On Firebase Hosting the bare path hits the SPA
  # `**` rewrite and answers `200 text/html`, so a check pointed there would
  # compare against an app shell. `check-wire-claims.mjs` refuses a non-JSON
  # content-type for exactly that reason, but the right URL is cheaper than the
  # right error. (Both spellings measured 2026-08-15.)
  #
  # ADR 0614 — that 2026-08-15 note was accurate and its conclusion was too small.
  # The bare path answering `text/html` is not just "point the checker elsewhere":
  # it is `capabilities.md:30`+`:32` violated on the canonical discovery path, and
  # every consumer without our `/api` knowledge broken. Fixed by routing the wire
  # to the origin root; this invocation keeps `/api` because it tests THIS deploy's
  # backend rather than the hosting rewrite in front of it.
  #
  # WHD-18 / ADR 0735 — EXPECTED_COMMIT is what the ORIGIN-MODE arm binds the
  # served v3 bundle to (`OPENWOP_CERT_BUNDLE_ORIGIN` set: the evidence is the
  # signed post-deploy cut, and its `host.build.id` must be THIS deploy's commit).
  # The live backend commit is preferred because it is the full 40-hex SHA the
  # bundle carries, whereas `$EXPECTED` may be a prefix the operator typed; the
  # backend arm above has already proved the two agree. In image mode the arm is
  # unused and the variable is inert.
  wire_commit="$EXPECTED"
  if [[ "${be_commit:-}" =~ ^[0-9a-f]{40}$ ]]; then wire_commit="$be_commit"; fi
  if ! EXPECTED_COMMIT="$wire_commit" node "$(dirname "$0")/check-wire-claims.mjs" "$BASE/api"; then
    fail=1
  fi
fi

# ── the SPA shell actually serves a module (H91) ───────────────────────────
# WHY. CLAUDE.md prescribes fetching `/`, extracting its `assets/index-*.js`
# reference, and asserting the response is `200 text/javascript` — warning in
# capitals that `200 text/html` means the SPA rewrite answered and `/` is
# BROKEN. It then says, twice: assert the CONTENT-TYPE, never the status code.
#
# MEASURED 2026-08-18: nothing executed that. `grep -rn 'text/javascript'
# scripts/` found no assertion anywhere. So the one check whose entire premise
# is that a green is misleading had zero automated coverage, while the commit
# checks above — which prove WHICH SOURCE is live, not that it BOOTS — passed
# happily through it.
#
# The failure is real and has happened twice: caught live 2026-08-02, and the
# 2026-08-03 wedge that sat 16+ minutes with zero errors logged because a
# fire-and-forget refresh was never resumed under CPU throttling. Anonymous
# visitors get `text/html` where a module is expected and the SPA never boots.
#
# WHY THIS POLLS INSTEAD OF ASSERTING ONCE. `/` is LEGITIMATELY broken for up
# to OPENWOP_SPA_SHELL_TTL_S (60s) after a frontend deploy — the backend caches
# the shell and briefly serves one referencing a bundle Hosting has pruned. A
# single immediate assertion would red on every healthy deploy, and a check
# that cries wolf gets deleted, taking the real signal with it. So a bounded
# wait: transient ⇒ converges, wedged ⇒ red. The TTL is the window, so the
# default budget is comfortably past it.
SHELL_CONVERGE_S="${SHELL_CONVERGE_S:-90}"
if [ "$CHECK_FRONTEND" -eq 1 ] && [ "$fail" -eq 0 ]; then
  # A BROWSER user-agent. A bare curl reads the UA-branched bot prerender,
  # which is cached separately for an hour — so the default agent would probe a
  # different document than the one a visitor gets, and pass while `/` is down.
  UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
  shell_ok=0; shell_why=""; waited=0
  while :; do
    sh_body=$(curl -fsS -A "$UA" --connect-timeout 5 --max-time 15 "$BASE/?cb=$(date +%s%N)" 2>/dev/null)
    asset=$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' <<<"$sh_body" | head -1)
    if [ -z "$asset" ]; then
      # NOT a skip. A shell with no bundle reference is a broken shell; treating
      # "I could not find what I came to check" as absence of a problem is the
      # empty-plus-exit-0 mistake H90 removed one layer down.
      shell_why="\`/\` returned no assets/index-*.js reference at all"
    else
      ct=$(curl -sS -o /dev/null -A "$UA" --connect-timeout 5 --max-time 15 \
             -w '%{content_type}' "$BASE/$asset" 2>/dev/null)
      case "$ct" in
        *javascript*|*ecmascript*) shell_ok=1; break ;;
        *) shell_why="$asset served as '${ct:-<none>}' — the SPA rewrite answered, so the bundle is GONE" ;;
      esac
    fi
    [ "$waited" -ge "$SHELL_CONVERGE_S" ] && break
    sleep 10; waited=$((waited+10))
  done
  if [ "$shell_ok" -eq 1 ]; then
    if [ "$waited" -gt 0 ]; then
      echo "  spa shell  OK       module served (converged after ${waited}s — the post-deploy TTL window)"
    else
      echo "  spa shell  OK       module served"
    fi
  else
    echo "  spa shell  BROKEN after ${SHELL_CONVERGE_S}s — $shell_why"
    echo "             Anonymous visitors get text/html where a module is expected and the"
    echo "             SPA never boots. This does NOT self-heal (the TTL is a floor, not a"
    echo "             ceiling — measured 16+ min stale with nothing in the logs). Force new"
    echo "             instances: scripts/update-env.sh OPENWOP_RESTART_NONCE=\$(date +%s)"
    echo "             (a bare services update strands at 0% traffic — CE-16)"
    fail=1
  fi
fi

# ── peer build in your deploy window (H90) ─────────────────────────────────
# WHY THIS MOVED HERE FROM PROSE. CLAUDE.md told you to run `gcloud builds list
# --limit 3` after every deploy, to catch the 2026-08-03 double-clobber class.
# MEASURED 2026-08-18: that command returns **empty, exit 0**. Cloud Run
# `--source` deploys produce REGIONAL builds, so without `--region` the list is
# unconditionally empty and the check has been unable to fail for as long as
# builds have been regional — it was green on deploys #5, #6 and #7 and meant
# nothing every time.
#
# Two separate defects, and the second is the general one:
#   1. wrong scope, so the query could not see the thing it was looking for;
#   2. an EMPTY result read as "nobody else built" instead of "the query is
#      wrong". Empty + exit 0 is the most reliable tell we have that a check
#      is inert, and it is not detectable by reading the check's output.
#
# A test's silence sits next to other tests' noise. A runbook step's silence
# sits next to nothing, which is why this had to become executed code rather
# than a corrected sentence.
#
# Hence the FLOOR below: the project must have at least one build, ever. That
# is true whenever the query is correctly scoped and false when it is not, so
# it fails on the exact defect being repaired rather than on the weather.
#
# Set PEER_BUILD_WINDOW_MIN=0 to skip the window check (kept explicit — there
# is deliberately no way to skip it silently).
# The default is a FALLBACK for a hand-run verify. `deploy.sh` exports this
# sized to its own elapsed time + 5m (ADR 0691), because the question is "did
# anyone else build during MY deploy" and only the deploy knows how long that
# was. The fixed 20 here was calibrated before certify and the major-2 ratchet
# ran ahead of the build; a full two-half deploy now exceeds it, which made this
# check fail every time while every substantive leg passed.
PEER_BUILD_WINDOW_MIN="${PEER_BUILD_WINDOW_MIN:-45}"
if [ "$CHECK_BACKEND" -eq 1 ]; then
  gcp_project="${OPENWOP_DEPLOY_PROJECT:-}"
  gcp_region="${OPENWOP_DEPLOY_REGION:-}"
  # IDENTITY, not just scope (#3771/#3775 closed this in preflight-deploy.sh and
  # check-pack-pin-drift.mjs; this script was missed). The deployer is a DIFFERENT
  # account from the project owner, and `gcloud` runs as whatever `core/account`
  # happens to be. MEASURED 2026-09-15 on a real deploy of 18987f1a1: as the active
  # account this query is PERMISSION_DENIED, the `2>/dev/null` below ate the error,
  # `$any` came back empty, and the floor fired "QUERY BROKEN" on a deploy that was
  # in fact clean — a FALSE RED on the check whose whole purpose is to be trusted.
  GC_ID=()
  [ -n "${OPENWOP_DEPLOY_ACCOUNT:-}" ] && GC_ID=(--account "$OPENWOP_DEPLOY_ACCOUNT")
  if ! command -v gcloud >/dev/null 2>&1; then
    # SKIPPED is a distinct word from OK on purpose. A check that degrades to
    # a pass when its tool is missing is the same inert-green this section
    # exists to remove.
    echo "  peer build  SKIPPED  (gcloud not on PATH)"
  elif [ -z "$gcp_project" ] || [ -z "$gcp_region" ]; then
    echo "  peer build  SKIPPED  (OPENWOP_DEPLOY_PROJECT / OPENWOP_DEPLOY_REGION unset — source scripts/deploy.env)"
  else
    # THE FLOOR. Not a peer check — a check on the check. A correctly scoped
    # query against a project that has ever deployed cannot return nothing.
    any_err=$(mktemp)
    any=$(gcloud builds list --project "$gcp_project" --region "$gcp_region" \
            ${GC_ID[@]+"${GC_ID[@]}"} --limit 1 --format='value(id)' 2>"$any_err")
    if [ -z "$any" ]; then
      echo "  peer build  QUERY BROKEN — 'gcloud builds list' returned NOTHING for"
      echo "              project=$gcp_project region=$gcp_region. A project that has"
      echo "              deployed always has builds, so this is a scope/credential"
      echo "              fault, NOT evidence that nobody else built. Do not read it"
      echo "              as a pass. (This is the H90 defect: the bare command omits"
      echo "              --region and is empty-with-exit-0 forever.)"
      # Say WHICH fault. "scope/credential" sent one operator reading region
      # config when the real answer was one line of stderr this script was
      # discarding: PERMISSION_DENIED for the active account.
      if [ -s "$any_err" ]; then
        echo "              gcloud said:"
        sed 's/^/                /' "$any_err" | head -3
        echo "              account=${OPENWOP_DEPLOY_ACCOUNT:-<unset — set OPENWOP_DEPLOY_ACCOUNT in scripts/deploy.env>}"
      fi
      fail=1
    elif [ "$PEER_BUILD_WINDOW_MIN" -gt 0 ] 2>/dev/null; then
      win=$(gcloud builds list --project "$gcp_project" --region "$gcp_region" \
              ${GC_ID[@]+"${GC_ID[@]}"} \
              --filter="createTime>-PT${PEER_BUILD_WINDOW_MIN}M" \
              --format='value(id,createTime,status)' 2>/dev/null)
      n=$(printf '%s\n' "$win" | grep -c '[^[:space:]]')
      if [ "$n" -ge 2 ]; then
        echo "  peer build  TWO OR MORE BUILDS in the last ${PEER_BUILD_WINDOW_MIN}m — a parallel deploy may have"
        echo "              landed on top of yours. The commit checks above CANNOT see this:"
        echo "              a clobbering build's own stamps are internally consistent."
        printf '%s\n' "$win" | sed 's/^/                /'
        fail=1
      elif [ "$n" -eq 0 ]; then
        # H92 — ZERO IS NOT A CLEAN RESULT, and this arm used to print OK for it.
        #
        # The floor above refuses to read an empty GLOBAL query as "nobody
        # built". The WINDOW query had no such floor, so the same empty-means-
        # inert defect survived one level down: a broken filter, a clock skew, or
        # a deploy that outran the window all produce n=0, and n=0 printed the
        # cleanest line on the page.
        #
        # After a deploy the reasoning is airtight: YOUR OWN build is in the
        # window, so zero is proof the query is not measuring what it claims —
        # never evidence of a quiet region. Hence fatal under --after-deploy.
        #
        # Run standalone (an ad-hoc check hours later) zero is legitimate, so it
        # is reported rather than failed. It still does NOT say OK: the arm
        # corroborated nothing, and a word that implies it did is how this class
        # keeps coming back.
        if [ "$AFTER_DEPLOY" -eq 1 ]; then
          echo "  peer build  WINDOW BROKEN — 0 builds in the last ${PEER_BUILD_WINDOW_MIN}m, but a deploy"
          echo "              JUST RAN, so at minimum your own build must be here. The filter,"
          echo "              the clock, or the window is wrong. This is NOT evidence that"
          echo "              nobody else deployed. (Widen with PEER_BUILD_WINDOW_MIN if the"
          echo "              build legitimately took longer than ${PEER_BUILD_WINDOW_MIN}m.)"
          fail=1
        else
          echo "  peer build  NOT CORROBORATED — 0 builds in the last ${PEER_BUILD_WINDOW_MIN}m. Expected when"
          echo "              run standalone rather than after a deploy; the arm checked nothing."
        fi
      else
        echo "  peer build  OK       $n build(s) in the last ${PEER_BUILD_WINDOW_MIN}m (region $gcp_region)"
      fi
    else
      echo "  peer build  FLOOR OK  (window check disabled via PEER_BUILD_WINDOW_MIN=0)"
    fi
    rm -f "$any_err"
  fi
fi

# ── superseded revisions still firing scheduled jobs (WHD-28, CE-16) ─────────
# WHY. With CPU always allocated (ADR 0741) a superseded revision's instance
# keeps running every background loop after its traffic moves — including the
# schedule daemon. MEASURED three times on 2026-09-29/30: the previous release
# fired scheduled jobs with OLD code for hours after a verified deploy, and the
# commit checks above cannot see it (they ask the SERVING revision). It was
# found each time by hand, by grouping `schedule fired` logs by revision.
#
# Right after a deploy the previous revision is still alive by construction, so
# a fire inside the lookback window may predate the traffic switch. After a
# deploy it is an ACTION; standalone, an unresolved non-serving fire still FAILS.
# Neither branch can infer current activity from historical logs. Measure drain
# separately and preserve the rollback revision (ADR 0802's D1 correction).
#
# Never an inert green: a failed log query is UNMEASURED and an empty one is NOT
# CORROBORATED — neither says OK. STALE_REV_WINDOW_MIN=0 skips it, explicitly.
STALE_REV_WINDOW_MIN="${STALE_REV_WINDOW_MIN:-60}"
if [ "$CHECK_BACKEND" -eq 1 ]; then
  sr_service="${OPENWOP_DEPLOY_SERVICE:-openwop-app-backend}"
  GC_ID=()
  [ -n "${OPENWOP_DEPLOY_ACCOUNT:-}" ] && GC_ID=(--account "$OPENWOP_DEPLOY_ACCOUNT")
  if ! command -v gcloud >/dev/null 2>&1; then
    echo "  stale revs  SKIPPED  (gcloud not on PATH)"
  elif [ -z "${OPENWOP_DEPLOY_PROJECT:-}" ] || [ -z "${OPENWOP_DEPLOY_REGION:-}" ]; then
    echo "  stale revs  SKIPPED  (OPENWOP_DEPLOY_PROJECT / OPENWOP_DEPLOY_REGION unset — source scripts/deploy.env)"
  elif ! [ "$STALE_REV_WINDOW_MIN" -gt 0 ] 2>/dev/null; then
    echo "  stale revs  SKIPPED  (STALE_REV_WINDOW_MIN=$STALE_REV_WINDOW_MIN)"
  else
    sr_err=$(mktemp)
    sr_json=$(gcloud run services describe "$sr_service" --project "$OPENWOP_DEPLOY_PROJECT" --region "$OPENWOP_DEPLOY_REGION" \
                ${GC_ID[@]+"${GC_ID[@]}"} --format=json 2>"$sr_err")
    # The revisions that actually take traffic (status, percent > 0) — SPEC can
    # name a revision that never became ready (the 2026-09-30 v22 rollout).
    sr_serving=$(printf '%s' "$sr_json" | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try {
          const t = (JSON.parse(s).status || {}).traffic || [];
          process.stdout.write(t.filter((x) => (x.percent || 0) > 0 && x.revisionName).map((x) => x.revisionName).join("\n"));
        } catch { process.exit(3); }
      });' 2>/dev/null)
    if [ -z "$sr_serving" ]; then
      echo "  stale revs  UNMEASURED — could not read the serving revision of $sr_service"
    else
      sr_fired=$(gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$sr_service\" AND jsonPayload.msg=\"schedule fired\"" \
                   --project "$OPENWOP_DEPLOY_PROJECT" ${GC_ID[@]+"${GC_ID[@]}"} --freshness="${STALE_REV_WINDOW_MIN}m" --limit 2000 \
                   --format='value(resource.labels.revision_name)' 2>"$sr_err")
      sr_rc=$?
      if [ "$sr_rc" -ne 0 ]; then
        echo "  stale revs  UNMEASURED — 'gcloud logging read' failed (rc=$sr_rc); stale revisions were NOT checked:"
        sed 's/^/                /' "$sr_err" | head -3
      elif [ -z "$(printf '%s' "$sr_fired" | tr -d '[:space:]')" ]; then
        echo "  stale revs  NOT CORROBORATED — no scheduled job fired in the last ${STALE_REV_WINDOW_MIN}m; nothing to attribute"
      else
        sr_stale=$(printf '%s\n' "$sr_fired" | grep -v '^[[:space:]]*$' | grep -vxF -f <(printf '%s\n' "$sr_serving") | sort | uniq -c)
        if [ -z "$sr_stale" ]; then
          echo "  stale revs  OK       every scheduled job in the last ${STALE_REV_WINDOW_MIN}m fired from the serving revision"
        else
          if [ "$AFTER_DEPLOY" -eq 1 ]; then
            echo "  stale revs  ACTION — superseded revision(s) fired scheduled jobs in the last ${STALE_REV_WINDOW_MIN}m"
            echo "              (expected right after a deploy: the old instance outlives its traffic, WHD-28)."
            echo "              Do NOT delete the previous revision: deleting does not stop its instance (ADR 0802),"
            echo "              it only removes the rollback target. It drains in ~1h; re-run verify-deploy.sh after that."
            printf '%s\n' "$sr_stale" | while read -r n rev; do
              echo "                $rev fired $n job(s) (draining; keep it as the rollback target)"
            done
          else
            echo "  stale revs  FAILED — a NON-serving revision fired scheduled jobs in the last ${STALE_REV_WINDOW_MIN}m,"
            echo "              This is historical evidence, not proof of current activity: compare log timestamps"
            echo "              with the traffic switch and measure container/instance_count for each revision."
            echo "              Keep the rollback target. Deleting a revision does not stop its open instances"
            echo "              (ADR 0802); investigate continued firing and re-check the measured drain."
            fail=1
            printf '%s\n' "$sr_stale" | while read -r n rev; do
              echo "                $rev fired $n job(s) in the lookback window (keep it as the rollback target)"
            done
          fi
        fi
      fi
    fi
    rm -f "$sr_err"
  fi
fi

if [ "$CHECK_BACKEND" -eq 1 ] && [ "$CHECK_FRONTEND" -eq 1 ]; then
  # ── ADR 0631 — the ORIGIN must serve the major-2 path space, not the SPA shell ──
  # MEASURED 2026-09-05: 14/15 manifest roots answered 200 text/html at the origin
  # with no OpenWOP-Version while the run.app URL was correct. Probe one root both
  # ways at the public origin: named major → JSON + the header; headerless browser
  # navigation → the SPA shell. Assert the content-type and the header, never the
  # status alone (a 200 was the lie).
  ORIGIN_ROOT="$BASE/runs/verify-deploy-does-not-exist"
  V2_HDR=$(curl -sS -o /tmp/vd-v2.body -D - -H 'OpenWOP-Version: 2' -H 'Accept: application/json' "$ORIGIN_ROOT?cb=$(date +%s%N)" | tr -d '\r')
  V2_VER=$(printf '%s' "$V2_HDR" | grep -i '^openwop-version:' | awk '{print $2}')
  V2_CT=$(printf '%s' "$V2_HDR" | grep -i '^content-type:' | awk '{print $2}')
  if [ "$V2_VER" = "2.0" ] && grep -q 'application/json' <<<"$V2_CT"; then
    echo "  v2 origin  OK       /runs/<id> under OpenWOP-Version: 2 → $V2_CT, openwop-version $V2_VER"
  else
    echo "  v2 origin  FAIL     /runs/<id> under OpenWOP-Version: 2 → content-type '$V2_CT', openwop-version '$V2_VER' (expected application/json + 2.0 — the SPA catch-all is answering the wire; ADR 0631)"; fail=1
  fi
  SHELL_CT=$(curl -sS -o /dev/null -w '%{content_type}' -A 'Mozilla/5.0' -H 'Accept: text/html,*/*;q=0.8' "$ORIGIN_ROOT?cb=$(date +%s%N)")
  if grep -q 'text/html' <<<"$SHELL_CT"; then echo "  spa root   OK       headerless browser navigation to /runs/<id> → $SHELL_CT"; else echo "  spa root   FAIL     headerless browser navigation to /runs/<id> → '$SHELL_CT' (expected text/html — the SPA page is unreachable; ADR 0631)"; fail=1; fi

  # ── ADR 0840 D3 — a plugin frame keeps ITS policy through Firebase ──
  # Hosting applies the app's own CSP to every non-static path. Whether the plugin
  # rule wins, and whether the CDN replaces the origin header or adds a second one,
  # is only visible here. Read EVERY CSP line the browser would get: at least one must
  # carry `sandbox allow-scripts` and `default-src 'none'`, and none may admit
  # `allow-same-origin`. Two lines are fine (a browser enforces both). The isolation
  # probe is the path an anonymous visitor can load; it goes out through the same
  # header builder and the same rule shape as a plugin frame.
  PROBE_HDRS=$(curl -sS -o /dev/null -D - -A 'Mozilla/5.0' -H 'Accept: text/html' "$BASE/api/host/openwop-app/ui-plugin/isolation-probe?cb=$(date +%s%N)" | tr -d '\r' | grep -i '^content-security-policy:' || true)
  PROBE_N=$(printf '%s' "$PROBE_HDRS" | grep -c . || true)
  if [ "$PROBE_N" -ge 1 ] && grep -qi "sandbox allow-scripts" <<<"$PROBE_HDRS" && grep -qi "default-src 'none'" <<<"$PROBE_HDRS" && ! grep -qi "allow-same-origin" <<<"$PROBE_HDRS"; then
    echo "  plugin csp OK       isolation probe carries the frame policy ($PROBE_N CSP header line(s); ADR 0840)"
  else
    echo "  plugin csp FAIL     isolation probe CSP through $BASE: $(printf '%s' "$PROBE_HDRS" | head -c 300) (expected sandbox allow-scripts + default-src 'none'; Firebase may be replacing the plugin policy — ADR 0840 D3)"; fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "DEPLOY NOT VERIFIED. Inspect the failed check above before choosing a remedy."
  echo "For a commit mismatch, re-read main and both deployed halves: a newer descendant"
  echo "may have superseded this candidate. Verify that release before considering a redeploy."
  echo "For old-revision job logs, compare timestamps and measure drain; keep rollback revisions."
  echo "Asset-hash equality alone does not establish the deployed source."
  exit 1
fi

if [ "$CHECK_BACKEND" -eq 1 ] && [ "$CHECK_FRONTEND" -eq 1 ]; then
  echo "both halves verified."
else
  echo "verified (single half — the other was not deployed)."
fi
