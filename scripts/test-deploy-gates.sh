#!/usr/bin/env bash
# Behavioural tests for the deploy gates (ADR 0518 verify + ADR 0530 preflight).
#
# These are shell tools, so they have no vitest home — but they are the last thing
# standing between a stale worktree and production, and an untested guard is a
# guard nobody should trust. Each case below is a failure mode that has either
# HAPPENED (case: behind-origin) or would silently defeat the guard if it
# regressed (cases: unstamped-passes, lockout).
#
# Runs against fixture git repos + a local stub HTTP server. Touches nothing real.
#
#   bash scripts/test-deploy-gates.sh

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null' EXIT

pass=0; fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
check(){ # check <desc> <expected-exit> <actual-exit>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected exit $2, got $3)"; fi
}

# ── a stub backend whose /api/readiness we control ──────────────────────────
# Bind an EPHEMERAL port and let the OS pick. A hard-coded port was the first
# version and it was wrong twice over: an orphaned server from a previous run
# squatted it (see below), and — on a machine where parallel sessions run `npm
# run ci` concurrently — a PEER's server was already listening on it. A test that
# fights other processes for a fixed port is a flaky test by construction.
#
# Start python DIRECTLY, not in a subshell: `$!` must be the server's own PID, or
# the trap kills a wrapper and leaves an orphan behind. That orphan then 404s
# every later run, which looked exactly like three real gate failures the first
# time this suite ran.
STUB_DIR="$TMP/stub"; mkdir -p "$STUB_DIR/api/.well-known"
# `verify-deploy.sh` also asserts the DEPLOYED capability document against the
# source (the four-day stale `recorded-outcome` advert). The stub must serve one,
# or every commit-logic case below fails for an unrelated reason — which is how
# this suite went red the first time the wire check landed.
#
# Emitted BY THE CHECKER rather than hand-written here: the fixture and the check
# then read the same SSoT, so they cannot disagree about the expected values. A
# second copy typed into this file would be exactly the drift the check exists to
# catch, reproduced in its own test.
#
# ADR 0550 P4. The checker also reads the CLAIMS stamp, resolved through
# `OPENWOP_BUILD_META_DIR` — the same seam `src/host/buildInfo.ts` and
# `src/host/conformanceClaims.ts` read. Point it at an EMPTY dir for the ordinary
# cases, BEFORE `--emit-expected` runs: otherwise this suite's verdict would move
# with whether the operator happened to run a certify recently, and a check that
# depends on unrelated local state is a flaky check — the lesson this suite
# already paid for once with ports. The stamped posture is staged deliberately in
# its own section further down.
CLAIMS_META="$TMP/nometa"; mkdir -p "$CLAIMS_META"
export OPENWOP_BUILD_META_DIR="$CLAIMS_META"
node "$(dirname "$0")/check-wire-claims.mjs" --emit-expected > "$STUB_DIR/api/.well-known/openwop"
PORT_FILE="$TMP/port"
python3 -c '
import sys, functools, http.server, socketserver
# The capability document and /api/readiness are EXTENSIONLESS, which
# SimpleHTTPRequestHandler serves as application/octet-stream. `check-wire-claims`
# refuses a non-JSON content-type on purpose — that is its guard against reading a
# a CDN 200 text/html app shell as a capability document - so an octet-stream
# stub reds every case here for a reason unrelated to what they test.
class H(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        leaf = path.rsplit("/", 1)[-1]
        return "application/json" if "." not in leaf else super().guess_type(path)
    # ADR 0631 — verify-deploy probes a MANIFEST ROOT at the origin both ways. An
    # honest origin answers a request naming major 2 with JSON + the header and a
    # headerless browser with the SPA shell. The `.v2-dishonest` flag file makes
    # the stub answer the shell to BOTH — production as it stood on 2026-09-05 —
    # so the harness can prove the probe fails on exactly that.
    def do_GET(self):
        import os
        # A DEGRADED backend answers /api/readiness with 503 AND a full body. The
        # `.readiness-status` file holds the code the stub should send with the
        # `api/readiness` body — the case `curl -f` used to turn into "down".
        if self.path.split("?", 1)[0] == "/api/readiness":
            sf = os.path.join(self.directory, "api", ".readiness-status")
            bf = os.path.join(self.directory, "api", "readiness")
            if os.path.exists(sf) and os.path.exists(bf):
                code = int(open(sf).read().strip() or "503")
                body = open(bf, "rb").read()
                self.send_response(code); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        # WHD-18 — the discovery document has TWO representations selected by
        # `OpenWOP-Version`. When `.well-known/openwop.v2` exists, a request naming
        # major 2 gets it; otherwise both get the one file (every older case).
        if self.path.split("?", 1)[0] == "/api/.well-known/openwop" and (self.headers.get("OpenWOP-Version") or "").startswith("2"):
            v2 = os.path.join(self.directory, "api", ".well-known", "openwop.v2")
            if os.path.exists(v2):
                body = open(v2, "rb").read()
                self.send_response(200); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        if self.path.startswith("/runs/"):
            dishonest = os.path.exists(os.path.join(self.directory, ".v2-dishonest"))
            if self.headers.get("OpenWOP-Version") and not dishonest:
                body = b"{\"error\":\"not_found\",\"message\":\"run not found\"}"
                self.send_response(404); self.send_header("Content-Type", "application/json")
                self.send_header("OpenWOP-Version", "2.0"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body); return
            self.path = "/index.html"
        return super().do_GET()
h = functools.partial(H, directory=sys.argv[1])
class Q(socketserver.TCPServer): allow_reuse_address = True
with Q(("127.0.0.1", 0), h) as srv:
    print(srv.server_address[1], flush=True)
    srv.serve_forever()
' "$STUB_DIR" > "$PORT_FILE" 2>/dev/null &
STUB_PID=$!

for _ in $(seq 1 50); do [ -s "$PORT_FILE" ] && break; sleep 0.1; done
PORT="$(tr -d '[:space:]' < "$PORT_FILE" 2>/dev/null)"
if [ -z "$PORT" ]; then
  echo "test-deploy-gates: stub server failed to start" >&2
  exit 2
fi
STUB="http://127.0.0.1:$PORT"
for _ in $(seq 1 50); do curl -fsS -o /dev/null "$STUB/" 2>/dev/null && break; sleep 0.1; done

set_live() { # set_live <commit|absent>
  rm -f "$STUB_DIR/api/.readiness-status"
  if [ "$1" = "absent" ]; then rm -f "$STUB_DIR/api/readiness"
  else printf '{"status":"ready","build":{"commit":"%s","stamped":true}}' "$1" > "$STUB_DIR/api/readiness"; fi
}
# The shape a real degraded backend returns (MEASURED 2026-09-06 on a white-label
# Cloud Run service with no managed AI key seeded): HTTP 503, status degraded,
# config+storage ok, and the commit right there in the body.
set_live_degraded() { # set_live_degraded <commit>
  printf '{"status":"degraded","build":{"commit":"%s","stamped":true},"checks":{"config":{"ok":true},"storage":{"ok":true},"managedProviders":[{"ready":false,"detail":"no server-held key seeded"}]}}' "$1" > "$STUB_DIR/api/readiness"
  printf '503' > "$STUB_DIR/api/.readiness-status"
}
# What a load balancer answers when the backend is actually gone: a 503 whose
# body is an HTML error page with no commit anywhere in it.
set_live_lb_error() {
  printf '<html><body><h1>503 Service Unavailable</h1></body></html>' > "$STUB_DIR/api/readiness"
  printf '503' > "$STUB_DIR/api/.readiness-status"
}

# ── a fixture repo with a real two-commit history ──────────────────────────
REPO="$TMP/repo"; ORIGIN="$TMP/origin.git"
git init -q --bare "$ORIGIN"
git init -q "$REPO"
( cd "$REPO"
  git config user.email t@t.test; git config user.name T; git config commit.gpgsign false
  git checkout -q -b main
  echo one > f
  # The real repo gitignores build-meta/ (the image stamp, #3106 Gate 4); the
  # fixture must too, or stamping HEAD trips the dirty-tree gate on the
  # harness's own contamination.
  printf 'build-meta/\n' > .gitignore
  git add f .gitignore; git commit -qm one
  git remote add origin "$ORIGIN"; git push -q origin main
) >/dev/null 2>&1
OLD=$(git -C "$REPO" rev-parse HEAD)
( cd "$REPO"; echo two > f; git add f; git commit -qm two; git push -q origin main ) >/dev/null 2>&1
NEW=$(git -C "$REPO" rev-parse HEAD)
# NOTE: invoke the script from $ROOT with cwd=$REPO. Copying it INTO the fixture
# would leave an untracked file there, and the dirty-tree gate would (correctly)
# fire on the harness's own contamination — which is exactly what happened the
# first time this suite ran.

# OPENWOP_DEPLOY_PROJECT blanked: the ADR 0655 D5 pin-drift arm queries REAL gcloud
# under a deploy environment, and an operator shell with deploy.env exported would
# otherwise make this harness network-bound and drift-dependent (the same reason
# V() below blanks it for verify-deploy).
run_preflight() { ( cd "$REPO" && BASE="$STUB" OPENWOP_DEPLOY_PROJECT= bash "$ROOT/scripts/preflight-deploy.sh" "$@" >/dev/null 2>&1; echo $? ); }
# #3106 Gate 4 — pass-expecting cases need the image stamp to describe HEAD.
stamp_head() { mkdir -p "$REPO/build-meta"; git -C "$REPO" rev-parse HEAD | tr -d '\n' > "$REPO/build-meta/commit.txt"; }

echo "== preflight-deploy (ADR 0530) =="

set_live "$OLD"
git -C "$REPO" checkout -q "$NEW" 2>/dev/null; git -C "$REPO" checkout -q main
stamp_head
check "PASSES on the tip with an ancestor live" 0 "$(run_preflight)"

# curl -f used to turn BOTH of these into "live commit unreadable (backend down,
# or pre-ADR-0518)" — one wrongly, one for the wrong reason.
set_live_degraded "$OLD"
check "PASSES with a DEGRADED (503) live that still reports an ancestor commit" 0 "$(run_preflight)"
set_live_lb_error
check "REFUSES (UNKNOWN) when readiness answers 503 with no commit — a load-balancer error page" 1 "$(run_preflight)"
set_live "$OLD"

# THE INCIDENT: a worktree behind origin/main, deployed after a newer merge landed.
git -C "$REPO" checkout -q "$OLD"
check "REFUSES a HEAD behind origin/main (the 2026-08-03 incident)" 1 "$(run_preflight)"
git -C "$REPO" checkout -q main

echo "dirty" >> "$REPO/f"
check "REFUSES a dirty tree" 1 "$(run_preflight)"
git -C "$REPO" checkout -q -- f

# Production must never move backwards, even from the tip.
set_live "$(printf '%040d' 7)"   # a well-formed SHA this repo does not contain
stamp_head
check "REFUSES when the live commit is unknown to the repo" 1 "$(run_preflight)"
check "  ...unless explicitly waived" 0 "$(run_preflight --allow-unverified-live)"

# A broken backend must not lock the operator out — deploying is often the fix.
set_live absent
check "REFUSES when live is unreadable (no silent pass)" 1 "$(run_preflight)"
check "  ...but the waiver lets a fix through" 0 "$(run_preflight --allow-unverified-live)"

# #3106 Gate 4 — both polarities: a MISSING stamp refuses (the image would say
# commit: unknown), and a STALE one refuses (the reused-checkout defect).
set_live "$OLD"
rm -f "$REPO/build-meta/commit.txt"
check "REFUSES an UNSTAMPED tree (Gate 4: missing commit.txt)" 1 "$(run_preflight)"
printf '%s' "$OLD" > "$REPO/build-meta/commit.txt"
check "REFUSES a STALE stamp (Gate 4: commit.txt != HEAD)" 1 "$(run_preflight)"
stamp_head

# ── Gate 6: hosting rewrites cover the v2 wire (ADR 0614) ──────────────────
# The fixture has no firebase.json, so every case above took the SKIP arm (a
# compose/Render deploy). Give it one: first the 2026-09-06 shape — an adopter's
# hand-edited file that rewrites only /api/** — then the real one. Both are
# committed and pushed so Gates 1-2 stay green and the only variable is Gate 6.
mkdir -p "$REPO/schemas/v2"; cp "$ROOT/schemas/v2/path-manifest.json" "$REPO/schemas/v2/"
# ADR 0641 (#3729/#3730) — the rewrite gate now also enumerates the SPA's
# feature route modules (`frontend/react/src/features/*/routes.tsx`, floor 20)
# to check site routes against the reserved wire segments, and REFUSES when
# the directory is absent or thin (an underivable list must not read as "no
# site routes"). The fixture models a real checkout, so it carries the real
# route modules — copied, not symlinked, and committed with the schemas so
# Gate 2 (clean tree) stays green. Found by main going red on this harness
# the moment #3730 merged without running it.
( cd "$ROOT/frontend/react/src/features" && find . -maxdepth 2 -name routes.tsx | while read -r f; do
    mkdir -p "$REPO/frontend/react/src/features/$(dirname "$f")"; cp "$f" "$REPO/frontend/react/src/features/$f"; done )
printf '{"hosting":{"public":"dist","rewrites":[{"source":"/api/**","run":{"serviceId":"x","region":"us-central1"}},{"source":"**","destination":"/index.html"}]}}\n' > "$REPO/firebase.json"
( cd "$REPO" && git add schemas firebase.json frontend && git commit -qm rewrites-partial && git push -q origin main ) >/dev/null 2>&1
stamp_head
check "REFUSES a firebase.json that does not cover the v2 wire (Gate 6 — the 2026-09-06 adopter shape)" 1 "$(run_preflight)"
cp "$ROOT/firebase.json" "$REPO/firebase.json"
( cd "$REPO" && git add firebase.json && git commit -qm rewrites-full && git push -q origin main ) >/dev/null 2>&1
stamp_head
check "PASSES with the real firebase.json (Gate 6 covers the v2 wire)" 0 "$(run_preflight)"

# ── Gate 6b: the site-route scanner must SEE a route with a nested `nav` ────
# CORRECTION 2026-09-11. The scanner matched route objects with an innermost-
# brace-pair regex, so every route carrying a `nav: { … }` block was invisible
# to it — and its floor counted `tier:` DECLARATIONS, a different population,
# so 130+ declarations parsed happily while routes were being dropped. A peer
# shipping nine `site` routes downstream measured the gate seeing TWO.
#
# This case is the pin: a `site` route on a RESERVED first segment, written the
# way real routes are written (with a nav block). The gate MUST refuse. Run it
# against the pre-fix scanner and it passes green, which is the whole point —
# a gate that cannot see the defect reports the same "✓ 0 site route(s)" as a
# clean tree.
mkdir -p "$REPO/frontend/react/src/features/__sitecollision"
cat > "$REPO/frontend/react/src/features/__sitecollision/routes.tsx" <<'SITEEOF'
import type { FeatureRoute } from '../../chrome/featureTypes.js';
const routes: FeatureRoute[] = [
  { path: '/runs', element: null, tier: 'site', auth: 'optional', nav: { group: 'Site', label: 'Runs', order: 1 } },
];
export default routes;
SITEEOF
( cd "$REPO" && git add frontend && git commit -qm site-collision && git push -q origin main ) >/dev/null 2>&1
stamp_head
check "REFUSES a \`site\` route on a reserved segment even when it carries a nested nav block (Gate 6b)" 1 "$(run_preflight)"
rm -rf "$REPO/frontend/react/src/features/__sitecollision"
( cd "$REPO" && git add -A frontend && git commit -qm site-collision-removed && git push -q origin main ) >/dev/null 2>&1
stamp_head
check "  ...and PASSES again once it is gone (the refusal was the route, not the fixture)" 0 "$(run_preflight)"

# ── Gate 7: the Firebase deploy identity can see the Firebase project ──────
# The gate that would have caught the 2026-09-09 kicktodo-1 deploy: `firebase
# deploy` used to take its identity from ambient CLI state while the four gcloud
# calls took theirs from deploy.env, so the frontend half failed AFTER the
# backend shipped, blaming project permissions rather than identity selection.
# A fake `firebase` keeps this deterministic and offline — the logic under test
# is "parse the listing and decide", which is the part that can rot.
FBBIN="$TMP/fbbin"; mkdir -p "$FBBIN"
cat > "$FBBIN/firebase" <<'FBEOF'
#!/usr/bin/env bash
printf '%s\n' "${FIREBASE_FAKE_OUT:-}"
exit "${FIREBASE_FAKE_RC:-0}"
FBEOF
chmod +x "$FBBIN/firebase"
FB_TABLE='┌───┬───┐
│ MyndHyve │ myndhyve-prod │
│ OpenWOP  │ openwop-dev (current) │
└───┴───┘'
run_preflight_fb() { ( cd "$REPO" && PATH="$FBBIN:$PATH" BASE="$STUB" \
  OPENWOP_DEPLOY_ACCOUNT="deployer@example.com" \
  OPENWOP_DEPLOY_FIREBASE_PROJECT="$1" FIREBASE_FAKE_OUT="$2" FIREBASE_FAKE_RC="${3:-0}" \
  bash "$ROOT/scripts/preflight-deploy.sh" >/dev/null 2>&1; echo $? ); }

check "PASSES when the deploy identity CAN see the Firebase project (Gate 7)" 0 "$(run_preflight_fb openwop-dev "$FB_TABLE")"
check "REFUSES when the identity cannot see it (the 2026-09-09 kicktodo case)" 1 "$(run_preflight_fb kicktodo-prod "$FB_TABLE")"
check "  ...and a FAILED enumeration refuses too (no pass-because-it-could-not-look)" 1 "$(run_preflight_fb openwop-dev "Error: not logged in" 1)"
check "  ...and a SUBSTRING of a listed id is not a match (whole-token compare)" 1 "$(run_preflight_fb openwop "$FB_TABLE")"
run_preflight_fb_backend() { ( cd "$REPO" && PATH="$FBBIN:$PATH" BASE="$STUB" \
  OPENWOP_DEPLOY_ACCOUNT="deployer@example.com" \
  OPENWOP_DEPLOY_FIREBASE_PROJECT="$1" FIREBASE_FAKE_OUT="$2" FIREBASE_FAKE_RC="${3:-0}" \
  bash "$ROOT/scripts/preflight-deploy.sh" --backend-only >/dev/null 2>&1; echo $? ); }
check "  ...but --backend-only does NOT need a Firebase identity (no Firebase half to protect)" 0 "$(run_preflight_fb_backend openwop-dev "Error: not logged in" 1)"
check "  ...and --backend-only narrows ONLY that gate: a dirty tree still refuses" 1 "$( ( cd "$REPO" && touch dirty-backend-only && PATH="$FBBIN:$PATH" BASE="$STUB" OPENWOP_DEPLOY_ACCOUNT=deployer@example.com OPENWOP_DEPLOY_FIREBASE_PROJECT=openwop-dev FIREBASE_FAKE_OUT="Error: not logged in" FIREBASE_FAKE_RC=1 bash "$ROOT/scripts/preflight-deploy.sh" --backend-only >/dev/null 2>&1; echo $?; rm -f dirty-backend-only ) )"

# ── the preflight's OWN gcloud reads must use the deploy identity ──────────
# Gate 7 above exists because `firebase deploy` took its identity from ambient
# CLI state while deploy.sh's gcloud calls took theirs from deploy.env. That fix
# was applied to the firebase arm and NOT to the gcloud arms in the same script.
# MEASURED 2026-09-12: with the non-deployer account active, `gcloud run services
# describe` returned PERMISSION_DENIED, Gate 5 refused, and the traffic block
# printed `serving=? percent=0` and carried on.
#
# Structural, like the `gcloud run deploy` assertions further down: a runtime arm
# would need a fake gcloud AND real deploy.env, and the property worth pinning is
# "the flag is on every call", which is exactly what reading the script shows.
# STRIP DOUBLE-QUOTED STRINGS FIRST. Without that, this matched three `echo`
# lines whose MESSAGE TEXT mentions `gcloud run services describe` — the same
# trap the `gcloud run deploy` assertion below documents ("matches the COMMENT").
# It would have reported three failures that are not invocations at all.
pf_unidentified=$(sed 's/"[^"]*"//g' "$ROOT/scripts/preflight-deploy.sh" | grep -nE '^[^#]*gcloud run ' | grep -v 'GC_ID' || true)
if [ -n "$pf_unidentified" ]; then
  bad "preflight-deploy.sh has gcloud run call(s) without the deploy identity:"
  printf '%s\n' "$pf_unidentified" | sed 's/^/      /'
else
  ok "every gcloud run call in preflight-deploy.sh passes the deploy identity"
fi

# ── the SAME rule for verify-deploy.sh, and for `gcloud builds` ────────────
# The assertion above was scoped two ways that both proved too narrow, and the
# gap produced a false red on a CLEAN production deploy (2026-09-15, 18987f1a1):
# it matched only `gcloud run ` — so `gcloud builds list` was never checked — and
# only preflight-deploy.sh — so verify-deploy.sh, which had NO identity plumbing
# at all, was never checked either.
#
# What that cost: verify's peer-build floor ran as the ambient account, got
# PERMISSION_DENIED, discarded it through `2>/dev/null`, read the empty result as
# "query broken" and failed a deploy whose every other check had passed. The floor
# was right to refuse an empty result; its own caller was feeding it one.
#
# JOIN BACKSLASH CONTINUATIONS FIRST. The assertion above is line-based and gets
# away with it because preflight puts GC_ID on the invocation line. deploy.sh does
# NOT: it spells `--account "$OPENWOP_DEPLOY_ACCOUNT"` on a CONTINUATION line, so a
# line-based grep reports all four of its correctly-identified calls as missing.
# Caught while writing this check — a guard that cannot read the code it audits
# reports noise, and noise gets baselined. Accept either mechanism (the GC_ID array
# or a literal --account) since both are real identity, and judge the whole command.
for gsrc in preflight-deploy.sh verify-deploy.sh deploy.sh; do
  [ -f "$ROOT/scripts/$gsrc" ] || continue
  g_unidentified=$(sed 's/"[^"]*"//g' "$ROOT/scripts/$gsrc" \
    | sed -e :a -e '/\\$/N; s/\\\n//; ta' \
    | grep -nE '^[^#]*gcloud (run|builds) ' \
    | grep -v 'GC_ID' | grep -v -- '--account' || true)
  if [ -n "$g_unidentified" ]; then
    bad "$gsrc has gcloud run/builds call(s) without the deploy identity:"
    printf '%s\n' "$g_unidentified" | sed 's/^/      /'
  else
    ok "every gcloud run/builds call in $gsrc passes the deploy identity"
  fi
done

# ── pin drift: "could not compare" is not a pass, and is NOT waivable ──────
# MEASURED 2026-09-12: the deploy account's token expired, `pinsFromCloudRun`
# threw, `check-pack-pin-drift.mjs` printed SKIPPED and exited 0 — and
# preflight's `elif node …; then note "OK"` reported `pack pins match the
# vendored versions` having compared nothing. Worse, `--allow-pin-drift` caught
# every non-zero exit, so fixing only the checker would have moved the silent
# pass one branch down into a waiver meant for a KNOWN drift.
#
# Structural: a runtime arm needs real gcloud and a real deploy env, and what
# matters is the contract between the two files — exit 3 means unreadable, and
# the waiver must not reach it.
if grep -q "process.exit(3)" "$ROOT/scripts/check-pack-pin-drift.mjs"; then
  ok "check-pack-pin-drift exits 3 (not 0) when it cannot read the pins"
else
  bad "check-pack-pin-drift still exits 0 when nothing was compared — preflight reads that as OK"
fi

pin_branch=$(sed -n '/drift_rc=\$?/,/^fi$/p' "$ROOT/scripts/preflight-deploy.sh")
if grep -q 'drift_rc" -eq 3' <<<"$pin_branch"; then
  ok "preflight distinguishes UNREADABLE pins from a real drift"
else
  bad "preflight does not branch on exit 3 — an unreadable pin list reads as drift or as OK"
fi
# The order is the property: the exit-3 arm must come BEFORE the waiver, or
# --allow-pin-drift swallows it.
unreadable_line=$(printf '%s' "$pin_branch" | grep -n 'drift_rc" -eq 3' | head -1 | cut -d: -f1)
waiver_line=$(printf '%s' "$pin_branch" | grep -n 'ALLOW_PIN_DRIFT" -eq 1' | head -1 | cut -d: -f1)
if [ -n "$unreadable_line" ] && [ -n "$waiver_line" ] && [ "$unreadable_line" -lt "$waiver_line" ]; then
  ok "  ...and checks it BEFORE --allow-pin-drift, so the waiver cannot swallow it"
else
  bad "--allow-pin-drift is reachable for an unreadable pin list (waiver at $waiver_line, unreadable at $unreadable_line)"
fi

# ── the major-2 ratchet must GATE the deploy, not merely run beside it ─────
# ADR 0687. The known-red list emptied when the era-2 refusal and the fork's
# prefix-timestamp copy both landed, which is what made this gate meaningful:
# before, a green ratchet only proved the two admitted MUST violations were
# still the ones we knew about.
#
# ── pin drift: the waiver covers the KNOWN list and nothing else (#3940) ─────
# `--allow-pin-drift` rode at least five consecutive deploys. A waiver that covers
# "whatever drifted" hides NEW drift behind the old, so the known drift is a
# checked-in list (scripts/pin-drift-known.json) and the checker's exit code says
# which kind it found: 4 = known rows only (waivable), 1 = anything else (not).
# BEHAVIOURAL, via the checker's own offline `--pins` arm — no gcloud involved.
PD="$ROOT/scripts/check-pack-pin-drift.mjs"
pd_known_name=$(node -p "require('$ROOT/scripts/pin-drift-known.json').unshipped[0]?.name ?? ''")
pd_known_pin=$(node -p "require('$ROOT/scripts/pin-drift-known.json').unshipped[0]?.pinned ?? ''")
pd_known_ver=$(node -p "require('$ROOT/scripts/pin-drift-known.json').unshipped[0]?.vendored ?? ''")
pd_rc() { node "$PD" --pins "$1" >/dev/null 2>&1; echo $?; }
if [ -z "$pd_known_name" ]; then
  # An EMPTY list is the goal state (#3940 closed), not a failure — but then these
  # cases have nothing to stand on, and saying so beats four vacuous greens.
  ok "pin-drift known list is EMPTY — the waiver has nothing left to cover (known-row cases not applicable)"
else
  [ "$(pd_rc "$pd_known_name@$pd_known_pin")" = "4" ] \
    && ok "drift made ONLY of known rows exits 4 (the one waivable case)" \
    || bad "known-only drift did not exit 4 — the waiver cannot tell known from new"
  [ "$(pd_rc "$pd_known_name@$pd_known_pin,core.openwop.ai@0.0.1")" = "1" ] \
    && ok "a NEW unshipped pack beside the known one exits 1 — not waivable" \
    || bad "a NEW unshipped pack hid behind the known drift (expected exit 1)"
  [ "$(pd_rc "$pd_known_name@0.0.1")" = "1" ] \
    && ok "a known pack whose pinned version MOVED exits 1 — the row is exact, not by-name" \
    || bad "a known pack with different versions was still treated as known"
  [ "$(pd_rc "$pd_known_name@$pd_known_ver")" = "1" ] \
    && ok "a row that no longer drifts is a STALE WAIVER and exits 1 — the list can only shrink" \
    || bad "a fixed drift left its waiver row standing (expected exit 1)"
  [ "$(OPENWOP_PIN_DRIFT_KNOWN_FILE=/nonexistent/known.json node "$PD" --pins "$pd_known_name@$pd_known_pin" >/dev/null 2>&1; echo $?)" = "1" ] \
    && ok "a MISSING known list fails closed: every drift is new" \
    || bad "a missing known list did not fail closed"
fi
# …and preflight honours the flag ONLY for exit 4. Structural: the first place the
# waiver flag is consulted must be the exit-4 arm.
# here-strings, not `printf | grep`: under `pipefail` a short-circuiting grep closes
# the pipe, printf takes EPIPE, and a TRUE condition reads FALSE (test-gate-tooling
# bans the shape — and caught this file shipping it).
first_waiver=$(grep -n 'ALLOW_PIN_DRIFT" -eq 1' <<<"$pin_branch" | head -1 || true)
if grep -q 'drift_rc" -eq 4' <<<"$first_waiver"; then
  ok "preflight consults --allow-pin-drift only together with exit 4 (known rows)"
else
  bad "preflight waives pin drift without checking it is the KNOWN drift: $first_waiver"
fi
if grep -q 'NOT covered by --allow-pin-drift' <<<"$pin_branch"; then
  ok "  ...and says so when the flag is passed over NEW drift"
else
  bad "preflight has no arm telling the operator the flag does not cover new drift"
fi

# Structural, same reasoning as the pin-drift case above: a runtime arm would
# need a booted host and a ~2-minute lane. What matters is the contract — the
# ratchet is CALLED from the certify block, and its failure stops the ship.
certify_block=$(sed -n '/certified: \$(node -e/,/^fi$/p' "$ROOT/scripts/deploy.sh")
if grep -q 'check-conformance-major2.sh' <<<"$certify_block"; then
  ok "deploy.sh runs the conformance@major2 ratchet on the certify path"
else
  bad "deploy.sh no longer runs scripts/check-conformance-major2.sh — a v2 regression can ship"
fi
# Running it is not gating it. `bash script` on its own line exits 0 for the
# deploy no matter what the ratchet said; its non-zero exit must be the CONDITION
# of the branch that exits.
#
# The first version of this case asserted "an `exit 1` within 6 lines of the
# call", and a sabotage proved it vacuous: rewriting the guard to
# `if bash …; then true; else true; fi` followed by `if false; then … exit 1`
# left the case GREEN while the ratchet's result was discarded entirely. A
# proximity grep measures layout, not control flow. Assert the negation itself.
ratchet_call=$(printf '%s' "$certify_block" | grep -n 'check-conformance-major2.sh' | head -1 | cut -d: -f2-)
if grep -qE '^[[:space:]]*if ! bash ' <<<"$ratchet_call"; then
  ok "  ...and REFUSES to ship when it fails (its exit status is the branch condition)"
else
  bad "the major-2 ratchet's result is discarded — deploy.sh continues past a red lane: $ratchet_call"
fi
ratchet_ctx=$(grep -A6 'check-conformance-major2.sh' <<<"$certify_block" || true)
if grep -q 'exit 1' <<<"$ratchet_ctx"; then
  ok "  ...and that branch exits nonzero"
else
  bad "the major-2 ratchet branch does not exit — a red lane would only print"
fi
# And it must not be reachable when the operator skipped certification: a
# --skip-certify deploy deliberately makes no claim, and a hard v2 gate there
# would make the documented escape hatch un-runnable.
if grep -q 'DO_CERTIFY' <<<"$certify_block"; then
  bad "the major-2 ratchet block re-tests DO_CERTIFY — it should already be inside the certify arm"
else
  ok "  ...and sits inside the certify arm, so --skip-certify stays usable"
fi

# ── the peer-build window must SPAN the deploy, not a fixed guess ──────────
# ADR 0691. MEASURED 2026-09-15: the backend build landed at 16:03:38Z and
# verify ran at 16:24:30Z — 21 minutes, one minute outside the fixed 20m window.
# The check then reported "0 builds in the last 20m, but a deploy JUST RAN" and
# failed a deploy that was correct on every substantive leg.
#
# That is the dangerous failure mode, not a harmless miscalibration: a gate that
# cannot pass teaches everyone to ignore it, and this one CAN fail usefully.
win_block=$(sed -n '/peer-build window is anchored/,/^fi$/p' "$ROOT/scripts/deploy.sh")
if grep -q 'DEPLOY_START_EPOCH="\$(date -u +%s)"' "$ROOT/scripts/deploy.sh"; then
  ok "deploy.sh stamps when it started"
else
  bad "deploy.sh does not stamp its start — the window cannot be anchored to the deploy"
fi
if sed -n '/Size the peer-build window/,/^fi$/p' "$ROOT/scripts/deploy.sh" | grep -q 'DEPLOY_START_EPOCH'; then
  ok "  ...and sizes PEER_BUILD_WINDOW_MIN from it, so the window spans the whole run"
else
  bad "the peer-build window is still a fixed guess — it will fail whenever a deploy outruns it"
fi
# An operator who set the window explicitly must win: the override exists to
# widen a legitimately slow build, and silently recomputing it takes that away.
if sed -n '/Size the peer-build window/,/^fi$/p' "$ROOT/scripts/deploy.sh" | grep -q 'if \[ -z "\${PEER_BUILD_WINDOW_MIN:-}" \]'; then
  ok "  ...and does NOT overwrite an operator-set PEER_BUILD_WINDOW_MIN"
else
  bad "deploy.sh recomputes PEER_BUILD_WINDOW_MIN even when the operator set one"
fi
# The arithmetic itself, because the two structural cases above pass against a
# formula that computes the wrong number.
win_calc=$( DEPLOY_START_EPOCH=$(( $(date -u +%s) - 1260 )); echo $(( ( $(date -u +%s) - DEPLOY_START_EPOCH ) / 60 + 5 )) )
if [ "$win_calc" -ge 26 ] && [ "$win_calc" -le 27 ]; then
  ok "  ...and a 21-minute deploy yields a ${win_calc}m window (covers it, plus margin)"
else
  bad "the window formula gives ${win_calc}m for a 21-minute deploy — it must cover the run"
fi

# ── a HEALTHY SPA shell for the verify cases (H91 arm) ─────────────────────
# verify-deploy now asserts that `/` references a bundle and that the bundle
# serves as a MODULE. Without this staging every commit-logic case below would
# red on an unrelated arm — the same trap the capability-document stub above
# documents.
mkdir -p "$STUB_DIR/assets"
shell_ref() { printf '<!doctype html><script type="module" src="/assets/index-%s.js"></script>' "$1" > "$STUB_DIR/index.html"; }
printf 'export const ok=1\n' > "$STUB_DIR/assets/index-TESTAAAA.js"
shell_ref TESTAAAA

echo "== verify-deploy (ADR 0518) =="
# OPENWOP_DEPLOY_* blanked: the H90 peer-build arm below would otherwise query
# REAL gcloud on a machine where deploy.env happens to be exported, making
# these commit-logic cases depend on the project's build history.
V() { ( cd "$REPO" && BASE="$STUB" SHELL_CONVERGE_S=0 OPENWOP_DEPLOY_PROJECT= OPENWOP_DEPLOY_REGION= bash "$ROOT/scripts/verify-deploy.sh" "$1" >/dev/null 2>&1; echo $? ); }
printf '{"commit":"%s","stamped":true,"dirty":false}' "$NEW" > "$STUB_DIR/build-info.json"
set_live "$NEW"
check "PASSES when both halves report the expected commit" 0 "$(V "$NEW")"
check "FAILS when the backend is a different commit" 1 "$(V "$OLD")"
# A degraded backend is SERVING and stamped; only a body without a commit fails.
set_live_degraded "$NEW"
check "PASSES when the backend is DEGRADED (503) but reports the expected commit" 0 "$(V "$NEW")"
set_live_lb_error
check "FAILS when readiness answers 503 with no commit (a load-balancer error page)" 1 "$(V "$NEW")"
set_live "$NEW"
set_live "unknown"
check "FAILS on an UNSTAMPED backend (never a silent pass)" 1 "$(V "$NEW")"
set_live "$NEW"
printf '{"commit":"%s","stamped":true,"dirty":true}' "$NEW" > "$STUB_DIR/build-info.json"
check "FAILS on a DIRTY frontend build even at the right commit" 1 "$(V "$NEW")"

# Single-half deploys must not fail on the half they deliberately did not touch.
# Without this, `deploy.sh --backend-only` deploys correctly and then reports
# DEPLOYED BUT NOT VERIFIED — which trains people to ignore a red verify.
VH() { ( cd "$REPO" && BASE="$STUB" SHELL_CONVERGE_S=0 OPENWOP_DEPLOY_PROJECT= OPENWOP_DEPLOY_REGION= bash "$ROOT/scripts/verify-deploy.sh" "$@" >/dev/null 2>&1; echo $? ); }
set_live "$NEW"
printf '{"commit":"%s","stamped":true,"dirty":false}' "$OLD" > "$STUB_DIR/build-info.json"  # frontend deliberately stale
check "--backend-only ignores an un-deployed frontend" 0 "$(VH "$NEW" --backend-only)"
check "  ...and the full check still catches it" 1 "$(VH "$NEW")"
set_live "$OLD"
printf '{"commit":"%s","stamped":true,"dirty":false}' "$NEW" > "$STUB_DIR/build-info.json"
check "--frontend-only ignores an un-deployed backend" 0 "$(VH "$NEW" --frontend-only)"

echo "== check-wire-claims: the published claims arm (ADR 0550 P4) =="
# The one arm whose SSoT is not source but the stamped artifact. Staged in both
# postures, because a check exercised in one direction only has not been shown to
# work — the mistake that shipped a `contractProvenance` arm which could never go
# green (see check-wire-claims.mjs).
W() { ( cd "$REPO" && OPENWOP_BUILD_META_DIR="$1" node "$ROOT/scripts/check-wire-claims.mjs" "$STUB/api" >/dev/null 2>&1; echo $? ); }
CERT_META="$TMP/certmeta"; mkdir -p "$CERT_META"
# A minimal but REAL pair: the claims document's digest is computed over the
# bundle with the same canonical-JSON rule the checker uses, so the resolve leg
# below exercises the actual binding rather than a hand-picked constant that
# would only ever prove the two strings were typed the same.
BUNDLE_JSON='{"bundleVersion":"2","claimedProfiles":["openwop-core-standard","openwop-discovery-core"],"results":{"requirements":[{"disposition":"executed-pass","requirementId":"openwop.floor.discovery","scenarioId":"discovery.test.ts"}]}}'
printf '%s' "$BUNDLE_JSON" > "$TMP/bundle.json"
BUNDLE_SHA="$(node -e '
const {createHash}=require("node:crypto");
const cj=(v)=>v===null||typeof v!=="object"?(JSON.stringify(v)??"null"):Array.isArray(v)?`[${v.map(cj).join(",")}]`:`{${Object.entries(v).filter(([,x])=>x!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>`${JSON.stringify(k)}:${cj(x)}`).join(",")}}`;
process.stdout.write(createHash("sha256").update(cj(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))),"utf8").digest("hex"));
' "$TMP/bundle.json")"
CLAIMS_JSON='{"claimsVersion":"1","claimedProfiles":["openwop-core-standard","openwop-discovery-core"],"evidence":{"bundleSha256":"'"$BUNDLE_SHA"'"}}'
printf '%s' "$CLAIMS_JSON" > "$CERT_META/conformance-claims.json"
# UNDER `api/`: the checker is handed `$STUB/api` (the Firebase rewrite prefix a
# real deploy uses), so every path it fetches is relative to THAT. Staging the
# file at the stub root made the fetch 404 — and the negative cases below still
# went red, for the wrong reason. A negative that passes on a 404 proves nothing.
CLAIMS_STUB="$STUB_DIR/api/v1/host/openwop-app/conformance"; mkdir -p "$CLAIMS_STUB"
printf '%s' "$CLAIMS_JSON" > "$CLAIMS_STUB/claims"
cp "$TMP/bundle.json" "$CLAIMS_STUB/certification-bundle"

# Unstamped checkout: the arm SKIPS loudly and must not fail the deploy.
check "no local stamp → the claims arm skips (never a false red)" 0 "$(W "$CLAIMS_META")"

# Stamped, and the wire agrees — but the advert is missing from the stub, which
# is the regression this arm exists for: a host that certified and then shipped
# an image whose pointer never reached discovery.
check "stamped + NO pointer advertised → FAILS" 1 "$(W "$CERT_META")"

# Add the pointer: now both halves agree and the arm passes.
python3 - "$STUB_DIR/api/.well-known/openwop" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d.setdefault('capabilities', {}).setdefault('conformance', {})['certificationBundleUrl'] = 'https://example.invalid/v1/host/openwop-app/conformance/certification-bundle'
json.dump(d, open(p, 'w'))
PY
check "stamped + pointer + matching claims → PASSES" 0 "$(W "$CERT_META")"

# The staleness this arm is named for: the deployed claim names a profile the
# artifact we built does not. A commit stamp cannot see this — the commit was
# never the claim.
printf '%s' '{"claimsVersion":"1","claimedProfiles":["openwop-core-standard","openwop-discovery-core","openwop-replay-fork"],"evidence":{"bundleSha256":"'"$(printf '%064d' 1)"'"}}' \
  > "$CLAIMS_STUB/claims"
check "deployed claims name an EXTRA profile → FAILS (stale claim)" 1 "$(W "$CERT_META")"

# The POINTER must resolve to the evidence the claims name. A pointer nobody can
# follow is the same as no claim, except that it looks like one.
printf '%s' '{"bundleVersion":"1"}' > "$CLAIMS_STUB/certification-bundle"
check "advertised bundle is v1, not v2 → FAILS" 1 "$(W "$CERT_META")"
printf '%s' '{"bundleVersion":"2","claimedProfiles":["openwop-core-standard","openwop-discovery-core"],"results":{"requirements":[]}}' > "$CLAIMS_STUB/certification-bundle"
check "advertised bundle digest != claims evidence → FAILS" 1 "$(W "$CERT_META")"
rm -f "$CLAIMS_STUB/certification-bundle"
check "advertised pointer 404s → FAILS" 1 "$(W "$CERT_META")"
cp "$TMP/bundle.json" "$CLAIMS_STUB/certification-bundle"

# Restore for anything downstream that reads the stub.
printf '%s' "$CLAIMS_JSON" > "$CLAIMS_STUB/claims"

echo "== check-wire-claims: ORIGIN mode — the signed post-deploy bundle (WHD-18, ADR 0735) =="
# The served evidence is the suite CLI's v3 cut, read by the host from an
# out-of-image origin. The oracle is the bundle's OWN binding (v3, THIS commit,
# the major of the root that advertised it, a key the LIVE host publishes), not
# the build-meta claims — which origin mode deliberately does not serve.
#
# Driven with the REAL signed fixture (major 2, commit 27315b41c…, key
# openwop-app-bundle-2), so the positive case is a bundle the suite produced,
# not one this harness forged with the checker's own helpers.
FIX="$ROOT/backend/typescript/test/fixtures/certification-bundle-v3-27315b41c-major2.json"
FIXCOMMIT=27315b41c8f43e76e99f2e0f413acff14ba026fb
FIXKEY='{"keyId":"openwop-app-bundle-2","alg":"ed25519","publicKey":"WVhUJ8jHoQf9g9b8VPsfMS6kiOjUSbGdjbIAiemOVq4"}'
DOC="$STUB_DIR/api/.well-known/openwop"
cp "$DOC" "$TMP/doc.origin.bak"
MAJ2_STUB="$STUB_DIR/api/host/openwop-app/conformance/certification-bundle"; mkdir -p "$MAJ2_STUB"
# docs <v1-pointer?> <v2-pointer?> <keys-json> — stage BOTH roots.
origin_docs() { python3 - "$TMP/doc.origin.bak" "$DOC" "$DOC.v2" "$1" "$2" "$3" <<'PY3'
import json, sys
src, v1p, v2p, p1, p2, keys = sys.argv[1:7]
d = json.load(open(src))
d.get("capabilities", {}).pop("conformance", None)
d["signingKeys"] = json.loads(keys)
if p1 == "yes":
    d.setdefault("capabilities", {})["conformance"] = {"certificationBundleUrl": "https://example.invalid/v1/host/openwop-app/conformance/certification-bundle"}
json.dump(d, open(v1p, "w"))
v2 = {"protocolVersions": ["1.1", "2.0"], "preferredVersion": "1.1"}
if p2 == "yes":
    v2["conformance"] = {"certificationBundleUrl": "https://example.invalid/host/openwop-app/conformance/certification-bundle/major-2"}
json.dump(v2, open(v2p, "w"))
PY3
}
# WO <expected-commit> → exit code; output kept for the PENDING/OK assertions.
WO() { ( cd "$REPO" && OPENWOP_BUILD_META_DIR="$CLAIMS_META" OPENWOP_CERT_BUNDLE_ORIGIN="gs://b/p" EXPECTED_COMMIT="$1" \
         node "$ROOT/scripts/check-wire-claims.mjs" "$STUB/api" >"$TMP/wo.out" 2>&1; echo $? ); }
rm -f "$CLAIMS_STUB/claims"   # origin mode: /claims is withheld (404)

origin_docs no no "[$FIXKEY]"
check "origin mode, nothing published yet → PASSES (exit 0)" 0 "$(WO "$FIXCOMMIT")"
if [ "$(grep -c 'PENDING' "$TMP/wo.out")" = 2 ] && ! grep -q 'OK       v3' "$TMP/wo.out"; then
  ok "  ...and says PENDING for both majors — not OK, not a failure"
else
  bad "  ...expected two PENDING rows and no OK row; got: $(grep -E 'certification bundle' "$TMP/wo.out" | tr '\n' ' ')"
fi
check "origin mode with no EXPECTED_COMMIT → FAILS (nothing to bind the bundle to)" 1 "$(WO "")"

origin_docs no yes "[$FIXKEY]"
cp "$FIX" "$MAJ2_STUB/major-2"
check "origin mode, the REAL signed major-2 bundle for this commit → PASSES" 0 "$(WO "$FIXCOMMIT")"
if grep -qE 'certification bundle \(major 2\) +OK +v3' "$TMP/wo.out" && grep -q 'major 1).*PENDING' "$TMP/wo.out"; then
  ok "  ...major 2 OK (signed by the live key), major 1 still PENDING"
else
  bad "  ...expected major-2 OK + major-1 PENDING; got: $(grep -E 'certification bundle' "$TMP/wo.out" | tr '\n' ' ')"
fi
check "…but for a DIFFERENT expected commit → FAILS (build-mismatch)" 1 "$(WO 1111111111111111111111111111111111111111)"
origin_docs no yes '[]'
check "…with the signing key NOT in the live discovery document → FAILS" 1 "$(WO "$FIXCOMMIT")"
origin_docs no yes "[$FIXKEY]"
python3 - "$FIX" "$MAJ2_STUB/major-2" <<'PY4'
import json, sys
d = json.load(open(sys.argv[1]))
row = next(r for r in d["results"]["requirements"] if isinstance(r.get("detail"), str))
row["detail"] += "!"
json.dump(d, open(sys.argv[2], "w"))
PY4
check "…with ONE ROW tampered → FAILS (witness-digest)" 1 "$(WO "$FIXCOMMIT")"
cp "$FIX" "$MAJ2_STUB/major-2"
origin_docs yes yes "[$FIXKEY]"
check "…with the major-2 bundle behind the MAJOR-1 pointer → FAILS (target-major)" 1 "$(WO "$FIXCOMMIT")"
origin_docs no yes "[$FIXKEY]"
printf '%s' "$CLAIMS_JSON" > "$CLAIMS_STUB/claims"
check "…while the in-image /claims is still served (200) → FAILS" 1 "$(WO "$FIXCOMMIT")"
rm -f "$CLAIMS_STUB/claims"

# End to end through verify-deploy.sh: the EXPECTED_COMMIT plumbing is what binds
# the bundle, so exercise it from the entry point an operator actually runs.
cp "$STUB_DIR/api/readiness" "$TMP/readiness.origin.bak" 2>/dev/null; cp "$STUB_DIR/build-info.json" "$TMP/build-info.origin.bak"
set_live "$FIXCOMMIT"
printf '{"commit":"%s","stamped":true,"dirty":false}' "$FIXCOMMIT" > "$STUB_DIR/build-info.json"
VO() { ( cd "$REPO" && BASE="$STUB" SHELL_CONVERGE_S=0 OPENWOP_DEPLOY_PROJECT= OPENWOP_DEPLOY_REGION= \
         OPENWOP_BUILD_META_DIR="$CLAIMS_META" OPENWOP_CERT_BUNDLE_ORIGIN="gs://b/p" \
         bash "$ROOT/scripts/verify-deploy.sh" "$1" >"$TMP/vo.out" 2>&1; echo $? ); }
check "verify-deploy.sh in origin mode binds the bundle to the deployed commit → PASSES" 0 "$(VO "$FIXCOMMIT")"
grep -qE 'certification bundle \(major 2\) +OK +v3' "$TMP/vo.out" && ok "  ...and reached the origin arm (major 2 OK)" || bad "  ...the origin arm never ran: $(tail -5 "$TMP/vo.out" | tr '\n' ' ')"

# Restore the stub for everything downstream.
cp "$TMP/doc.origin.bak" "$DOC"; rm -f "$DOC.v2" "$MAJ2_STUB/major-2"
cp "$TMP/build-info.origin.bak" "$STUB_DIR/build-info.json"
if [ -f "$TMP/readiness.origin.bak" ]; then cp "$TMP/readiness.origin.bak" "$STUB_DIR/api/readiness"; else rm -f "$STUB_DIR/api/readiness"; fi
printf '%s' "$CLAIMS_JSON" > "$CLAIMS_STUB/claims"

# ── the a2a posture arm: a SKIP that used to be a RED ──────────────────────
# Found 2026-09-09 on a live KickTodo deploy. The agent-card arm gated on
# posture; the two `a2a.*` version rows did not, in the same file — so one run
# printed SKIP and STALE about the same capability, and the STALE branch printed
# a diagnosis ("deploy the backend") that could never clear it.
#
# BIDIRECTIONAL on purpose: a guard that only ever skips is indistinguishable
# from deleting the rows. Off must skip; ON with genuinely stale versions must
# still fail.
DOC="$STUB_DIR/api/.well-known/openwop"
cp "$DOC" "$TMP/doc.bak"
a2a_doc() { python3 - "$DOC" "$1" <<'PY2'
import json, sys
d = json.load(open(sys.argv[1]))
caps = d.setdefault("capabilities", {})
mode = sys.argv[2]
if mode == "absent":
    caps.pop("a2a", None)
elif mode == "stale":
    caps["a2a"] = {"supported": True, "protocolVersions": ["0.3"], "preferredVersion": "0.3"}
json.dump(d, open(sys.argv[1], "w"))
PY2
}
a2a_doc absent
check "a2a NOT advertised → the version rows SKIP, not STALE (the 2026-09-09 false red)" 0 "$(W "$CLAIMS_META")"
a2a_doc stale
check "  ...but a2a ADVERTISED with stale versions still FAILS (the guard did not delete the check)" 1 "$(W "$CLAIMS_META")"
cp "$TMP/doc.bak" "$DOC"
check "  ...and the restored document passes again (control)" 0 "$(W "$CLAIMS_META")"

echo "== deploy.sh + write-build-commit: the certify stamp (ADR 0550 P4) =="
# THE HAZARD: `build-meta/*` is gitignored but `.gcloudignore` deliberately
# un-ignores it, so a long-lived deploy checkout carries the LAST certify's
# bundle into the next upload. That deploy would advertise the RFC 0089 §D
# pointer at evidence describing a different commit, and every existing gate
# would pass — the commit stamp matches HEAD, and verify-deploy checks the
# commit, which was never the claim. Same class as the 1.66.0 corpus-suite
# incident, with a public conformance claim in place of a version string.
#
# write-build-commit.mjs cannot re-derive a bundle (it takes a real suite run),
# so its only honest move is DELETION. Both polarities below.
WBC_ROOT="$TMP/wbcroot"; mkdir -p "$WBC_ROOT/build-meta" "$WBC_ROOT/scripts"
cp "$ROOT/scripts/write-build-commit.mjs" "$WBC_ROOT/scripts/"
printf '%s' '{"bundleVersion":"2","claimedProfiles":["openwop-core-standard"]}' > "$WBC_ROOT/build-meta/certification-bundle.json"
printf '%s' '{"claimsVersion":"1","claimedProfiles":["openwop-core-standard"]}' > "$WBC_ROOT/build-meta/conformance-claims.json"
node "$WBC_ROOT/scripts/write-build-commit.mjs" "$(printf '%040d' 3)" >/dev/null 2>&1
if [ -f "$WBC_ROOT/build-meta/certification-bundle.json" ] || [ -f "$WBC_ROOT/build-meta/conformance-claims.json" ]; then
  bad "write-build-commit left a stale certification stamp in place"
else
  ok "write-build-commit DELETES a stale certification stamp (cannot re-derive ⇒ absent, never stale)"
fi
# ...and the commit stamp it CAN derive still lands, so the deletion above is a
# targeted removal rather than the script having failed outright.
if [ -s "$WBC_ROOT/build-meta/commit.txt" ]; then ok "  ...while still writing the commit stamp it can derive"; else bad "write-build-commit wrote no commit.txt"; fi

# deploy.sh must PRODUCE the stamp on the deploy path, and must REFUSE to ship
# when the lane cannot. Asserted on the source, because running the real lane
# here would be a 10-minute conformance fleet inside a gate test.
D_SRC="$(cat "$ROOT/scripts/deploy.sh")"
case "$D_SRC" in *"npm run test:conformance -- --certify"*) ok "deploy.sh RUNS the certify lane on the deploy path" ;;
  *) bad "deploy.sh does not run --certify — a deploy would ship whatever build-meta held" ;; esac
case "$D_SRC" in *"the certify lane FAILED — refusing to ship"*) ok "deploy.sh REFUSES to ship when the certify lane fails" ;;
  *) bad "deploy.sh does not refuse on a failed certify lane" ;; esac
case "$D_SRC" in *"exited 0 but produced no stamp"*) ok "deploy.sh REFUSES when the lane exits 0 but writes nothing" ;;
  *) bad "deploy.sh trusts the lane exit code instead of the artifact" ;; esac
case "$D_SRC" in *"--skip-certify"*) ok "deploy.sh offers --skip-certify (ABSENT pointer, never stale)" ;;
  *) bad "deploy.sh has no way to ship deliberately unclaimed" ;; esac
# Every preflight exception must be REACHABLE through deploy.sh, which is the
# only supported entry point (ADR 0530). A flag that preflight documents and
# the wrapper rejects is an escape hatch that exists on paper only — measured
# 2026-09-11, when a 15-pack pin drift blocked a host-code deploy and
# `deploy.sh --allow-pin-drift` answered `unknown argument`.
P_SRC="$(cat "$ROOT/scripts/preflight-deploy.sh")"
for flag in --allow-unverified-live --allow-pin-drift; do
  # Match the flag AT A CASE-PATTERN BOUNDARY (`flag)` or `flag|`), not as a
  # substring: the first version of this check passed against a sabotaged
  # `--allow-pin-driftXX)`, which is the spelling-not-invariant trap.
  case "$P_SRC" in *"$flag)"*|*"$flag|"*)
    case "$D_SRC" in *"$flag)"*|*"$flag|"*) ok "deploy.sh forwards $flag (preflight's exception is reachable)" ;;
      *) bad "preflight accepts $flag but deploy.sh rejects it — the documented exception is unreachable" ;; esac ;;
  esac
done

# The one flag that must NOT exist: anything that ships a bundle it did not derive.
case "$D_SRC" in *--allow-stale-certify*|*--keep-certify*) bad "deploy.sh has a flag that would ship a STALE certification stamp" ;;
  *) ok "deploy.sh has no flag that ships a stale stamp" ;; esac
# The certify step must come BEFORE the backend upload, or the image is built
# from a build-meta the step has not written yet.
# `^[^#]*` — the same guard the frontend-deps ordering check above learned to
# use. A bare `gcloud run deploy` grep matches the COMMENT at deploy.sh:116
# explaining why the merge flags are used, so the first "match" is 130 lines
# above the real invocation and the ordering assertion reads backwards. This
# check found that on its first run, which is the only reason it is not
# silently comparing a comment to a command.
CERT_LINE=$(grep -nE '^[^#]*npm run test:conformance -- --certify' "$ROOT/scripts/deploy.sh" | head -1 | cut -d: -f1)
DEPLOY_LINE=$(grep -nE '^[^#]*gcloud run deploy' "$ROOT/scripts/deploy.sh" | head -1 | cut -d: -f1)
if [ -n "$CERT_LINE" ] && [ -n "$DEPLOY_LINE" ] && [ "$CERT_LINE" -lt "$DEPLOY_LINE" ]; then
  ok "deploy.sh certifies before the backend upload (line $CERT_LINE < $DEPLOY_LINE)"
else
  bad "deploy.sh certify step does not precede the upload (certify=$CERT_LINE upload=$DEPLOY_LINE)"
fi

echo "== deploy.sh config parsing (DGATE-2) =="
# The env file is parsed, never sourced. If it were sourced, the line below would
# execute and the marker file would exist — that is the whole assertion.
CFG_DIR="$TMP/cfgroot/scripts"; mkdir -p "$CFG_DIR"
cp "$ROOT/scripts/deploy.sh" "$TMP/cfgroot/scripts/deploy.sh"
cat > "$CFG_DIR/deploy.env" <<CFG
# a comment
OPENWOP_DEPLOY_SERVICE=svc
OPENWOP_DEPLOY_PROJECT="quoted-proj"
OPENWOP_DEPLOY_REGION=us-central1
OPENWOP_DEPLOY_ACCOUNT=me@example.test
OPENWOP_DEPLOY_HOSTING_TARGET=app
OPENWOP_DEPLOY_FIREBASE_PROJECT=fb
OPENWOP_DISTRIBUTION=default
BASE=$STUB
touch $TMP/PWNED
export EVIL=1
CFG
( cd "$TMP/cfgroot" && bash scripts/deploy.sh --frontend-only >/dev/null 2>&1 )
if [ -e "$TMP/PWNED" ]; then bad "config file was SOURCED — arbitrary code ran"; else ok "config is parsed, not sourced (no code execution)"; fi

# A config line the parser does not understand must FAIL CLOSED — never be
# half-accepted. `export FOO=bar` is the common .env idiom this parser does not
# support, so a config whose only definition of a required var is an `export`
# line must report that var unset and refuse to deploy.
#
# NOTE, honestly: this passes against the earlier `tr -d` parser too, because
# that one also left FOO unset (it invented `exportFOO` instead). A sabotage
# check proved the two are indistinguishable from outside — so this test pins
# FAIL-CLOSED, which is the property that matters, and does NOT claim to catch
# the naming quirk. A test that cannot fail is worse than no test; this one can
# (delete the required-var check and it goes red).
CFG2="$TMP/cfg2/scripts"; mkdir -p "$CFG2"
cp "$ROOT/scripts/deploy.sh" "$CFG2/deploy.sh"
{
  echo "export OPENWOP_DEPLOY_SERVICE=viaexport"
  echo "OPENWOP_DEPLOY_PROJECT=p"
  echo "OPENWOP_DEPLOY_REGION=r"
  echo "OPENWOP_DEPLOY_ACCOUNT=a"
  echo "OPENWOP_DEPLOY_HOSTING_TARGET=h"
  echo "OPENWOP_DEPLOY_FIREBASE_PROJECT=f"
  echo "OPENWOP_DISTRIBUTION=default"
  echo "BASE=$STUB"
} > "$CFG2/deploy.env"
out2=$( ( cd "$TMP/cfg2" && bash scripts/deploy.sh --frontend-only 2>&1 ) || true )
case "$out2" in
  *OPENWOP_DEPLOY_SERVICE*) ok "an unsupported 'export FOO=' line fails closed (var reported unset)" ;;
  *) bad "'export FOO=' was half-accepted — deploy proceeded without the var" ;;
esac

# The frontend build selects `default` when OPENWOP_DISTRIBUTION is absent.
# That fallback is useful for development but unsafe at deploy time: a
# white-label host can ship the wrong product and validate against the wrong
# bundle budget. The deploy wrapper must therefore require an explicit choice.
CFG3="$TMP/cfg3/scripts"; mkdir -p "$CFG3"
cp "$ROOT/scripts/deploy.sh" "$CFG3/deploy.sh"
cat > "$CFG3/deploy.env" <<CFG
OPENWOP_DEPLOY_SERVICE=svc
OPENWOP_DEPLOY_PROJECT=p
OPENWOP_DEPLOY_REGION=r
OPENWOP_DEPLOY_ACCOUNT=a
OPENWOP_DEPLOY_HOSTING_TARGET=h
OPENWOP_DEPLOY_FIREBASE_PROJECT=f
BASE=$STUB
CFG
out3=$( ( cd "$TMP/cfg3" && bash scripts/deploy.sh --frontend-only 2>&1 ) || true )
case "$out3" in
  *"unset in "*OPENWOP_DISTRIBUTION*) ok "deploy.sh refuses an implicit default distribution" ;;
  *) bad "deploy.sh accepted no OPENWOP_DISTRIBUTION — a white-label deploy can build default" ;;
esac

# ── deploy.sh must stamp the image BEFORE it runs its own preflight ────────────
# REGRESSION PIN. deploy.sh used to write build-meta/commit.txt AFTER calling
# preflight-deploy.sh, whose gate 4 FAILS on a missing stamp. From the clean
# detached worktree the deploy recipe prescribes, that file does not exist — so
# `scripts/deploy.sh`, the RECOMMENDED path, could never once pass its own gate.
# Nobody noticed because both scripts documented the other as handling it.
#
# Matchers skip comment lines: both scripts discuss these very calls in prose,
# and an unanchored grep measured the COMMENT rather than the code (it did, on
# first write of the half-deploy pin below — a false red that looked real).
# Asserted structurally (line order) rather than by execution: running deploy.sh
# for real needs network, gcloud credentials, and HEAD to be origin/main's tip,
# and a test that flaky gets disabled, which is how the gap reopens.
stamp_line=$(grep -nE '^[^#]*write-build-commit\.mjs' "$ROOT/scripts/deploy.sh" | head -1 | cut -d: -f1)
pre_line=$(grep -nE '^[^#]*scripts/preflight-deploy\.sh' "$ROOT/scripts/deploy.sh" | head -1 | cut -d: -f1)
if [ -z "$stamp_line" ] || [ -z "$pre_line" ]; then
  bad "deploy.sh no longer calls write-build-commit.mjs and/or preflight-deploy.sh"
elif [ "$stamp_line" -lt "$pre_line" ]; then
  ok "deploy.sh stamps the image before its preflight (line $stamp_line < $pre_line)"
else
  bad "deploy.sh stamps AFTER preflight (line $stamp_line > $pre_line) — it cannot pass gate 4 from a clean worktree"
fi

# ── the frontend must be proven BUILDABLE before the backend SHIPS ────────────
# REGRESSION PIN for the 2026-08-11 half-deploy: backend reached Cloud Run
# (revision 00637-pm2), then the frontend build died on `tsc: command not found`
# because the clean deploy worktree had no node_modules. Recoverable only
# because backend-first is the safe order.
dep_line=$(grep -nE '^[^#]*frontend/react/node_modules' "$ROOT/scripts/deploy.sh" | head -1 | cut -d: -f1)
gcloud_line=$(grep -nE '^[^#]*gcloud run deploy' "$ROOT/scripts/deploy.sh" | head -1 | cut -d: -f1)
if [ -z "$dep_line" ]; then
  bad "deploy.sh no longer checks frontend/react/node_modules — a missing dep would half-deploy again"
elif [ -z "$gcloud_line" ]; then
  bad "deploy.sh no longer calls 'gcloud run deploy'"
elif [ "$dep_line" -lt "$gcloud_line" ]; then
  ok "deploy.sh proves the frontend can build before shipping the backend (line $dep_line < $gcloud_line)"
else
  bad "deploy.sh checks frontend deps AFTER shipping the backend (line $dep_line > $gcloud_line) — half-deploy risk"
fi

# Presence is insufficient for the backend suite: a stale but valid install
# certified and stamped 2.1.5 while package-lock resolved 2.31.0 (2026-09-20).
# Exercise both polarities of the dedicated parity checker and pin its ordering
# before any Cloud Run write.
PARITY_FIX="$TMP/deploy-parity"; mkdir -p "$PARITY_FIX/backend/typescript/node_modules/@openwop/openwop-conformance"
printf '%s\n' '{"packages":{"node_modules/@openwop/openwop-conformance":{"version":"2.31.0"}}}' > "$PARITY_FIX/backend/typescript/package-lock.json"
printf '%s\n' '{"version":"2.31.0"}' > "$PARITY_FIX/backend/typescript/node_modules/@openwop/openwop-conformance/package.json"
if node "$ROOT/scripts/check-deploy-conformance-install.mjs" "$PARITY_FIX" >/dev/null 2>&1; then
  ok "deploy conformance install parity accepts an exact lockfile match"
else
  bad "deploy conformance install parity rejected an exact lockfile match"
fi
printf '%s\n' '{"version":"2.1.5"}' > "$PARITY_FIX/backend/typescript/node_modules/@openwop/openwop-conformance/package.json"
if node "$ROOT/scripts/check-deploy-conformance-install.mjs" "$PARITY_FIX" >/dev/null 2>&1; then
  bad "deploy conformance install parity accepted a stale installed suite"
else
  ok "deploy conformance install parity refuses a stale installed suite"
fi
parity_line=$(grep -nE '^[^#]*check-deploy-conformance-install\.mjs' "$ROOT/scripts/deploy.sh" | head -1 | cut -d: -f1)
if [ -n "$parity_line" ] && [ -n "$gcloud_line" ] && [ "$parity_line" -lt "$gcloud_line" ]; then
  ok "deploy.sh checks conformance lock parity before shipping the backend (line $parity_line < $gcloud_line)"
else
  bad "deploy.sh checks conformance lock parity too late or not at all (parity=$parity_line upload=$gcloud_line)"
fi

# And the escape hatch that makes the ordering exercisable must still exist.
if grep -q -- '--preflight-only' "$ROOT/scripts/deploy.sh"; then
  ok "deploy.sh keeps --preflight-only (stamp + gate, no deploy)"
else
  bad "deploy.sh lost --preflight-only — the ordering is no longer exercisable without a real deploy"
fi

echo "== ci.sh: the gate must know WHICH TREE it tested (H101) =="
# WHY. A gate reads the working tree continuously — backend `tsc` early, vitest
# throughout, the frontend build minutes later. An edit mid-run produces a result
# corresponding to NO SINGLE TREE STATE. MEASURED 2026-08-18: a peer edited a
# source file ~10 min into a run and killed it themselves; nothing in ci.sh would
# have caught it.
#
# And the ledger made it worse than undetected — the row is keyed by
# `git rev-parse --short HEAD`, so the run would have been DURABLY ATTRIBUTED to a
# commit it never tested. Every other gap this repo closed was a check that failed
# to DETECT; this one MANUFACTURES a false record in the artifact people consult
# later, when the context that would let them doubt it is gone.

# Behavioural, in a throwaway repo: the fingerprint must survive an unchanged
# tree (or the gate is always void — the always-red end state) and must catch
# BOTH kinds of movement. Staged in all three directions on purpose.
H101_REPO="$TMP/h101"; mkdir -p "$H101_REPO"
( cd "$H101_REPO" && git init -q . && git config user.email t@t && git config user.name t \
    && echo a > f && git add f && git -c commit.gpgsign=false commit -qm init ) >/dev/null 2>&1
# Reuse ci.sh's OWN definitions rather than a copy: a test that re-implements the
# function under test proves the test author can write it, not that the script does.
h101_fns=$(sed -n '/^tree_fingerprint() {/,/^}/p;/^tree_unchanged() {/,/^}/p' "$ROOT/scripts/ci.sh")
if [ -z "$h101_fns" ]; then
  bad "ci.sh no longer defines tree_fingerprint/tree_unchanged — the H101 guard is gone"
else
  h101_probe() { # h101_probe <mutation-command>  -> prints CHANGED or SAME
    ( cd "$H101_REPO" && ROOT="$H101_REPO" && eval "$h101_fns" \
      && CI_TREE_AT_START="$(tree_fingerprint | shasum -a 256 | cut -d' ' -f1)" \
      && eval "$1" >/dev/null 2>&1 \
      && { tree_unchanged && echo SAME || echo CHANGED; } )
  }
  case "$(h101_probe true)" in
    SAME) ok "an UNCHANGED tree reads as unchanged (else the gate is always void)" ;;
    *)    bad "an unchanged tree read as CHANGED — the guard would void every run" ;;
  esac
  case "$(h101_probe 'echo edited > f')" in
    CHANGED) ok "an uncommitted EDIT is detected (the measured failure mode)" ;;
    *)       bad "an uncommitted edit was NOT detected" ;;
  esac
  # HEAD moves too — a rebase or checkout mid-run changes the commit while the
  # porcelain stays clean, so a dirty-only check would miss it entirely.
  case "$(h101_probe 'echo more > g && git add g && git -c commit.gpgsign=false commit -qm second')" in
    CHANGED) ok "a HEAD move is detected (rebase/checkout, clean porcelain)" ;;
    *)       bad "a HEAD move was NOT detected — a dirty-only check misses rebases" ;;
  esac
fi

# STRUCTURAL: the ledger must have exactly ONE writer, and it must be the guarded
# one. A second raw `>> ledger` anywhere re-opens the false-attribution hole
# without touching the function this suite tests.
raw_writers=$(grep -cE '^[^#]*>>[[:space:]]*"?\$\{?(e2e_ledger|OPENWOP_CI_E2E_LEDGER)' "$ROOT/scripts/ci.sh" || true)
if [ "${raw_writers:-0}" -eq 0 ]; then
  ok "no raw ledger append survives — ledger_append is the only writer"
else
  bad "ci.sh has $raw_writers raw ledger append(s) bypassing ledger_append (H101 hole reopened)"
fi

# And the run must FAIL, not merely warn: refusing the row stops the false record
# persisting, but only a non-zero exit stops the operator believing the green.
if grep -q 'GATE VOID' "$ROOT/scripts/ci.sh"; then
  ok "ci.sh VOIDS the run when the tree moved (fatal, not advisory)"
else
  bad "ci.sh no longer voids a mutated-tree run — a green whose inputs moved would pass"
fi

echo "== verify-deploy: the peer-build arm (H90) =="
# WHY. CLAUDE.md prescribed `gcloud builds list --limit 3` after every deploy as
# the remedy for the 2026-08-03 double-clobber. MEASURED 2026-08-18: it returns
# EMPTY WITH EXIT 0, because Cloud Run `--source` builds are REGIONAL and the
# command omits --region. It was green on deploys #5/#6/#7 and meant nothing.
# It was also prose only — `grep -rn 'gcloud builds' scripts/` found no caller —
# so it never even had the chance to drift out of correctness.
#
# These cases stage a FAKE gcloud. Every one of them can fail: the floor case
# goes green if you delete the floor, the two-build case goes green if you
# downgrade the peer signal to a printed line, and the one-build case goes red
# if you make the arm unconditionally angry. A guard exercised in one direction
# only has not been shown to work.
FAKEBIN="$TMP/fakebin"; mkdir -p "$FAKEBIN"
# The fake prints whatever GCLOUD_FAKE_OUT holds, for any argv. Deliberately
# argv-blind: pinning it to the exact flags would make this suite assert its own
# fixture rather than the script's behaviour.
cat > "$FAKEBIN/gcloud" <<'FAKE'
#!/usr/bin/env bash
# `services describe` answers the staged service JSON (preflight Gate 5 reads
# pool/maxScale/minScale/tags from it); `revisions list` answers nothing;
# everything else answers GCLOUD_FAKE_OUT (the `builds list` cases below).
case "$*" in
  *"services describe"*) printf '%s' "${GCLOUD_FAKE_SERVICE_JSON:-}"; exit 0 ;;
  *"revisions list"*) exit 0 ;;
esac
printf '%s' "${GCLOUD_FAKE_OUT:-}"
[ -n "${GCLOUD_FAKE_OUT:-}" ] && echo
exit 0
FAKE
chmod +x "$FAKEBIN/gcloud"

set_live "$NEW"
printf '{"commit":"%s","stamped":true,"dirty":false}' "$NEW" > "$STUB_DIR/build-info.json"

# `--limit 1` (the floor) and the windowed list both go through the same fake, so
# a single GCLOUD_FAKE_OUT drives both: one line = floor OK + one build in window.
P() { ( cd "$REPO" && PATH="$FAKEBIN:$PATH" BASE="$STUB" \
        OPENWOP_DEPLOY_PROJECT=p OPENWOP_DEPLOY_REGION=r SHELL_CONVERGE_S=0 \
        GCLOUD_FAKE_OUT="$1" bash "$ROOT/scripts/verify-deploy.sh" "$NEW" >/dev/null 2>&1; echo $? ); }
POUT() { ( cd "$REPO" && PATH="$FAKEBIN:$PATH" BASE="$STUB" \
        OPENWOP_DEPLOY_PROJECT=p OPENWOP_DEPLOY_REGION=r SHELL_CONVERGE_S=0 \
        GCLOUD_FAKE_OUT="$1" bash "$ROOT/scripts/verify-deploy.sh" "$NEW" 2>&1 ); }

# ── preflight Gate 5: the pg connection budget (incident 2026-09-05, twice) ──
# Gates 1–4 pass in this repo state (the control case proves it), and the fake
# gcloud answers `services describe` with a staged template, so each case below
# is ONE line of arithmetic: pool × maxScale + tagged-idle × pool ≤ max_conn − 3.
svc_json() { # svc_json <pool> <maxScale> <minScale> <tags-csv>
  local tags="" t; for t in $(printf '%s' "$4" | tr ',' ' '); do tags="$tags,{\"tag\":\"$t\",\"revisionName\":\"r-$t\"}"; done
  printf '{"spec":{"template":{"metadata":{"annotations":{"autoscaling.knative.dev/maxScale":"%s","autoscaling.knative.dev/minScale":"%s"}},"spec":{"containers":[{"env":[{"name":"OPENWOP_PG_POOL_MAX","value":"%s"}]}]}},"traffic":[{"revisionName":"live","percent":100}%s]},"status":{"traffic":[{"revisionName":"live","percent":100}]}}' "$2" "$3" "$1" "$tags"
}
PB() { ( cd "$REPO" && PATH="$FAKEBIN:$PATH" BASE="$STUB" OPENWOP_DEPLOY_SERVICE=svc OPENWOP_DEPLOY_PROJECT=p OPENWOP_DEPLOY_REGION=r \
        OPENWOP_PG_MAX_CONNECTIONS=25 GCLOUD_FAKE_SERVICE_JSON="$1" bash "$ROOT/scripts/preflight-deploy.sh" >/dev/null 2>&1; echo $? ); }
PBOUT() { ( cd "$REPO" && PATH="$FAKEBIN:$PATH" BASE="$STUB" OPENWOP_DEPLOY_SERVICE=svc OPENWOP_DEPLOY_PROJECT=p OPENWOP_DEPLOY_REGION=r \
        OPENWOP_PG_MAX_CONNECTIONS=25 GCLOUD_FAKE_SERVICE_JSON="$1" bash "$ROOT/scripts/preflight-deploy.sh" 2>&1 ); }
check "pg budget control: pool 4 × maxScale 3, no tags → 12 ≤ 22 PASSES" 0 "$(PB "$(svc_json 4 3 1 '')")"
check "pg budget: pool 4 × maxScale 6 = 24 > 22 FAILS" 1 "$(PB "$(svc_json 4 6 1 '')")"
check "pg budget: the 2026-09-05 shape (4 × 5 + five tags × 4 = 40) FAILS" 1 "$(PB "$(svc_json 4 5 1 'smoke,rlhi,v2p4,p4c,v2p5')")"
case "$(PBOUT "$(svc_json 4 5 1 'smoke,rlhi,v2p4,p4c,v2p5')")" in
  *"--remove-tags smoke,rlhi,v2p4,p4c,v2p5"*) ok "  ...and prints the exact remove-tags command" ;;
  *) bad "  ...but did not name the tags to remove" ;;
esac
check "pg budget: one tag that still fits (4 × 3 + 4 = 16) PASSES with a NOTE" 0 "$(PB "$(svc_json 4 3 1 'smoke')")"
case "$(PBOUT "$(svc_json 4 3 1 'smoke')")" in *"NOTE      : 1 tagged revision"*) ok "  ...and the NOTE names the idle tag" ;; *) bad "  ...but no NOTE about the tag" ;; esac
check "pg budget: minScale 0 → tags hold no idle instance (4 × 5 + 0 = 20) PASSES" 0 "$(PB "$(svc_json 4 5 0 'smoke,rlhi')")"
check "pg budget: UNREADABLE service JSON FAILS (never guess a budget)" 1 "$(PB "")"
# …and the SUMMARY must say which fact it is. `refusing to guess` in the detail
# followed by `the connection budget does not fit` in the headline is a gate
# that is honest where nobody looks and false where everybody does — it misled
# this session twice on 2026-09-11 (an expired gcloud token, then a real pin
# drift). An unreadable check summarises as UNMEASURED; only a measurement may
# claim a breach.
UNREAD_OUT="$(PBOUT "")"
case "$UNREAD_OUT" in *"COULD NOT BE MEASURED"*) ok "  ...and the summary says it could not MEASURE, not that the budget fails" ;;
  *) bad "  ...but the summary does not distinguish unmeasured from breached" ;; esac
case "$UNREAD_OUT" in *"the connection budget does not fit"*) bad "  ...and it still claims a breach it never measured" ;;
  *) ok "  ...and it does NOT claim a breach it never measured" ;; esac
BREACH_OUT="$(PBOUT "$(svc_json 4 6 1 '')")"
case "$BREACH_OUT" in *"the connection budget does not fit"*) ok "  ...while a MEASURED breach still says the budget does not fit" ;;
  *) bad "  ...but a measured breach no longer names the breach" ;; esac
case "$BREACH_OUT" in *"COULD NOT BE MEASURED"*) bad "  ...and a measured breach wrongly reports itself as unmeasured" ;;
  *) ok "  ...and a measured breach is not reported as unmeasured" ;; esac

B1='b1	2026-08-18T16:28:06+00:00	SUCCESS'
B2='b2	2026-08-18T16:29:11+00:00	SUCCESS'

# THE FLOOR, and the whole point of the card: empty must be a FAILURE. Before
# H90 this exact condition was the permanent state of the check and read as
# "nobody else built".
check "EMPTY build list FAILS (the query is wrong, not the answer 'no peers')" 1 "$(P "")"
case "$(POUT "")" in
  *"QUERY BROKEN"*) ok "  ...and says QUERY BROKEN rather than reporting a clean result" ;;
  *) bad "  ...but did not name the scope/credential fault" ;;
esac

# Non-vacuity in the other direction: the arm must be capable of passing, or the
# floor above proves nothing. (A gate that is always red gets disabled, and then
# the real one is gone too — the same end state as a gate that cannot fail.)
check "ONE build in the window PASSES" 0 "$(P "$B1")"

# The signal the 08-03 incident actually needed. The commit checks above cannot
# see this: a clobbering build's own stamps are internally consistent.
check "TWO builds in the window FAIL (a parallel deploy may have landed on yours)" 1 "$(P "$B1
$B2")"

# A missing tool must SKIP, never pass. Degrading to a green when gcloud is
# absent would rebuild the inert-check this card exists to remove.
# `PATH=$TMP/emptybin` was the first spelling and it was WRONG: it removed
# curl/grep/sed as well, so the script died long before the arm ran and the case
# went red for a reason unrelated to gcloud. A negative that fails for the wrong
# reason proves nothing. `/usr/bin:/bin` was the second spelling and it was
# WRONG TOO, one platform over: on macOS the SDK lives outside those dirs, but
# `ubuntu-latest` ships the Cloud SDK at /usr/bin/gcloud, so on a hosted runner
# the arm found gcloud, never skipped, and this case went red (MEASURED by a
# white-label adopter, 2026-09-06). The condition under test is "no gcloud on
# PATH", so build exactly that: every executable the harness can see, minus
# gcloud, in one directory — and prove gcloud is gone before running the arm.
NOGCLOUD="$TMP/nogcloud"; mkdir -p "$NOGCLOUD"
IFS=: read -r -a _path_dirs <<<"$PATH"
for _d in "${_path_dirs[@]}"; do
  [ -d "$_d" ] || continue
  for _f in "$_d"/*; do
    _n=$(basename "$_f")
    case "$_n" in gcloud*) continue ;; esac
    [ -e "$NOGCLOUD/$_n" ] || ln -s "$_f" "$NOGCLOUD/$_n" 2>/dev/null || true
  done
done
if ( PATH="$NOGCLOUD" command -v gcloud >/dev/null 2>&1 ); then
  bad "no-gcloud PATH still resolves gcloud — the arm below would test nothing"
fi
skip_out=$( ( cd "$REPO" && PATH="$NOGCLOUD" BASE="$STUB" \
              OPENWOP_DEPLOY_PROJECT=p OPENWOP_DEPLOY_REGION=r SHELL_CONVERGE_S=0 \
              bash "$ROOT/scripts/verify-deploy.sh" "$NEW" 2>&1 ) || true )
case "$skip_out" in
  *"peer build  SKIPPED"*) ok "no gcloud → SKIPPED (a distinct word from OK, so it cannot read as a pass)" ;;
  *) bad "no gcloud → the arm did not report SKIPPED" ;;
esac
case "$skip_out" in
  *"peer build  OK"*) bad "no gcloud → the arm ALSO printed OK; SKIPPED must not coexist with a pass" ;;
  *) ok "  ...and did not print OK alongside it" ;;
esac

# Unset config must skip too — deploy.sh exports these, a bare run does not.
unset_out=$( ( cd "$REPO" && PATH="$FAKEBIN:$PATH" BASE="$STUB" \
               OPENWOP_DEPLOY_PROJECT= OPENWOP_DEPLOY_REGION= SHELL_CONVERGE_S=0 \
               bash "$ROOT/scripts/verify-deploy.sh" "$NEW" 2>&1 ) || true)
case "$unset_out" in
  *"peer build  SKIPPED"*) ok "unset OPENWOP_DEPLOY_PROJECT/REGION → SKIPPED, not a silent pass" ;;
  *) bad "unset deploy config → the arm did not report SKIPPED" ;;
esac

# deploy.sh must EXPORT the config, or the arm it now depends on skips on every
# real deploy — inert again, by a different route.
if grep -qE '^[^#]*export .*OPENWOP_DEPLOY_PROJECT' "$ROOT/scripts/deploy.sh"; then
  ok "deploy.sh exports OPENWOP_DEPLOY_PROJECT/REGION so the arm actually runs"
else
  bad "deploy.sh does not export OPENWOP_DEPLOY_PROJECT — the peer-build arm SKIPS on every real deploy"
fi

echo "== verify-deploy: zero builds in the window (H92) =="
# WHY. H90 gave the GLOBAL query a floor — empty is QUERY BROKEN, never "no
# peers". The WINDOWED query kept no floor, so the identical empty-means-inert
# defect survived one level down and printed the cleanest line on the page:
#
#     peer build  OK       0 build(s) in the last 20m (region us-central1)
#
# After a deploy that is provably wrong: your OWN build is in the window, so
# zero means the filter/clock/window is broken, not that the region is quiet.
#
# These cases need a fake that DISTINGUISHES the two queries, because the
# argv-blind fake above drives both from one variable and therefore cannot reach
# "floor fine, window empty" at all. That is a limit of the fixture, not of the
# script — and it is exactly the state H92 is about, so it has to be reachable.
FAKEBIN2="$TMP/fakebin2"; mkdir -p "$FAKEBIN2"
cat > "$FAKEBIN2/gcloud" <<'FAKE'
#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    --filter=*) printf '%s' "${GCLOUD_FAKE_WINDOW:-}"; [ -n "${GCLOUD_FAKE_WINDOW:-}" ] && echo; exit 0 ;;
  esac
done
printf '%s' "${GCLOUD_FAKE_FLOOR:-}"; [ -n "${GCLOUD_FAKE_FLOOR:-}" ] && echo
exit 0
FAKE
chmod +x "$FAKEBIN2/gcloud"

# $1 = floor output, $2 = window output, $3.. = extra verify-deploy args
W() { fl="$1"; wn="$2"; shift 2
  ( cd "$REPO" && PATH="$FAKEBIN2:$PATH" BASE="$STUB" \
    OPENWOP_DEPLOY_PROJECT=p OPENWOP_DEPLOY_REGION=r SHELL_CONVERGE_S=0 \
    GCLOUD_FAKE_FLOOR="$fl" GCLOUD_FAKE_WINDOW="$wn" \
    bash "$ROOT/scripts/verify-deploy.sh" "$NEW" "$@" >/dev/null 2>&1; echo $? ); }
WOUT() { fl="$1"; wn="$2"; shift 2
  ( cd "$REPO" && PATH="$FAKEBIN2:$PATH" BASE="$STUB" \
    OPENWOP_DEPLOY_PROJECT=p OPENWOP_DEPLOY_REGION=r SHELL_CONVERGE_S=0 \
    GCLOUD_FAKE_FLOOR="$fl" GCLOUD_FAKE_WINDOW="$wn" \
    bash "$ROOT/scripts/verify-deploy.sh" "$NEW" "$@" 2>&1 ); }

# FIXTURE SELF-CHECK. If the argv split silently stopped working, every case
# below would collapse onto one branch and still look like it ran. Assert the
# fake can actually produce "floor fine, window empty" before trusting it to.
case "$(WOUT "$B1" "" --after-deploy)" in
  *"QUERY BROKEN"*) bad "fixture: the argv-aware fake fell through to the FLOOR — the window cases test nothing" ;;
  *) ok "fixture: floor and window queries are distinguishable" ;;
esac

check "ZERO in the window AFTER A DEPLOY fails (your own build must be there)" 1 "$(W "$B1" "" --after-deploy)"
case "$(WOUT "$B1" "" --after-deploy)" in
  *"WINDOW BROKEN"*) ok "  ...and names the broken query rather than reporting quiet" ;;
  *) bad "  ...but did not say WINDOW BROKEN" ;;
esac
case "$(WOUT "$B1" "" --after-deploy)" in
  *"peer build  OK"*) bad "  ...and STILL printed OK — the H92 defect verbatim" ;;
  *) ok "  ...and never prints OK for zero" ;;
esac

# Standalone is a different question. `verify-deploy.sh` is legitimately run
# hours after a deploy, where zero is the honest answer — so this must NOT fail.
# It must also not say OK, because the arm corroborated nothing; a word that
# implies it did is how this class returns.
check "ZERO in the window STANDALONE does not fail (no deploy just ran)" 0 "$(W "$B1" "")"
case "$(WOUT "$B1" "")" in
  *"NOT CORROBORATED"*) ok "  ...and says NOT CORROBORATED, a distinct word from OK" ;;
  *) bad "  ...but did not distinguish an unchecked window from a clean one" ;;
esac
case "$(WOUT "$B1" "")" in
  *"peer build  OK"*) bad "  ...and printed OK for a window it never corroborated" ;;
  *) ok "  ...and withheld OK" ;;
esac

# NON-VACUITY. The arm must still be capable of passing WITH --after-deploy, or
# the cases above are satisfied by a guard that is simply always angry.
check "ONE build in the window AFTER A DEPLOY still PASSES" 0 "$(W "$B1" "$B1" --after-deploy)"
check "TWO builds AFTER A DEPLOY still FAIL (the peer signal survives H92)" 1 "$(W "$B1" "$B1
$B2" --after-deploy)"

# STRUCTURAL. The flag is worthless if deploy.sh never sends it, and it must be
# tied to the BACKEND condition — a frontend-only deploy produces no build and
# would fail the new check every time.
if grep -qE '^\[ "\$DO_BACKEND" -eq 1 \].*--after-deploy' "$ROOT/scripts/deploy.sh"; then
  ok "deploy.sh passes --after-deploy, and only when it deployed the BACKEND"
else
  bad "deploy.sh does not pass --after-deploy on a backend deploy — the H92 arm never arms"
fi

# DOC PIN. The prose form is what people type by hand; if it loses --region it
# is empty-with-exit-0 again and this whole card reopens.
# ANCHORED to line start. The first spelling matched any occurrence and went red
# on the CORRECTION NOTE's own quotation of the broken command — a pin that
# cannot tell a prescription from a description of the defect it fixed. A
# prescribed command opens its line (inside a fence); a prose mention sits
# mid-sentence in backticks.
if grep -nE '^[[:space:]]*gcloud builds list' "$ROOT/CLAUDE.md" | grep -qv -- '--region'; then
  bad "CLAUDE.md still prescribes a 'gcloud builds list' without --region (empty + exit 0 forever)"
else
  ok "CLAUDE.md's 'gcloud builds list' always carries --region"
fi

echo "== verify-deploy: the SPA shell arm (H91) =="
# WHY. CLAUDE.md prescribes fetching `/`, extracting its `assets/index-*.js`
# reference and asserting `200 text/javascript`, warning in capitals that
# `200 text/html` means the SPA rewrite answered and `/` is BROKEN — then saying
# twice: assert the CONTENT-TYPE, never the status code. MEASURED 2026-08-18:
# `grep -rn 'text/javascript' scripts/` found no assertion anywhere. The one
# check whose whole premise is that a green is misleading had no coverage, for a
# failure that has happened twice (2026-08-02 live; the 2026-08-03 16-minute
# wedge that logged nothing).
S() { ( cd "$REPO" && BASE="$STUB" SHELL_CONVERGE_S=0 \
        OPENWOP_DEPLOY_PROJECT= OPENWOP_DEPLOY_REGION= \
        bash "$ROOT/scripts/verify-deploy.sh" "$NEW" >/dev/null 2>&1; echo $? ); }
set_live "$NEW"
printf '{"commit":"%s","stamped":true,"dirty":false}' "$NEW" > "$STUB_DIR/build-info.json"

shell_ref TESTAAAA
check "a shell whose bundle SERVES AS A MODULE passes" 0 "$(S)"
# ── ADR 0631 — the origin must serve the major-2 path space, not the shell ──
# Both polarities: the honest stub above passes every case that reaches here;
# a stub that answers the SPA shell to a request naming major 2 (production on
# 2026-09-05, 14 of 15 roots) must be REFUSED — a 200 is the lie here.
touch "$STUB_DIR/.v2-dishonest"
check "FAILS when the ORIGIN answers the SPA shell to a major-2 request on a manifest root (ADR 0631)" 1 "$(S)"
rm -f "$STUB_DIR/.v2-dishonest"
check "  ...and passes again once the origin routes the root to the backend" 0 "$(S)"

# THE REGRESSION. Hosting pruned the bundle the cached shell still names, so the
# asset URL falls through to the SPA rewrite. The STATUS is unhelpful (a real
# rewrite answers 200); only the content-type distinguishes it, which is why the
# runbook says never to assert the status. Here the stub answers 404 text/html —
# a different status, the SAME content-type — so a check keyed on status would
# pass this case in production and fail it here. Keyed on type, it fails both.
shell_ref PRUNED00
check "a shell naming a PRUNED bundle FAILS (content-type, not status)" 1 "$(S)"

# A shell with no bundle reference at all is a broken shell, not an absence of
# evidence. Treating "I could not find what I came to check" as a pass is the
# empty-plus-exit-0 mistake H90 removed one layer down.
printf '<!doctype html><p>no bundle here</p>' > "$STUB_DIR/index.html"
check "a shell with NO bundle reference FAILS (not skipped)" 1 "$(S)"

# --backend-only must not assert the frontend's shell, for the same reason it
# does not assert the frontend's commit: a half it deliberately did not deploy.
check "--backend-only does not red on a broken shell" 0 "$( ( cd "$REPO" && BASE="$STUB" SHELL_CONVERGE_S=0 \
        OPENWOP_DEPLOY_PROJECT= OPENWOP_DEPLOY_REGION= \
        bash "$ROOT/scripts/verify-deploy.sh" "$NEW" --backend-only >/dev/null 2>&1; echo $? ) )"

# The arm must use a BROWSER user-agent: a bare curl reads the UA-branched bot
# prerender, cached separately for an hour, so the default agent probes a
# different document than a visitor gets and would pass while `/` is down.
if grep -qE '^[^#]*UA=.*Mozilla' "$ROOT/scripts/verify-deploy.sh"; then
  ok "the shell arm sends a browser user-agent (not the bot prerender)"
else
  bad "the shell arm lost its browser user-agent — it now probes the bot prerender"
fi

# Restore for anything downstream.
shell_ref TESTAAAA

echo
echo "== deploy-gates: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
