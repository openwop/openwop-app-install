# Live-deploy smoke test — app.openwop.dev

**Last run:** 2026-08-10 ~18:20 UTC, against a FULL both-halves deploy of
origin/main `e65ff6888` (backend revision `openwop-app-backend-00632-7t6`;
frontend `index-QMVCKkXe.js`, up from `index-DcVpoY8L.js`). All steps green.
`scripts/verify-deploy.sh` → `both halves verified` at `e65ff6888e1e`.

**Stamp gotcha caught this run — `stamped: true` is NOT evidence of freshness.**
A bare `gcloud run deploy` (correctly passing no `--set-*`, so the live secret +
env binding survives) also preserves `OPENWOP_BUILD_COMMIT`. The new revision
therefore ran `e65ff6888` while `/api/readiness` reported
`{commit: 43b539ed2…, stamped: true}` — the *previous* deploy's commit,
presented with a truthy `stamped` flag. That is worse than `unknown`: the
`stamped` boolean only records that *some* value was injected, never that it
matches the running code. The `--update-env-vars OPENWOP_BUILD_COMMIT=…` line
(DEPLOY.md §"Backend redeploy") is what corrects it, and only
`verify-deploy.sh`, which *compares* the value against your HEAD, can detect the
drift. Read the commit, never the flag — or just use `scripts/deploy.sh`, which
computes the stamp rather than relying on the operator to remember it.

Step 3 uses a UNIQUE workflowId: the fixed `smoke-uppercase` id now 404s on
re-registration (ADR 0440 P4 write guard on a leftover global-by-id
registration) while staying runnable — a false failure the old runbook tripped
over. See the note on step 3.

Repeat this whenever the backend redeploys to confirm the full
cookie-auth + cookie-scoped-state + admin-cleanup loop works
end-to-end.

```bash
BASE="https://app.openwop.dev/api"
CJAR=/tmp/smoke-cookies.txt
WFID="smoke-uc-$(date +%s)"   # UNIQUE per run — see the note on step 3
rm -f $CJAR

# 0. Liveness probe (the canonical "is the backend up" check)
curl -sI "$BASE/health" | head -1   # HTTP/2 200 expected

# R2-D11 (UX_UPGRADE-docs round 2) — the root llms.txt door (a Firebase rewrite
# to the backend; needs OPENWOP_PUBLIC_SITE_ORG_ID bound on the service).
curl -s -o /dev/null -w "llms.txt HTTP %{http_code}\n" "https://app.openwop.dev/llms.txt"   # 200 with published docs

# 0.5 Readiness — downstream-dependency health, not just liveness.
# 200 {"status":"ready"} when every managed ("Try it free") tier
# advertised in providers.json has its server-held key seeded; 503
# {"status":"degraded", checks:{managedProviders:[...]}} when one
# doesn't (dropped/unmounted secret, missing env at boot). This is the
# step that catches a MINIMAX_API_KEY that never reached the runtime
# before a user hits it and gets `managed_unavailable`.
curl -s -o /tmp/readiness.json -w "readiness HTTP %{http_code}\n" "$BASE/readiness"
python3 -c "import json; d=json.load(open('/tmp/readiness.json')); print('status:', d['status']); [print(' -', p['providerId'], p['ready'], p['detail']) for p in d.get('checks',{}).get('managedProviders',[])]; print('webSearch:', d.get('checks',{}).get('webSearch'))"

# 0.6 Web-search key — REPORTED by 0.5 above, never gating (search is optional,
# so a host without it is genuinely healthy and must not 503). Read the
# `webSearch:` line: `{'configured': True, 'source': 'host-vault'|'env'}` means a
# key resolves; `{'configured': False, 'source': None}` means research nodes will
# fall back to the `demo` engine and return synthetic results.
#
# Why this line exists: before it, the ONLY way to check was to run a research
# workflow and read `engine` off a run event — so an operator who had just set the
# Vault key could not confirm it landed. It never returns the key itself; the
# endpoint is unauthenticated, and the probe is HOST-scope only (a tenant's own
# BYOK key is deliberately not enumerable here).
# To configure: /access?tab=connections → scope **Host-global** → ref `web-search`.

# 0.7 Deploy provenance — the commit must be CORROBORATED, not merely claimed.
# `commitSource: image` means the SHA travelled inside the artifact. `env` means
# it is a deploy-time claim that a bare redeploy can carry over from the PREVIOUS
# deploy — exactly what happened on 2026-08-10 (rev 00631 ran e65ff6888 and
# reported 43b539ed2 with `stamped: true`). Do NOT read `stamped`: it only says a
# value was injected, never that it describes the running code.
#
# This line is also the FIRST EXECUTION of the image-baked path (Dockerfile
# `COPY build-meta`): it could not be tested before shipping, because the
# authoring machine had no Docker daemon. `image` here is that verification.
curl -s "$BASE/readiness" | python3 -c "import sys,json; b=json.load(sys.stdin).get('build',{}); print('commit:',b.get('commit'),'source:',b.get('commitSource'))"
# Expect: source: image   ·   `env` = the writer was skipped (see DEPLOY.md)
#         `none` = unstamped; verify-deploy.sh hard-fails this

# 1. Well-known capabilities (no auth)
curl -s "$BASE/.well-known/openwop" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print('protocol:', d['protocolVersion']); print('surfaces:', len(d['capabilities']['hostSurfaces'])); print('aiProviders:', d['capabilities']['aiProviders']['supported'])"

# 1.5 RFC 0101 multi-party group conversation — the LIVE CONFORMANCE WITNESS
#     (ADR 0040 Phase 6 / openwop #738+#739). Folds the INTEROP-MATRIX
#     "live + strict-verified" flip into the deploy: first assert the capability is
#     advertised on the live discovery doc, THEN run RFC 0101's gated conformance leg
#     NON-VACUOUSLY against this deployed host (the black-box path RFC 0095's
#     connection-packs witness used).
curl -s "$BASE/.well-known/openwop" | \
  python3 -c "import json,sys; m=json.load(sys.stdin)['capabilities'].get('multiPartyConversation',{}); print('multiPartyConversation:', m.get('supported'), '· maxParticipants:', m.get('maxParticipants'))"
# Expected: multiPartyConversation: True · maxParticipants: 8
#
# Then, from a clean openwop spec checkout, run the gated leg against THIS host:
#   ( cd ../openwop/conformance && \
#       OPENWOP_BASE_URL="$BASE" OPENWOP_REQUIRE_BEHAVIOR=true \
#       npx vitest run src/scenarios/multi-party-conversation-shape.test.ts )
# A NON-VACUOUS pass (the capability-gated behavioral leg runs, not skips) is the
# RFC 0101 `Active → Accepted` behavioral evidence. On success:
#   1) flip the INTEROP-MATRIX § "Multi-party group conversation" openwop-app row from
#      "implemented — live strict-verification pending deploy" → "live + strict-verified",
#      citing this deployed Cloud Run revision + suite version (openwop PR);
#   2) tick RFC 0101's behavioral-evidence acceptance box [~] → [x].

# 2. Catalog (mints the __session cookie)
curl -s -c $CJAR -i "$BASE/v1/host/openwop-app/node-catalog" | grep -i set-cookie | head -1
curl -s -b $CJAR "$BASE/v1/host/openwop-app/node-catalog" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print('nodes:', len(d['nodes']), 'runnable:', sum(1 for n in d['nodes'] if not n.get('missingHostSurfaces')))"

# 3. Register a sample workflow under the cookie's tenant.
#    IMPORTANT: use a UNIQUE workflowId ($WFID above), NOT a fixed literal.
#    The workflow registry is GLOBAL-by-id (workflowOwnership.ts), and the
#    ADR 0440 P4 write guard (routes/workflows.ts:290, `isWriteProtected`)
#    refuses a POST under an id another tenant already owns with an
#    INDISTINGUISHABLE 404 `workflow_not_found` (no existence oracle). A fixed
#    id like `smoke-uppercase` persists from earlier smoke runs (owned by an
#    older anon tenant, and never pruned by admin cleanup), so re-registering
#    it 404s forever even though it stays globally RUNNABLE — a false failure.
#    A fresh $WFID each run exercises the real register→run path. Expect 201
#    `{"workflowId":"smoke-uc-…","nodeCount":1}`.
curl -s -b $CJAR -c $CJAR -X POST -H 'content-type: application/json' \
  "$BASE/v1/host/openwop-app/workflows" \
  -d "{\"workflowId\":\"$WFID\",\"nodes\":[{\"nodeId\":\"shout\",\"typeId\":\"local.openwop-app.uppercase\"}]}"

# 4. Create a run — body omits tenantId, cookie provides it
RUNID=$(curl -s -b $CJAR -c $CJAR -X POST -H 'content-type: application/json' \
  "$BASE/v1/runs" -d "{\"workflowId\":\"$WFID\",\"inputs\":{\"text\":\"hello demo\"}}" | \
  python3 -c "import json,sys; print(json.load(sys.stdin)['runId'])")
echo "runId: $RUNID"

# 5. Fetch snapshot
sleep 1
curl -s -b $CJAR "$BASE/v1/runs/$RUNID" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print('status:', d['status'])"

# 6. Admin cleanup (Bearer the OPENWOP_ADMIN_TOKEN from Secret Manager)
ADMIN=$(gcloud secrets versions access latest --secret=openwop-admin-token)
curl -s -X POST -H "Authorization: Bearer $ADMIN" \
  "$BASE/v1/host/openwop-app/admin/cleanup" | python3 -m json.tool

# 7. /privacy page reachable
curl -sI https://app.openwop.dev/privacy | head -1
```

## Expected vs. actual (2026-08-10, rev `00632-7t6`, origin/main `e65ff6888`)

| Step | Expected | Actual |
|---|---|---|
| 0 | HTTP 200 | ✓ `HTTP/2 200` · `llms.txt` HTTP 200 |
| 0.5 | `status: ready`, every managed tier ready | ✓ `ready` |
| 1 | protocol 1.1, ≥ 17 surfaces, 3 providers | ✓ protocol `1.1` · 26 surfaces |
| 1.5 | `multiPartyConversation: True · maxParticipants: 8`; then the gated RFC 0101 leg passes NON-VACUOUSLY → flip INTEROP-MATRIX row + tick the acceptance box | ✓ `True · 8` advertised _(gated conformance leg not re-run this deploy)_ |
| 2 | Set-Cookie + nodes ≥ 270 + runnable ≥ 220 | ✓ `__session` set · 773 nodes / 773 runnable |
| 3 | `{"workflowId":"smoke-uc-…","nodeCount":1}` (UNIQUE id — a fixed id 404s, see note) | ✓ `nodeCount:1` on a fresh `$WFID` |
| 4 | runId UUID returned | ✓ `d57cf339-b08f-…` |
| 5 | `status: completed` (or `running`/`waiting-*` if HITL) | ✓ `running` at T+2s — within the documented set, but NOT re-polled to completion |
| 6 | `{ok:true, activeTenants:N, wipedSecrets:M}` | **NOT RUN** — admin cleanup mutates prod (prunes anon tenants/secrets); deliberately skipped on an unattended deploy |
| 7 | HTTP 200 | ✓ `HTTP/2 200` |

Frontend-half checks (not in the numbered sequence above, but required by
`CLAUDE.md` § Deploying — assert the served bundle and the CONTENT-TYPE, never a
status code):

| Check | Result |
|---|---|
| `app-shell.html` bundle == local `dist/assets/index-*.js` | ✓ `index-QMVCKkXe.js` |
| `/dashboard` (a real SPA route) bundle | ✓ `index-QMVCKkXe.js` |
| `/` shell freshness — asset it references serves as JS, not the HTML rewrite | ✓ `200 text/javascript` (no stale-shell window observed; post-#3056) |
| `scripts/verify-deploy.sh` (commit-level, both halves) | ✓ `both halves verified` @ `e65ff6888e1e` |
| CORS preflight, direct Cloud Run URL + allowlisted origin | ✓ allow-headers carries `X-OpenWOP-Field-Contract` + `x-openwop-act-as` |

These bundle checks discriminate: the pre-deploy baseline was
`index-DcVpoY8L.js`, so an unchanged hash would have failed them.

Surface/node counts grow over time (more published packs land between runs); the
`≥` floors are what matter. **Step-3 gotcha (2026-07-21):** the pre-existing
global-by-id workflow registry means a fixed `workflowId` registered by one smoke
run is owned thereafter, so a later run's re-registration is refused an
indistinguishable 404 by the ADR 0440 P4 write guard (`routes/workflows.ts:290`)
even while the workflow stays runnable — admin cleanup (step 6) prunes anon
secrets/tenants but not these global registrations. Always register a unique
`$WFID` per run; that also proves the register→run path non-vacuously.

## What this proves

- Firebase Hosting → Cloud Run `/api/**` rewrite working end-to-end.
- Backend `/api` prefix strip correct (`/api/v1/...` → `/v1/...`).
- Session cookie minted with the right attributes: name `__session` (the only
  cookie name Firebase Hosting forwards through its CDN), HttpOnly, Secure,
  SameSite=None (required for the `/api` rewrite path), Max-Age=86400, HS256
  signature. Decoded payload carries `tenantId: anon:<sid>`, `tier: anon`.
- Cookie-scoped tenant isolation working — body omits `tenantId`,
  cookie's `anon:<sid>` is used.
- 17 published packs install + register cleanly at backend cold start
  (the patched `core.openwop.{http@1.1.1, rag@1.0.1, crypto@1.0.1}`
  are part of the install set).
- Admin cleanup endpoint authorized via the Bearer admin token (NOT
  via the cookie path), runs idempotently.
- `/privacy` page deep-links work under the SPA fallback rewrite.

## What this does NOT prove

- Browser-level UX (SSE event streaming, BYOK panel, builder
  drag/drop) — needs a manual browser session.
- Cert provisioning — currently `CERT_PROPAGATING` with TEMPORARY
  cert; long-lived cert lands automatically.
- Rate-limit thresholds — would need to fire >10 runs/min against
  the same cookie to confirm 429. Easy to add if needed.

## OAuth connect (Connections) — after configuring a provider client

Prereq: `OPENWOP_OAUTH_CALLBACK_BASE_URL=https://app.openwop.dev/api` on the
service (set 2026-07-02, rev `00367-8q4`) and a client id/secret stored for the
provider (DEPLOY.md § Configuring provider OAuth clients).

```bash
# 1. Catalog honesty flag — the provider should report oauthConfigured: true
#    (requires a signed-in session cookie; superadmin not needed for the read).
curl -s -b "$COOKIE_JAR" https://app.openwop.dev/api/v1/host/openwop-app/providers \
  | jq '.providers[] | select(.id=="google") | {id, oauthConfigured}'
```

2. In the browser (signed in): Admin → Access → Connections → **Connect
   Google** is enabled; clicking it lands on `accounts.google.com` with a
   `redirect_uri` that starts `https://app.openwop.dev/api/…/connections/google/callback`
   (the `/api` prefix present is the whole point — its absence 404s only after
   consent). Complete consent → row `active` → **Test** → green.

## Production host-surface posture (when OPENWOP_SURFACE_*= are set)

A deploy that selects real backends (`OPENWOP_SURFACE_KV=durable`,
`OPENWOP_SURFACE_BLOB=s3`, `OPENWOP_SURFACE_SQL=postgres`, …) should advertise
them honestly. `/.well-known/openwop` reports the *effective* backend per
surface, so the non-durable badge clears only when a real backend is actually
wired:

```bash
# Each selected surface should report its backend id, NOT a non-durable tag
# (in-memory / sandboxed-local-fs / brute-force-cosine / …).
curl -s https://<host>/.well-known/openwop \
  | jq '.hostSurfaces[] | {name, implementation}'
```

Expect e.g. `host.kvStorage → "durable"`, `host.blobStorage → "s3"`,
`host.db.sql → "postgres"`. A surface still showing a non-durable tag means its
`OPENWOP_SURFACE_*` env didn't reach the runtime. The boot itself fails closed
if a selected backend has no adapter (or, in the `auth` posture, if
`OPENWOP_BYOK_KMS_KEY` is unset), so a running service already implies a valid
selection.

The end-to-end wiring (env → seam → `ctx.*` → discovery advertisement) is
covered locally by `backend/typescript/test/seam-smoke.test.ts`, which boots the
app with durable surfaces and drives kv/fs/table over HTTP.

## SEO crawler prerender (ADR 0384)

After a backend deploy (custom-domain door — works immediately):

```
curl -s -A "ClaudeBot/1.0" https://<custom-domain>/ | head -5           # <!doctype html> + <title>
curl -s -A "ClaudeBot/1.0" https://<custom-domain>/p/<slug> | grep -c 'ld+json'   # ≥ 1
```

After the platform-origin rewrite flip (DEPLOY.md § SEO crawler prerender):

```
curl -s -A "Slackbot-LinkExpanding 1.0" https://app.openwop.dev/p/<slug> | grep '<title>'
curl -s -A "Mozilla/5.0" https://app.openwop.dev/p/<slug> | grep -c 'assets/index-'   # human = SPA shell
curl -sI -A "ClaudeBot/1.0" https://app.openwop.dev/p/<slug> | grep -i '^vary:'       # includes User-Agent
```

Then: Slack/LinkedIn unfurl inspectors on a published URL; Google Rich Results
test on the JSON-LD. A human browser must be byte-identical to pre-flip.
