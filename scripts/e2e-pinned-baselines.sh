#!/usr/bin/env bash
# ADR 0863 D9 P5 — record the `-pinned` visual baselines: the two visual specs,
# rendered by the browser of the version-pinned Playwright image (by digest,
# frontend/react/e2e/pinned-browser.json) through its run-server, against the
# same e2e backend the gate boots (scripts/lib/e2e-backend.sh). NOT part of any
# gate: it WRITES baselines, which a person reviews before they are committed.
#
#   scripts/e2e-pinned-baselines.sh [--record-version] [REVIEW_DIR]
#
# Writes e2e/*-snapshots/*-pinned.png and e2e/pinned-baselines.lock.json (checked by
# scripts/check-pinned-baselines.mjs in every gate) in this checkout, and REVIEW_DIR/index.html,
# a side-by-side sheet (darwin | pinned) for the review. Needs Docker and a built
# backend (backend/typescript/lib/index.js). --record-version writes the connected
# browser's version into pinned-browser.json (first use, or after a pin change).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FE="$ROOT/frontend/react"
RECORD=0; [ "${1:-}" = --record-version ] && { RECORD=1; shift; }
REVIEW_DIR="${1:-$(mktemp -d "${TMPDIR:-/tmp}/pinned-baselines.XXXXXX")}"
mkdir -p "$REVIEW_DIR"
pin() { node -e "process.stdout.write(String(require('$FE/e2e/pinned-browser.json')['$1']))"; }
IMAGE="$(pin image)"; DIGEST="$(pin digest)"; PW="$(pin playwright)"
[ -f "$ROOT/backend/typescript/lib/index.js" ] || { echo "build the backend first (npm --prefix backend/typescript run build)" >&2; exit 2; }
command -v docker >/dev/null || { echo "Docker is required" >&2; exit 2; }

. "$ROOT/scripts/lib/gate-ports.sh"
E2E_PORT_BE="$(gate_pick_free_port 8080)"; E2E_PORT_FE="$(gate_pick_free_port 5173)"; PW_PORT="$(gate_pick_free_port 3200)"
NAME="owci-pinned-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; e2e_backend_stop 2>/dev/null || true; }
trap cleanup EXIT
. "$ROOT/scripts/lib/e2e-backend.sh"

echo "▶ pinned renderer: ${IMAGE%%:*}@$DIGEST (Playwright $PW), amd64"
docker run -d --rm --name "$NAME" --platform linux/amd64 --init -p "127.0.0.1:$PW_PORT:3000" "${IMAGE%%:*}@$DIGEST" \
  /bin/sh -c "cd /tmp && npx -y playwright@$PW run-server --port 3000 --host 0.0.0.0" >/dev/null
for _ in $(seq 1 150); do docker logs "$NAME" 2>&1 | grep -qi listening && break; sleep 2; done
docker logs "$NAME" 2>&1 | grep -qi listening || { echo "the pinned run-server never listened" >&2; docker logs "$NAME" | tail -5 >&2; exit 1; }
# Only the visual specs connect to it (test.use, e2e/support/visualGuard.ts).
export OPENWOP_E2E_PINNED_WS="ws://127.0.0.1:$PW_PORT/"

GOT="$(cd "$FE" && node -e "
  const { chromium } = require('@playwright/test');
  chromium.connect(process.env.OPENWOP_E2E_PINNED_WS).then(async b => { process.stdout.write(b.version()); await b.close(); });")"
echo "  connected browser: $GOT"
if [ "$RECORD" = 1 ]; then
  node -e "const f='$FE/e2e/pinned-browser.json';const j=require(f);j.browserVersion='$GOT';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
  echo "  recorded browserVersion=$GOT in e2e/pinned-browser.json"
elif [ "$GOT" != "$(pin browserVersion)" ]; then
  echo "the connected browser ($GOT) is not the pinned $(pin browserVersion); rerun with --record-version only for a deliberate pin change" >&2; exit 1
fi

echo "▶ e2e backend on :$E2E_PORT_BE"
e2e_backend_start || exit 1
echo "▶ recording -pinned baselines (design-system, route-snapshots)"
( cd "$FE" && OPENWOP_E2E_PORT="$E2E_PORT_FE" OPENWOP_DEV_PROXY_TARGET="http://localhost:$E2E_PORT_BE" \
    VITE_OPENWOP_BASE_URL="/api" VITE_OPENWOP_SSE_BASE_URL="http://localhost:$E2E_PORT_BE" \
    npx playwright test e2e/design-system.spec.ts e2e/route-snapshots.spec.ts \
      --update-snapshots --workers=1 --reporter=list --output="$REVIEW_DIR/test-results" ) || rc=$?

# The lock: which -darwin image each -pinned one was rendered beside (sha256), checked
# by scripts/check-pinned-baselines.mjs in every gate. Written only on a clean recording.
if [ "${rc:-0}" = 0 ]; then node "$ROOT/scripts/check-pinned-baselines.mjs" --write; fi

# Review sheet: every -pinned baseline beside its -darwin counterpart.
node -e "
  const fs=require('fs'),path=require('path');const e2e='$FE/e2e';const rows=[];
  for (const d of fs.readdirSync(e2e).filter(n=>n.endsWith('-snapshots')))
    for (const f of fs.readdirSync(path.join(e2e,d)).filter(n=>n.endsWith('-pinned.png')).sort()) {
      const mac=f.replace('-pinned.png','-darwin.png');const img=n=>fs.existsSync(path.join(e2e,d,n))?'<img src=\"data:image/png;base64,'+fs.readFileSync(path.join(e2e,d,n)).toString('base64')+'\">':'<em>none</em>';
      rows.push('<tr><td><b>'+d+'/'+f.replace('-chromium-pinned.png','')+'</b><br>'+img(mac)+'</td><td><br>'+img(f)+'</td></tr>');
    }
  fs.writeFileSync('$REVIEW_DIR/index.html','<!doctype html><meta charset=utf-8><title>Pinned baselines review</title><style>body{font:14px system-ui;margin:16px}td{vertical-align:top;padding:8px;border-top:1px solid #ccc}img{max-width:46vw;border:1px solid #ddd}</style><h1>darwin | pinned</h1><p>'+rows.length+' baselines</p><table>'+rows.join('')+'</table>');
  console.log('review sheet: $REVIEW_DIR/index.html ('+rows.length+' baselines)');"
exit "${rc:-0}"
