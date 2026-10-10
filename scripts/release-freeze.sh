#!/usr/bin/env bash
# release-freeze.sh — freeze `main` for a release window, visibly and reversibly (CE-17).
#
#   scripts/release-freeze.sh status                       # exit 0 open, 3 frozen (holder/expiry printed)
#   scripts/release-freeze.sh freeze --holder <name> --reason "<why>" [--ttl-min 120]
#   scripts/release-freeze.sh merge <pr> --holder <name>   # the holder's guarded merge, while frozen
#   scripts/release-freeze.sh thaw --holder <name> [--force]
#
# WHY. Every session merges as the SAME GitHub account, so nothing tells GitHub
# that a merge is unwelcome — six unannounced merges landed mid-release in two
# days (2026-09-29/30), and on 2026-10-05 a merge moved main under a 45-minute
# gate twice. What worked was ad hoc: a repository ruleset blocking updates to
# the default branch, switched off for the release's own merge, deleted after
# verify. This is that, with the holder written where every session can read it.
#
# The freeze is ONE ruleset whose name carries the holder, the expiry and the
# reason. The expiry is advisory (GitHub does not expire rulesets): `status`
# reports a freeze past it as EXPIRED so a dead holder is visible, and only
# `thaw --force` removes someone else's. A guarded merge disables enforcement
# for that one merge and re-enables it on ANY exit, so a failed merge never
# leaves main open. Cooperative, not a security boundary: the holder name is
# self-declared and every session has admin.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${RELEASE_FREEZE_REPO:-}"
[ -n "$REPO" ] || REPO="$(cd "$ROOT" && gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)" \
  || { echo "release-freeze: cannot tell which repository (set RELEASE_FREEZE_REPO)" >&2; exit 2; }
PREFIX="release-freeze"
die() { echo "release-freeze: $*" >&2; exit 1; }

cmd="${1:-status}"; [ $# -gt 0 ] && shift
HOLDER="${OPENWOP_FREEZE_HOLDER:-}"; REASON=""; TTL_MIN=120; FORCE=0; PR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --holder) HOLDER="${2:-}"; shift 2 ;;
    --reason) REASON="${2:-}"; shift 2 ;;
    --ttl-min) TTL_MIN="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^#[[:space:]]\{0,1\}//'; exit 0 ;;
    *) if [ "$cmd" = merge ] && [ -z "$PR" ]; then PR="$1"; shift; else echo "release-freeze: unexpected argument: $1" >&2; exit 2; fi ;;
  esac
done

# Prints "<id>\t<enforcement>\t<holder>\t<untilEpoch>\t<reason>" for the freeze, or nothing.
current() {
  local raw; raw=$(gh api "repos/$REPO/rulesets" 2>/dev/null) || return 1
  printf '%s' "$raw" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let a;try{a=JSON.parse(s)}catch{process.exit(1)}if(!Array.isArray(a))process.exit(1);const r=a.find(x=>typeof x.name==="string"&&x.name.startsWith(process.argv[1]+" "));if(!r)return;const f={};for(const p of r.name.split(" | ").slice(1)){const i=p.indexOf("=");if(i>0)f[p.slice(0,i)]=p.slice(i+1)}process.stdout.write([r.id,r.enforcement||"",f.holder||"?",String(Date.parse(f.until||"")/1000|0),f.reason||""].join("\t"))})' "$PREFIX"
}
describe() { # describe <current line>
  local id enf holder until reason now
  IFS=$'\t' read -r id enf holder until reason <<< "$1"; now=$(date +%s)
  local when; when=$(node -e 'console.log(new Date(Number(process.argv[1])*1000).toISOString().replace(/\.\d+Z$/,"Z"))' "$until")
  if [ "$until" -gt 0 ] && [ "$until" -lt "$now" ]; then
    echo "FROZEN by $holder — EXPIRED at $when (the holder may be gone; only they, or thaw --force, may lift it) — $reason"
  else
    echo "FROZEN by $holder until $when — $reason${enf:+ (enforcement: $enf)}"
  fi
}

case "$cmd" in
  status)
    cur=$(current) || die "could not read rulesets for $REPO"
    if [ -z "$cur" ]; then echo "main is OPEN (no release freeze on $REPO)"; exit 0; fi
    describe "$cur"; exit 3 ;;

  freeze)
    [ -n "$HOLDER" ] || { echo "release-freeze: --holder is required (or OPENWOP_FREEZE_HOLDER)" >&2; exit 2; }
    [ -n "$REASON" ] || { echo "release-freeze: --reason is required — other sessions read it" >&2; exit 2; }
    case "$TTL_MIN" in ''|*[!0-9]*) echo "release-freeze: --ttl-min must be minutes" >&2; exit 2 ;; esac
    cur=$(current)
    if [ -n "$cur" ]; then echo "release-freeze: already $(describe "$cur")" >&2; exit 1; fi
    until=$(node -e 'console.log(new Date(Date.now()+Number(process.argv[1])*60000).toISOString().replace(/\.\d+Z$/,"Z"))' "$TTL_MIN")
    clean_reason=$(printf '%s' "$REASON" | tr -d '|\t\n' | cut -c1-60)
    name="$PREFIX | holder=$HOLDER | until=$until | reason=$clean_reason"
    body=$(node -e 'console.log(JSON.stringify({name:process.argv[1],target:"branch",enforcement:"active",conditions:{ref_name:{include:["~DEFAULT_BRANCH"],exclude:[]}},rules:[{type:"update"}]}))' "$name")
    printf '%s' "$body" | gh api -X POST "repos/$REPO/rulesets" --input - >/dev/null || die "could not create the freeze ruleset"
    cur=$(current); [ -n "$cur" ] || die "created the freeze but cannot read it back"
    echo "main FROZEN — $(describe "$cur" | sed 's/^FROZEN //')" ;;

  merge)
    [ -n "$PR" ] || { echo "release-freeze: merge needs a PR number" >&2; exit 2; }
    [ -n "$HOLDER" ] || { echo "release-freeze: --holder is required (or OPENWOP_FREEZE_HOLDER)" >&2; exit 2; }
    cur=$(current)
    if [ -z "$cur" ]; then
      gh pr merge "$PR" --merge >/dev/null 2>&1 || true
    else
      IFS=$'\t' read -r id _ holder _ _ <<< "$cur"
      [ "$holder" = "$HOLDER" ] || die "main is $(describe "$cur") — not yours to merge through"
      # Re-enable on ANY exit: a failed merge must never leave main open.
      trap 'gh api -X PUT "repos/$REPO/rulesets/$id" -f enforcement=active >/dev/null 2>&1 || echo "release-freeze: COULD NOT RE-ENABLE the freeze (ruleset $id) — main is OPEN; fix it now" >&2' EXIT
      gh api -X PUT "repos/$REPO/rulesets/$id" -f enforcement=disabled >/dev/null || die "could not lift the freeze for the merge"
      gh pr merge "$PR" --merge >/dev/null 2>&1 || true   # exit code is not the result from a worktree
    fi
    state=$(gh pr view "$PR" --json state --jq .state 2>/dev/null)
    [ "$state" = "MERGED" ] || die "#$PR is ${state:-unreadable} after the merge"
    echo "merged #$PR${cur:+ through the freeze (re-enabled on exit)}" ;;

  thaw)
    cur=$(current)
    if [ -z "$cur" ]; then echo "main is already OPEN"; exit 0; fi
    IFS=$'\t' read -r id _ holder _ _ <<< "$cur"
    if [ "$holder" != "$HOLDER" ] && [ "$FORCE" -ne 1 ]; then
      die "main is $(describe "$cur") — only its holder may thaw it (or --force, after asking them)"
    fi
    gh api -X DELETE "repos/$REPO/rulesets/$id" >/dev/null || die "could not delete ruleset $id"
    [ -z "$(current)" ] || die "deleted ruleset $id but a freeze is still listed"
    forced=""; [ "$FORCE" -eq 1 ] && [ "$holder" != "$HOLDER" ] && forced=" with --force"
    echo "main is OPEN (freeze by $holder lifted$forced)" ;;

  *) echo "release-freeze: unknown command '$cmd' (status|freeze|merge|thaw)" >&2; exit 2 ;;
esac
