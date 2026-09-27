#!/usr/bin/env bash
# Refuse to deploy stale or divergent source (ADR 0530).
#
# ── ITS TEST IS `scripts/test-deploy-gates.sh` — RUN IT WHEN YOU ADD A GATE ──
# That harness builds throwaway repos and drives this script's exit codes. Its
# PASS-expecting cases must still pass after your change, and a new gate almost
# always needs a new fixture line to satisfy it (Gate 4 needed `stamp_head`).
#
# This is not advice. `scripts/ci.sh` runs that harness BEFORE the vitest lanes,
# so a gate added without its fixture reddens `npm run ci` for EVERY session in
# the repo, not just yours — measured 2026-08-10 (#3106, fixed in #3108: three
# pass-expecting cases flipped and the whole gate aborted before a single test
# ran). A green backend vitest run says nothing about this file; that is exactly
# the substitution that shipped the breakage. Since #3123 the harness also runs
# inside the backend suite (`test/deploy-gates-harness.test.ts`), so that
# particular escape route is closed — but run it directly anyway, it takes ~2s.
#
# WHY THIS AND NOT A LOCK. On 2026-08-03 two sessions deployed within minutes of
# each other and the second silently reverted the first, once per half. The
# obvious remedy is mutual exclusion — and it is the wrong one. Replay the
# incident under a lock: A takes the lock, deploys X, releases; B takes the lock,
# deploys Y (which is BEHIND X); B still clobbers A, just politely and one at a
# time. Serialising deploys does not stop a deploy from shipping older code.
#
# The property that was actually violated is MONOTONICITY: production went
# backwards. And the rule that would have caught it already existed in CLAUDE.md
# ("deploy from a clean origin/main checkout") — it simply was not enforced. The
# clobbering session was deploying a worktree whose HEAD was not origin/main's
# tip, after the newer commit had already merged.
#
# So this enforces the existing rule instead of adding infrastructure:
#
#   1. HEAD == origin/main tip     — the gate that catches the real incident
#   2. working tree is clean       — a SHA does not describe a modified tree
#   3. live commit is an ANCESTOR  — production never moves backwards
#
# Gate 3 reads `build.commit` from the deployed backend (ADR 0518). It must NOT
# hard-block when that is unreachable or unstamped: a broken backend is a reason
# to deploy, not a reason to be locked out. Those cases warn and require an
# explicit --allow-unverified-live, so the operator states the exception rather
# than the script silently passing.
#
# Usage:
#   scripts/preflight-deploy.sh                        # check, then deploy by hand
#   scripts/preflight-deploy.sh --allow-unverified-live
#   BASE=https://staging.example scripts/preflight-deploy.sh
#
# Exit 0 = safe to deploy.

set -uo pipefail

BASE="${BASE:-https://app.openwop.dev}"
ALLOW_UNVERIFIED=0
ALLOW_PIN_DRIFT=0
BACKEND_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --allow-unverified-live) ALLOW_UNVERIFIED=1 ;;
    --allow-pin-drift) ALLOW_PIN_DRIFT=1 ;;
    # Forwarded by `deploy.sh --backend-only`. It narrows ONE gate — the Firebase
    # identity check (Gate 7), which protects a frontend half this deploy does not
    # have. Every other gate still applies.
    --backend-only) BACKEND_ONLY=1 ;;
    -h|--help) sed -n '2,40p' "$0" | sed 's/^#[[:space:]]\{0,1\}//'; exit 0 ;;
    *) echo "preflight-deploy: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

fail=0
note() { printf '  %-9s %s\n' "$1" "$2"; }

HEAD_SHA=$(git rev-parse HEAD 2>/dev/null) || { echo "preflight-deploy: not a git repo" >&2; exit 2; }
echo "preflight: $(printf '%.12s' "$HEAD_SHA")  (base: $BASE)"

# ── Gate 1: HEAD is origin/main's tip ──────────────────────────────────────
# THE gate. Everything else is defence in depth.
if ! git fetch -q origin main 2>/dev/null; then
  note "FETCH" "could not reach origin — cannot prove HEAD is current"
  fail=1
else
  MAIN_SHA=$(git rev-parse origin/main)
  if [ "$HEAD_SHA" = "$MAIN_SHA" ]; then
    note "OK" "HEAD is origin/main's tip"
  else
    note "STALE" "HEAD is not origin/main ($(printf '%.12s' "$MAIN_SHA"))"
    if git merge-base --is-ancestor "$HEAD_SHA" "$MAIN_SHA" 2>/dev/null; then
      behind=$(git rev-list --count "$HEAD_SHA..$MAIN_SHA" 2>/dev/null || echo '?')
      echo "           you are $behind commit(s) BEHIND — deploying would revert them"
    else
      echo "           HEAD has diverged from origin/main (unmerged work?)"
    fi
    fail=1
  fi
fi

# ── Gate 2: clean tree ─────────────────────────────────────────────────────
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  note "DIRTY" "uncommitted changes — the SHA does not describe what you would ship"
  fail=1
else
  note "OK" "working tree clean"
fi

# ADR 0655 D5 — pack pin drift. A pin BELOW the vendored version is REFUSED by the
# installer (it never downgrades), so production serves the VENDORED copy for that
# pack — not registry-verified, and the pin is inert. (CORRECTED 2026-09-16, ADR 0713: this
# comment used to say the installer serves the pinned version and "the merge shipped
# nothing" — the opposite of what D5 does. Measured 2026-09-11 for the original
# case: `core.openwop.integration` vendored 1.1.2, pinned 1.1.0.) The drift check reads the live pins from Cloud Run; a drift
# fails the preflight unless the operator states the exception with
# --allow-pin-drift (publish + re-pin is the fix, not the flag).
# Runs only under a deploy environment (deploy.sh sources deploy.env ⇒
# OPENWOP_DEPLOY_PROJECT is set); a bare invocation — the gate harness, a dry
# run — never reaches for gcloud.
PIN_DRIFT_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-pack-pin-drift.mjs"
if [ -z "${OPENWOP_DEPLOY_PROJECT:-}" ]; then
  note "SKIPPED" "pack pin drift — no deploy environment (OPENWOP_DEPLOY_PROJECT unset)"
elif [ ! -f "$PIN_DRIFT_SCRIPT" ]; then
  # Resolved beside THIS script, not the cwd: the gate harness runs preflight from a
  # fixture repo where a cwd-relative `scripts/…` path does not exist.
  note "SKIPPED" "pack pin drift — checker not found beside preflight ($PIN_DRIFT_SCRIPT)"
elif OPENWOP_CR_PROJECT="$OPENWOP_DEPLOY_PROJECT" OPENWOP_CR_REGION="${OPENWOP_DEPLOY_REGION:-us-central1}" OPENWOP_CR_SERVICE="${OPENWOP_DEPLOY_SERVICE:-openwop-app-backend}" \
     OPENWOP_DEPLOY_ACCOUNT="${OPENWOP_DEPLOY_ACCOUNT:-}" \
     node "$PIN_DRIFT_SCRIPT" >/tmp/preflight-pin-drift.txt 2>&1; then
  note "OK" "pack pins match the vendored versions (or are waived in-script)"
else
  drift_rc=$?
  # EXIT 3 = COULD NOT COMPARE (expired credentials, wrong project, no permission).
  # Handled BEFORE the waiver on purpose, and it is not waivable.
  #
  # `--allow-pin-drift` is an operator stating "I know these pins are behind and I
  # accept it". It is not, and must not be, "proceed whatever this gate said" —
  # but it was: the waiver caught EVERY non-zero exit, so an unreadable pin list
  # was waived by a flag meant for a known drift. MEASURED 2026-09-12: the deploy
  # account's token expired, the checker exited 0 (it used to), and this branch
  # reported `OK  pack pins match`. Fixing the checker to exit 3 without fixing
  # the waiver would have moved the silent pass one line down.
  #
  # Same treatment Gate 5 gives an unreadable `describe`, for the same reason.
  if [ "$drift_rc" -eq 3 ]; then
    note "UNREADABLE" "pack pin drift — the live pins could not be read; NOTHING was compared"
    sed 's/^/           /' /tmp/preflight-pin-drift.txt | tail -6
    # DEFERRED, not `fail=1`. The early exit further down preempts Gates 5 and 7,
    # so failing here would SUPPRESS the connection-budget and Firebase-identity
    # diagnoses — and in the one fixture where the service JSON is unreadable,
    # every one of those gates has something specific to say. Caught by the gate
    # harness going red on "the summary does not distinguish unmeasured from
    # breached": a refusal that silences a better refusal is a downgrade.
    pins_unreadable=1
  elif [ "$drift_rc" -eq 4 ] && [ "$ALLOW_PIN_DRIFT" -eq 1 ]; then
    # EXIT 4 = every drifting pack is a row in scripts/pin-drift-known.json. That —
    # and only that — is what the flag waives (#3940). Before this the waiver
    # covered ANY exit 1, so five deploys' worth of `--allow-pin-drift` would have
    # hidden a brand-new unshipped pack behind the one everybody already knew about.
    note "WAIVED" "pack pin drift — KNOWN rows only, proceeding on --allow-pin-drift (see /tmp/preflight-pin-drift.txt)"
  elif [ "$drift_rc" -eq 4 ]; then
    note "PIN-DRIFT" "known pack pin drift (scripts/pin-drift-known.json) — publish + re-pin, or state the exception with --allow-pin-drift"
    sed 's/^/           /' /tmp/preflight-pin-drift.txt | tail -20
    fail=1
  elif [ "$ALLOW_PIN_DRIFT" -eq 1 ]; then
    note "PIN-DRIFT" "NEW pack pin drift — NOT covered by --allow-pin-drift, which waives only scripts/pin-drift-known.json"
    sed 's/^/           /' /tmp/preflight-pin-drift.txt | tail -20
    fail=1
  else
    note "PIN-DRIFT" "NEW pack pin drift (exit $drift_rc) — publish + re-pin. --allow-pin-drift would NOT cover it: it waives only scripts/pin-drift-known.json"
    sed 's/^/           /' /tmp/preflight-pin-drift.txt | tail -20
    fail=1
  fi
fi

# ── Gate 3: production does not move backwards ─────────────────────────────
# Bounded read: a hung endpoint must not stall the gate. A timeout lands in the
# UNKNOWN branch below, which already requires an explicit waiver.
# NO `-f`. `/api/readiness` answers 503 whenever it is `status: degraded` — and
# degraded is a normal SERVING state (a managed AI key not seeded is the usual
# reason) that carries `build.commit` in its body like any other. `curl -f`
# discarded that body, so every degraded-but-healthy backend read as "down" here,
# and the message then guessed two causes that were both wrong. MEASURED
# 2026-09-06 on a white-label deploy: preflight printed "backend down, or
# pre-ADR-0518" against a backend that was answering the very request, and the
# operator was forced onto --allow-unverified-live for every deploy. The commit is
# what this gate needs, and a degraded backend is exactly when you most want it.
# Branch on what was PARSED, and say what was OBSERVED when nothing parses.
live_raw=$(curl -sS --connect-timeout 5 --max-time 15 -w '\n%{http_code}' "$BASE/api/readiness?cb=$(date +%s%N)" 2>/dev/null) || live_raw=""
live_code="${live_raw##*$'\n'}"; live_body="${live_raw%$'\n'*}"; [ "$live_body" = "$live_raw" ] && live_body=""
live_commit=$(grep -oE '"commit"[[:space:]]*:[[:space:]]*"[^"]*"' <<<"${live_body:-}" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
live_state=$(grep -oE '"status"[[:space:]]*:[[:space:]]*"[^"]*"' <<<"${live_body:-}" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
live_tag=""; [ "$live_code" != "200" ] && live_tag=" (HTTP $live_code${live_state:+ $live_state} — serving, not ready)"

if [ -z "$live_commit" ] || [ "$live_commit" = "unknown" ]; then
  # Deliberately NOT a hard block. If the backend is down or predates ADR 0518,
  # deploying is very likely the fix; a wall here would be the tool causing the
  # outage it exists to prevent. But name the condition actually observed —
  # the previous wording named two causes and the real one was neither.
  if [ -z "$live_raw" ] || [ "$live_code" = "000" ]; then
    why="no response from $BASE/api/readiness within 15s (backend down, or unreachable from here)"
  elif [ "$live_commit" = "unknown" ]; then
    why="readiness answered HTTP $live_code with commit \"unknown\" — an UNSTAMPED deploy (OPENWOP_BUILD_COMMIT not passed)"
  elif [ -z "$live_body" ]; then
    why="readiness answered HTTP $live_code with an empty body"
  else
    why="readiness answered HTTP $live_code with no commit field — a load-balancer error page, or a backend older than ADR 0518"
  fi
  if [ "$ALLOW_UNVERIFIED" -eq 1 ]; then
    note "WAIVED" "live commit unreadable: $why — proceeding on --allow-unverified-live"
  else
    note "UNKNOWN" "live commit unreadable: $why"
    echo "           re-run with --allow-unverified-live if you intend to deploy anyway"
    fail=1
  fi
elif [ "$live_commit" = "$HEAD_SHA" ]; then
  note "OK" "live is already this commit (re-deploy)$live_tag"
elif git merge-base --is-ancestor "$live_commit" "$HEAD_SHA" 2>/dev/null; then
  note "OK" "live $(printf '%.12s' "$live_commit") is an ancestor — moving forward$live_tag"
elif git cat-file -e "${live_commit}^{commit}" 2>/dev/null; then
  note "BACKWARD" "live is $(printf '%.12s' "$live_commit"), which is NOT an ancestor of HEAD"
  echo "           deploying would move production backwards or sideways"
  fail=1
else
  # The live commit is not in this clone — someone deployed from a branch we
  # cannot see. Unresolvable here, and guessing would defeat the point.
  note "UNKNOWN" "live commit $(printf '%.12s' "$live_commit") is not in this repo — fetch it, or waive"
  # NOT `a && b || c`: if the && branch's last command ever returned non-zero the
  # || branch would ALSO run, silently setting fail=1 after reporting a waiver.
  if [ "$ALLOW_UNVERIFIED" -eq 1 ]; then
    note "WAIVED" "proceeding on --allow-unverified-live"
  else
    fail=1
  fi
fi

# ── Gate 4: the image stamp describes HEAD ─────────────────────────────────
# `build-meta/commit.txt` is baked into the image and is what /api/readiness
# reports as `commitSource: image`. It is GITIGNORED, which means it PERSISTS in
# a reused deploy checkout (e.g. /tmp/owp-deploy) — so a hand-deploy that skips
# `scripts/write-build-commit.mjs` uploads the PREVIOUS deploy's SHA and bakes
# it in. That is the original 2026-08-10 defect relocated from the env var to a
# file: silent, well-formed, and wrong. Gate 2 cannot see it (ignored files are
# not "dirty") and no unit test can (they point at a temp dir).
#
# Read-only on purpose: this gate REPORTS rather than regenerating, so the
# operator learns the step exists instead of having it silently done for them.
# `scripts/deploy.sh` writes the stamp BEFORE calling this script, so for that
# path the gate verifies the write landed and matches HEAD.
#
# CORRECTION 2026-08-11: this line used to claim deploy.sh "passes this
# trivially". It did not — deploy.sh wrote the stamp AFTER preflight, so from the
# clean detached worktree the recipe prescribes, deploy.sh could never get past
# this gate at all. The ordering is now pinned by a test in test-deploy-gates.sh;
# do not move the write back below the preflight call.
# Resolve from git rather than a caller-supplied $ROOT: this script is run
# standalone by the hand path, where no such variable exists.
STAMP_FILE="$(git rev-parse --show-toplevel)/build-meta/commit.txt"
if [ ! -f "$STAMP_FILE" ]; then
  note "UNSTAMPED" "build-meta/commit.txt is missing — the image would report commit: unknown"
  echo "           run: node scripts/write-build-commit.mjs"
  fail=1
else
  stamp=$(tr -d '[:space:]' < "$STAMP_FILE")
  if [ "$stamp" = "$HEAD_SHA" ]; then
    note "OK" "image stamp matches HEAD"
  else
    note "STALE" "build-meta/commit.txt is $(printf '%.12s' "$stamp"), HEAD is $(printf '%.12s' "$HEAD_SHA")"
    echo "           a leftover stamp from an earlier deploy in this checkout would be"
    echo "           baked into the image and reported as authoritative provenance"
    echo "           run: node scripts/write-build-commit.mjs"
    fail=1
  fi
fi

# ── Gate 6: hosting rewrites cover the v2 wire (ADR 0614) ──────────────────
# The check itself lives in frontend/react/scripts and runs in `npm run build`
# and in firebase.json's `predeploy` hook. It ALSO runs here so an edited
# firebase.json fails before the eight-minute backend build, not after it.
# Skipped, not failed, when the deploying repo has no firebase.json: compose,
# Render and Railway deploys are not Firebase Hosting deploys, and a gate that
# fails on an absent artefact is the class ADR 0636's neighbours keep meeting.
# (Numbered 6 because Gate 5, the connection budget, needs gcloud and sits below
# the summary; this one is pure source and belongs with Gates 1-4.)
DEPLOY_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
REWRITE_GATE="$(cd "$(dirname "$0")/.." && pwd)/frontend/react/scripts/check-hosting-wire-rewrites.cjs"
if [ -f "$DEPLOY_ROOT/firebase.json" ]; then
  if [ ! -f "$REWRITE_GATE" ]; then
    note "UNKNOWN" "firebase.json present but the rewrite gate is missing at $REWRITE_GATE — refusing to guess"
    fail=1
  elif rewrite_out=$(node "$REWRITE_GATE" "$DEPLOY_ROOT/firebase.json" 2>&1); then
    note "OK" "firebase.json rewrites cover the v2 wire"
  else
    note "REFUSED" "firebase.json does not cover the v2 wire (ADR 0614):"
    printf '%s\n' "$rewrite_out" | sed 's/^/           /'
    fail=1
  fi
else
  note "SKIP" "no firebase.json at $DEPLOY_ROOT — not a Firebase Hosting deploy"
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "PREFLIGHT FAILED — do not deploy."
  echo "Deploys run from a CLEAN worktree at origin/main's tip (CLAUDE.md). Usually:"
  echo "  git worktree add --detach /tmp/owp-deploy origin/main"
  exit 1
fi

# ── ADR 0631 — make the serial trap VISIBLE before the eight-minute build ──
# Revision serials are not monotonic on this service (measured 2026-09-05:
# 00684 → 00686 → 00666 → 00691 → 00668 by creation time). Print the three
# newest by CREATION beside the serving one, and warn when traffic is pinned
# by name — deploy.sh shifts by name afterwards, but a reader should see it.
# IDENTITY FOR EVERY gcloud READ BELOW (correction 2026-09-12).
#
# `deploy.sh` passes `--account "$OPENWOP_DEPLOY_ACCOUNT"` to its gcloud calls.
# THIS script did not — its Cloud Run reads took identity from ambient CLI state,
# which is the EXACT defect Gate 7 below was written to catch for `firebase
# deploy` ("the Firebase half took its identity from ambient CLI state"). That fix
# was applied to the firebase arm, twenty lines down, and not to the gcloud arms
# in the same file.
#
# MEASURED 2026-09-12: with two logged-in accounts and the non-deployer active,
# `gcloud run services describe` returned PERMISSION_DENIED. Gate 5 correctly
# refused ("UNREADABLE … refusing to guess") — but the traffic block above it
# printed `serving=? percent=0 latestRevision-mode=??` and carried on, so the same
# unreadable source produced a refusal in one gate and a silent `?` in the other.
# The preflight's whole purpose is to answer before the eight-minute build; an
# answer of `?` from the wrong identity is not an answer.
GC_ID=()
[ -n "${OPENWOP_DEPLOY_ACCOUNT:-}" ] && GC_ID=(--account "$OPENWOP_DEPLOY_ACCOUNT")

if command -v gcloud >/dev/null 2>&1 && [ -n "${OPENWOP_DEPLOY_SERVICE:-}" ]; then
  # Read the SERVING entry (percent == 100), never traffic[0] — the first entry
  # is whatever tag happened to be listed first (measured 2026-09-05: the 0%
  # `smoke` tag), which printed the wrong revision under the right label.
  SERVING=$(gcloud run services describe "$OPENWOP_DEPLOY_SERVICE" ${GC_ID[@]+"${GC_ID[@]}"} --region "${OPENWOP_DEPLOY_REGION:-us-central1}" --project "${OPENWOP_DEPLOY_PROJECT:-openwop-dev}" --format=json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const t=(j.status&&j.status.traffic)||[];const live=t.find(x=>x.percent===100)||{};const spec=((j.spec&&j.spec.traffic)||[]).find(x=>x.percent===100)||{};process.stdout.write((live.revisionName||"?")+"\t"+(live.percent||0)+"\t"+(spec.latestRevision?"True":"False"))}catch(e){process.stdout.write("?\t0\t?")}})' 2>/dev/null || printf '?\t0\t?')
  echo "  traffic   : serving=$(printf '%s' "$SERVING" | cut -f1) percent=$(printf '%s' "$SERVING" | cut -f2) latestRevision-mode=$(printf '%s' "$SERVING" | cut -f3)"
  gcloud run revisions list --service "$OPENWOP_DEPLOY_SERVICE" ${GC_ID[@]+"${GC_ID[@]}"} --region "${OPENWOP_DEPLOY_REGION:-us-central1}" --project "${OPENWOP_DEPLOY_PROJECT:-openwop-dev}" --limit 3 --format='value(metadata.name,metadata.creationTimestamp)' 2>/dev/null | sed 's/^/  newest    : /' || true
  [ "$(printf '%s' "$SERVING" | cut -f3)" = "True" ] || echo "  NOTE      : traffic is pinned by NAME — a new revision gets 0% until deploy.sh shifts it (ADR 0631)."
fi
# ── Gate 5: the Postgres connection budget (incident 2026-09-05, twice in 20 min) ──
# `db-f1-micro` has ~25 `max_connections`, 3 reserved for superusers → 22 usable.
# Every instance opens `OPENWOP_PG_POOL_MAX` connections at BOOT, `minScale ≥ 1`
# keeps one idle instance alive for EVERY routable revision — including 0%-traffic
# TAGGED ones — and a boot that cannot get a slot exits(1) and crash-loops, leaving
# zombie backends on the Cloud SQL frontend that no restart outruns while the loop
# runs. MEASURED: maxScale had drifted 3 → 5 and five stale tags (`smoke`, `rlhi`,
# `v2p4`, `p4c`, `v2p5`) held 16–20 slots permanently; the first certify run scaled
# the service out and the front door answered 500 for 7 min, then again for 11.
# The arithmetic is the gate: pool × maxScale + tags × pool ≤ max_connections − 3.
# (A deploy briefly runs old + new revisions together, so headroom matters too.)
if command -v gcloud >/dev/null 2>&1 && [ -n "${OPENWOP_DEPLOY_SERVICE:-}" ]; then
  SVC_JSON=$(gcloud run services describe "$OPENWOP_DEPLOY_SERVICE" ${GC_ID[@]+"${GC_ID[@]}"} --region "${OPENWOP_DEPLOY_REGION:-us-central1}" --project "${OPENWOP_DEPLOY_PROJECT:-openwop-dev}" --format=json 2>/dev/null || true)
  BUDGET=$(printf '%s' "$SVC_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const t=(j.spec&&j.spec.template)||{};const a=(t.metadata&&t.metadata.annotations)||{};const env=(((t.spec||{}).containers||[])[0]||{}).env||[];const pool=Number((env.find(e=>e.name==="OPENWOP_PG_POOL_MAX")||{}).value||10);const max=Number(a["autoscaling.knative.dev/maxScale"]||100);const min=Number(a["autoscaling.knative.dev/minScale"]||0);const tags=((j.spec&&j.spec.traffic)||[]).filter(x=>x.tag).map(x=>x.tag);process.stdout.write(pool+"\t"+max+"\t"+min+"\t"+tags.length+"\t"+tags.join(","))}catch(e){process.stdout.write("")}})' 2>/dev/null || true)
  # Two OUTCOMES, never one. `refusing to guess` and `the budget does not fit`
  # are different facts: the first is an UNKNOWN, the second is a MEASURED
  # breach. They shared `fail=1` and one summary line until 2026-09-11, so an
  # unreadable check announced itself as a measured breach — twice in one
  # night, once on an expired gcloud token (the budget was fine and simply
  # unreadable) and once on a real drift. A gate that cannot measure must say
  # so; only a measurement may claim a breach. (They also shared the SCRIPT's
  # `fail`, so any earlier gate's failure would have printed the budget
  # headline had the script not exited first — a distinction that held by
  # control flow rather than by construction. These two are local.)
  budget_unreadable=0; budget_breach=0
  if [ -z "$BUDGET" ]; then
    echo "  pg budget : UNREADABLE (gcloud run services describe returned no JSON) — refusing to guess"
    budget_unreadable=1
  else
    pool=$(printf '%s' "$BUDGET" | cut -f1); maxs=$(printf '%s' "$BUDGET" | cut -f2); mins=$(printf '%s' "$BUDGET" | cut -f3); ntags=$(printf '%s' "$BUDGET" | cut -f4); tagnames=$(printf '%s' "$BUDGET" | cut -f5)
    maxconn=${OPENWOP_PG_MAX_CONNECTIONS:-25}; usable=$((maxconn - 3))
    idle=$(( mins > 0 ? ntags * pool : 0 )); need=$(( pool * maxs + idle ))
    if [ "$need" -gt "$usable" ]; then
      echo "  pg budget : FAIL  pool $pool × maxScale $maxs = $((pool*maxs)) + tagged-idle $ntags × $pool = $idle → $need > $usable usable (max_connections $maxconn − 3)"
      [ "$ntags" -gt 0 ] && echo "              tags: $tagnames — 'gcloud run services update-traffic $OPENWOP_DEPLOY_SERVICE --remove-tags $tagnames' frees $idle; or lower maxScale / OPENWOP_PG_POOL_MAX (pool × maxScale is the steady state; a deploy briefly doubles it)."
      budget_breach=1
    else
      echo "  pg budget : OK    pool $pool × maxScale $maxs + tagged-idle $idle = $need ≤ $usable usable (max_connections $maxconn − 3)"
      [ "$ntags" -gt 0 ] && echo "  NOTE      : $ntags tagged revision(s) ($tagnames) each hold an idle instance under minScale $mins — remove tags you are not using."
    fi
  fi
  if [ "$budget_breach" -ne 0 ]; then
    echo; echo "PREFLIGHT FAILED — the connection budget does not fit; fix the service before the eight-minute build."; exit 1
  fi
  if [ "$budget_unreadable" -ne 0 ]; then
    echo; echo "PREFLIGHT FAILED — the connection budget COULD NOT BE MEASURED, which is not the same as a breach."
    echo "  \`gcloud run services describe\` returned no JSON: expired credentials (\`gcloud auth login\`), the wrong"
    echo "  project/region, or no permission on the service. Restore the read, then re-run — do not assume a breach."
    exit 1
  fi
fi

# ── Gate 7: the Firebase deploy identity can SEE the Firebase project ──────
# deploy.sh passes `--account "$OPENWOP_DEPLOY_ACCOUNT"` to four gcloud calls and
# now to `firebase deploy` too. Before that fix the Firebase half took its
# identity from ambient CLI state, and the resulting failure landed BETWEEN the
# two halves: backend shipped, frontend refused, error text blaming project
# permissions rather than identity selection (measured 2026-09-09, kicktodo-1).
#
# Passing the flag is necessary but not sufficient — the named account still has
# to be logged in AND able to see the project. That is checkable here, in the
# cheap phase, so the answer arrives before the eight-minute build instead of
# after the irreversible half.
#
# SKIP only when this is genuinely not a Firebase deploy (no CLI, or no project
# configured). A failure to ENUMERATE is a refusal, not a skip: an identity check
# that passes because it could not look is the defect it exists to prevent.
if [ "$BACKEND_ONLY" -eq 1 ]; then
  # MEASURED 2026-09-16: an expired `firebase login` refused a backend-only deploy
  # of the ADR 0713 installer fix — "the Firebase half would fail AFTER the backend
  # shipped", for a deploy with no Firebase half. The gate's reason does not hold
  # here, so it does not run; the frontend deploy still meets it.
  note "SKIP" "firebase identity — backend-only deploy has no Firebase half"
elif command -v firebase >/dev/null 2>&1 && [ -n "${OPENWOP_DEPLOY_FIREBASE_PROJECT:-}" ]; then
  FB_ARGS=()
  [ -n "${OPENWOP_DEPLOY_ACCOUNT:-}" ] && FB_ARGS=(--account "$OPENWOP_DEPLOY_ACCOUNT")
  FB_WHO="${OPENWOP_DEPLOY_ACCOUNT:-<ambient CLI state>}"
  if fb_out=$(firebase projects:list ${FB_ARGS[@]+"${FB_ARGS[@]}"} 2>&1); then
    # Match the project id as a whole token, so a longer id that merely CONTAINS
    # it does not read as a hit.
    if grep -qE "(^|[^A-Za-z0-9_.-])$(printf '%s' "$OPENWOP_DEPLOY_FIREBASE_PROJECT" | sed 's/[][\.^$*+?(){}|/-]/\\&/g')([^A-Za-z0-9_.-]|\$)" <<<"$fb_out"; then
      note "OK" "firebase identity $FB_WHO can see $OPENWOP_DEPLOY_FIREBASE_PROJECT"
    else
      note "REFUSED" "firebase identity $FB_WHO cannot see project '$OPENWOP_DEPLOY_FIREBASE_PROJECT'"
      echo "             This is an IDENTITY problem, not a permissions one — do not grant access to fix it."
      echo "             firebase login:list                 # which accounts are known"
      echo "             firebase login:add $FB_WHO           # register the deploy account"
      echo "             firebase projects:list --account $FB_WHO"
      fail=1
    fi
  else
    note "REFUSED" "could not list Firebase projects as $FB_WHO — refusing to guess"
    printf '%s\n' "$fb_out" | sed 's/^/             /' | head -5
    fail=1
  fi
  if [ "$fail" -ne 0 ]; then
    echo
    echo "PREFLIGHT FAILED — the Firebase half would fail AFTER the backend shipped. Fix the identity first."
    exit 1
  fi
else
  note "SKIP" "no firebase CLI or no OPENWOP_DEPLOY_FIREBASE_PROJECT — not a Firebase Hosting deploy"
fi

if [ "${pins_unreadable:-0}" -eq 1 ]; then
  echo
  echo "PREFLIGHT FAILED — the pack pins COULD NOT BE READ, which is not the same as a match."
  echo "  Nothing was compared. Re-authenticate the deploy account (gcloud auth login) or pass"
  echo "  --pins, then re-run. --allow-pin-drift does NOT cover this: it states a KNOWN drift"
  echo "  is acceptable, and an unreadable list is not a known anything."
  exit 1
fi

echo "preflight passed."
