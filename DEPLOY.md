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
| `OPENWOP_BYOK_ENCRYPTION_KEY` | `printf '%s' "$(openssl rand -hex 32)"` | **Required in the `auth` posture, INCLUDING when `OPENWOP_BYOK_KMS_KEY` is set.** The two are not alternatives: KMS envelope-encrypts signed-in tenant secrets, while the local-AES path keeps its own master key and is still reached at boot. Setting only KMS fails closed with *"BYOK local-AES master key is not configured in production"* (SEC-3 refuses to mint a throwaway disk key — one generated on a fresh Cloud Run instance is unrecoverable across restarts and gives false at-rest assurance). Only `OPENWOP_BYOK_EPHEMERAL=true` deploys, like the live demo, skip it. **Never rotate it once live** — anything encrypted under it becomes unreadable. Use `printf '%s'`, not a bare pipe: see the secret-seeding note below. |

### Optional AI capabilities (off by default — honest-off until configured)

These three surfaces ship **dark by default** and advertise nothing until an operator
wires them. The code + the chat agent personas are already on the image; they just
return a capability-missing result until the matching env is set. All are merge-updates
(`--update-env-vars` / `--update-secrets`), never `--set-*` (see the [§ White-label] note
about preserving live config).

| Capability (ADR) | Env to enable | Notes |
|---|---|---|
| **Code execution** (ADR 0114 + 0146) — the *Code Interpreter* chat agent | **Managed sandbox (recommended for a new deploy — ADR 0114 Phase 8):** `OPENWOP_CODE_EXEC_PROVIDER=e2b` + `OPENWOP_E2B_API_KEY=<e2b key>`. **In-process WASI is ON BY DEFAULT** (just sync the asset). **External (self-hosted Code-API):** `OPENWOP_CODE_EXEC_ENDPOINT=https://<your-code-api>` (+ `OPENWOP_CODE_EXEC_KEY`). **Opt out of WASI:** `OPENWOP_CODE_EXEC_RUNTIME=off` | **E2B (ADR 0114 Phase 8)** is the easiest way to get **working code-exec** on a new deploy without standing up a bespoke Code-API service: get an API key from the E2B dashboard, then set `OPENWOP_CODE_EXEC_PROVIDER=e2b` + `OPENWOP_E2B_API_KEY` — the capability lights up (`supported:true`) against E2B's isolated micro-VMs, which genuinely enforce the CPU/mem/fs/network isolation the OPERATOR CONTRACT assumes. It is **operator-validated** against E2B's documented REST API (create → exec → kill; egress SSRF-pinned to the `e2b.dev` eTLD+1), and rides the same per-tenant budget + concurrency cap + HITL approval as every other adapter. **Selection precedence (explicit):** `e2b` (provider + key) → `OPENWOP_CODE_EXEC_ENDPOINT` (Code-API) → in-process WASI → honest-off (`capability_not_provided`). A `provider=e2b` with a MISSING key falls through to the next tier (never a hard error). **WASI** runs CPython in-process under Node's `node:wasi` — a *sound* boundary (no `js` FFI; no host fs/env/network), Python-only, ~36 ms cold start. It is **on by default whenever `backend/typescript/vendor/python-3.12.0.wasm` is present**, so the **build MUST run `bash scripts/sync-pythonwasm.sh`** (vendors the ~25 MB binary) — a host that never synced it stays honest-off → `capability_not_provided` (no false advertisement). The self-hosted **Code-API** (a LibreChat-style service; strong isolation + polyglot) remains the escape hatch when its endpoint is set and no E2B provider is selected; `=off` forces honest-off. **Memory is best-effort under WASI** (a hard cap needs the deferred ADR 0146 Phase 4b; note on Cloud Run `/tmp` is tmpfs/RAM, so guest scratch writes count against instance memory) — size the instance + keep `OPENWOP_CODE_EXEC_MAX_CONCURRENT` (default 8) modest. Captured stdout/stderr is read-capped by `OPENWOP_CODE_EXEC_MAX_OUTPUT_BYTES` (default 1 MB) so a huge print can't OOM the host. Optional: `OPENWOP_CODE_EXEC_LANGUAGES` (external default `python,javascript,typescript,bash,ruby,go`; WASI advertises `python` only), `OPENWOP_CODE_EXEC_MAX_PER_DAY` (per-tenant daily cap, default 100; `0`/unset = uncapped). Execution is gated behind a per-run HITL approval. |
| **Image generation** (ADR 0115) — the *Image Generator* chat agent | `OPENWOP_IMAGE_PROVIDER_ENABLED=true` **and** `OPENWOP_IMAGE_PROVIDER_ENDPOINT=https://<provider>` (+ `OPENWOP_IMAGE_PROVIDER_KEY`) | Flips `imageGeneration.supported` in discovery only when enabled. Per-provider routing: `OPENWOP_IMAGE_PROVIDER_ENDPOINT_<PROVIDER>` / `_KEY_<PROVIDER>` (e.g. `_GOOGLE` for Imagen) override the generic endpoint, so `openai` and `google` can route to their own backends; the generic endpoint is the fallback. SSRF-guarded; the endpoint is never echoed (§D). Without it, `callImageGenerator` returns `host_capability_missing`. |
| **Self-hosted / OpenAI-compatible providers** (ADR 0121 / RFC 0108) — the Keys-page connect form | `OPENWOP_COMPAT_PROVIDER_ENABLED=true` | The operator opt-in that exposes the `/compat-endpoints` config surface (the **Self-hosted / OpenAI-compatible endpoints** card on `/keys`) so tenants can add an Ollama / LM Studio / vLLM / any compat base URL. RFC 0108 is Accepted, so the `aiProviders.selfHosted[]` advertisement is honest once a reachable endpoint is configured. Per-endpoint base URL + optional key are stored via BYOK (the key never returns to the FE); declared capabilities (vision/tools/long-context) are taken from what the tenant sets (the host can't probe a black box). SSRF-guarded. |

All three keep the per-tenant feature posture intact — they are **operator** opt-ins (env on
the service), not per-user toggles. The chat agents (`Code Interpreter`, `Image Generator`)
are already discoverable in the agent picker regardless; they simply gain a working tool once
the capability is wired.

### LLM observability — OTel tracing + browser spans (ADR 0118)

Span export is **env-gated infra** (default off; no toggle). Set
`OTEL_EXPORTER_OTLP_ENDPOINT` on the backend to export the per-turn / per-dispatch
spans (`openwop.chat.turn`, `openwop.provider.dispatch`) to any OTLP collector.
Spans carry **structured attributes only** — provider/model/token/latency and the
allowlisted `openwop.*` metadata — **never** prompt/response bytes, PII, or
credentials (the `safeSpanAttributes` allowlist is the single enforcement point).

- **OpenInference compatibility (Phase 6).** Each span also carries the raw
  `openinference.span.kind` attribute (`LLM` on a provider dispatch), so
  off-the-shelf GenAI trace viewers — **Arize Phoenix, Langfuse, Grafana Tempo** —
  classify the span without any openwop-specific config. It's a fixed closed enum
  outside the `openwop.*` namespace (no content/credential risk by construction).
- **Optional Langfuse sink (Phase 4).** `OPENWOP_LANGFUSE_HOST` /
  `_PUBLIC_KEY` / `_SECRET_KEY` add a second OTLP exporter on the same span tree
  (Basic auth from host-side keys — never on the wire).
- **Browser-side OTel (Phase 6).** Set `VITE_OTEL_EXPORTER_OTLP_ENDPOINT` **at
  frontend BUILD time** (`.env.production` / build env) to lazily bootstrap
  `@opentelemetry/sdk-trace-web` in the SPA. It auto-instruments the SPA's own
  `fetch` calls, so a browser-perceived request span becomes the **parent** of the
  matching backend span — client-perceived latency correlates directly with the
  server trace. Browser spans carry **only route/timing/status** (no PII, no
  bodies). The **collector must accept CORS from the SPA origin**. The whole
  OTel-web SDK ships in a **separate lazy async chunk** — unset ⇒ zero entry-bundle
  cost, no browser tracing. (The cross-origin `*.run.app` SSE stream deliberately
  does NOT get a `traceparent` header — that would trip a CORS preflight and break
  SSE.)

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

In the `auth` posture the boot guard (ADR 0195, corrected by ADR 0636) requires
every surface that **has** a durable adapter to use one. Two do not have one under
the `durable` id — `blob` (only `s3`) and `observability` (none) — so the working
auth configuration is:

```bash
OPENWOP_SURFACE_BACKEND=durable
OPENWOP_SURFACE_OBSERVABILITY=memory        # no durable adapter exists; not counted
OPENWOP_SURFACE_BLOB=s3                     # + OPENWOP_BLOB_S3_* — or:
OPENWOP_SURFACE_BLOB=memory                 #   ephemeral uploads, acknowledged BY NAME:
OPENWOP_ALLOW_INMEMORY_SURFACES=blob
```

The acknowledgement is a comma list of surface keys; `true` also boots but makes
**every** surface ephemeral, which is the case the guard exists to catch. Both boot
errors print the exact lines to add.

**Upgrade ordering (ADR 0636):** the list form is understood from `093014619`
onward; every older backend reads the hatch as a strict `=== 'true'`, so
`=blob` on an older revision REFUSES TO BOOT. Set the list form in the same deploy
that ships the new code — never as a config-only update to a revision that
predates it.

Shipped backends:

- `memory` — the in-memory tier (default; process-local, wiped on restart).
- `durable` — backs **`kv`, `cache`, `table`, `queue`, `queueBus`, `vector`,
  `search`, `nosql`, `fs`, `sql`, and `memory`** (`OPENWOP_SURFACE_<KEY>=durable`;
  NOT `blob` or `observability` — see the `auth` note above). Real adapters
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

# `echo -n` / `printf '%s'` is load-bearing — NOT decoration. A bare
# `openssl rand -hex 32 | gcloud secrets create --data-file=-` stores openssl's
# TRAILING NEWLINE, so the secret is 65 bytes and every consumer sees the `\n`.
# `OPENWOP_BYOK_ENCRYPTION_KEY` is validated `^[0-9a-f]{64}$` and rejects it by
# name; the admin token is not, so it just fails a length check inside
# timingSafeEqual and every admin request 401s with nothing in the log pointing
# at the secret. (The host now trims these at read and warns once — see
# `src/host/secretEnv.ts` — but the stored value should still be exact.)
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
#  - OPENWOP_API_KEYS entries are `<key>` or `<key>:<tenant>` (ADR 0561). A BARE
#    key is scoped to the `default` tenant; cross-tenant operator access must be
#    written explicitly as `<key>:*`. Before ADR 0561 every configured key got
#    the wildcard implicitly, so a deployment upgrading from that behaviour must
#    append `:*` to any key it expects to read across tenants.
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
# the RECONCILED multi-instance value with `gcloud run services update …
# --max-instances=5` (NOT 10 — see the pg connection budget note below).
#
# VOICE + multi-instance (CS-VX-1, 2026-07-09): the realtime session registry
# is durable (a Gemini /tool-call landing on a non-minting instance recovers
# its binding), but the live AUDIO plumbing — walkie buffers, the OpenAI
# sideband WebSocket, firewall seen-sets — is inherently instance-local. If
# realtime voice is enabled on a multi-instance service, ALSO enable Cloud Run
# session affinity so a call's requests stick to one instance:
#   gcloud run services update openwop-app-backend --session-affinity \
#     --region us-central1 --project openwop-dev
# (Best-effort affinity; the durable registry covers the tool-call edge when
# affinity misses.)
# ⚠ PG CONNECTION BUDGET (ADR 0481 Gate A / ADR 0335): the pool rule is
# OPENWOP_PG_POOL_MAX × --max-instances ≤ max_connections − ~3.
# db-f1-micro allows ~25 connections, so the reconciled posture is
# OPENWOP_PG_POOL_MAX=4 with --max-instances=5 (4×5=20 ≤ ~22). The default
# poolMax is 10 — deploying with defaults at --max-instances=10 would demand
# 100 connections, 4× the tier. Verify the LIVE posture on deploy day:
#   gcloud run services describe openwop-app-backend --region us-central1 \
#     --format='value(spec.template.metadata.annotations.autoscaling.knative.dev/maxScale)'
#   (and confirm OPENWOP_PG_POOL_MAX=4 in the service env.)
#
# ⚠ A TAGGED REVISION COSTS A FULL POOL, EVEN AT 0% TRAFFIC. The budget above
# counts `pool × maxScale + tags × pool`, because a tagged revision stays
# routable and is kept warm with its own connections. MEASURED 2026-09-15 on
# kicktodo: a single `harden` tag left on a 0%-traffic revision took the sum to
# `4×5 + 1×4 = 24 > 22 usable` and preflight ABORTED the next deploy — correctly.
# The tag was read as "traffic-inert", which it is for traffic and is not for
# connections.
#   Rule: verify an env-only revision on its tagged URL and REMOVE the tag in the
#   SAME step (`gcloud run services update-traffic <svc> --remove-tags <tag>`),
#   before anyone else preflights. Reads of a revision — `revisions describe`,
#   boot logs — need no tag at all.
#
# ⚠ A BIGGER CLOUD SQL TIER DOES NOT RAISE `max_connections`. Upgrading
# `db-f1-micro` → `db-custom-1-3840` (2026-09-15) left `max_connections` at 25,
# so the usable 22 is unchanged. Capacity and connection budget are independent
# knobs on this tier — do not treat a tier bump as headroom for more instances,
# tags, or a larger pool. Re-read `max_connections` after any tier change rather
# than inferring it.
gcloud run deploy openwop-app-backend \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --memory=512Mi --cpu=1 --concurrency=80 --max-instances=5 \
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
| `schemas/`           | `schemas/`              | `bash scripts/sync-schemas.sh --tag openwop-conformance/vX.Y.Z` (recorded in `schemas/CORPUS_TAG`, which `check-vendored-schemas.mjs` requires to match the installed suite) |
| `conformance/fixtures/` | `conformance-fixtures/` | `bash scripts/sync-fixtures.sh --tag openwop-conformance/vX.Y.Z` — the tag whose version equals the installed `@openwop/openwop-conformance`, which is what `check-vendored-fixtures.mjs` asserts against |
| `packs/`             | `packs/`                | `bash scripts/sync-packs.sh`    |
| CPython-WASI runtime (pinned download) | `backend/typescript/vendor/python-3.12.0.wasm` | `bash scripts/sync-pythonwasm.sh` — **only when** enabling `OPENWOP_CODE_EXEC_RUNTIME=wasi` (ADR 0146 Phase 4a; ~25 MB, SHA-256-pinned, gitignored) |

The vendored copies are committed to git, so a clean checkout of `origin/main`
already has them. Re-run the relevant sync script only when the canonical
source changed since the last commit and the vendored copy is stale.

> **Both corpus syncs read a TAG, not the sibling clone's working tree.**
> `sync-schemas.sh` and `sync-fixtures.sh` refuse without `--tag` and then
> `git archive` that tag into a scratch dir. So the sibling `../openwop` clone can
> sit on any branch, any commit, dirty or clean — you never check it out at the
> tag (it is shared with other sessions), and you do not need a throwaway
> worktree. `git -C ../openwop fetch --tags` is the only preparation.
>
> **Which tag:** the one whose conformance version equals the **installed**
> `@openwop/openwop-conformance` — `check-vendored-fixtures.mjs` asserts the
> vendored tree against that package, and `check-vendored-schemas.mjs` asserts
> `schemas/CORPUS_TAG` against it. When the two disagree the guards print the
> exact command, tag included. Moving forward is a separate change: bump the pin,
> `npm ci` in `backend/typescript`, then re-vendor at the new tag in the same commit.
>
> Until 2026-09-23 `sync-fixtures.sh` took no tag and copied the clone's working
> tree. With the clone one release ahead of the pin, a failing
> `check-vendored-fixtures` told the reader to run it, and that run vendored the
> wrong release — failing the same guard for the opposite reason.

> **Vendoring a pack is NOT shipping it.** Production runs
> `OPENWOP_STRICT_REGISTRY=true`, so `mountLocalPacks` symlinks every vendored pack
> in and the registry installer then OVERWRITES the ones named in
> `OPENWOP_INSTALL_PACKS` with the pinned version. For any **pinned** pack, merging
> to this repo changes nothing in production — **the registry publish is the ship
> step**, followed by advancing the pin.
>
> This was not theoretical. A sweep on 2026-08-01 found **13** packs whose pinned
> version differed from the vendored one — `core.openwop.ai` was six weeks behind
> (three LLM-exchange waves, image-gen, video-gen, ADR 0458 P2, all merged and never
> executed), `core.openwop.http` a full major version behind with 2.0.0 already
> published, and 8 agent packs still serving prompts that named non-existent tools.
>
> Check it before and after a deploy:
>
> ```bash
> node scripts/check-pack-pin-drift.mjs           # reads the live pins via gcloud
> node scripts/check-pack-pin-drift.mjs --pins "core.openwop.ai@1.3.2,…"
> ```
>
> It exits 1 when the repo vendors something NEWER than production runs (unshipped
> work) and warns — without failing — when production is ahead (the repo is stale;
> `sync-packs.sh` fixes that). It is deliberately NOT a CI gate: the pin list lives
> in the Cloud Run service config, not in this repo, so an offline check cannot see
> it.

```bash
# From a CLEAN checkout of origin/main — never the shared working tree,
# which may carry another session's uncommitted work into the build
# context. (e.g. `git worktree add --detach /tmp/owp-deploy origin/main`)

# Bake the commit into the IMAGE. Do NOT skip this: the --update-env-vars stamp
# below is deploy CONFIG, and a bare redeploy PRESERVES the previous deploy's
# value — so an env-only stamp can report the wrong SHA with `stamped: true`.
#
# Skipping it is NOT fail-safe in a REUSED deploy checkout (e.g. /tmp/owp-deploy):
# the output is gitignored, so a leftover stamp from the last deploy persists and
# gets baked in. Run preflight (below) — Gate 4 fails on a stamp that is absent
# or != HEAD, which is the only thing that catches that.
node scripts/write-build-commit.mjs

gcloud run deploy openwop-app-backend \
  --source . \
  --region us-central1 \
  --project openwop-dev \
  --update-env-vars "OPENWOP_BUILD_COMMIT=$(git rev-parse HEAD),OPENWOP_BUILD_DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --quiet
```

> **`OPENWOP_BUILD_META_DIR`** overrides where the backend looks for the baked
> stamp. It exists as a test seam and as an escape hatch for a layout the
> resolver does not anticipate — it is NOT part of normal operation, and pointing
> it at the wrong directory silently changes reported provenance. Leave it unset.
>
> **Reading provenance honestly.** `/api/readiness` reports `build.commitSource`
> alongside `build.commit`. `image` means the SHA travelled with the artifact and
> describes the running code. **`env` means it is a deploy-time CLAIM** that a bare
> redeploy may have carried over from the PREVIOUS deploy — that is exactly what
> happened on 2026-08-10, when a revision ran `e65ff6888` and reported `43b539ed2`
> with `stamped: true`. `stamped` only answers "is there a commit at all?"; it has
> never answered "does it describe this code". Trust `commitSource: image`, or run
> `scripts/verify-deploy.sh`, which compares the value against your HEAD.

> **Easiest path (ADR 0530):** `scripts/deploy.sh` does all of this in the right
> order — preflight → backend → frontend → verify — and computes the commit stamp
> so it cannot be forgotten. Copy `scripts/deploy.env.example` to
> `scripts/deploy.env` (gitignored) and fill in your topology first. The raw
> recipe below stays supported; if you use it, run `scripts/preflight-deploy.sh`
> BEFORE the build and `scripts/verify-deploy.sh` after.

> **The backend deploy now also CERTIFIES, and that adds ~10 minutes**
> (ADR 0550 P4). `scripts/deploy.sh` runs the full conformance lane in strict,
> no-quarantine mode and derives this build's public profile claims from the
> RFC 0148 §A ledger into `build-meta/certification-bundle.json` +
> `conformance-claims.json`, which the image serves and
> `capabilities.conformance.certificationBundleUrl` points at.
>
> Two things follow, and both are deliberate:
>
> - **`scripts/write-build-commit.mjs` DELETES any existing pair on every run.**
>   It cannot re-derive them (that needs a real suite run), and a leftover pair
>   in a long-lived deploy checkout would publish a *different commit's*
>   evidence as this build's — invisible to every other gate, because the commit
>   stamp would still match HEAD. Absent is honest (RFC 0089 §D: "Omitting it is
>   fully conformant"); stale is a false public claim.
> - **A failed certify lane REFUSES the deploy.** If you need to ship without
>   the claim, say so: `scripts/deploy.sh --skip-certify` leaves the pointer
>   ABSENT. There is no flag that ships a stale one.

> **Do not drop the `--update-env-vars` line** (ADR 0518). It is what lets
> `/readiness` report WHICH COMMIT is running, and it is the only reliable way to
> detect that someone else's deploy landed on top of yours. `--update-env-vars` has
> *merge* semantics, so it is safe here — unlike `--set-env-vars`, which would wipe
> the live config. Omit it and `scripts/verify-deploy.sh` fails with `UNSTAMPED`,
> deliberately: a verification that passes without evidence is worse than none.

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

**Throttling costs more than a cold start — it starves DETACHED WORK.**
This section used to describe `cpu-throttling` purely as a latency
posture, and that omission has already cost one outage. With
throttling on, anything the process does *after* flushing a response
runs at ~5% CPU: a fire-and-forget `.then`, a `setImmediate`
dispatch, a background refresh. In #3056 a detached SPA-shell refresh
never completed over **16+ minutes despite active traffic**, and
because the promise never settled it never rejected either — so
nothing was logged and a latch it held was never released. `/` served
a pruned bundle until the instances were replaced.

The app's canonical run dispatch is the same shape
(`setImmediate(() => executeRun(...))` — `host/runDispatch.ts:105`,
`routes/runs.ts:1193`, `host/triggerIngestionService.ts:556` and two
more), so this posture is worth understanding before changing it.
`--no-cpu-throttling` removes the hazard as a side effect of removing
cold starts. Rules for writing such code — clear-on-settle, a time
bound, or finish it in-request — are in ARCHITECTURE.md's "Work that
OUTLIVES the thing that started it" seam row, enforced by
`backend/typescript/test/detached-latch-tripwire.test.ts`.

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

### Optional: localized public content (`capabilities.i18n` / `capabilities.content`) — RFC 0103 / ADR 0064

The anonymous `/v1/content/pages/:slug` delivery negotiates its locale over **host env**
(the operator honesty gate — `capabilities.i18n` + `capabilities.content` are advertised
at `/.well-known/openwop` ONLY when more than one locale is configured; unset ⇒ no advert,
byte-identical to a non-localized deploy). Per-ORG authoring locales are separate (the CMS
"Content languages" panel, `cms-localization` toggle). Enable WITHOUT a rebuild
(incremental update preserves all other config):

```
gcloud run services update openwop-app-backend \
  --update-env-vars '^|^OPENWOP_I18N_LOCALES=en,es,pt-BR,fr|OPENWOP_I18N_DEFAULT_LOCALE=en' \
  --region us-central1 --project openwop-dev
```

> **CORRECTED 2026-09-24 (ADR 0748).** This block used to read
> `--update-env-vars OPENWOP_I18N_LOCALES=en,es,pt-BR,OPENWOP_I18N_DEFAULT_LOCALE=en`.
> gcloud splits `--update-env-vars` on commas, so that form is not one value —
> it is a malformed list (`es` and `pt-BR` parse as keys with no `=`). The
> `^|^` prefix switches the delimiter to `|` so the commas stay inside the value.
> The live value when this was written was `en,es,pt-BR,fr` (`gcloud run services
> describe`), i.e. someone had already worked around it by hand.
>
> **DO NOT add `es-419` (or any tag with a numeric or script subtag) to this list while
> the Firebase Hosting door fronts `/api` (CORRECTED 2026-09-26, ADR 0748).** Firebase
> Hosting rewrites `Accept-Language` before Cloud Run sees it. MEASURED: `Accept-Language:
> es-419` via `app.openwop.dev/api` gets `Content-Language: es`, while the same request
> straight to the `*.run.app` origin gets `es-419`. So no client of the public door can
> negotiate the tag, and advertising it there is a claim the door cannot honour. The
> host code is correct; the witness lives on the origin-direct lanes (ADR 0748
> § "Correction (2026-09-26b)"). The path back is a protocol origin that does not
> rewrite headers (a Cloud Run domain mapping / LB), not this list.
>
> *(Superseded paragraph, kept for the trail:)* **`es-419` (RFC 0206, ADR 0748)** is the case-canonical extended tag that makes the
> v2 row `openwop.requirement.0206.delivery-extended-locale` executable: the v2
> `content` record then advertises a locale outside RFC 0103's `ll(-RR)` subset,
> and the §D admin ops (`POST /content/pages`, `PUT …/sections/{id}`) author for it.
> Error envelopes negotiated to `es-419` are answered from the `es` catalog with
> `Content-Language: es` (the column actually used). Keep `es` in the list: an
> `es-MX` reader negotiates to the first-declared Spanish tag.

Verify: `curl -H 'Accept-Language: pt-BR' https://app.openwop.dev/api/v1/content/pages/home -i`
→ `Content-Language: pt-BR` (falls back to the default locale for unsupported tags), and
`/.well-known/openwop` lists `capabilities.i18n`. With `OpenWOP-Version: 2`, discovery
carries top-level `i18n` and `content` records (without `es-419` on this deployment; see above).
An AUTHENTICATED `GET /v1/content/pages/:slug` reads the caller's own workspace, not the
system site (`localized-content.md` §F; ADR 0748).

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
#
# The in-app Network inspector's full-capture opt-in (VITE_ENABLE_NETWORK_RECORDER=1)
# now lives in `.env.production` — this command needs NO inline override.
# It used to live only on this line, and a deploy that forgot it silently shipped
# the panel in liveness-only mode ("0 calls"): that regressed 2026-07-14 and
# AGAIN 2026-07-15, so the flag moved into the showcase's own config where it
# cannot be forgotten. It is adopter-safe there because build-whitelabel-zip.sh
# strips every real `.env*` from the bundle; `check-network-recorder-posture.mjs`
# (in the build chain) pins that strip, the showcase opt-in, and the adopter
# template's silence together.
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
  --memory=512Mi --cpu=1 --concurrency=80 --max-instances=5 \
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

**Install command**: both Docker stages use **`npm ci`**, never `npm install`
(#2680). `npm ci` installs the lockfile verbatim; `npm install` RE-RESOLVES, and
npm 11.5–11.x prunes the transitive deps of an `optionalDependency` — which
silently ships an Azure Key Vault KMS backend that cannot load. Measured in the
image, same lockfile: npm 10.9.8 → 466 pkgs and `@azure/identity` loads; 11.6.2 →
464 pkgs and `ERR_MODULE_NOT_FOUND`; 12.0.2 → fixed. Self-hosters get the tracked
`package-lock.json` in the bundle and should use `npm ci` too — that is the path
`scripts/check-whitelabel-build.sh` smoke-tests. A local `npm install` on an
affected npm additionally rewrites the lockfile with the pruned resolution; never
commit that churn.

**Gotcha**: the bundled image's `package.json` must declare every runtime
dependency the bundled code imports. Esbuild bundles with `--packages=external`
+ the runtime stage does `npm ci --omit=dev`, so transitive-only deps
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

## Configuring provider OAuth clients (Connections)

The Connections catalog (`Admin → Access → Connections`) renders a **Connect**
button per OAuth provider (Google Workspace, Microsoft Graph, Slack, Dropbox,
Box, …), but each button stays disabled — with a "not configured" hint — until
this host has that provider's **OAuth client credentials** (ADR 0024 § host-managed
OAuth client config). Wiring one provider takes ~10 minutes; nothing here needs a
redeploy.

### 0. One-time: the TWO base URLs (already set on the demo host)

Firebase Hosting routes **only `/api/**`** to Cloud Run, so the redirect URI the
provider calls back MUST carry the `/api` prefix. Without this env the redirect
URI resolves to the bare app origin and every provider redirect 404s **after** a
successful consent — the host never sees the error. And after the callback
stores the tokens, the browser is sent back to the SPA at
`OPENWOP_PUBLIC_BASE_URL` — when THAT is unset the redirect falls back to the
request origin (the `*.run.app` backend), landing the user on a JSON
`not_found` page even though the connection saved (hit live on the demo host
2026-07-02). Set both:

```bash
gcloud run services update openwop-app-backend \
  --update-env-vars OPENWOP_OAUTH_CALLBACK_BASE_URL=https://app.openwop.dev/api,OPENWOP_PUBLIC_BASE_URL=https://app.openwop.dev \
  --region us-central1 --project openwop-dev
```

(Set on the demo host 2026-07-02 — callback base revision `00367-8q4`, public
base revision `00373-szn`. Self-hosters whose backend shares the SPA origin can
omit both — resolution falls back to the request origin, which is then correct.
Pinned by `backend/typescript/test/oauth-callback-base.unit.test.ts`.)

Every provider registration below uses the same redirect URI shape:

```text
https://app.openwop.dev/api/v1/host/openwop-app/connections/<provider-id>/callback
```

### 1. Create the OAuth app at the provider (console-only, not scriptable)

**Google (`provider id: google`)** — Cloud Console → *APIs & Services*:
1. *OAuth consent screen* — direct link:
   `https://console.cloud.google.com/auth/overview/create?project=openwop-dev`
   — External, app name "OpenWOP", authorized domain `openwop.dev`. Publish
   (or add testers while in Testing).
2. Enable the APIs the scopes touch: Drive, Calendar, Gmail.
3. *Credentials → Create credentials → OAuth client ID → Web application*;
   authorized redirect URI = the shape above with `<provider-id>` = `google`.
4. Default (read) scopes requested at connect time: `drive.readonly`,
   `calendar.readonly`, `gmail.readonly`; write scopes (`gmail.send`,
   `calendar.events`) are a **separate re-consent** the user triggers later
   ("Grant write") — list them all on the consent screen.

**Microsoft (`provider id: microsoft-graph`)** — Entra admin center → *App
registrations → New registration*: single-tenant or multi-tenant per your
audience; Web platform redirect URI = the shape above with `microsoft-graph`;
*Certificates & secrets → New client secret*. Grant **delegated** Graph
permissions matching the manifest's scope groups: `Mail.ReadWrite` (Outlook
drafts — deliberately never `Mail.Send`) + `offline_access` (the default
consent), plus `Files.Read` and `Sites.Read.All` for the OneDrive/SharePoint
read groups. Note this builtin is the *narrow* mail-drafts + files connector;
broader Microsoft 365 reach (Teams, Calendar) is the separate
`core.openwop.connections.microsoft365` **connection pack** (operator-installed
via `OPENWOP_INSTALL_PACKS`), whose provider id — and env key, if you use the
env fallback — is `microsoft365`.

**Slack / Dropbox / Box / Zoom** — same pattern; the scope strings each
manifest requests live in
`backend/typescript/src/features/connections/providerRegistry.ts`
(`defaultScopes` = the initial read consent).

### 2. Store the client on the host (primary path: superadmin UI, no redeploy)

Admin → Access → Connections → **OAuth clients** panel (superadmin only): pick
the provider, paste client id + secret, save. The secret is sealed with the
BYOK envelope (AES-256-GCM) at rest and is never returned by any read surface.
The provider's Connect button lights up immediately (`oauthConfigured: true` in
the catalog).

Fallback (env, requires a config update): `OPENWOP_OAUTH_<KEY>_CLIENT_ID` /
`OPENWOP_OAUTH_<KEY>_CLIENT_SECRET`, where `<KEY>` is the provider id
uppercased with non-alphanumerics → `_` (`google` → `GOOGLE`,
`microsoft-graph` → `MICROSOFT_GRAPH`). Prefer `--update-secrets` bindings over
plaintext env; **never** `--set-env-vars`/`--set-secrets` (wipes the live
binding set — see the §14 warning). The UI-stored client wins over env when
both exist; configure exactly one path per provider.

### Related: Microsoft SIGN-IN (identity, not connections)

The auth modal's "Continue with Microsoft" button is separate from the
Graph *connection* above — it is Firebase Auth identity, gated on a build
flag so hosts without an Entra app never render a dead sign-in path.
Full steps (also in README § "Microsoft sign-in"):

1. Firebase console → *Authentication → Sign-in method → Add new provider →
   **Microsoft*** → Enable. Copy the callback URL Firebase displays
   (`https://<project>.firebaseapp.com/__/auth/handler`); keep the tab open.
2. [Entra admin center](https://entra.microsoft.com) → *App registrations →
   New registration*: pick the supported account types ("any organizational
   directory + personal Microsoft accounts" for the broadest sign-in) and add
   a **Web** redirect URI = the Firebase callback URL.
3. Copy the **Application (client) ID**; *Certificates & secrets → New client
   secret* → copy the secret **Value** (shown once).
4. Paste both into the Firebase Microsoft provider dialog → Save.
5. Build the SPA with `VITE_AUTH_MICROSOFT=true` (e.g. in
   `frontend/react/.env.production`) and redeploy hosting
   (`firebase deploy --only hosting:app`). Verify: the sign-in modal shows
   "Continue with Microsoft" and a round-trip lands signed in.

### 3. Verify

1. Catalog: `Connect <provider>` is enabled on `/connections` (the
   "not configured" hint disappears).
2. Complete a real consent round-trip; the row appears with status `active`.
3. Click **Test** on the row (the `/test` health probe) → green.
4. `DEPLOY-SMOKE.md` § OAuth connect covers the same steps against prod.

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

## SEO crawler prerender (ADR 0384 — the platform-origin flip)

The backend ships the crawler prerender complete: custom-domain document paths
(`/` and `/p/:slug` on a bound hostname) serve prerendered semantic HTML to all
clients as soon as the backend deploys — no operator action. The **platform
origin** (`app.openwop.dev`) is a separate, deliberate flip because Firebase
Hosting serves the SPA shell for document requests and crawlers never reach
Cloud Run until the rewrite changes:

1. **Prereqs (both required before the flip):**
   - `OPENWOP_PUBLIC_SITE_ORG_ID` — the org whose published pages the platform
     documents serve (the same org the SPA's `VITE_PUBLIC_SITE_ORG_ID` points
     at). Unset ⇒ bots fall through to the human path (no guessing).
   - `OPENWOP_SPA_SHELL_URL` (preferred) — normally
     `https://app.openwop.dev/app-shell.html`. The backend fetches Hosting's STATIC
     shell (rewrites never apply to existing static files — no loop) and caches
     it with a TTL refresh (`OPENWOP_SPA_SHELL_TTL_S`, default **60 s** —
     cut from 300 s on 2026-08-03 because the TTL *is* the outage window, not a
     freshness knob). Refreshes send `If-None-Match`, but MEASURED 2026-08-03
     Firebase does NOT honour conditional requests for this file (full 200 +
     body), so the window reduction comes from the TTL alone here; the header
     pays off only on a white-label host that answers 304. **CORRECTION (verified live
     2026-08-02): this line used to claim "no stale-asset-hash hazard" — there
     IS one, for the length of the TTL.** Hosting PRUNES the previous build's
     **CORRECTION 2026-08-08: the TTL is a FLOOR, not a ceiling.** A starved
     fire-and-forget refresh (Cloud Run CPU throttling) wedged the cache for
     16+ minutes with no error logged; fixed in #3056. If `/` is stale, force
     new instances rather than waiting, and probe with a BROWSER UA (curl gets
     the bot prerender, cached separately for an hour).
     assets, so within that window `/` serves a cached shell referencing a
     bundle that no longer exists; the request falls through the SPA rewrite and
     returns `index.html` as `200 text/html`, the browser refuses it under
     strict MIME checking, and the SPA never boots for anonymous visitors on the
     public home page. SPA routes are unaffected. It resolves itself when the
     TTL lapses — so the honest posture is: expect a ≤5-minute `/` outage after
     each frontend deploy, verify with `content_type` (never the status code —
     the rewrite makes it a misleading `200`), and lower
     `OPENWOP_SPA_SHELL_TTL_S` if that window is unacceptable.
     A refresh failure serves the last-good shell; a non-HTML body is never
     cached. (`OPENWOP_SPA_SHELL_FILE` remains for mounted-volume deploys —
     note the image does NOT bundle `frontend/react/dist`.) Do NOT flip the
     rewrite without one of these configured (the routes 404 humans honestly).
2. **The flip:** the hosting `predeploy` hook (which first runs
   `check-hosting-wire-rewrites.cjs`, so a hand-edited `firebase.json` that no
   longer covers the v2 wire refuses to deploy even without a rebuild — ADR 0614)
   renames the built shell
   (`dist/index.html` → `dist/app-shell.html`) so `/` falls through to the
   rewrite — Firebase serves an EXACT static match BEFORE rewrites, so a static
   root `index.html` would shadow the `/` document rewrite forever. The `**`
   catch-all targets `/app-shell.html`. Platform-origin document responses are
   `no-store` (the Hosting CDN strips `Vary`, so UA-branched public caching
   would be cross-audience poisonable); the backend's prerender LRU absorbs the
   cost. Change `firebase.json` hosting rewrites so `/` and `/p/**`
   (document requests ONLY — never `/assets/**`, `/api/**`, or the SSE URL)
   target the Cloud Run service instead of `/index.html`, then
   `firebase deploy --only hosting:app`. The backend UA-branches: bots get
   prerendered HTML, humans get the shell, every response carries
   `Vary: User-Agent` (cache-poisoning guard — never strip it).
3. **Rollback:** revert the rewrite (humans instantly back on the CDN shell),
   or `OPENWOP_SEO_PRERENDER_DISABLED=true` via `--update-env-vars` to disable
   all prerendering (custom-domain documents revert to 404) without a deploy.

Knobs: `OPENWOP_SEO_PRERENDER_TTL_S` (Cache-Control max-age, default 3600),
`OPENWOP_SEO_BOT_UA_EXTRA` (comma-separated extra UA tokens),
`OPENWOP_PUBLIC_SITE_NAME` (og:site_name/JSON-LD override; defaults to the
org's name).

## Custom domains for published content (ADR 0295 — operator infra)

The app-side half (domain registration, `_openwop-verify.<host>` TXT ownership
check, the org-pinned public-only host guard, per-domain rate limits) ships in
the `custom-domains` feature. **TLS + routing for customer hostnames are the
platform proxy tier — operator infrastructure, not app code.** The pinned
reference recipe (ADR 0295 option A, GCLB certificate map):

1. Reserve a global IP + create the HTTPS load balancer fronting the existing
   Cloud Run service (serverless NEG):
   ```
   gcloud compute addresses create owp-domains-ip --global
   gcloud compute network-endpoint-groups create owp-backend-neg \
     --region=us-central1 --network-endpoint-type=serverless \
     --cloud-run-service=openwop-app-backend
   ```
2. Create a certificate map; add each verified customer hostname as a
   managed-certificate map entry — `scripts/domain-cert-commands.sh` generates
   (or with `RUN=1` executes) these commands for the hostnames shown LIVE on
   the app's /domains page:
   ```
   gcloud certificate-manager maps create owp-domains-map
   gcloud certificate-manager certificates create cert-<name> \
     --domains=<customer-hostname>
   gcloud certificate-manager maps entries create entry-<name> \
     --map=owp-domains-map --hostname=<customer-hostname> \
     --certificates=cert-<name>
   ```
3. Attach the map to the HTTPS proxy; point the customer's DNS at the LB IP
   (subdomains: a `CNAME`/`A` to the IP; apex needs the DNS host's ALIAS).
4. The tenant adds + verifies the hostname in the app (TXT record), the sweep
   keeps re-checking (a lost record demotes the domain to `failed` —
   disable-don't-delete). Requests arriving on the hostname reach ONLY that
   org's public pages/funnels/storefront (`middleware/customDomain.ts`,
   fail-closed) with a per-domain rate budget
   (`OPENWOP_CUSTOM_DOMAIN_REQS_PER_MIN`, default 600).

The SPA's public page renderer is served from the platform origin; a customer
domain fronting the full HTML site additionally routes `/` at the LB to the
Firebase Hosting origin — that leg is deployment-specific and deliberately
NOT baked into the app.

## Trusted (Tier-1) plugin packs

To serve openwop-team-signed plugin packs in the MAIN frame (ADR 0367): mount a
public keyring (`OPENWOP_TRUSTED_PACK_KEYS_DIR`, e.g. the committed
`deploy/trusted-keys/`), optionally a revocation list
(`OPENWOP_TRUSTED_PACK_REVOCATIONS`), and enable the `trusted-plugins` toggle
(default OFF — the runtime kill switch). Signature + revocation are re-verified
at every serve; any miss falls back to the Tier-2 sandbox. Full review/signing/
rotation/revocation recipe: [`docs/trusted-pack-publishing.md`](docs/trusted-pack-publishing.md).

## White-label distributions (ADR 0366)

A distribution manifest (`distributions/<name>.json`) composes a build: include-mode (`"bundles": ["commerce"]` — core + named bundles; the licensing-safe direction) or exclude-mode (Phase-1). Build with `OPENWOP_DISTRIBUTION=<name>` set for BOTH halves (`npm --prefix backend/typescript run build`, `npm --prefix frontend/react run build`); the generated registries tree-shake excluded features out of both artifacts, and the build REFUSES to fall back to the full registry silently. Validate every manifest + the bundle catalog with `node scripts/gen-distribution.mjs --check` (or `npm run ci:distribution`, which also builds the slim proof). Deploy per distribution exactly like the default (backend first, then hosting); the slim boot must stay green under `OPENWOP_REQUIRE_BEHAVIOR=true`.

**Chunk budgets do not transfer between distributions — a SLIM build can make a chunk BIGGER (measured 2026-08-28).** `check-bundle-budget` runs after `vite build` and is calibrated against the DEFAULT build. Excluding features can *inflate* an individual chunk, so a named distribution can fail the gate with nothing actually being too big:

| build | `DocumentEditorPage` |
|---|---|
| default | 77.9 kB raw / **27.2 kB gzip** — passes |
| `kicktodo` | 543.0 kB raw / **172.6 kB gzip** — fails the 150 kB chunk ceiling |

Same source file, **6.3× larger gzip in the smaller build**. The mechanism is co-tenant dependency sharing: in the default build (953 chunks) Rollup hoists dependencies shared by several features into common chunks; exclude those co-tenants and nothing else imports the shared code, so it inlines into the one surviving chunk.

**Both obvious fixes are traps.** Raising `CHUNK_GZIP_BUDGET` (or adding a `PER_CHUNK_GZIP_BUDGET` override) hides a real signal for the default build, where that ceiling was tuned against measured chunk weights. Code-splitting the page is work against a chunk that is 27 kB in the build the budget exists to protect. **The right question is whether the feature belongs in that distribution at all** — which is how the case above resolved: `document-editor` was in the KickTodo build only through a bundle-name collision, and removing it took the chunk with it.

Which half of the gate still means something on a named distribution:

- **The ENTRY budget transfers and stays honest.** A slim build's entry chunk is a subset of the default's, so it should never exceed it — measured 124.6 kB (kicktodo) against 128.5 kB (default), same 130 kB ceiling. A slim build breaching the ENTRY budget is a real finding.
- **The non-entry 150 kB chunk ceiling does NOT transfer.** It was chosen relative to default-build chunk composition (see the comments in `frontend/react/scripts/check-bundle-budget.mjs`, which cite measured default-build weights such as `documentSchema` 146.3 kB and `wardley` 141.9 kB). Under a different composition those weights change, so a breach is not evidence of a size problem until you have measured the same chunk in the default build.

**So the first diagnostic step for a distribution build that reds this gate is to build the DEFAULT distribution and measure the same chunk.** If default passes, it is a composition artifact, not a size regression.

**Regenerate before you measure.** `vite.config.ts` substitutes a GENERATED `src/features/registry.distribution.ts` that `scripts/gen-distribution.mjs` writes in the `prebuild` hook. Running bare `vite build` reuses whatever was generated last — so a manifest edit does not reach the artifact and the build silently measures a distribution that no longer exists. Use `npm run build` (which runs `prebuild`), or run `node scripts/gen-distribution.mjs` explicitly first. The tell is an unchanged chunk hash across builds that should have differed.

**Composing a distribution (ADR 0366 P3):** the marketplace's bundle shop (`/marketplace/bundles`) browses the bundle catalog and exports an include-mode manifest. Commit it as `distributions/<name>.json` in a reviewed PR (the review IS the security gate — no runtime path mutates the build), then `OPENWOP_DISTRIBUTION=<name> npm run build:distribution` produces both artifacts. Note: `gcloud run deploy --source .` image builds always build the DEFAULT distribution (the Docker builder carries only the backend subtree); build a named distribution locally/CI and deploy its artifacts explicitly.

## Chat + retention runtime knobs (operator reference)

The 2026-07-14/15 incident-response work added these env knobs — all read at
call time (no rebuild), all merge-updatable via `--update-env-vars`:

- `OPENWOP_PROVIDER_429_RETRY_MS` — backoff before the ONE retry a
  rate-limited model call gets on both chat dispatch seams (tool loop AND
  single completion). Default `4000`; `0` disables the retry entirely.
- `OPENWOP_GROUP_ROOM_TOOL_LOOP=true` — restores the agent TOOL LOOP for
  group conversations (advisory boards / project convenes). Default OFF: group
  rooms take one completion per advisor voice, because a cadence of
  tool-looping advisors fires up to 5×N model calls back-to-back and bombards
  provider rate limits (the 2026-07-14 silent-board incident); advisor
  grounding rides prompt-side knowledge injection either way.
- `OPENWOP_RETENTION_SWEEP_ENABLED=true` + `OPENWOP_RUN_RETENTION_DAYS` +
  `OPENWOP_WEBHOOK_DELIVERY_RETENTION_DAYS` — ADR 0287 engine retention
  (whole-run cascade incl. artifacts; hourly; audit-row tombstones). LIVE in
  prod since 2026-07-15 at 30/14 days. `0`/unset = off (fail-safe default).
- `OPENWOP_WEBHOOK_SECRET_ROTATION_OVERLAP_S` (default `86400`, valid
  `60`–`604800`; anything else falls back to the default) and
  `OPENWOP_WEBHOOK_VERIFY_PER_TENANT_PER_MIN` (default `10`, per instance) —
  RFC 0201 / ADR 0747 Standard Webhooks: the advertised
  `webhooks.secretRotation.overlapSeconds`, and the per-tenant budget of
  endpoint-verification requests an opted-in registration may send. Neither
  needs setting in production; the conformance lane sets `60` / `1000`.
  **Reachability caveat:** an opted-in registration succeeds only if the
  endpoint answers the verification POST within 10 s, through the same egress
  guard deliveries use — a suite receiver on loopback is refused in prod
  exactly as its deliveries would be (front it with `OPENWOP_WEBHOOK_RECEIVER_URL`).
- `OPENWOP_KNOWLEDGE_SYNC_DAEMON_ENABLED` — the **kill-switch** for knowledge-sync
  spend (ADR 0107 / ADR 0605, Drive/OneDrive/Dropbox/Box → KB, on each source's
  schedule). **WF-KB-3 / KSWF-1 note:** the bespoke cadence *daemon* is gone — the
  recurring sync is now a per-source scheduler job running the `knowledge-sync.run`
  workflow (the gmailSync twin). This env var **still works, unchanged** as the
  host-wide stop: it is now checked inside the `knowledge-sync` surface's `runOnce`
  (`knowledgeSyncGate.ts` `syncEnabledFor`), so a fired job that finds it engaged
  is a typed skip with **zero egress**. **Defaults ON**; set it to any of `false` /
  `0` / `off` / `no` / `disabled` (case-insensitive) — this is the control to reach
  for during a third-party-egress or embedding-spend incident:
  ```
  gcloud run services update openwop-app-backend \
    --update-env-vars OPENWOP_KNOWLEDGE_SYNC_DAEMON_ENABLED=false \
    --region us-central1 --project openwop-dev
  ```
  Because it defaults ON, its polarity is INVERTED vs the `=== 'true'` opt-ins
  above: a value it does not recognise leaves sync RUNNING. That is why it accepts
  the whole falsy set rather than the single literal `false` (ADR 0583 § D5).
  Per-tenant spend is separately gated in the same `syncEnabledFor` — the
  `knowledge-sync` toggle AND the plan entitlement, both fail-closed — so this var
  is the blunt host-wide stop, not the per-tenant control. (Note: with the switch
  engaged, a source's job still *fires* on cadence and immediately skips — no
  egress, but an empty run row per source per cadence; to also stop the fires,
  disable the sources or the feature toggle.)
- `OPENWOP_ANON_TENANT_RETENTION_DAYS` — ADR 0372 anon-tenant lifecycle:
  tears down `anon:*` tenants with no HUMAN activity (non-scheduler run or
  chat update) for N days, via the account-delete teardown quartet; max 5
  tenants per hourly tick, audit-tombstoned. `0`/unset = off (the default —
  this deletes business kv, so enabling is an explicit operator call;
  suggested value once wanted: `14`).

## Image generation / editing (ADR 0401)

- **BYOK only** — users store an OpenAI / Google / **Replicate** key (Providers page);
  the editor affordances (Generate / Edit-with-AI on every image field) are
  honest-off until a key exists. No operator env needed for dispatch.
- **Spend ceiling:** images meter under the ADR 0106 media budget as a per-tenant
  daily COUNT — env default `OPENWOP_IMAGE_MAX_PER_DAY` (50; 0 = uncapped), per-org
  override in the superadmin Governance panel (`images` field; explicit 0 = uncapped
  for that org).
- Replicate output fetches are pinned to `replicate.delivery`/`api.replicate.com`
  (https, uncredentialed, 25 MiB/image) — no other egress is possible from the
  image path.
