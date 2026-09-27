#!/usr/bin/env bash
# domain-cert-commands (ADR 0295 follow-on) — generate (or run) the GCLB
# certificate-map commands for customer hostnames verified in the app's
# /domains page. The app side (ownership TXT verification, the org-pinned
# public-only host guard) is already live once a domain shows LIVE; this
# script automates the operator TLS half from DEPLOY.md § Custom domains.
#
# Usage:
#   bash scripts/domain-cert-commands.sh pages.acme.com shop.other.io   # print
#   RUN=1 bash scripts/domain-cert-commands.sh pages.acme.com           # execute
#
# Env: CERT_MAP (default owp-domains-map), PROJECT (default openwop-dev).
set -euo pipefail

CERT_MAP="${CERT_MAP:-owp-domains-map}"
PROJECT="${PROJECT:-openwop-dev}"
RUN="${RUN:-0}"

if [[ $# -eq 0 ]]; then
  echo "usage: [RUN=1] [CERT_MAP=map] [PROJECT=proj] $0 <hostname> [hostname...]" >&2
  echo "Hostnames come from the app's /domains page (status LIVE)." >&2
  exit 2
fi

emit() {
  if [[ "$RUN" = "1" ]]; then echo "+ $*"; "$@"; else echo "$*"; fi
}

# One-time (idempotent — errors if it already exists; safe to ignore):
emit gcloud certificate-manager maps create "$CERT_MAP" --project "$PROJECT" || true

for hostname in "$@"; do
  # slug for resource names: dots → dashes
  name="${hostname//./-}"
  emit gcloud certificate-manager certificates create "cert-${name}" \
    --domains="$hostname" --project "$PROJECT"
  emit gcloud certificate-manager maps entries create "entry-${name}" \
    --map="$CERT_MAP" --hostname="$hostname" \
    --certificates="cert-${name}" --project "$PROJECT"
  echo "# ${hostname}: point DNS at the LB IP; the managed cert provisions once DNS resolves."
done
