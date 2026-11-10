# shellcheck shell=bash
# The e2e lane's backend: ONE definition, used by scripts/ci.sh's e2e lane and by
# scripts/e2e-pinned-baselines.sh (ADR 0863 D9 P5), so a baseline is recorded
# against exactly the backend the gate checks it against. Needs ROOT; reads
# E2E_PORT_BE and E2E_PORT_FE. Sets E2E_PACK_DIR and E2E_BE_PID.
# The reasoning for each setting lives at the call site in scripts/ci.sh.

# e2e_backend_start: boot and wait for a real login-201. Returns 1 (after printing
# the backend log's tail and cleaning up) when it never becomes ready.
e2e_backend_start() {
  E2E_PACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/owp-e2e-packs.XXXXXX")"
  e2e_packs_mounted=0
  for p in "$ROOT"/packs/*/; do
    p="${p%/}"
    [ -f "$p/pack.json" ] || continue
    ln -s "$p" "$E2E_PACK_DIR/$(basename "$p")" 2>/dev/null && e2e_packs_mounted=$((e2e_packs_mounted + 1))
  done
  # Report the COUNT: zero means every pack-node path is about to fail for an
  # environmental reason, and that must be legible here, not inferred from red.
  echo "  packs: mounted $e2e_packs_mounted vendored pack(s) into $E2E_PACK_DIR (deterministic; not ~/.openwop-packs)"
  if [ "$e2e_packs_mounted" -eq 0 ]; then
    echo "error: no vendored packs under $ROOT/packs — the e2e backend would boot without node packs" >&2
    rm -rf "$E2E_PACK_DIR"
    return 1
  fi
  (
    cd "$ROOT/backend/typescript"
    OPENWOP_TEST_AUTH_ENABLED=true \
    OPENWOP_FEATURE_TOGGLES_DEV_OPEN=true \
    OPENWOP_DEMO_MODE=true \
    OPENWOP_STORAGE_DSN=memory:// \
    OPENWOP_MOUNT_LOCAL_PACKS=false \
    OPENWOP_PACK_DIR="$E2E_PACK_DIR" \
    OPENWOP_WORKFLOW_CHAIN_PACKS_DIR="$ROOT/frontend/react/e2e/fixtures/chain-packs" \
    OPENWOP_WORKFLOW_CHAIN_EXAMPLES=0 \
    OPENWOP_CORS_ORIGINS=http://localhost:"$E2E_PORT_FE" \
    OPENWOP_SESSION_SECRET=local-ci-session-secret-at-least-32-characters-long \
    PORT="$E2E_PORT_BE" node lib/index.js > /tmp/openwop-ci-e2e-backend.log 2>&1 &
    echo $! > /tmp/openwop-ci-e2e-backend.pid
  )
  E2E_BE_PID="$(cat /tmp/openwop-ci-e2e-backend.pid 2>/dev/null || true)"
  e2e_ready=0
  for _ in $(seq 1 45); do
    # If our own process died, stop waiting — otherwise we would keep probing and
    # could be answered by something else that appeared on the port meanwhile.
    if [ -n "$E2E_BE_PID" ] && ! kill -0 "$E2E_BE_PID" 2>/dev/null; then break; fi
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
      http://127.0.0.1:"$E2E_PORT_BE"/host/openwop-app/test/login \
      -H 'content-type: application/json' \
      -d '{"email":"ready@ci.local","tenantId":"ci-readiness"}' || true)
    if [ "$code" = "201" ]; then e2e_ready=1; break; fi
    sleep 2
  done
  if [ "$e2e_ready" != "1" ]; then
    echo "error: e2e backend never became ready on :$E2E_PORT_BE (last code: ${code:-none})" >&2
    tail -60 /tmp/openwop-ci-e2e-backend.log >&2 || true
    [ -n "$E2E_BE_PID" ] && kill "$E2E_BE_PID" 2>/dev/null || true
    rm -rf "$E2E_PACK_DIR"
    return 1
  fi
}

# e2e_backend_stop: ONLY our own PID (never a port sweep), then the pack dir.
e2e_backend_stop() {
  if [ -n "${E2E_BE_PID:-}" ]; then
    kill "$E2E_BE_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5; do kill -0 "$E2E_BE_PID" 2>/dev/null || break; sleep 1; done
    kill -0 "$E2E_BE_PID" 2>/dev/null && kill -9 "$E2E_BE_PID" 2>/dev/null || true
  fi
  rm -rf "${E2E_PACK_DIR:-}"
}
