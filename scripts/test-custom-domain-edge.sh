#!/usr/bin/env bash
# Behavioural tests for scripts/custom-domain-edge.sh (ADR 0906 P3).
#
# Runs against a stub `gcloud` on PATH that keeps "resources" as files in a temp
# dir. Touches nothing real; no GCP call can happen because the real gcloud is
# never on PATH here.
#
#   bash scripts/test-custom-domain-edge.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/custom-domain-edge.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected $2, got $3)"; fi; }

mkdir -p "$TMP/bin" "$TMP/state"
export STUB_STATE="$TMP/state" STUB_LOG="$TMP/calls.log"
cat > "$TMP/bin/gcloud" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
args=("$@")
# resource key = the first two words + the name (third positional)
key="$(printf '%s_%s_%s' "${args[0]}" "${args[1]}" "${args[3]:-}" | tr '/ ' '__')"
verb="${args[2]:-}"
case "$*" in
  *"addresses describe"*"value(address)"*) [ -f "$STUB_STATE/${args[0]}_${args[1]}_${args[3]}" ] && echo 203.0.113.7 && exit 0; exit 1 ;;
  *"target-https-proxies describe"*"value(certificateMap)"*)
    [ -f "$STUB_STATE/${args[0]}_${args[1]}_${args[3]}" ] && echo "//certificatemanager.googleapis.com/projects/p/locations/global/certificateMaps/test-certmap"; exit 0 ;;
  *"forwarding-rules list"*) for f in "$STUB_STATE"/compute_forwarding-rules_*; do [ -f "$f" ] && echo "${f##*_}"; done; exit 0 ;;
  "run services describe"*) echo '{"spec":{"template":{"spec":{"containers":[{"env":[{"name":"OPENWOP_TRUSTED_PROXY_CIDRS","value":"198.51.100.0/24"}]}]}}}}'; exit 0 ;;
esac
case "$verb" in
  describe) [ -f "$STUB_STATE/$key" ] && exit 0; exit 1 ;;
  import) cat > "$STUB_STATE/redirect.yaml"; touch "$STUB_STATE/$key"; exit 0 ;;
  create) touch "$STUB_STATE/$key"; exit 0 ;;
  add-backend) exit 0 ;;
esac
exit 0
STUB
chmod +x "$TMP/bin/gcloud"
cat > "$TMP/update-env.sh" <<'UPD'
#!/usr/bin/env bash
echo "update-env $*" >> "$STUB_LOG"
UPD
cat > "$TMP/deploy.env" <<'ENVF'
OPENWOP_DEPLOY_SERVICE=svc
OPENWOP_DEPLOY_PROJECT=proj-x
OPENWOP_DEPLOY_REGION=us-central1
OPENWOP_DEPLOY_ACCOUNT=deployer@example.com
OPENWOP_CUSTOM_DOMAIN_CERT_MAP=test-certmap
ENVF
export PATH="$TMP/bin:$PATH" CUSTOM_DOMAIN_EDGE_ENV_FILE="$TMP/deploy.env" CUSTOM_DOMAIN_EDGE_UPDATE_ENV="$TMP/update-env.sh"
calls() { [ -f "$STUB_LOG" ] && grep -c "${1:-.}" "$STUB_LOG" || echo 0; }
reset() { rm -f "$STUB_LOG" "$STUB_STATE"/*; }

echo "custom-domain-edge.sh"

reset
out="$(bash "$SCRIPT" plan)"; rc=$?
check "plan exits 0" 0 "$rc"
check "plan runs NO gcloud" 0 "$(calls)"
case "$out" in *"forwarding-rules create owp-edge-https-fr"*"--project proj-x"*) ok "plan prints the pinned commands" ;; *) bad "plan output missing the HTTPS rule" ;; esac
check "no args means plan" 0 "$(bash "$SCRIPT" >/dev/null; calls)"

reset
grep -v CERT_MAP "$TMP/deploy.env" > "$TMP/nomap.env"
CUSTOM_DOMAIN_EDGE_ENV_FILE="$TMP/nomap.env" bash "$SCRIPT" plan >/dev/null 2>&1; rc=$?
check "no certificate map ⇒ refuses (no default map)" 1 "$rc"
check "the refusal runs no gcloud" 0 "$(calls)"

reset
bash "$SCRIPT" apply >/dev/null 2>&1; rc=$?
check "apply without confirmation refuses" 1 "$rc"
check "refused apply runs no gcloud" 0 "$(calls)"
OPENWOP_EDGE_APPLY_PROJECT=other-proj bash "$SCRIPT" apply >/dev/null 2>&1; rc=$?
check "apply confirmed for the WRONG project refuses" 1 "$rc"

reset
bash "$SCRIPT" verify >/dev/null 2>&1; rc=$?
check "verify on an empty project FAILS (empty listing is not all-clear)" 1 "$rc"

reset
OPENWOP_EDGE_APPLY_PROJECT=proj-x bash "$SCRIPT" apply >/dev/null 2>&1; rc=$?
check "apply creates the edge" 0 "$rc"
check "apply ran 10 creates/imports (one per resource)" 10 "$(grep -cE ' (create|import) ' "$STUB_LOG")"
check "the redirect map was imported from stdin" 1 "$(grep -c 'httpsRedirect: true' "$STUB_STATE/redirect.yaml" 2>/dev/null || echo 0)"
check "apply attached the NEG" 1 "$(calls 'add-backend owp-edge-backend')"
check "every gcloud call pins the project" 0 "$(grep -v '^update-env' "$STUB_LOG" | grep -vc -- '--project proj-x')"
check "trusted proxy appended, existing value kept" 1 "$(calls 'update-env OPENWOP_TRUSTED_PROXY_CIDRS=198.51.100.0/24,203.0.113.7/32')"
bash "$SCRIPT" verify >/dev/null 2>&1; rc=$?
check "verify passes once applied" 0 "$rc"

rm -f "$STUB_LOG"
OPENWOP_EDGE_APPLY_PROJECT=proj-x bash "$SCRIPT" apply >/dev/null 2>&1; rc=$?
check "a second apply succeeds" 0 "$rc"
check "a second apply creates nothing (idempotent)" 0 "$(grep -cE ' (create|import|add-backend) ' "$STUB_LOG")"

rm -f "$STUB_STATE"/compute_forwarding-rules_owp-edge-http-fr
bash "$SCRIPT" verify >/dev/null 2>&1; rc=$?
check "verify fails when one forwarding rule is missing" 1 "$rc"

reset
out="$(bash "$SCRIPT" host Pages.Example.COM.)"; rc=$?
check "host exits 0" 0 "$rc"
check "host runs no gcloud" 0 "$(calls)"
case "$out" in *"--domain=pages.example.com --type=PER_PROJECT_RECORD"*) ok "host prints a PER_PROJECT_RECORD DNS authorization" ;; *) bad "host output lacks PER_PROJECT_RECORD" ;; esac
case "$out" in *"owp-cd-"*"-cert --domains=pages.example.com --dns-authorizations="*) ok "host certificate uses DNS authorization" ;; *) bad "host certificate lacks --dns-authorizations" ;; esac

echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
