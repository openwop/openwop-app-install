#!/usr/bin/env bash
# Cut, verify and PUBLISH the signed post-deploy certification evidence for the
# revision that is serving right now (WHD-18, ADR 0735 decision 2).
#
# WHAT IT DOES, in order — and stops at the first thing that is not true:
#   1. reads the SERVING commit from $BASE/api/readiness (full 40-hex);
#   2. refuses unless that commit is origin/main's tip (--allow-any-commit);
#   3. fetches the bundle-signing key from Secret Manager into a 0600 temp file
#      (never printed; deleted on exit) and proves its public half is the key
#      the live host publishes under OPENWOP_BUNDLE_SIGNING_KEY_ID;
#   4. fetches the conformance client key(s) from the host's api-key binding;
#   5. starts a cloudflared quick tunnel for the suite's webhook receiver (the
#      ADR 0735 run-side remedy — NEVER relax the SSRF guard instead);
#   6. per major (2, then 1): runs the suite CLI against the deployed origin with
#      --bundle-version 3 --require-behavior, signed; verifies the bundle with the
#      suite's --verify under the LIVE key AND with the host's own serving rules;
#      uploads it to <OPENWOP_CERT_BUNDLE_ORIGIN>/<commit>/major-<m>.json;
#   7. deletes every webhook subscription the run left in the conformance tenant
#      and reports the counts before/after;
#   8. polls the served pointer until the host serves the uploaded bytes
#      (sha256 equal), or reports that it has not yet.
#
# NOT wired into deploy.sh: it is an operator step, run AFTER a deploy has been
# verified. It writes to a production bucket and runs a ~10-minute load against
# the live service; neither belongs inside the deploy's critical path.
#
# Config comes from scripts/deploy.env (the same strict KEY=VALUE parser as
# deploy.sh). Required there:
#   BASE, OPENWOP_DEPLOY_PROJECT, OPENWOP_DEPLOY_ACCOUNT,
#   OPENWOP_CERT_BUNDLE_ORIGIN   gs://<bucket>/<prefix> — the SAME value the service has
#   OPENWOP_BUNDLE_SIGNING_KEY_ID the keyId the host publishes for the signing key
# Optional:
#   OPENWOP_BUNDLE_SIGNING_KEY_SECRET  (default openwop-app-bundle-signing-key)
#   OPENWOP_CONFORMANCE_KEY_SECRET     (default openwop-conformance-api-key)
#   OPENWOP_CONFORMANCE_BIN            (default backend/typescript/node_modules/.bin/openwop-conformance)
#
# Usage:
#   scripts/publish-evidence.sh                    # both majors, 2 then 1
#   scripts/publish-evidence.sh --major 2          # one major (repeatable)
#   scripts/publish-evidence.sh --allow-any-commit # the live commit is not origin/main's tip
#   scripts/publish-evidence.sh --print-config     # parse + print the plan; touch nothing
#   scripts/publish-evidence.sh --max-workers 1    # suite concurrency (default 1 — a CERTIFICATION cut MUST run single-worker)

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${PUBLISH_EVIDENCE_ENV_FILE:-$ROOT/scripts/deploy.env}"
HELPERS="$ROOT/scripts/lib/publish-evidence-helpers.mjs"
VERIFY="$ROOT/scripts/lib/bundle-v3-verify.mjs"
OPTOUTS="$ROOT/scripts/lib/conformance-opt-outs.mjs"

die() { echo "publish-evidence: $*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in -h|--help) sed -n '2,45p' "$0" | sed 's/^#[[:space:]]\{0,1\}//'; exit 0 ;; esac
done

# ── arguments ────────────────────────────────────────────────────────────────
# MAX_WORKERS defaults to 1 (2026-09-25). It was 2 ("it is a load test"), but the
# suite's pinned fixture ports (webhook receiver, effect receiver, front-mux) are
# owned by ONE worker process, and its per-process routing registry is by design:
# a certification cut MUST run `--max-workers 1` (conformance effect-receiver.ts;
# the corpus cut-bundle.sh passes it). At 2, a scenario in the other worker
# registered a nonce nobody served — MEASURED: 0173 durable-delivery and 0187
# webhook-emitted timed out on every prod cut while the host retried correctly.
ALLOW_ANY_COMMIT=0; PRINT_CONFIG=0; MAX_WORKERS=1; MAJORS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --allow-any-commit) ALLOW_ANY_COMMIT=1 ;;
    --print-config) PRINT_CONFIG=1 ;;
    --major)
      [ $# -ge 2 ] || { echo "publish-evidence: --major needs 1 or 2" >&2; exit 2; }
      case "$2" in 1|2) MAJORS+=("$2") ;; *) echo "publish-evidence: --major must be 1 or 2 (got $2)" >&2; exit 2 ;; esac
      shift ;;
    --max-workers)
      [ $# -ge 2 ] && [[ "$2" =~ ^[1-9][0-9]*$ ]] || { echo "publish-evidence: --max-workers needs a positive integer" >&2; exit 2; }
      MAX_WORKERS="$2"; shift ;;
    *) echo "publish-evidence: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
# Major 2 FIRST: it is the evidence the corpus declaration waits on, and a run
# that fails partway should have produced the one that matters most.
[ ${#MAJORS[@]} -gt 0 ] || MAJORS=(2 1)

# ── config (strict parse, never `source` — same reasoning as deploy.sh) ─────
[ -f "$ENV_FILE" ] || { echo "publish-evidence: $ENV_FILE not found (cp scripts/deploy.env.example scripts/deploy.env)" >&2; exit 2; }
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in *=*) : ;; *) continue ;; esac
  key="${line%%=*}"; val="${line#*=}"
  key="${key#"${key%%[![:space:]]*}"}"; key="${key%"${key##*[![:space:]]}"}"
  case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
  case "$val" in \"*\") val="${val#\"}"; val="${val%\"}" ;; "'"*"'") val="${val#\'}"; val="${val%\'}" ;; esac
  export "$key=$val"
done < "$ENV_FILE"

missing=()
for v in BASE OPENWOP_DEPLOY_PROJECT OPENWOP_DEPLOY_ACCOUNT OPENWOP_CERT_BUNDLE_ORIGIN OPENWOP_BUNDLE_SIGNING_KEY_ID; do
  [ -n "${!v:-}" ] || missing+=("$v")
done
(( ${#missing[@]} )) && { echo "publish-evidence: unset in $ENV_FILE: ${missing[*]}" >&2; exit 2; }
[[ "$OPENWOP_CERT_BUNDLE_ORIGIN" =~ ^gs://[a-z0-9][a-z0-9._-]+[a-z0-9](/.*)?$ ]] \
  || { echo "publish-evidence: OPENWOP_CERT_BUNDLE_ORIGIN must be gs://<bucket>[/<prefix>] (got $OPENWOP_CERT_BUNDLE_ORIGIN)" >&2; exit 2; }
ORIGIN="${OPENWOP_CERT_BUNDLE_ORIGIN%/}"
BASE="${BASE%/}"
SIGNING_SECRET="${OPENWOP_BUNDLE_SIGNING_KEY_SECRET:-openwop-app-bundle-signing-key}"
CONF_SECRET="${OPENWOP_CONFORMANCE_KEY_SECRET:-openwop-conformance-api-key}"
BIN="${OPENWOP_CONFORMANCE_BIN:-$ROOT/backend/typescript/node_modules/.bin/openwop-conformance}"
GC=(--project "$OPENWOP_DEPLOY_PROJECT" --account "$OPENWOP_DEPLOY_ACCOUNT")

if [ "$PRINT_CONFIG" -eq 1 ]; then
  # The whole plan, from the parsed inputs alone — no network, no secrets.
  echo "base=$BASE"
  echo "origin=$ORIGIN"
  echo "majors=${MAJORS[*]}"
  echo "max_workers=$MAX_WORKERS"
  echo "allow_any_commit=$ALLOW_ANY_COMMIT"
  echo "signing_key_id=$OPENWOP_BUNDLE_SIGNING_KEY_ID"
  echo "signing_secret=$SIGNING_SECRET"
  echo "conformance_secret=$CONF_SECRET"
  for m in "${MAJORS[@]}"; do echo "object[$m]=$ORIGIN/<serving-commit>/major-$m.json"; done
  exit 0
fi

for tool in node gcloud cloudflared curl git; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not on PATH"
done
[ -x "$BIN" ] || die "suite CLI not found at $BIN — run 'npx -y npm@10.9.8 ci' in backend/typescript, or set OPENWOP_CONFORMANCE_BIN"

# ── scratch space: 0600 files, removed on ANY exit, tunnel killed ────────────
umask 077
WORK="$(mktemp -d)"
TUNNEL_PID=""
LOW_SCOPE_KEY_ID=""
cleanup() {
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
  # The low-scope key minted for the cut is revoked on ANY exit (it also carries a
  # 2 h expiry, so a hard kill leaves nothing usable for long).
  if [ -n "$LOW_SCOPE_KEY_ID" ]; then
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X DELETE -H "Authorization: Bearer $OPENWOP_API_KEY" "$BASE/api/host/openwop-app/developer-keys/$LOW_SCOPE_KEY_ID" || true)"
    echo "low-scope key revoked: $code"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# ── 1–2. which revision is serving, and is it the one we mean? ───────────────
curl -sS --connect-timeout 5 --max-time 20 "$BASE/api/readiness?cb=$(date +%s%N)" > "$WORK/readiness.json" \
  || die "could not read $BASE/api/readiness"
COMMIT="$(node "$HELPERS" discovery-field build.commit < "$WORK/readiness.json")" || die "/api/readiness carries no build.commit"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "the serving commit is '$COMMIT', not a full sha — an unstamped deploy has no key to publish under"
git -C "$ROOT" fetch -q origin main || die "git fetch origin failed"
TIP="$(git -C "$ROOT" rev-parse origin/main)"
if [ "$COMMIT" != "$TIP" ] && [ "$ALLOW_ANY_COMMIT" -eq 0 ]; then
  die "the serving commit ${COMMIT:0:12} is not origin/main's tip ${TIP:0:12}. Evidence is published for what is SERVING; if that is really what you want, pass --allow-any-commit."
fi
echo "serving: ${COMMIT:0:12}  (origin/main ${TIP:0:12})"

curl -sS --max-time 20 "$BASE/.well-known/openwop?cb=$(date +%s%N)" > "$WORK/discovery.json" || die "could not read discovery"
IMPL_NAME="$(node "$HELPERS" discovery-field implementation.name < "$WORK/discovery.json")" || IMPL_NAME="openwop-workflow-engine"
IMPL_VERSION="$(node "$HELPERS" discovery-field implementation.version < "$WORK/discovery.json")" || IMPL_VERSION="0.0.0"

# ── 3. the signing key (never printed) ──────────────────────────────────────
gcloud secrets versions access latest --secret="$SIGNING_SECRET" "${GC[@]}" > "$WORK/signing.pem" 2>"$WORK/gcloud.err" \
  || die "could not read secret $SIGNING_SECRET ($(head -1 "$WORK/gcloud.err"))"
node "$HELPERS" key-matches "$OPENWOP_BUNDLE_SIGNING_KEY_ID" "$WORK/signing.pem" < "$WORK/discovery.json" \
  || die "refusing to cut: the signing key does not match what the host publishes (see above)"
PUB="$(node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const k=(d.signingKeys||[]).find(x=>x.keyId===process.argv[1]);process.stdout.write(k.publicKey)' "$OPENWOP_BUNDLE_SIGNING_KEY_ID" < "$WORK/discovery.json")"
node "$VERIFY" --pem "$PUB" > "$WORK/host.pem"

# ── 4. the conformance client key(s) ────────────────────────────────────────
gcloud secrets versions access latest --secret="$CONF_SECRET" "${GC[@]}" > "$WORK/binding" 2>"$WORK/gcloud.err" \
  || die "could not read secret $CONF_SECRET ($(head -1 "$WORK/gcloud.err"))"
node "$HELPERS" client-keys < "$WORK/binding" > "$WORK/client-keys" || die "the api-key binding in $CONF_SECRET holds no key"
OPENWOP_API_KEY="$(sed -n 1p "$WORK/client-keys")"; export OPENWOP_API_KEY
SECONDARY="$(sed -n 2p "$WORK/client-keys")"
if [ -n "$SECONDARY" ]; then export OPENWOP_TEST_SECONDARY_API_KEY="$SECONDARY"; else echo "note: no second key in the binding — cross-tenant legs will record their own disposition"; fi
# The suite's cross-tenant legs read TENANT_B, not SECONDARY (10 scenario files);
# exported only when the binding's two keys are on DIFFERENT tenants — see
# tenantBKeyFromBinding. Never printed.
if TENANT_B_KEY="$(node "$HELPERS" tenant-b-key < "$WORK/binding" 2>/dev/null)" && [ -n "$TENANT_B_KEY" ]; then
  export OPENWOP_TEST_TENANT_B_API_KEY="$TENANT_B_KEY"
  echo "tenant-B: set (the binding's second key is on a different tenant)"
else
  echo "note: no second key on a DIFFERENT tenant — tenant-B legs will record blocked"
fi

# The low-scope Subject (0200.challenge-403-scope, the approvals:respond leg of
# interrupt-auth-required-resume): a SHORT-LIVED `runs:read`-only owk_ key, minted
# through the production developer-keys route in the conformance key's own tenant,
# revoked in `cleanup`. Never printed.
EXPIRES="$(node -e 'process.stdout.write(new Date(Date.now()+2*3600e3).toISOString())')"
if curl -sS --max-time 20 -X POST -H "Authorization: Bearer $OPENWOP_API_KEY" -H 'content-type: application/json' \
     -d "{\"name\":\"conformance low-scope (runs:read, evidence cut)\",\"scopes\":[\"runs:read\"],\"expiresAt\":\"$EXPIRES\"}" \
     "$BASE/api/host/openwop-app/developer-keys" > "$WORK/lowscope.json" \
   && LOW_SCOPE_KEY_ID="$(node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write((j.key&&j.key.keyId)||"")' < "$WORK/lowscope.json")" \
   && [ -n "$LOW_SCOPE_KEY_ID" ]; then
  OPENWOP_TEST_LOW_SCOPE_KEY="$(node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(j.token||"")' < "$WORK/lowscope.json")"
  export OPENWOP_TEST_LOW_SCOPE_KEY
  echo "low-scope key: minted (runs:read, expires $EXPIRES)"
else
  echo "note: could not mint a low-scope key — its legs will record blocked"
fi

webhook_ids() {
  curl -sS --max-time 20 -H "Authorization: Bearer $OPENWOP_API_KEY" "$BASE/api/v1/webhooks" > "$WORK/webhooks.json" || return 1
  node "$HELPERS" webhook-ids < "$WORK/webhooks.json"
}
BEFORE="$(webhook_ids)" || die "could not list webhook subscriptions (is the client key valid?)"
BEFORE_N="$(printf '%s' "$BEFORE" | grep -c .)"

# ── 5. the tunnel ───────────────────────────────────────────────────────────
PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"
cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" > "$WORK/tunnel.log" 2>&1 &
TUNNEL_PID=$!
TUNNEL_URL=""
for _ in $(seq 1 60); do
  TUNNEL_URL="$(node "$HELPERS" tunnel-url < "$WORK/tunnel.log" 2>/dev/null)" && break
  kill -0 "$TUNNEL_PID" 2>/dev/null || die "cloudflared exited: $(tail -3 "$WORK/tunnel.log")"
  sleep 1
done
[ -n "$TUNNEL_URL" ] || die "cloudflared printed no trycloudflare URL within 60s"
export OPENWOP_WEBHOOK_RECEIVER_PORT="$PORT" OPENWOP_WEBHOOK_RECEIVER_URL="$TUNNEL_URL"
export OPENWOP_IMPLEMENTATION_NAME="$IMPL_NAME" OPENWOP_IMPLEMENTATION_VERSION="$IMPL_VERSION"
# A quick tunnel's URL appears before its DNS + edge route are live. MEASURED on the
# 0f9c447c8 cut: every tunnel-borne row (0173 durable delivery, 0201 rotation) saw
# NOTHING reach the listener, while the same rows passed on the cut before. Settle,
# then require the edge to answer SOMETHING (the suite's receiver is not up yet, so
# a 502/530 from the edge is the success signal; 000 = not routable).
sleep 20
up=0
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$TUNNEL_URL" || true)"
  if [ -n "$code" ] && [ "$code" != "000" ]; then up=1; break; fi
  sleep 4
done
[ "$up" -eq 1 ] || die "the tunnel $TUNNEL_URL never became routable — every webhook row would be starved"
echo "tunnel: $TUNNEL_URL -> 127.0.0.1:$PORT (routable)"

# ── 6. cut, verify, upload — per major ──────────────────────────────────────
published=()
for m in "${MAJORS[@]}"; do
  OUT="$WORK/major-$m.json"
  # WHD-23 — the production-posture opt-outs are checked against the TARGET's own
  # discovery; the helper refuses (non-zero) if the target advertises any of them.
  OPENWOP_OPTED_OUT_PROFILES="$(node "$OPTOUTS" --major "$m" --discovery-url "$BASE/.well-known/openwop")" \
    || die "could not derive the opt-out ledger (a posture opt-out may contradict live discovery — see above)"
  echo "  opt-outs (major $m): $OPENWOP_OPTED_OUT_PROFILES"
  export OPENWOP_OPTED_OUT_PROFILES
  echo "▶ major $m: cutting against $BASE (this is a load test; --max-workers $MAX_WORKERS)"
  "$BIN" --base-url "$BASE" --certify "$OUT" --target-major "$m" --bundle-version 3 --require-behavior \
    --max-workers "$MAX_WORKERS" --host-build "commit:$COMMIT" \
    --signing-key "$WORK/signing.pem" --signing-key-id "$OPENWOP_BUNDLE_SIGNING_KEY_ID"
  cut_exit=$?
  # A non-zero exit with a bundle written means "the host did not certify
  # everything" — that IS the evidence, honestly recorded. No bundle is fatal.
  [ -s "$OUT" ] || die "major $m: the suite wrote no bundle (exit $cut_exit)"
  echo "  suite exit $cut_exit (non-zero = some rows are not passes; the bundle records which)"

  "$BIN" --verify "$OUT" --host-key "$WORK/host.pem" > "$WORK/verify-$m.txt" 2>&1
  v=$?
  if [ "$v" -ne 0 ]; then
    cat "$WORK/verify-$m.txt"
    die "major $m: the suite's --verify did not return VERIFIED (exit $v) — not uploading"
  fi
  node "$HELPERS" discovery-field signingKeys < "$WORK/discovery.json" > "$WORK/keys.json"
  node "$VERIFY" "$OUT" --commit "$COMMIT" --major "$m" --keys-json "$WORK/keys.json" \
    || die "major $m: the host would REFUSE this bundle (above) — not uploading"

  DEST="$ORIGIN/$COMMIT/major-$m.json"
  gcloud storage cp "$OUT" "$DEST" --content-type=application/json "${GC[@]}" \
    || die "major $m: upload to $DEST failed"
  echo "  uploaded → $DEST  (sha256 $(shasum -a 256 "$OUT" | cut -c1-12))"
  published+=("$m")
done

# ── 7. leave the conformance tenant as we found it ──────────────────────────
AFTER="$(webhook_ids)" || AFTER=""
AFTER_N="$(printf '%s' "$AFTER" | grep -c .)"
deleted=0
for id in $AFTER; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X DELETE -H "Authorization: Bearer $OPENWOP_API_KEY" "$BASE/api/v1/webhooks/$id")"
  case "$code" in 2*) deleted=$((deleted+1)) ;; *) echo "  webhook $id: DELETE answered $code" ;; esac
done
FINAL="$(webhook_ids)" || FINAL="?"
FINAL_N="$(printf '%s' "$FINAL" | grep -c .)"
echo "webhook subscriptions: before=$BEFORE_N after-run=$AFTER_N deleted=$deleted remaining=$FINAL_N"

# ── 8. is it served? ────────────────────────────────────────────────────────
# The host re-reads a withheld key at most every 60 s, so allow a little over
# that. Compare DIGESTS of the bytes, which is what a third party would do.
for m in ${published[@]+"${published[@]}"}; do
  want="$(shasum -a 256 "$WORK/major-$m.json" | cut -d' ' -f1)"
  got=""
  for _ in $(seq 1 10); do
    hdr=(); [ "$m" = 2 ] && hdr=(-H 'OpenWOP-Version: 2')
    curl -sS --max-time 20 ${hdr[@]+"${hdr[@]}"} "$BASE/.well-known/openwop?cb=$(date +%s%N)" > "$WORK/disco-$m.json"
    ptr="$(node "$HELPERS" discovery-field "$([ "$m" = 2 ] && echo conformance.certificationBundleUrl || echo capabilities.conformance.certificationBundleUrl)" < "$WORK/disco-$m.json" 2>/dev/null)"
    if [ -n "$ptr" ]; then
      path="${ptr#http*://*/}"
      got="$(curl -sS --max-time 20 "$BASE/${path}?cb=$(date +%s%N)" | shasum -a 256 | cut -d' ' -f1)"
      [ "$got" = "$want" ] && break
    fi
    sleep 10
  done
  if [ "$got" = "$want" ]; then
    echo "  major $m: SERVED  pointer → bytes with sha256 ${want:0:12} (equal to the upload)"
  else
    echo "  major $m: NOT YET SERVED (pointer ${ptr:-absent}; got ${got:0:12}, want ${want:0:12}) — check the service has OPENWOP_CERT_BUNDLE_ORIGIN=$ORIGIN and the logs for certification_evidence_withheld"
  fi
done
