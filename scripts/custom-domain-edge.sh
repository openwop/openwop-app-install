#!/usr/bin/env bash
# custom-domain-edge.sh (ADR 0906 D6): the ONE-TIME edge that serves customer
# hostnames, codified and operator-run.
#
#   scripts/custom-domain-edge.sh plan                 # print every command; runs NO gcloud (default)
#   OPENWOP_EDGE_APPLY_PROJECT=<project> \
#     scripts/custom-domain-edge.sh apply              # create what is missing (idempotent)
#   scripts/custom-domain-edge.sh verify               # assert every resource exists and is wired
#   scripts/custom-domain-edge.sh host <hostname>      # print the per-host commands (manual provider)
#   scripts/custom-domain-edge.sh repoint --service <cloud-run-service> --project <edge-project> \
#       [--region R] [--account A] [--apply]           # hand the edge to a deployment's own backend (ADR 0940)
#
# What the edge is: a global external Application Load Balancer in front of the
# existing Cloud Run service. One reserved global IP, a serverless NEG on the
# service, an EXTERNAL_MANAGED backend service, a URL map sending every host to
# it, a target HTTPS proxy holding a Certificate Manager map, an HTTP->HTTPS
# redirect, and the two forwarding rules (443 and 80).
#
# What it is NOT: per-domain certificates. With OPENWOP_CUSTOM_DOMAIN_EDGE=
# gcp-certificate-manager the app creates each domain's DNS authorization,
# certificate and map entry itself (ADR 0906 P1). With the default `manual`
# provider the operator runs `host <hostname>` for each verified domain.
#
# Costs money (ADR 0906 § Costs: roughly $18-25/month base plus egress). That is
# why `plan` is the default, and why `apply` needs OPENWOP_EDGE_APPLY_PROJECT set
# to the configured project, typed out, every time.
#
# Topology comes from scripts/deploy.env (OPENWOP_DEPLOY_PROJECT / _REGION /
# _SERVICE / _ACCOUNT), the same file deploy.sh and update-env.sh read. There is
# no default project: a script with ours baked in would ship our topology to
# every white-label adopter.
#
# Required, with no default (a wrong-but-plausible default would point this at
# someone else's project or map): OPENWOP_DEPLOY_PROJECT / _SERVICE / _ACCOUNT
# from deploy.env, and
#   OPENWOP_CUSTOM_DOMAIN_CERT_MAP   certificate map name, set explicitly (env or
#                                    deploy.env); the app reads the same variable
# Optional env:
#   OPENWOP_EDGE_PREFIX              resource-name prefix (default owp-edge)
#   CUSTOM_DOMAIN_EDGE_ENV_FILE      alternative deploy.env path (tests)
#   CUSTOM_DOMAIN_EDGE_UPDATE_ENV    alternative update-env.sh (tests)
#
# Cloud Run ingress is deliberately left at `all`: the Firebase Hosting /api
# rewrite still reaches the service on its run.app URL.
set -uo pipefail
set -f # gcloud args below are word-split on purpose; never glob them

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${CUSTOM_DOMAIN_EDGE_ENV_FILE:-$ROOT/scripts/deploy.env}"
die() { echo "custom-domain-edge: $*" >&2; exit 1; }

MODE="${1:-plan}"
case "$MODE" in
  plan|apply|verify) ;;
  host) [ -n "${2:-}" ] || { echo "usage: $0 host <hostname>" >&2; exit 2; } ;;
  repoint) ;;
  -h|--help) sed -n '2,39p' "$0" | sed 's/^#[[:space:]]\{0,1\}//'; exit 0 ;;
  *) echo "usage: $0 {plan|apply|verify|host <hostname>|repoint --service S --project P [--apply]}" >&2; exit 2 ;;
esac

# The same strict parser deploy.sh uses: KEY=VALUE lines only, never sourced.
if [ ! -f "$ENV_FILE" ] && [ "$MODE" != repoint ]; then die "$ENV_FILE not found (cp scripts/deploy.env.example scripts/deploy.env)"; fi
[ -f "$ENV_FILE" ] && while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in *=*) : ;; *) continue ;; esac
  key="${line%%=*}"; val="${line#*=}"
  key="${key#"${key%%[![:space:]]*}"}"; key="${key%"${key##*[![:space:]]}"}"
  case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
  case "$val" in \"*\") val="${val#\"}"; val="${val%\"}" ;; "'"*"'") val="${val#\'}"; val="${val%\'}" ;; esac
  # The process environment wins over the file, so a test or a one-off can override.
  [ -n "${!key:-}" ] || export "$key=$val"
done < "$ENV_FILE"

# ── repoint: hand the edge's URL-map default to a deployment's own backend (ADR 0940) ──
# Each deployment owns its edge. This creates a serverless NEG + backend service
# for <service> in the EDGE's own project and makes it the URL map's default.
# Dry-run by default: it reads (describe/export) and prints, and mutates nothing.
# The URL-map mutation is a fingerprint-conditional PATCH after exact target
# wiring validation. The previous backend remains. An owned conditional rollback
# receipt is issued only after operation completion and full configuration read-back.
if [ "$MODE" = repoint ]; then
  shift
  exec python3 "$ROOT/scripts/lib/custom-domain-repoint.py" "$@"
fi

for v in OPENWOP_DEPLOY_SERVICE OPENWOP_DEPLOY_PROJECT OPENWOP_DEPLOY_ACCOUNT; do
  [ -n "${!v:-}" ] || die "$v is not set in $ENV_FILE"
done

PROJECT="$OPENWOP_DEPLOY_PROJECT"
REGION="${OPENWOP_DEPLOY_REGION:-us-central1}"
SERVICE="$OPENWOP_DEPLOY_SERVICE"
PREFIX="${OPENWOP_EDGE_PREFIX:-owp-edge}"
case "$PREFIX" in ''|*[!a-z0-9-]*) die "OPENWOP_EDGE_PREFIX must be lowercase letters, digits and dashes" ;; esac
CERT_MAP="${OPENWOP_CUSTOM_DOMAIN_CERT_MAP:-}"
[ -n "$CERT_MAP" ] || die "OPENWOP_CUSTOM_DOMAIN_CERT_MAP is required (no default): name the certificate map explicitly"
case "$CERT_MAP" in [a-z]*) ;; *) die "OPENWOP_CUSTOM_DOMAIN_CERT_MAP must be a Certificate Manager map id" ;; esac
case "$CERT_MAP" in *[!a-z0-9-]*) die "OPENWOP_CUSTOM_DOMAIN_CERT_MAP must be a Certificate Manager map id" ;; esac
IP="$PREFIX-ip"; NEG="$PREFIX-neg"; BE="$PREFIX-backend"; URLMAP="$PREFIX-urlmap"
REDIRECT="$PREFIX-http-redirect"; HTTPS_PROXY="$PREFIX-https-proxy"; HTTP_PROXY="$PREFIX-http-proxy"
FR_HTTPS="$PREFIX-https-fr"; FR_HTTP="$PREFIX-http-fr"
G=(--project "$PROJECT" --account "$OPENWOP_DEPLOY_ACCOUNT")

# ── host: the per-domain recipe for the `manual` provider (print only) ──────────
if [ "$MODE" = host ]; then
  h="$(printf '%s' "$2" | tr 'A-Z' 'a-z')"; h="${h%.}"
  # Same deterministic ids the app's gcp-certificate-manager adapter uses (ADR 0906 D4).
  id="owp-cd-$(printf '%s' "$h" | shasum -a 256 | cut -c1-20)"
  cat <<EOF
# ${h}: run AFTER the domain shows ownership VERIFIED in the app.
# DNS authorization (PER_PROJECT_RECORD: does not need to own _acme-challenge.${h}):
gcloud certificate-manager dns-authorizations create ${id}-auth --domain=${h} --type=PER_PROJECT_RECORD ${G[*]}
gcloud certificate-manager dns-authorizations describe ${id}-auth --format='value(dnsResourceRecord)' ${G[*]}
#   -> the customer adds that CNAME; the certificate can go ACTIVE before traffic moves.
gcloud certificate-manager certificates create ${id}-cert --domains=${h} --dns-authorizations=${id}-auth ${G[*]}
gcloud certificate-manager maps entries create ${id}-entry --map=${CERT_MAP} --hostname=${h} --certificates=${id}-cert ${G[*]}
# Routing record: subdomain -> CNAME to the edge hostname; apex -> A to the LB IP
# (never a CNAME at the apex).
EOF
  exit 0
fi

# ── the resource list: name, describe command, create commands ──────────────────
# Each entry: "<label>|<describe args>|<create args>[|<more create args>]".
# Create args are run in order; a second command extends the first (add-backend).
REDIRECT_YAML="name: $REDIRECT
defaultUrlRedirect:
  httpsRedirect: true
  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT"

RESOURCES=(
  "global IP|compute addresses describe $IP --global|compute addresses create $IP --global --ip-version=IPV4"
  "serverless NEG|compute network-endpoint-groups describe $NEG --region=$REGION|compute network-endpoint-groups create $NEG --region=$REGION --network-endpoint-type=serverless --cloud-run-service=$SERVICE"
  "backend service|compute backend-services describe $BE --global|compute backend-services create $BE --global --load-balancing-scheme=EXTERNAL_MANAGED|compute backend-services add-backend $BE --global --network-endpoint-group=$NEG --network-endpoint-group-region=$REGION"
  "certificate map|certificate-manager maps describe $CERT_MAP|certificate-manager maps create $CERT_MAP"
  "URL map|compute url-maps describe $URLMAP --global|compute url-maps create $URLMAP --global --default-service=$BE"
  "target HTTPS proxy|compute target-https-proxies describe $HTTPS_PROXY --global|compute target-https-proxies create $HTTPS_PROXY --global --url-map=$URLMAP --certificate-map=$CERT_MAP"
  "HTTPS forwarding rule|compute forwarding-rules describe $FR_HTTPS --global|compute forwarding-rules create $FR_HTTPS --global --load-balancing-scheme=EXTERNAL_MANAGED --target-https-proxy=$HTTPS_PROXY --address=$IP --ports=443"
  "HTTP redirect map|compute url-maps describe $REDIRECT --global|compute url-maps import $REDIRECT --global --quiet"
  "target HTTP proxy|compute target-http-proxies describe $HTTP_PROXY --global|compute target-http-proxies create $HTTP_PROXY --global --url-map=$REDIRECT"
  "HTTP forwarding rule|compute forwarding-rules describe $FR_HTTP --global|compute forwarding-rules create $FR_HTTP --global --load-balancing-scheme=EXTERNAL_MANAGED --target-http-proxy=$HTTP_PROXY --address=$IP --ports=80"
)

gc() { # gc <args as one string> [stdin]: run gcloud with the project/account pinned
  # shellcheck disable=SC2086
  if [ "$#" -gt 1 ]; then printf '%s\n' "$2" | gcloud $1 "${G[@]}"; else gcloud $1 "${G[@]}"; fi
}

# ── plan: print, run nothing ──────────────────────────────────────────────────────
if [ "$MODE" = plan ]; then
  echo "# custom-domain edge plan: project=$PROJECT region=$REGION service=$SERVICE prefix=$PREFIX map=$CERT_MAP"
  echo "# apply runs each create ONLY when its describe fails (idempotent)."
  for r in "${RESOURCES[@]}"; do
    label="${r%%|*}"
    echo "# $label"
    rest="${r#*|}"; rest="${rest#*|}"
    while [ -n "$rest" ]; do
      cmd="${rest%%|*}"; echo "gcloud $cmd ${G[*]}"
      [ "$rest" = "$cmd" ] && break; rest="${rest#*|}"
    done
    case "$label" in "HTTP redirect map") printf '#   with stdin:\n%s\n' "$REDIRECT_YAML" | sed 's/^/#   /' ;; esac
  done
  echo "# trusted proxy: append <reserved IP>/32 to OPENWOP_TRUSTED_PROXY_CIDRS via scripts/update-env.sh"
  echo "#   (the LB appends its forwarding-rule IP to X-Forwarded-For; ADR 0851 already trusts the GFE ranges)"
  echo "# then: OPENWOP_CUSTOM_DOMAIN_CERT_MAP=$CERT_MAP and OPENWOP_CUSTOM_DOMAIN_LB_IP=<reserved IP> for the app (ADR 0906 P1)"
  exit 0
fi

# ── apply: create what is missing ─────────────────────────────────────────────────
if [ "$MODE" = apply ]; then
  [ "${OPENWOP_EDGE_APPLY_PROJECT:-}" = "$PROJECT" ] \
    || die "apply creates billable resources in $PROJECT. Re-run with OPENWOP_EDGE_APPLY_PROJECT=$PROJECT to confirm."
  for r in "${RESOURCES[@]}"; do
    IFS='|' read -r label describe _ <<<"$r"
    if gc "$describe" >/dev/null 2>&1; then echo "= $label exists"; continue; fi
    echo "+ $label"
    rest="${r#*|}"; rest="${rest#*|}"
    while [ -n "$rest" ]; do
      cmd="${rest%%|*}"
      if [ "$label" = "HTTP redirect map" ]; then gc "$cmd" "$REDIRECT_YAML" || die "failed: gcloud $cmd"
      else gc "$cmd" || die "failed: gcloud $cmd"; fi
      [ "$rest" = "$cmd" ] && break; rest="${rest#*|}"
    done
  done
  ip_addr="$(gc "compute addresses describe $IP --global --format=value(address)")" || die "could not read the reserved IP"
  [ -n "$ip_addr" ] || die "the reserved IP $IP has no address"
  current="$(gcloud run services describe "$SERVICE" --region "$REGION" "${G[@]}" --format=json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const e=(JSON.parse(s).spec.template.spec.containers[0].env||[]).find(x=>x.name==="OPENWOP_TRUSTED_PROXY_CIDRS");process.stdout.write(e&&e.value||"")}catch{process.exit(1)}})')" \
    || die "could not read the service env (gcloud run services describe)"
  case ",$current," in
    *",$ip_addr/32,"*) echo "= trusted proxy $ip_addr/32 already set" ;;
    *) next="${current:+$current,}$ip_addr/32"
       echo "+ trusted proxy: OPENWOP_TRUSTED_PROXY_CIDRS=$next"
       UPDATE_ENV_ENV_FILE="$ENV_FILE" bash "${CUSTOM_DOMAIN_EDGE_UPDATE_ENV:-$ROOT/scripts/update-env.sh}" "OPENWOP_TRUSTED_PROXY_CIDRS=$next" \
         || die "update-env.sh failed; the edge exists but callers behind it share one rate-limit key until this is set" ;;
  esac
  echo "edge applied. Reserved IP: $ip_addr. Next: scripts/custom-domain-edge.sh verify"
  exit 0
fi

# ── verify: every resource exists and is wired; an empty listing is a FAILURE ────
fail=0
for r in "${RESOURCES[@]}"; do
  IFS='|' read -r label describe _ <<<"$r"
  if gc "$describe" >/dev/null 2>&1; then echo "ok   $label"; else echo "MISS $label"; fail=1; fi
done
attached="$(gc "compute target-https-proxies describe $HTTPS_PROXY --global --format=value(certificateMap)" 2>/dev/null || true)"
case "$attached" in
  *"/certificateMaps/$CERT_MAP"|"$CERT_MAP") echo "ok   certificate map attached to $HTTPS_PROXY" ;;
  *) echo "MISS certificate map $CERT_MAP is not attached to $HTTPS_PROXY (got: ${attached:-nothing})"; fail=1 ;;
esac
# Empty plus exit 0 means the QUERY is wrong (CLAUDE.md, H90), never "all clear".
rules="$(gc "compute forwarding-rules list --global --filter=name~^$PREFIX- --format=value(name)" 2>/dev/null || true)"
count="$(printf '%s' "$rules" | grep -c . || true)"
if [ "${count:-0}" -ge 2 ]; then echo "ok   $count forwarding rules under $PREFIX-"
else echo "MISS forwarding-rule listing returned ${count:-0} rows (expected 2); an empty listing is a failure"; fail=1; fi
if [ "${OPENWOP_TRUSTED_PROXY_DEFAULTS:-}" = private ]; then
  echo "WARN OPENWOP_TRUSTED_PROXY_DEFAULTS=private in $ENV_FILE: the GFE ranges are not trusted, so add them too"
fi
[ "$fail" -eq 0 ] && echo "edge verified" || echo "edge NOT verified"
exit "$fail"
