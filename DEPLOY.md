# workflow-engine — GCP deployment bootstrap

> **This is the Google Cloud (GCP) deploy pack.** It is one of several — the app
> runs on any host. To pick a different target (vendor-neutral Docker Compose,
> Fly.io, Render/Railway, AWS, Azure) start at **[`deploy/README.md`](deploy/README.md)**.
> The GCP pack's orchestrator is **[`deploy/gcp/up.sh`](deploy/gcp/up.sh)**;
> `firebase.json` / `.firebaserc` / `Dockerfile` stay at the repo root by
> Firebase/Cloud-Build convention.

Reproducible recipe for the live demo at `app.openwop.dev`. Captures every
gcloud / firebase / DNS step that brought up the Phase 1 + Phase 2 stack
so future maintainers can rebuild it from scratch in <30 min.

Read alongside `DEPLOY-SMOKE.md` (the live-deploy verification sequence).

## White-label quick path

For a new branded fork, use the deploy helper instead of copying the
`app.openwop.dev` commands below verbatim. It keeps the backend -> frontend
order, grants Secret Manager access to the runtime service account, builds the
SPA with an SSE URL that bypasses the Firebase `/api` proxy, runs the branding
leak guard, deploys Firebase Hosting, and verifies `/api/readiness`.

The helper is a dry run unless explicitly confirmed:

```bash
OPENWOP_GCP_PROJECT=<your-project> \
OPENWOP_RUN_SERVICE=<your-cloud-run-service> \
OPENWOP_RUN_REGION=<region> \
OPENWOP_FIREBASE_TARGET=<hosting-target> \
OPENWOP_PUBLIC_BASE_URL=https://<your-domain> \
bash deploy/gcp/up.sh
```

The helper defaults `OPENWOP_DEPLOY_POSTURE=cookie-per-visitor`: every visitor
gets an isolated anonymous cookie tenant, and the managed free tier is usable
without sign-in under the existing rate limits. Set
`OPENWOP_DEPLOY_POSTURE=bearer-shared` for a shared demo token posture, or
`OPENWOP_DEPLOY_POSTURE=auth` to require sign-in for managed-tier turns.
`OPENWOP_MANAGED_ANON_SIGNIN_REQUIRED=true|false` can override only that
managed-tier sign-in wall.

After the printed commands look right, execute them:

```bash
OPENWOP_DEPLOY_CONFIRM=1 \
OPENWOP_GCP_PROJECT=<your-project> \
OPENWOP_RUN_SERVICE=<your-cloud-run-service> \
OPENWOP_RUN_REGION=<region> \
OPENWOP_FIREBASE_TARGET=<hosting-target> \
OPENWOP_PUBLIC_BASE_URL=https://<your-domain> \
bash deploy/gcp/up.sh
```

Before the live run, copy
`frontend/react/.env.production.example` to `.env.production` and fill in your
`VITE_BRAND_*` values. `scripts/check-branding.sh` intentionally fails if the
built bundle still contains stock OpenWOP title/favicon/domain/instance
defaults. For existing Cloud Run services, the helper uses merge-style
`--update-secrets` / `--update-env-vars`; keep using those forms for one-off
changes and avoid `--set-*`, which replaces the whole binding set.

## Upgrading (operator contract — ADR 0052)

openwop-app ships as **immutable `vX.Y.Z` releases** (the `/install/` download's
`latest` alias points at the newest). Upgrading an existing install:

1. **Back up your database first.** Upgrades are **forward-only** — there are no
   down-migrations. Rollback = redeploy the prior version's image **and** restore the
   pre-upgrade snapshot (ADR 0052 §D3).
2. **Check `RELEASES.md` for a required stop** between your current version and the
   target. By default there are none — migrations replay forward on boot, so you can
   jump several versions in one upgrade. A release flagged `requiredStop: true` in
   `releases.json` must be landed on first (ADR 0052 §D2).
3. **Read the release's `#### Upgrading from` block** in `CHANGELOG.md` for breaking
   config/env changes and any manual action.
4. **Deploy the new image** (backend first, then frontend — see §6/§7). DB **schema**
   migrations (`__schema_version`) and **app** migrations (`__app_meta`) run
   automatically on boot, in order, idempotently — an instance on any prior version
   catches up in one start.
5. **Verify:** `curl https://<host>/api/readiness` returns `200` with
   `"version": "<the version you shipped>"`, then smoke the changed surface.

**Rolling (multi-instance) deploys:** a migration in a `MINOR` release MUST be safe
for the prior binary running concurrently (additive / expand-then-contract) — old and
new revisions briefly serve traffic together during a Cloud Run rollout. A migration
that can't be made rolling-safe MUST ship as a `MAJOR` and be flagged a required stop.

**Versions:** the running app version is the SSoT in `/VERSION` (mirrored into
`src/version.ts` + both `package.json`s by `/cut-app-release`), advertised as
`service.version` at `/.well-known/openwop` and `version` at `/readiness`. Pre-1.0
(`0.x`): a `0.MINOR` bump MAY carry breaking changes.

## From the in-memory tier to durable storage

The app has two planes, and only one defaults to non-durable:

- **Control plane** — runs, the event log (replay/fork backbone), suspensions,
  and BYOK secrets. Already production-capable: set
  `OPENWOP_STORAGE_DSN=postgres://…` (Cloud SQL) and the durable store runs
  schema migrations on boot. No code change.
- **Host data-plane surfaces** — `ctx.storage.{kv,table,cache,blob,queue}`,
  `ctx.db.{sql,vector,search,nosql}`, `ctx.fs`, `ctx.queueBus`,
  `ctx.observability`. These default to the **in-memory tier**:
  process-local, wiped on restart, single-instance. This is the only
  non-durable part.

### Required env for the production (`auth`) posture

| Var | Value | Why |
|---|---|---|
| `OPENWOP_DEPLOY_POSTURE` | `auth` | Require sign-in for managed-tier turns. |
| `OPENWOP_STORAGE_DSN` | `postgres://…` | Durable control plane (runs, events, secrets). |
| `OPENWOP_BYOK_KMS_KEY` | `projects/…/cryptoKeys/…` | **Mandatory in `auth`.** Signed-in tenant secrets get KMS-envelope encryption. The backend now **refuses to boot** in the `auth` posture without it — it will not silently fall back to the ephemeral/plaintext secret store. |
| `OPENWOP_BYOK_ENCRYPTION_KEY` | `openssl rand -hex 32` | Only needed if a deploy uses the **local-AES** BYOK path (not `OPENWOP_BYOK_EPHEMERAL=true` and not KMS). Under `NODE_ENV=production` the backend now **fails closed** rather than auto-generating a throwaway disk key (SEC-3): a freshly-minted disk key is unrecoverable across Cloud Run instances/restarts and gives false at-rest assurance. The live demo sets `OPENWOP_BYOK_EPHEMERAL=true`, so it never hits this path. |

### Optional AI capabilities (off by default — honest-off until configured)

These three surfaces ship **dark by default** and advertise nothing until an operator
wires them. The code + the chat agent personas are already on the image; they just
return a capability-missing result until the matching env is set. All are merge-updates
(`--update-env-vars` / `--update-secrets`), never `--set-*` (see the [§ White-label] note
about preserving live config).

| Capability (ADR) | Env to enable | Notes |
|---|---|---|
| **Code execution** (ADR 0114 + 0146) — the *Code Interpreter* chat agent | **In-process WASI is ON BY DEFAULT** (just sync the asset). **External (upgrade):** `OPENWOP_CODE_EXEC_ENDPOINT=https://<your-code-api>` (+ `OPENWOP_CODE_EXEC_KEY`). **Opt out:** `OPENWOP_CODE_EXEC_RUNTIME=off` | **WASI** runs CPython in-process under Node's `node:wasi` — a *sound* boundary (no `js` FFI; no host fs/env/network), Python-only, ~36 ms cold start. It is **on by default whenever `backend/typescript/vendor/python-3.12.0.wasm` is present**, so the **build MUST run `bash scripts/sync-pythonwasm.sh`** (vendors the ~25 MB binary) — a host that never synced it stays honest-off → `capability_not_provided` (no false advertisement). **External** (a LibreChat-style Code API; strong isolation + polyglot) **always wins** when its endpoint is set; `=off` forces honest-off. **Memory is best-effort under WASI** (a hard cap needs the deferred ADR 0146 Phase 4b; note on Cloud Run `/tmp` is tmpfs/RAM, so guest scratch writes count against instance memory) — size the instance + keep `OPENWOP_CODE_EXEC_MAX_CONCURRENT` (default 8) modest. Captured stdout/stderr is read-capped by `OPENWOP_CODE_EXEC_MAX_OUTPUT_BYTES` (default 1 MB) so a huge print can't OOM the host. Optional: `OPENWOP_CODE_EXEC_LANGUAGES` (external default `python,javascript,typescript,bash,ruby,go`; WASI advertises `python` only), `OPENWOP_CODE_EXEC_MAX_PER_DAY` (per-tenant daily cap, default 100; `0`/unset = uncapped). Execution is gated behind a per-run HITL approval. |
| **Image generation** (ADR 0115) — the *Image Generator* chat agent | `OPENWOP_IMAGE_PROVIDER_ENABLED=true` **and** `OPENWOP_IMAGE_PROVIDER_ENDPOINT=https://<provider>` (+ `OPENWOP_IMAGE_PROVIDER_KEY`) | Flips `imageGeneration.supported` in discovery only when enabled. Per-provider routing: `OPENWOP_IMAGE_PROVIDER_ENDPOINT_<PROVIDER>` / `_KEY_<PROVIDER>` (e.g. `_GOOGLE` for Imagen) override the generic endpoint, so `openai` and `google` can route to their own backends; the generic endpoint is the fallback. SSRF-guarded; the endpoint is never echoed (§D). Without it, `callImageGenerator` returns `host_capability_missing`. |
| **Self-hosted / OpenAI-compatible providers** (ADR 0121 / RFC 0108) — the Keys-page connect form | `OPENWOP_COMPAT_PROVIDER_ENABLED=true` | The operator opt-in that exposes the `/compat-endpoints` config surface (the **Self-hosted / OpenAI-compatible endpoints** card on `/keys`) so tenants can add an Ollama / LM Studio / vLLM / any compat base URL. RFC 0108 is Accepted, so the `aiProviders.selfHosted[]` advertisement is honest once a reachable endpoint is configured. Per-endpoint base URL + optional key are stored via BYOK (the key never returns to the FE); declared capabilities (vision/tools/long-context) are taken from what the tenant sets (the host can't probe a black box). SSRF-guarded. |

All three keep the per-tenant feature posture intact — they are **operator** opt-ins (env on
the service), not per-user toggles. The chat agents (`Code Interpreter`, `Image Generator`)
are already discoverable in the agent picker regardless; they simply gain a working tool once
the capability is wired.

### Headless profile — no rendering client (ADR 0168 Part A)

The backend is headless-by-construction (zero browser-global runtime deps; the SPA is purely a
view over the API), and the Bearer-token path (`OPENWOP_API_KEYS` + `OPENWOP_AUTH_DISABLE_COOKIES=true`)
already drives it without a browser (curl / the `@openwop` SDK / the conformance harness). For a
deployment with **no rendering client**, set the profile so `/.well-known/openwop` stays honest:

```
gcloud run services update openwop-app-backend \
  --update-env-vars OPENWOP_PROFILE=headless \
  --region us-central1 --project openwop-dev
```

`OPENWOP_PROFILE=headless` withholds the three **client-presentation** surfaces — `uiPlugins`
(the RFC 0117 iframe RPC seam), `realtimeVoice` (browser mic capture), and the `chatWidget`
public embed gateway — from BOTH the discovery advert AND their route mounts (a smaller attack
surface; advertise only what a no-client deploy serves). **Everything else is unchanged** — runs,
workflows, agents, the RFC 0005 conversation primitive, dispatch, storage, auth. `OPENWOP_PROFILE=full`
(the default) is exactly today's behavior. A per-capability override `OPENWOP_PRESENTATION_<CAP>=on|off`
(`UIPLUGINS`/`REALTIMEVOICE`/`CHATWIDGET`) beats the profile for a mixed deploy (e.g. headless but
keep uiPlugins). All merge-updates (`--update-env-vars`), never `--set-*`.

### Making host surfaces durable (horizontal scale)

Until the data-plane surfaces are backed by shared stores, you **cannot run more
than one backend instance** safely — two instances see two divergent
`ctx.storage.kv`. Each surface is selected through a backend seam
(`backend/typescript/src/host/surfaceBackends.ts`); the wire shape is identical
whichever backend is chosen:

```bash
OPENWOP_SURFACE_BACKEND=<id>   # global default for every portable surface
OPENWOP_SURFACE_KV=<id>        # per-surface override (KV, TABLE, CACHE, BLOB,
                               # QUEUE, SQL, VECTOR, SEARCH, NOSQL, FS,
                               # QUEUEBUS, OBSERVABILITY)
```

Shipped backends:

- `memory` — the in-memory tier (default; process-local, wiped on restart).
- `durable` — backs **`kv`, `cache`, `table`, `queue`, `queueBus`, `vector`,
  `search`, `nosql`, and `fs`** (`OPENWOP_SURFACE_<KEY>=durable`). Real adapters
  over the shared `Storage` (whatever `OPENWOP_STORAGE_DSN` points at — sqlite or
  Postgres), so they survive restarts and are consistent across instances.
  Cloud-agnostic. See `backend/typescript/src/host/durable/`.
  - `kv` / `cache`: `atomicIncrement` and `cas` are atomic **across instances**
    via `Storage.kvCompareAndSwap` (an in-process per-key lock additionally
    coalesces same-instance contention). `table` enforces its
    schema-on-first-insert durably and paginates by cursor.
  - `queue` / `queueBus`: FIFO via a durable monotonic sequence; delivery is
    **at most once across instances** (a consumer claims the head with an atomic
    `kvDelete`). `queueBus` tracks in-flight messages by deliveryToken with
    ack / nack-requeue / deadLetter (`<subject>.dlq`) and `fromBeginning`
    stream snapshots.
  - `vector` / `search` / `nosql` / `fs`: durable + cross-instance, with the
    exact in-memory semantics (cosine kNN, bag-of-words ranking, exact-match
    document filters with `$`-operator injection refused, sandboxed virtual fs).
  - Cross-tenant isolation (CTI-1) is enforced by per-tenant key prefixes on
    every durable surface and verified by a dedicated isolation test sweep.
  - `sql` (`OPENWOP_SURFACE_SQL=durable`): a per-tenant **SQLite file** under
    `<dataDir>/host-sql/` (durable + fully isolated; non-parametric SQL refused,
    RFC 0018). Single-node. For **cross-instance** SQL use
    `OPENWOP_SURFACE_SQL=postgres` (the `postgres` backend, below).
  - Trade-offs (documented, in-memory tier): `table`/`nosql` `query` and the
    `durable` `vector`/`search` are O(n) prefix scans. For scale, point those at
    the dedicated engines below instead.
    `queueBus` nack re-publishes at the tail (visibility-timeout-style).

- Scale / cross-instance engines (optional, replace the `durable` data adapters):
  - `postgres` — backs **`sql`** (`OPENWOP_SURFACE_SQL=postgres`). `host.db.sql`
    over a shared Postgres with **schema-per-tenant** isolation (`tenant_<id>`,
    `search_path`-scoped per op); the cross-instance counterpart to durable
    sql. Non-parametric SQL refused (RFC 0018); `lastInsertRowid` is 0 (use
    `RETURNING`). Env: `OPENWOP_SQL_PG_DSN`. Live-validated by the `pg-sql-live`
    CI job. See `backend/typescript/src/host/sql/`.
  - `opensearch` — backs **`search`** (`OPENWOP_SURFACE_SEARCH=opensearch`).
    `host.db.search` over OpenSearch/Elasticsearch (BM25, real indexing) via the
    HTTP API; dependency-free (`fetch`); per-(tenant,index) physical index.
    Env: `OPENWOP_SEARCH_OS_ENDPOINT` (+ `_USERNAME`/`_PASSWORD` or `_API_KEY`,
    `_INDEX_PREFIX`). See `backend/typescript/src/host/search/`.
  - `pgvector` — backs **`vector`** (`OPENWOP_SURFACE_VECTOR=pgvector`).
    `host.db.vector` over Postgres + pgvector (`<=>` cosine, ANN-indexable),
    fixed embedding dimension. Env: `OPENWOP_VECTOR_PG_DSN`,
    `OPENWOP_VECTOR_PG_DIM` (+ `_TABLE`). See `backend/typescript/src/host/vector/`.
    The SQL is unit-test-pinned; validate end-to-end against a live pgvector
    (CI service container) before production use.

- `s3` — backs **`blob`** (`OPENWOP_SURFACE_BLOB=s3`). `host.blobStorage` over
  any S3-compatible object store (AWS S3, GCS S3-interop, Cloudflare R2,
  Backblaze B2, MinIO). `presign()` returns a **real** SigV4-presigned URL the
  client uses directly against the bucket (no host bandwidth, no synthetic
  token). Dependency-free (node:crypto SigV4 + `fetch`); cloud-agnostic via
  endpoint config. See `backend/typescript/src/host/blob/`. Required env:
  `OPENWOP_BLOB_S3_BUCKET`, `OPENWOP_BLOB_S3_ACCESS_KEY_ID`,
  `OPENWOP_BLOB_S3_SECRET_ACCESS_KEY` (+ optional `_REGION` / `_ENDPOINT` /
  `_FORCE_PATH_STYLE` / `_SESSION_TOKEN` / `_PREFIX` / `_PRESIGN_TTL_SECONDS`).
  Boot fails fast if `blob=s3` but config is incomplete.

**Every** portable host surface now has a real backend: `durable` for
kv/cache/table/queue/queueBus/vector/search/nosql/fs/sql, `s3` for blob, plus
optional `opensearch`/`pgvector` scale engines; `observability` routes to the
structured logger / OTel. Only the `memory` defaults remain non-durable. Any
other id (`redis`, Postgres-schema-per-tenant `sql`, …) or new surface requires a
**registered adapter** — implement the surface interface against the real store
and `registerSurfaceAdapter(...)` per the seam file header (`durableKv.ts` /
`s3Blob.ts` are the reference patterns). **The backend refuses to boot if a
selected backend has no adapter** — it will not silently serve the in-memory store
when durability was requested. As real adapters land, each surface's advertised
`implementation` in `/.well-known/openwop` flips from a non-durable tag to the
backend id, and the UI non-durable badge self-clears.

## Prerequisites

- GCP project `openwop-dev` exists. Owner = `admin@myndhyve.ai`.
- Firebase project linked to `openwop-dev` (hosting target).
- Domain `openwop.dev` controlled at GoDaddy with editable DNS.
- gcloud CLI ≥ 510, firebase CLI ≥ 15, openssl, jq, node ≥ 22 locally.

```bash
gcloud config set account admin@myndhyve.ai
gcloud config set project openwop-dev
```

## 1. Attach a billing account

Cloud Run + Artifact Registry + Cloud Build all require billing.

```bash
gcloud beta billing accounts list                       # find an account
gcloud beta billing projects link openwop-dev \
  --billing-account=<ACCOUNT_ID>
```

## 2. Enable required APIs

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  firebasehosting.googleapis.com
```

## 3. Override the `allowedPolicyMemberDomains` org policy

The myndhyve.ai org policy denies `allUsers` IAM bindings, which blocks
public Cloud Run invocations. Override at the project level (does not
affect the org-wide policy).

```bash
cat > /tmp/allow-all-users.yaml <<'EOF'
constraint: constraints/iam.allowedPolicyMemberDomains
listPolicy:
  allValues: ALLOW
EOF
gcloud resource-manager org-policies set-policy /tmp/allow-all-users.yaml \
  --project=openwop-dev
# Propagation takes ~2 min. Test with: gcloud run services add-iam-policy-binding
```

## 4. Grant the Compute SA the Cloud Build roles

`gcloud run deploy --source` uses Cloud Build, which runs as the default
Compute SA (`<project-number>-compute@developer.gserviceaccount.com`).
It needs to read source, push images, write logs, AND access deploy-time
secrets.

```bash
PROJECT_NUMBER=$(gcloud projects describe openwop-dev --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

for role in \
  roles/storage.objectViewer \
  roles/artifactregistry.writer \
  roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding openwop-dev \
    --member="serviceAccount:$SA" \
    --role="$role" --condition=None
done
```

## 5. Generate + push session/admin secrets

```bash
SESSION_SECRET=$(openssl rand -hex 32)
ADMIN_TOKEN=$(openssl rand -hex 16)

echo -n "$SESSION_SECRET" | gcloud secrets create openwop-session-secret --data-file=-
echo -n "$ADMIN_TOKEN"    | gcloud secrets create openwop-admin-token   --data-file=-

# Save ADMIN_TOKEN — Cloud Scheduler step 9 needs it.
echo "ADMIN_TOKEN=$ADMIN_TOKEN"

# Grant the runtime SA secret-accessor on both secrets
for secret in openwop-session-secret openwop-admin-token; do
  gcloud secrets add-iam-policy-binding $secret \
    --member="serviceAccount:$SA" \
    --role="roles/secretmanager.secretAccessor"
done
```

## 6. Deploy the Cloud Run backend

The Dockerfile lives at the repo root (`Dockerfile`) and expects the build
context to be the repo root (`.`), so it can COPY `backend/typescript/...`,
`providers.json`, and the vendored `schemas/`, `packs/`, and `conformance-fixtures/`.

> **⚠️ The command below is the FIRST-TIME / from-scratch bring-up only.**
> It sets the Phase-1 config (`OPENWOP_STORAGE_DSN: memory://`, just the
> session + admin secrets). **Do NOT re-run it to ship a code update to an
> already-live service** — `--env-vars-file` and `--set-secrets` *replace*
> (not merge), so re-running it wipes everything §14 and later steps added.
> The live `openwop-app-backend` currently binds **7 secrets** (session,
> admin, the real `openwop-storage-dsn`, both VAPID keys, `minimax-api-key`,
> `openwop-messaging-bridge-token`) plus OIDC + KMS env — running the
> from-scratch command against it would drop the real DB, the managed
> "Try it free" key, Web Push, and messaging in one shot. To ship new code,
> use **[Redeploying new code to the live service](#redeploying-new-code-to-the-live-service)** below. `gcloud run services describe openwop-app-backend --region us-central1 --format='value(spec.template.spec.containers[0].env)'` is the source of truth for what's bound.

```bash
# Pull latest pack versions from the registry so we always deploy the
# most recently-patched packs (e.g., http@1.1.2 with the deterministic
# idempotency-key safety-fix, not http@1.1.1).
PACKS=$(for p in ai data http mcp triggers integration a2a agents crypto db files flow hitl messaging obs rag storage; do
  v=$(curl -s "https://packs.openwop.dev/v1/packs/core.openwop.$p/index.json" | jq -r '.latest')
  echo "core.openwop.$p@$v"
done | paste -sd,)

cat > /tmp/openwop-env.yaml <<EOF
NODE_ENV: production
OPENWOP_STORAGE_DSN: memory://
OPENWOP_BYOK_EPHEMERAL: "true"
OPENWOP_COOKIE_SECURE: "true"
OPENWOP_STRICT_REGISTRY: "true"
OPENWOP_API_KEYS: ""
OPENWOP_ENABLE_CONFORMANCE_NODES: "true"
OPENWOP_INSTALL_PACKS: "$PACKS"
EOF

# Two production-behavior knobs to know about in the env above:
#  - OPENWOP_ENABLE_CONFORMANCE_NODES="true" — conformance-only node typeIds
#    (core.conformance.mock-agent, conformance.secret.echo, …) are OFF by
#    default under NODE_ENV=production so a fork doesn't expose them; the
#    reference deploy IS a conformance target, so it MUST opt back in here (else
#    /.well-known/openwop stops advertising capabilities.conformance.mockAgent
#    and black-box conformance runs fail).
#  - OPENWOP_API_KEYS: "" is correct for this cookie-per-visitor posture — the
#    API-key path (a wildcard-tenant admin credential) stays disabled and the
#    built-in dev-token is withdrawn in prod. /readiness stays green because the
#    deploy is NOT bearer-enforced (no OPENWOP_AUTH_ENFORCE_BEARER). A deploy
#    that DOES set OPENWOP_AUTH_ENFORCE_BEARER=true MUST also provide a bearer
#    path (OPENWOP_API_KEYS or OIDC) + an OPENWOP_INTERNAL_TOKEN for sub-runs.

# Multi-instance is safe: the host-extension stores (Kanban / roster /
# org-chart / RFC 0083 trigger bridge) are READ-THROUGH on the durable kv
# table — every read/write hits storage, so instances stay consistent. (Before
# that hardening they were a boot-hydrated in-memory cache, which required
# pinning to `--max-instances=1`; if the live service is still pinned, restore
# a multi-instance value with `gcloud run services update … --max-instances=10`.)
gcloud run deploy openwop-app-backend \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --memory=512Mi --cpu=1 --concurrency=80 --max-instances=10 \
  --port=8080 --timeout=300 \
  --env-vars-file=/tmp/openwop-env.yaml \
  --set-secrets="OPENWOP_SESSION_SECRET=openwop-session-secret:latest,OPENWOP_ADMIN_TOKEN=openwop-admin-token:latest"

# Confirm public invocation works (org-policy override from step 3)
gcloud run services add-iam-policy-binding openwop-app-backend \
  --region=us-central1 --member="allUsers" --role="roles/run.invoker"
```

### Redeploying new code to the live service

Once the service exists (post-§14, with its full secret + env set), the
**only safe way to ship a code change** is to rebuild the image while
leaving the running config untouched. `gcloud run deploy` preserves the
current revision's env vars and secret bindings for any flag you omit —
so pass **no** `--env-vars-file`, `--set-env-vars`, or `--set-secrets`.

**Optional pre-deploy: refresh the vendored spec artifacts.** `gcloud run deploy --source .` uploads the repo root, which is the build context. Three artifacts the runtime image needs --- `schemas/`, `conformance-fixtures/`, and `packs/` --- live at the repo root, vendored from the upstream `openwop/openwop` spec corpus. Re-run the matching refresh script below only when the upstream spec changed since the last commit:

| Repo-root source     | Vendored at                                  | Sync script                                       |
|----------------------|----------------------------------------------|---------------------------------------------------|
| `schemas/`           | `schemas/`              | `bash scripts/sync-schemas.sh`  |
| `conformance/fixtures/` | `conformance-fixtures/` | `bash scripts/sync-fixtures.sh` |
| `packs/`             | `packs/`                | `bash scripts/sync-packs.sh`    |
| CPython-WASI runtime (pinned download) | `backend/typescript/vendor/python-3.12.0.wasm` | `bash scripts/sync-pythonwasm.sh` — **only when** enabling `OPENWOP_CODE_EXEC_RUNTIME=wasi` (ADR 0146 Phase 4a; ~25 MB, SHA-256-pinned, gitignored) |

The vendored copies are committed to git, so a clean checkout of `origin/main`
already has them. Re-run the relevant sync script only when the canonical
source changed since the last commit and the vendored copy is stale.

```bash
# From a CLEAN checkout of origin/main — never the shared working tree,
# which may carry another session's uncommitted work into the build
# context. (e.g. `git worktree add --detach /tmp/owp-deploy origin/main`)
gcloud run deploy openwop-app-backend \
  --source . \
  --region us-central1 \
  --project openwop-dev \
  --quiet
```

This builds via Cloud Build and rolls a new revision with the new image
+ the *existing* 7 secrets, OIDC/KMS env, Cloud SQL attachment, resource
limits, and `--allow-unauthenticated` IAM all carried forward unchanged.

To **add or rotate** a single binding without disturbing the rest, use the
*merge* flags — `--update-secrets="VAR=secret:latest"` or
`--update-env-vars=...` — never the `--set-*` (full-replace) forms. This is
how `MINIMAX_API_KEY` and `OPENWOP_MESSAGING_BRIDGE_TOKEN` were added after
§14 without a full re-spec. (The §14 `--set-secrets` list is itself now a
partial snapshot — it predates those two bindings, so re-running §14
verbatim would also drop them.)

> **REQUIRED in production: `OPENWOP_BYOK_ENCRYPTION_KEY`.** A SEC-3 boot guard
> (`byok/encryption.ts`) **refuses to start** under `NODE_ENV=production` if no
> stable BYOK local-AES master key is configured — it will not auto-generate a
> throwaway disk key. The managed-provider bootstrap (encrypting `MINIMAX_API_KEY`
> at rest) needs this key, so a deploy **boot-fails** without it:
> `fatal startup error … BYOK local-AES master key is not configured in production`
> → the revision never serves traffic (prod stays on the prior revision). Note
> this is **separate from `OPENWOP_BYOK_KMS_KEY`**, which only covers signed-in
> (`user:*`) tenant secrets — it does not satisfy this local-AES path. The key
> lives in the `openwop-byok-encryption-key` Secret Manager secret (a 64-hex /
> 32-byte value, `openssl rand -hex 32`); it is now bound on the service. If a
> future deploy ever drops it, re-add with the merge flag:
> `--update-secrets OPENWOP_BYOK_ENCRYPTION_KEY=openwop-byok-encryption-key:latest`.

After any deploy, confirm the binding set survived and the managed tier is
healthy:

```bash
gcloud run services describe openwop-app-backend --region=us-central1 \
  --format='value(spec.template.spec.containers[0].env)' | tr ';' '\n' | grep -i secret
curl -s https://app.openwop.dev/api/readiness   # {"status":"ready",...} — 503 if a managed key is unconfigured
```

### Verifying live agent dispatch (real model completion)

`POST /v1/host/openwop-app/agents/{agentId}/dispatch` with `{"live": true}` runs a
manifest agent's turn through the real provider pipeline. By default it routes
to the **managed tier** (no per-tenant BYOK needed), so a real completion
requires the managed key to be configured:

- **Managed tier:** set `MINIMAX_API_KEY` (the `openwop-free` tier is
  MiniMax-backed) and restart; `/api/readiness` turns green. Then a `live`
  dispatch produces a real completion.
- **BYOK:** issue a tenant secret for a real provider (anthropic / openai /
  google) and dispatch with `{"live": true, "provider": "<id>", "model": "<id>"}`
  (the resolver honors an explicit pin; `callAI` is the provider gate).

Two automated checks back this:

- **In-sandbox, no key** — `test/agent-dispatch-live-real.test.ts` exercises the
  full `callAI → dispatchStructured` pipeline (structured-output validation, §F
  escalation, usage emission, SR-1) through the keyless `mock` provider. Runs in
  CI.
- **Real provider, opt-in** — `test/agent-dispatch-live-managed.test.ts` is
  skipped unless `OPENWOP_VERIFY_LIVE=1`; with `MINIMAX_API_KEY` set it confirms
  an actual managed-tier completion. Never runs in CI.

```bash
MINIMAX_API_KEY=... OPENWOP_VERIFY_LIVE=1 \
  npx vitest run test/agent-dispatch-live-managed.test.ts
```

### Feature toggle: warm-instance posture

By default the deploy above uses `min-instances=0` (Cloud Run evicts
the container after ~15 min of no traffic). That's the cheapest
posture (~$0/mo idle) but introduces the cold-start UX the AI chat
surface mitigates with its "Waking up the server…" card.

To eliminate cold starts entirely — at a cost of ~$30-40/month for
a single always-warm `cpu=1, memory=512Mi` instance — flip the
posture **without redeploying** by running this one-liner against
the existing service:

```bash
gcloud run services update openwop-app-backend \
  --region=us-central1 \
  --min-instances=1 \
  --no-cpu-throttling
```

`--no-cpu-throttling` is what makes `min-instances=1` actually
keep the container warm; without it, the idle instance gets CPU
throttled to ~5% and the *first* request still pays a partial
warmup cost.

To revert to the cost-saving posture later:

```bash
gcloud run services update openwop-app-backend \
  --region=us-central1 \
  --min-instances=0 \
  --cpu-throttling
```

The FE's cold-start UX gracefully handles both postures — it
adapts based on `lastSuccessAt` in localStorage rather than
hard-coding cold-start assumptions. So you can flip the toggle
either way without coordinating a FE redeploy.

### Insights Suite — Workday connector (stage before enabling in prod)

The **Insights & Drafting Suite** (toggle `insights-suite`, ADR 0082) drives two of its
three workflows off a `core.workday.query` connector node. That node and the `workday`
builtin provider ship with **mock-broker tests only** — there is no automated coverage of a
real Workday tenant, so **the first production deploy is the first real exercise** of the
integration-system-user (ISU) auth + per-tenant URL construction (`{instance}.workday.com/{tenant}`).

Before flipping the `insights-suite` toggle ON for a real tenant:

1. Stand up a Workday **sandbox** tenant + API Client (ISU) and mint a refresh token (the
   unattended/scheduled path rides a refreshable OAuth connection; interactive chat runs use
   OAuth2 PKCE).
2. Create the connection and run the `anniversary-draft` / `talent-prep` workflows once
   against the sandbox; confirm the `core.workday.query` node returns rows (not a 401/URL error).
3. Only then enable the toggle in production.

The suite is **OFF by default**, so a deploy that skips this is safe — the connector simply
isn't reached until an operator opts a tenant in. See ADR 0082 § "Live-creds caveat".

### Optional: media → text for RAG (OCR + transcription) — ADR 0108/0110/0111

KB ingest can turn **images** (OCR) and **audio** (transcription) into searchable RAG text —
for manual uploads AND drive-synced files (knowledge-sync, ADR 0107). It's **OFF by default**
(it bills provider tokens), gated by two env vars. Enable WITHOUT a rebuild (incremental
update preserves all other config):

```
gcloud run services update openwop-app-backend \
  --update-env-vars OPENWOP_KB_OCR_ENABLED=true,OPENWOP_KB_TRANSCRIBE_ENABLED=true \
  --region us-central1 --project openwop-dev
```

- **Needs a multimodal model.** The managed reference target is **MiniMax (text-only)**, so
  media routes to the tenant's **Default AI provider** — a BYOK binding `{provider, model,
  credentialRef}` set on the SPA's **`/keys` page** ("Default AI provider for media"). Use a
  vision/audio-capable model — **`gemini-3.1-flash-lite`** is the recommended Gemini default
  (audio needs Google; Anthropic/OpenAI are vision-only). Without a capable provider, media
  ingest returns an honest `422` (text/PDF/Office ingest is unaffected).
- **Cost is governed** — audio pre-flights the per-org `mediaBudget('stt')` byte budget; a
  per-sync-source "include media" toggle bounds drive-sync blast (`PATCH …/knowledge-sync/:id`).
- **Long audio** (> ~15 MiB) auto-uploads via the Gemini File API; manual upload caps at
  200 MiB, drive-sync the same. Synced content is fenced **untrusted**.

## 7. Firebase Hosting + custom domain

```bash
# Create the new hosting site + bind the `app` target
firebase hosting:sites:create app-openwop-dev --project openwop-dev
firebase target:apply hosting app app-openwop-dev --project openwop-dev

# Build the SPA. The production env vars (VITE_OPENWOP_BASE_URL=/api,
# VITE_OPENWOP_AUTH_MODE=cookie) live in `.env.production` at the
# frontend root and Vite auto-loads them. `vite.config.ts` asserts
# baseUrl is non-default in production mode, so a missing `.env.production`
# aborts the build instead of silently shipping the dev fallback.
( cd frontend/react && npm run build )

# Deploy
firebase deploy --only hosting:app --project openwop-dev

# Attach custom domain via REST API (gcloud doesn't have a Firebase
# Hosting custom-domains command in 510)
TOKEN=$(gcloud auth print-access-token)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: openwop-dev" \
  -H "content-type: application/json" \
  "https://firebasehosting.googleapis.com/v1beta1/projects/openwop-dev/sites/app-openwop-dev/customDomains?customDomainId=app.openwop.dev" \
  -d '{}'

# The response contains DNS records you need to add at GoDaddy.
# Verify ownership TXT + the CNAME / _acme-challenge TXT propagate:
dig +short app.openwop.dev CNAME
dig +short TXT _acme-challenge.app.openwop.dev

# Re-poll status (`cert.state` → `CERT_ACTIVE` when Let's Encrypt finishes):
curl -s -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: openwop-dev" \
  "https://firebasehosting.googleapis.com/v1beta1/projects/openwop-dev/sites/app-openwop-dev/customDomains/app.openwop.dev" | jq '{hostState, ownershipState, "cert.state": .cert.state}'
```

## 8. Firebase Hosting → Cloud Run invoker grant

The Firebase Hosting service agent (auto-provisioned on first deploy)
needs `run.invoker` on the backend service. The agent doesn't always
exist at deploy time — grant the `firebase-adminsdk` SA as a fallback
that Firebase Hosting uses for `run:` rewrites:

```bash
gcloud run services add-iam-policy-binding openwop-app-backend \
  --region=us-central1 \
  --member="serviceAccount:firebase-adminsdk-fbsvc@openwop-dev.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
```

## 9. Cloud Scheduler — daily cleanup cron

```bash
ADMIN_TOKEN=$(gcloud secrets versions access latest --secret=openwop-admin-token)
gcloud scheduler jobs create http openwop-app-daily-cleanup \
  --location=us-central1 \
  --schedule="0 3 * * *" --time-zone="UTC" \
  --uri="https://app.openwop.dev/api/v1/host/openwop-app/admin/cleanup" \
  --http-method=POST \
  --headers="Authorization=Bearer ${ADMIN_TOKEN}" \
  --description="Daily wipe of expired anon-session BYOK secrets + tenant trackers" \
  --attempt-deadline=60s --max-retry-attempts=3

# Test-fire (optional)
gcloud scheduler jobs run openwop-app-daily-cleanup --location=us-central1
```

## 10. Smoke

```bash
bash DEPLOY-SMOKE.md  # the seven-step sequence
# Or run the curl commands from that file inline.
```

## Phase 3 — Signed-in tier (Firebase Auth + Cloud SQL + KMS)

Phase 3 layers persistent storage on top of the anon cookie tier. Anonymous
visitors keep working exactly as before; signed-in users (Google or
GitHub via Firebase Auth) get persistent runs + workflows + BYOK secrets,
KMS-encrypted at rest.

### 11. Cloud SQL Postgres

```bash
# Create a small Postgres 15 instance (~$10/mo at the cheapest tier).
gcloud sql instances create openwop-app-pg \
  --database-version=POSTGRES_15 \
  --tier=db-f1-micro \
  --region=us-central1 \
  --storage-type=SSD \
  --storage-size=10 \
  --backup-start-time=04:00 \
  --availability-type=ZONAL

# Create the application database + user.
gcloud sql databases create openwop --instance=openwop-app-pg
gcloud sql users create openwop_app --instance=openwop-app-pg \
  --password="$(openssl rand -base64 32 | tr -d '+/=')"

# Connection string lives in Secret Manager.
DB_PASSWORD=$(gcloud sql users list --instance=openwop-app-pg \
  --filter='name:openwop_app' --format='value(name)')  # placeholder; copy from the create command output
INSTANCE_CONN=$(gcloud sql instances describe openwop-app-pg \
  --format='value(connectionName)')
DSN="postgresql://openwop_app:${DB_PASSWORD}@/openwop?host=/cloudsql/${INSTANCE_CONN}"
printf '%s' "$DSN" | gcloud secrets create openwop-storage-dsn --data-file=-
```

### 12. KMS key for BYOK envelope encryption

```bash
gcloud kms keyrings create openwop-byok --location=us-central1
gcloud kms keys create dek-wrap \
  --keyring=openwop-byok --location=us-central1 \
  --purpose=encryption \
  --rotation-period=90d \
  --next-rotation-time="$(date -u -v+90d '+%Y-%m-%dT%H:%M:%SZ')"

# Grant the Cloud Run runtime SA encrypt/decrypt on the key.
RUNTIME_SA=$(gcloud run services describe openwop-app-backend \
  --region=us-central1 --format='value(spec.template.spec.serviceAccountName)')
gcloud kms keys add-iam-policy-binding dek-wrap \
  --keyring=openwop-byok --location=us-central1 \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/cloudkms.cryptoKeyEncrypterDecrypter
```

### 13. Firebase Auth — providers + OAuth client redirect URIs

In the Firebase console (`https://console.firebase.google.com/project/openwop-dev/authentication`):
1. Authentication → Sign-in method → enable Google + GitHub providers.
2. Authentication → Settings → Authorized domains: confirm `app.openwop.dev`
   is listed AND `localhost` is listed (the latter auto-added; needed if you
   want to test sign-in via `npm run dev`).
3. Firebase web app must exist BEFORE you can fetch its config in step 15.
   Create it once:
   ```bash
   firebase apps:create WEB "app.openwop.dev" --project=openwop-dev
   ```

The OIDC issuer for Firebase ID tokens is:
- Issuer: `https://securetoken.google.com/openwop-dev`
- Audience: `openwop-dev` (the project id)
- JWKS: `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`

**OAuth client redirect URIs (mandatory manual step):** Firebase Auth's
**Authorized domains** list controls which *origins* can initiate sign-in. The
**redirect URIs** for the underlying OAuth clients are a separate concept that
Firebase only auto-syncs for the default `*.firebaseapp.com` domain. For a
custom domain you must add it manually:

- **Google** — `https://console.cloud.google.com/apis/credentials?project=openwop-dev`.
  Open the "Web client (auto created by Google Service)" entry. Add to
  **Authorized JavaScript origins**: `https://app.openwop.dev`. Add to
  **Authorized redirect URIs**: `https://app.openwop.dev/__/auth/handler`.
  Without this Google rejects sign-in with `Error 400: redirect_uri_mismatch`.
- **GitHub** — `https://github.com/settings/developers` → your "openwop-dev"
  OAuth app. Add `https://app.openwop.dev/__/auth/handler` to the
  **Authorization callback URL** list. (GitHub allows only ONE callback URL
  per app; if you want both the default and custom domains to work, either
  pick one OR create a second GitHub OAuth app.)

Changes propagate near-instantly; Google docs claim up to a few hours.

### 14. Re-deploy Cloud Run with Phase 3 env

The default `--update-env-vars` separator is `,`, but the JWKS URL contains
literal `@` and commas in some hosts, so we use the `^|^` custom-separator
form. If a previous deploy set `OPENWOP_STORAGE_DSN` as a plain env var, it
must be removed first — Cloud Run refuses to swap "plain env" → "secret env"
under the same name.

```bash
# One-time cleanup if step 6 left OPENWOP_STORAGE_DSN as a plain env var.
gcloud run services update openwop-app-backend \
  --region=us-central1 --remove-env-vars=OPENWOP_STORAGE_DSN

# Re-build the image from source so the bundle has the P3 code (Postgres
# adapter, OIDC verifier, KMS bootstrap). `--source` triggers Cloud Build.
gcloud run deploy openwop-app-backend \
  --source . \
  --region us-central1 --allow-unauthenticated \
  --memory=512Mi --cpu=1 --concurrency=80 --max-instances=10 \
  --port=8080 --timeout=300 \
  --env-vars-file=/tmp/openwop-p3-env.yaml \
  --set-secrets='OPENWOP_SESSION_SECRET=openwop-session-secret:latest,OPENWOP_ADMIN_TOKEN=openwop-admin-token:latest,OPENWOP_STORAGE_DSN=openwop-storage-dsn:latest,OPENWOP_VAPID_PUBLIC_KEY=openwop-vapid-public-key:latest,OPENWOP_VAPID_PRIVATE_KEY=openwop-vapid-private-key:latest' \
  --add-cloudsql-instances=openwop-dev:us-central1:openwop-app-pg
```

**Web Push (PR #174)** binds two additional secrets:
`OPENWOP_VAPID_PUBLIC_KEY` + `OPENWOP_VAPID_PRIVATE_KEY`. Generate the
keypair once at bootstrap with `npx web-push generate-vapid-keys
--json`, then load each value into Secret Manager as in §5. Absent
env vars → push fanout no-ops gracefully (the FE just hides the
"Enable background push" affordance via the `/config` endpoint).

Where `/tmp/openwop-p3-env.yaml` contains:

```yaml
NODE_ENV: production
OPENWOP_BYOK_EPHEMERAL: "true"
OPENWOP_COOKIE_SECURE: "true"
OPENWOP_STRICT_REGISTRY: "true"
OPENWOP_API_KEYS: ""
OPENWOP_INSTALL_PACKS: "core.openwop.ai@1.1.1,…"
OPENWOP_OIDC_ISSUER: "https://securetoken.google.com/openwop-dev"
OPENWOP_OIDC_AUDIENCE: "openwop-dev"
OPENWOP_OIDC_JWKS_URL: "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
OPENWOP_BYOK_KMS_KEY: "projects/openwop-dev/locations/us-central1/keyRings/openwop-byok/cryptoKeys/dek-wrap"
```

**Gotcha**: the bundled image's `package.json` must declare every runtime
dependency the bundled code imports. Esbuild bundles with `--packages=external`
+ the runtime stage does `npm install --omit=dev`, so transitive-only deps
disappear at runtime. After P3 landed, the missing one was `ajv` (used by
`src/host/mcpServerRouter.ts` but only present transitively via
`@openwop/openwop-conformance` dev-dep). Add `ajv` to `dependencies` in
`backend/typescript/package.json` if you see
`Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ajv'` in revision logs.

### 15. Frontend Firebase config + Hosting headers

Fetch the web-app config (step 13 must have created the WEB app first):

```bash
# Find the appId
APP_ID=$(firebase apps:list --project=openwop-dev | awk '/WEB/ {print $4}')
firebase apps:sdkconfig WEB "$APP_ID" --project=openwop-dev
```

Copy `apiKey`, `authDomain`, `projectId` into
`frontend/react/.env.production`.

**Critical**: `VITE_FIREBASE_AUTH_DOMAIN` must be the SAME custom domain that
serves the SPA (`app.openwop.dev`), NOT the default `*.firebaseapp.com`.
Reason: redirect-based sign-in persists in-flight auth state into the
auth-domain origin's storage. If `authDomain ≠ SPA origin`, the embedded
auth iframe on the SPA is third-party and modern browsers (Safari ITP / Brave
Shields / Firefox TCP) partition its storage → `getRedirectResult` returns
null and sign-in is silently dropped. Firebase Hosting auto-proxies
`/__/auth/*` on custom domains, so this just works once you point authDomain
at the custom domain. See commit `e785890` for the full root-cause analysis.

`firebase.json` Hosting headers (`/index.html` MUST have `Cache-Control:
no-cache, no-store, must-revalidate` AND `Cross-Origin-Opener-Policy:
same-origin-allow-popups` on the SAME source rule — Firebase Hosting only
applies headers from the LAST-matching source per request, so two separate
rules covering the same path will lose one):

```json
{
  "source": "**/!(*.@(js|css|svg|png|jpg|jpeg|webp|avif|ico|woff|woff2|map))",
  "headers": [
    { "key": "Cache-Control", "value": "no-cache, no-store, must-revalidate" },
    { "key": "Cross-Origin-Opener-Policy", "value": "same-origin-allow-popups" }
  ]
}
```

Without the no-cache directive, Firebase Hosting caches `index.html` for ~1
hour, so newly-deployed bundles aren't picked up until the cache expires.

### 16. Smoke the Phase 3 surface

```bash
# Anon-tier still works (no auth).
curl -i -X POST https://app.openwop.dev/api/v1/runs \
  -H 'content-type: application/json' \
  -d '{"workflowId":"openwop-app.uppercase","tenantId":"","inputs":{"text":"hi"}}'

# Sign in via the SPA, copy the ID token from devtools, then:
curl -i https://app.openwop.dev/api/v1/runs \
  -H "authorization: Bearer <ID_TOKEN>"

# BYOK secret set as signed-in user
curl -i -X POST https://app.openwop.dev/api/v1/host/openwop-app/byok/secrets \
  -H "authorization: Bearer <ID_TOKEN>" \
  -H 'content-type: application/json' \
  -d '{"credentialRef":"TEST_KEY","value":"sk-test"}'
```

## Phase 3 production-rollout gotchas (post-mortem)

Every item below was a real bug we hit during the initial app.openwop.dev
deploy. Documented here so the next bootstrap doesn't have to repeat the
debug cycle.

- **Session cookie name must be `__session`.** Firebase Hosting strips every
  cookie *except* `__session` from requests it forwards to Cloud Run, so
  any other name is silently dropped on every API call. The backend reads
  the cookie name from `OPENWOP_SESSION_COOKIE_NAME` (default `__session`).
  Behind a reverse proxy that doesn't strip cookies, you can override.

- **Redirect-based sign-in beats popup-based** for any auth flow that runs
  in a browser with strict COOP defaults. `signInWithPopup`'s polling of
  `window.closed` triggers `Cross-Origin-Opener-Policy would block` warnings
  on every poll, persistent through the auth flow. The redirect flow has no
  popup and no warnings. The trade-off is two full page reloads for the
  link-account flow (Google rejected + Google signed in to complete the
  link).

- **`Cross-Origin-Opener-Policy: same-origin-allow-popups`** belongs on
  every Hosting response, but `same-origin` (the browser default for
  documents without an explicit header) blocks popup auth. The redirect
  flow doesn't strictly need this; we set it anyway as defense in depth
  for adopters who fork the SPA and revert to popups.

- **`authDomain` MUST be the SPA's custom domain.** See step 15 above.
  Without this, `getRedirectResult` returns null after a successful OAuth
  round-trip because the auth state was persisted into the default-domain
  origin's partitioned third-party storage.

- **Modal portal**: any modal whose JSX lives inside a `position: sticky`
  + `backdrop-filter` ancestor must portal out to `document.body` via
  `createPortal`. Both properties create stacking contexts that cap the
  modal's z-index. The `<SignInButton>` modal originally rendered behind
  `<main>` because the `<header>` had both. Fix: portal both the sign-in
  and delete-account modals out.

- **Rules of Hooks**: any `useEffect` after a conditional return is a
  ticking time bomb that detonates on the first render where the
  conditional flips. `InMemoryHostBanner` had `if (user) return null;` BEFORE
  a `useEffect` and crashed the whole SPA the moment a user signed in.
  Eslint-plugin-react-hooks catches this if enabled; we don't ship a
  lint config in this repo yet so use it locally
  (`npx eslint --plugin react-hooks ...`) before sharing screenshots.

- **Local dev points at prod by default.** `frontend/
  react/vite.config.ts` proxies `/api/**` to `https://app.openwop.dev` so
  `npm run dev` in the frontend dir works end-to-end against the deployed
  backend without spinning up a local Postgres / KMS / Firebase Auth. The
  proxy rewrites the `__session` cookie's Domain to `localhost` so cookies
  travel. Override with `OPENWOP_DEV_PROXY_TARGET=http://localhost:8080`
  to point at a locally-running backend.

## Roll-forward a new pack version

Step 6's `PACKS=$(...)` block always resolves `latest` from the registry,
so re-running steps 6–7 picks up freshly-published pack versions
automatically. Use this when a pack ships a safety fix (e.g.,
`core.openwop.http@1.1.2` after the deterministic idempotency-key fix
in commit `49dd801`).

## Roll-back

```bash
# Cloud Run keeps every revision. Roll back via traffic split:
gcloud run services update-traffic openwop-app-backend \
  --region=us-central1 --to-revisions=openwop-app-backend-00001-8hd=100
# Firebase Hosting keeps prior versions too:
firebase hosting:rollback --site=app-openwop-dev --project openwop-dev
```

> **Traffic follows latest — and a `--to-revisions` rollback PINS it.** The service's
> traffic is configured `--to-latest` (`spec.traffic: {latestRevision: true, percent: 100}`),
> so a bare `gcloud run deploy` auto-migrates 100% to the new revision (as the deploy
> steps above assume). **But the rollback command pins traffic to a *specific* revision** —
> once pinned, the service stops following latest, and every subsequent bare deploy
> **builds a new revision that comes up at 0%** (a "successful" deploy that silently ships
> nothing; prod stays on the pinned revision). After a rollback, **restore auto-migrate**
> once the fix is out, or the next deploy won't serve:
> ```bash
> gcloud run services update-traffic openwop-app-backend \
>   --region=us-central1 --project openwop-dev --to-latest
> ```
> To smoke a revision *before* it serves prod, deploy it dark and verify a tag URL first:
> `gcloud run deploy … --no-traffic`, then `--update-tags verify=<rev>`, smoke the
> `verify---…run.app` URL, then `--to-revisions=<rev>=100` (and `--to-latest` to un-pin).

## Decommissioning

```bash
gcloud scheduler jobs delete openwop-app-daily-cleanup --location=us-central1
gcloud run services delete openwop-app-backend --region=us-central1
firebase hosting:sites:delete app-openwop-dev --project openwop-dev
# Remove the custom-domain entry via the REST API DELETE on the same
# /customDomains/app.openwop.dev resource.
# Remove the GoDaddy DNS records (CNAME app, TXT _acme-challenge.app).
# Optionally restore the org policy if you decommission permanently:
gcloud resource-manager org-policies delete \
  constraints/iam.allowedPolicyMemberDomains --project=openwop-dev
# And destroy the secrets:
gcloud secrets delete openwop-session-secret
gcloud secrets delete openwop-admin-token
```
