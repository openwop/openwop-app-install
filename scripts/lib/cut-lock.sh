# cut-lock.sh — read the evidence-cut lock (sourced; defines one function).
#
# `publish-evidence.sh` takes `<OPENWOP_CERT_BUNDLE_ORIGIN>/.cut-lock.json` for
# the length of a cut. Anything that CHANGES the serving revision while it is
# held (a deploy, an env update) makes the cut's bundles describe a build they
# did not test — MEASURED 2026-10-05. Both preflight-deploy.sh (Gate 8) and
# update-env.sh read the lock through this one function so they cannot disagree.
#
#   cut_lock_state <lock-url> [gcloud identity args...]
#
# Prints ONE line, first word the state:
#   absent                 no lock object
#   expired <json>         a lock past its expiresAtEpoch (its cut is over)
#   held <json>            a live lock — refuse
#   unparseable <json>     an object that is not a lock — refuse, never guess
#   unreadable <error>     the read failed for another reason — refuse as UNMEASURED
cut_lock_state() {
  local url="$1"; shift
  local err json rc state
  err=$(mktemp)
  json=$(gcloud storage cat "$url" "$@" 2>"$err"); rc=$?
  if [ "$rc" -ne 0 ]; then
    if grep -qiE 'matched no objects|not found|404|No such object' "$err"; then
      echo "absent"
    else
      echo "unreadable $(tail -1 "$err")"
    fi
    rm -f "$err"; return 0
  fi
  rm -f "$err"
  state=$(printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const e=JSON.parse(s).expiresAtEpoch;if(!Number.isFinite(e))throw 0;process.stdout.write(e<Date.now()/1000?"expired":"held")}catch{process.stdout.write("unparseable")}})' 2>/dev/null)
  echo "${state:-unparseable} $json"
}
