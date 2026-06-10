# openwop-app — OpenWOP Application

> **The live reference deployment of an OpenWOP host** — and a white-label starting point you can fork and rebrand. Consumes the protocol via the published [`@openwop/openwop`](https://www.npmjs.com/package/@openwop/openwop) SDK; the protocol spec itself lives in [`openwop/openwop`](https://github.com/openwop/openwop). Carved from that monorepo (`apps/workflow-engine`) with full history.
>
> **Status:** Runs in production at [app.openwop.dev](https://app.openwop.dev/). Adopt it as a white-label template (see [`frontend/react/WHITE-LABEL.md`](./frontend/react/WHITE-LABEL.md)); harden against your own security review before your own production use. Remaining productionization is tracked in [`MIGRATION-TODO.md`](./MIGRATION-TODO.md).
> **SDK:** consumes `@openwop/openwop` `^1.2.0` (+ `@openwop/openwop-conformance` for the black-box suite).
> **License:** [Apache-2.0](./LICENSE).
>
> **Live demo:** [app.openwop.dev](https://app.openwop.dev/) — anonymous, browser-session-scoped. Build + run workflows visually; BYOK keys are session-only. Resets every 24h. [Smoke test](./DEPLOY-SMOKE.md) · [Privacy](https://app.openwop.dev/privacy)

A deployable reference application demonstrating the full vertical slice of an OpenWOP host: a Cloud Run-shape TypeScript backend that implements the v1.1 wire contract, paired with a React frontend that consumes it via the published SDK.

## What this sample demonstrates

### Backend (`backend/typescript/`)

- **All four canonical run-lifecycle endpoints** — `POST /v1/runs`, `GET /v1/runs/{id}`, `POST /v1/runs/{id}/cancel`, `POST /v1/runs/{id}:fork`
- **All four interrupt `kind`s** — `approval`, `clarification`, `refinement`, `cancellation` — wired through `POST /v1/runs/{id}/interrupts/{nodeId}` and the signed-token callback `POST /v1/interrupts/{token}`
- **SSE event stream** with the four canonical stream modes (`values` / `updates` / `messages` / `debug`) and `Last-Event-ID` resume
- **Two-layer idempotency** — HTTP `Idempotency-Key` + engine `invocationId`
- **BYOK end-to-end** — node manifest declares `requires.secrets[]`, run options carry `credentialRef`, secret resolves at execute time, secret material is stripped from persisted run-doc / events / errors
- **Pack consumption** — fetch + verify + extract pack tarballs from `packs.openwop.dev` at boot (SHA-256 SRI + Ed25519 sig over `pack.json` bytes per `registry/scripts/verify-signatures.mjs`). Installed packs survive across restarts under `~/.openwop-packs/` and are re-verified against their trust marker on every load to catch post-install tampering.
- **MCP server mount** (RFC 0020) — opt-in JSON-RPC endpoint at `POST /v1/host/sample/mcp` that lets external MCP clients (Claude Desktop, Cursor, conformance harness) discover and invoke workflows as MCP tools/resources/prompts, with bidirectional `sampling/createMessage` + `elicitation/create` bridged into `ctx.callAI` / `ctx.suspend`. Env-gated on `OPENWOP_MCP_SERVER_ENABLED=true`. OFF by default; the boot log emits a `NEVER enable in production without auth review` warning when ON. All 6 `mcp-server-*.test.ts` conformance scenarios pass behaviorally against this mount.
- **Full `core.openwop.*` + reference `vendor.myndhyve.*` palette out of the box** — every core pack in the repo (`a2a, agents, ai, crypto, data, db, examples, files, flow, hitl, http, integration, mcp, messaging, obs, rag, storage, triggers`) **plus the reference vendor packs** (`chat, canvas, kanban, knowledge-tools, launch-studio, web-research`) surfaces in the visual builder — the sample now wires their `host.{chat,canvas,kanban,knowledge,launchStudio,webResearch}` surfaces (+ `host.a2a`, `host.triggers`, `host.db.nosql`) so those nodes run, not just render. Unsigned packs from the repo are mounted as dev-mode symlinks alongside signed registry installs; the catalog response marks any node whose host surface isn't advertised so the UI can dim it and the inspector can explain. See `ARCHITECTURE.md §"Pack coverage"`.
- **In-memory host surfaces (demo-grade)** — `ctx.storage.{kv,table,cache,blob,queue}`, `ctx.db.{sql,vector}`, `ctx.fs`, `ctx.queueBus`, `ctx.observability` are wired with process-local adapters so most core-pack nodes execute end-to-end. State is wiped on restart. The interface contracts match what a real-backend host (`examples/hosts/postgres`) implements, so swapping any surface is a one-file change. See `ARCHITECTURE.md §"Path to real backends"`.
- **`aiProviders` host surface end-to-end** — packs that declare `peerDependencies: { aiProviders: "supported" }` (e.g., `core.openwop.ai`) execute via `ctx.callAI(...)` per `spec/v1/host-capabilities.md §host.aiProviders`. All four policy modes (`disabled` / `optional` / `required` / `restricted`) gated per `spec/v1/capabilities.md:246-289`; credentials resolved by convention (`secrets[provider]` then `<provider>-*` / `<provider>:*` prefixes); cleartext API keys never cross the result boundary or land in events; provider-specific error bodies are NEVER forwarded (they get mapped to the 15 canonical error codes from `host-capabilities.md:141-154` so upstream credential-shaped error payloads can't leak through). `OPENWOP_AI_POLICY_<PROVIDER>` env-vars drive the resolver.
- **Prompt-library composition seam (RFC 0027 Phase A)** — advertises `capabilities.prompts.{supported: true, endpointsSupported: false, observability: "full"}`. The composition pipeline (`src/host/promptCompose.ts`) implements RFC 0027 §E's secret redaction (`[REDACTED:<credentialRef>]` markers) + untrusted-content wrapping (`<UNTRUSTED>...</UNTRUSTED>`) + sha256 deterministic hashing for `prompt.composed` events. Exercised end-to-end via `POST /v1/host/sample/prompt/compose` (host-extension test seam) by the conformance scenarios `prompt-composed-secret-redaction.test.ts` + `prompt-composed-trust-marker.test.ts`. The spec'd Phase B `/v1/prompts*` REST surface (RFC 0028) is **not** implemented in this sample — `endpointsSupported: false` is honestly advertised so clients see the spec'd `501 capability_not_provided` instead of a 404 (route missing).
- **OTel under `openwop.*`** with W3C `traceparent` propagation
- **Cloud Run shape** — single container, `$PORT`, `/health` + `/readiness`, multi-stage Dockerfile with esbuild bundle
- **Conformance harness** — `npm run test:conformance` runs `@openwop/openwop-conformance` against the local service
- **DAG executor with concurrent paths** — workflows are no longer limited to a single linear chain. The scheduler (`src/executor/scheduler.ts`) drains a topological ready-queue with bounded concurrency (`OPENWOP_MAX_CONCURRENT_NODES`, default 8) and honors the five canonical `WorkflowEdge.triggerRule` values from `spec/v1/workflow-definition.schema.json` (`all_success` / `any_success` / `all_complete` / `none_failed` / `any_failed`). Edge `condition` predicates filter per-edge input contributions. Per-node outputs land in a port-keyed map (`{ output: ... }`); downstream nodes read by `targetInput` from any incoming edge. Suspended branches keep the run alive while other branches drain; on resume, the resolved node flips to `completed` and the scheduler re-enters. Cycles reject at run-start with `cycle_detected`. Linear workflows are a degenerate case of the same scheduler — back-compat preserved bit-for-bit.

### Frontend (`frontend/react/`)

- **`@openwop/openwop` SDK consumption from the browser** — same package as the BE for wire types
- **Run lifecycle UI** — create, status, cancel, fork from any event
- **SSE event stream rendering** with `Last-Event-ID` resume across reconnect
- **Interrupt rendering for all four `kind`s** — sample-quality cards demonstrating the host-extension renderer pattern
- **Capability discovery panel** — live render of `GET /.well-known/openwop`
- **BYOK key entry + policy explainer** — visualizes the resolution order
- **Branching + merging in the builder** — drag a second outgoing edge from any node for fan-out; multiple edges into a single target node form a fan-in. The right-hand inspector exposes the edge's `triggerRule` (`all_success` / `any_success` / `all_complete` / `none_failed` / `any_failed`) and optional `condition` predicate (`path`+`op`+`value` over the source's output). Cycles still reject at save time.

## What this sample is NOT

- **Not a fifth reference host.** Conformance is owned by `examples/hosts/postgres/` (production-profile, 91.9% of 850 scenarios). This sample stubs more and targets ~70% — that figure is a **2026-05-15, suite-v1.1.0-era estimate**; the sample has since wired the full `host.{kanban,chat,canvas,knowledge,webResearch,launchStudio,a2a,triggers,db.nosql}` vendor-surface set + the normative `ctx.interrupt`/`ctx.suspend` primitive, so it now stubs fewer surfaces than that figure implies (un-re-measured against the current suite).
- **Not normative.** It is sample/template code, not part of the v1.1 spec corpus.
- **Not coupled to one cloud.** The single container image runs on any platform, and [`deploy/`](./deploy/README.md) ships ready-made packs for **Docker Compose** (the cloud-free default), **Fly.io**, **Render/Railway**, **AWS**, **Azure**, and **Google Cloud**. Storage, BYOK key-wrapping (KMS), identity (OIDC), and object storage are env-selected behind interfaces; the cloud SDKs are *optional* dependencies loaded only when chosen. Real KMS backends exist for **AWS KMS**, **Azure Key Vault**, and **Google Cloud KMS** (`OPENWOP_BYOK_KMS_KEY=aws-kms:… / azure-keyvault:… / projects/…`), plus a portable local-AES fallback.
- **Not a fork of the production-grade postgres host.** It deliberately omits the audit-log integrity profile, durable webhook queue, multi-region partition handling, and other production concerns to stay at "starter-template" scope.

### `aiProviders` known limits

- **Embeddings, image generation, video generation** — advertised as `false`; the corresponding `core.ai` pack nodes throw `host_capability_missing`. The sample's `providers/dispatch.ts` only wires the three chat-completion endpoints.
- **Tool-calling is Anthropic-only** — advertised via `aiProviders.toolCalling.providers: ['anthropic']`. OpenAI / Google tool-use wire shapes are not implemented in this sample. Packs requesting tool-calling on other providers fail with `host_capability_missing`.
- **Tool-calling is single-round** — `ctx.callAIWithTools(...)` returns `{ content, toolCalls[], finishReason, usage, model }` from one Anthropic round trip. The pack (or downstream workflow nodes) is responsible for executing the tools and re-invoking the LLM with results appended to `messages`. The sample's chat tab uses a separate multi-round helper (`dispatchAnthropicWithTools`) for its in-bubble tool-use loop; that is not exposed on `ctx`.
- **Per-tenant policy is sample-grade** — `OPENWOP_AI_POLICY_<PROVIDER>` env vars apply to every `(tenantId, scopeId)` tuple. Real hosts persist per-tenant policy in their tenants table; the policy resolver's signature accepts `{tenantId, scopeId}` so swapping the impl is a one-file change.
- **Sub-run-via-tool tenant inheritance** — when the chat node invokes a workflow as a tool, the sub-run inherits the chat run's `tenantId` / `scopeId` (not hardcoded). See `subruns/subRunDispatcher.ts`.
- **No host-managed credential of last resort** — every AI call requires a BYOK secret. `req.credentialRef` is honored when explicitly passed; otherwise the host falls back to `secrets[provider]` (e.g., `secrets['anthropic']`) and then any secret prefixed with `<provider>-` or `<provider>:`.

## Quickstart

The repo-local CLI can check and launch the full demo:

```bash
node cli/openwop.mjs doctor
node cli/openwop.mjs demo start
```

Manual startup still works:

```bash
# Terminal 1 — backend
cd backend/typescript
npm install
npm run dev          # listens on http://localhost:8080

# Terminal 2 — frontend
cd frontend/react
npm install
npm run dev          # opens http://localhost:5173
```

The frontend connects to `http://localhost:8080` by default. Override with `VITE_OPENWOP_BASE_URL` in a `.env.local`.

### Deploy

The app runs on any host — pick a deploy pack under [`deploy/`](./deploy/README.md):

| Pack | Best for |
|---|---|
| [`deploy/compose`](./deploy/compose/) | laptop / VPS / on-prem — cloud-free default (`docker compose up`) |
| [`deploy/fly`](./deploy/fly/) | fastest self-serve cloud deploy |
| [`deploy/render`](./deploy/render/) | low-config PaaS (Render / Railway) |
| [`deploy/aws`](./deploy/aws/) | enterprise — Fargate + RDS + Secrets Manager + KMS |
| [`deploy/azure`](./deploy/azure/) | enterprise — Container Apps + PostgreSQL + Key Vault |
| [`deploy/gcp`](./deploy/gcp/) | the steward's reference deploy (`app.openwop.dev`) |

[`deploy/README.md`](./deploy/README.md) is the choose-your-host index and documents the **host contract** (the capability set every pack satisfies) and the deploy postures. The capability-keyed env surface is in [`backend/typescript/.env.example`](./backend/typescript/.env.example).

### Smoke test (BE only)

```bash
curl http://localhost:8080/.well-known/openwop | jq
curl -X POST http://localhost:8080/v1/runs \
  -H 'Authorization: Bearer sample-token' \
  -H 'Content-Type: application/json' \
  -d '{"workflowId":"sample.demo.uppercase","tenantId":"demo","inputs":{"text":"hello"}}'
```

### Conformance

```bash
cd backend/typescript
npm run test:conformance
```

Honest pass-matrix vs. `@openwop/openwop-conformance` v1.1.0 — a **2026-05-15-era snapshot**. The sample has since wired 9 vendor host surfaces + the `ctx.interrupt`/`ctx.suspend` primitive, which adds capability coverage but has **not been re-measured** against the current suite; treat the counts below as a floor, not the current state:

| Suite | Pass | Skip-equivalent | Reason for skip |
|---|---|---|---|
| `openwop-core` | ✅ all | — | — |
| `openwop-stream-sse` | ✅ all | — | — |
| `openwop-interrupts` | ✅ all | — | — |
| `openwop-replay-fork` | ✅ all | — | — |
| `openwop-node-packs` | ✅ all | — | — |
| `openwop-audit-log-integrity` | — | ❌ all | Stubbed auth; no Ed25519 checkpoint signing |
| `openwop-production-profile` | — | ❌ all | Sample doesn't claim production-profile (no SLA, no claim acquisition) |
| `openwop-durable-webhooks` | partial | partial | Demonstrates HMAC delivery; Cloud Tasks queue stubbed |

## Deploy to Cloud Run

```bash
cd backend/typescript
gcloud run deploy workflow-engine --source . --region us-central1
```

The Dockerfile is pre-wired for `--source` deploys. For real production:

- Replace the in-memory secret resolver (`src/byok/secretResolver.ts`) with a KMS-backed implementation.
- Replace the sqlite storage adapter (`src/storage/sqlite/`) with Postgres / Firestore / DynamoDB.
- Replace the stub identity resolver (`src/host/identityResolver.ts`) with Firebase Auth / OIDC / your IdP.
- Wire the OTel SDK to your collector (replace the console exporter in `src/observability/tracer.ts`).
- Add the Cloud Tasks dispatch surface (mirror `services/workflow-runtime/src/runDispatch/` from the MyndHyve reference).

## Architecture

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for component diagram, boundary discipline, and the file-by-file map between this sample and `MYNDHYVE-ON-OPENWOP-SHOULD-BE-ANALYSIS.md` §3.

## File map

```
openwop-app/
├── README.md                              # this file
├── ARCHITECTURE.md
├── backend/
│   └── typescript/
│       ├── Dockerfile                     # multi-stage Node 22-slim + esbuild
│       ├── package.json
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       ├── src/
│       │   ├── index.ts                   # express bootstrap
│       │   ├── routes/                    # 7 route modules
│       │   ├── bootstrap/                 # 6 boot-time installers
│       │   ├── host/                      # HostAdapterSuite (15 slots)
│       │   ├── storage/                   # sqlite (default) + memory (tests)
│       │   ├── byok/                      # secret resolver + ephemeral run secrets
│       │   ├── observability/             # OTel tracer + cost emitter
│       │   ├── middleware/                # auth, traceContext, errorEnvelope
│       │   ├── packs/                     # tarball loader + signature verify
│       │   ├── executor/                  # node-module dispatch loop
│       │   └── types.ts
│       ├── conformance/                   # @openwop/openwop-conformance harness
│       ├── scripts/                       # local-dev helpers
│       └── test/                          # vitest unit + integration
└── frontend/
    └── react/
        ├── package.json
        ├── vite.config.ts
        ├── tsconfig.json
        ├── index.html
        └── src/
            ├── main.tsx
            ├── App.tsx
            ├── client/                    # @openwop/openwop wrappers
            ├── runs/                      # run lifecycle UI
            ├── streams/                   # SSE event stream view
            ├── interrupts/                # 4 kinds of interrupt renderers
            ├── byok/                      # key entry + policy explainer
            ├── discovery/                 # capabilities panel
            └── styles/
```

## Adding more languages or frameworks

The `backend/<language>/` and `frontend/<framework>/` shape is intentionally future-proof:

- A future Python Cloud Run reference: `backend/python/`
- A future Go AWS Lambda reference: `backend/go/`
- A future Vue frontend: `frontend/vue/`

When adding, mirror the structure (README + Dockerfile/build config + src/) and update the file map above.

## See also

- `plans/openwop-reference-app-plan.md` — the analysis this sample was built from
- `examples/hosts/postgres/README.md` — the production-profile reference host
- `MYNDHYVE-ON-OPENWOP-SHOULD-BE-ANALYSIS.md` (in the MyndHyve repo) — the should-be guide that informed this sample's scope
