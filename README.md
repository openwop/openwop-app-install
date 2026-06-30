> **Published white-label install bundle.** Auto-synced from `openwop/openwop-app` (source `8b3fa006`). Clone or download the release zip, then follow **[WHITE-LABEL.md](./frontend/react/WHITE-LABEL.md)** to deploy your own. Generated — PRs here are not merged; development happens upstream.

# openwop-app — OpenWOP Application

> **The live reference deployment of an OpenWOP host** — and a white-label starting point you can fork and rebrand. Consumes the protocol via the published [`@openwop/openwop`](https://www.npmjs.com/package/@openwop/openwop) SDK; the protocol spec itself lives in [`openwop/openwop`](https://github.com/openwop/openwop). Carved from that monorepo (`apps/workflow-engine`) with full history.
>
> **Status:** Runs in production at [app.openwop.dev](https://app.openwop.dev/). Adopt it as a white-label template (see [`frontend/react/WHITE-LABEL.md`](./frontend/react/WHITE-LABEL.md)); harden against your own security review before your own production use. Remaining productionization is tracked in [`MIGRATION-TODO.md`](./MIGRATION-TODO.md).
> **SDK:** consumes `@openwop/openwop` `^1.2.0` (+ `@openwop/openwop-conformance` for the black-box suite).
> **License:** [Apache-2.0](./LICENSE).
>
> **Live demo:** [app.openwop.dev](https://app.openwop.dev/) — anonymous, browser-session-scoped. Build + run workflows visually; BYOK keys are session-only. Resets every 24h. [Smoke test](./DEPLOY-SMOKE.md) · [Privacy](https://app.openwop.dev/privacy)

A deployable reference application demonstrating the full vertical slice of an OpenWOP host: a Cloud Run-shape TypeScript backend that implements the v1.1 wire contract, paired with a React frontend that consumes it via the published SDK.

## What this app demonstrates

### Backend (`backend/typescript/`)

- **All four canonical run-lifecycle endpoints** — `POST /v1/runs`, `GET /v1/runs/{id}`, `POST /v1/runs/{id}/cancel`, `POST /v1/runs/{id}:fork`
- **All four interrupt `kind`s** — `approval`, `clarification`, `refinement`, `cancellation` — wired through `POST /v1/runs/{id}/interrupts/{nodeId}` and the signed-token callback `POST /v1/interrupts/{token}`
- **SSE event stream** with the four canonical stream modes (`values` / `updates` / `messages` / `debug`) and `Last-Event-ID` resume
- **Two-layer idempotency** — HTTP `Idempotency-Key` + engine `invocationId`
- **BYOK end-to-end** — node manifest declares `requires.secrets[]`, run options carry `credentialRef`, secret resolves at execute time, secret material is stripped from persisted run-doc / events / errors
- **Pack consumption** — fetch + verify + extract pack tarballs from `packs.openwop.dev` at boot (SHA-256 SRI + Ed25519 sig over `pack.json` bytes per `registry/scripts/verify-signatures.mjs`). Installed packs survive across restarts under `~/.openwop-packs/` and are re-verified against their trust marker on every load to catch post-install tampering.
- **MCP server mount** (RFC 0020) — opt-in JSON-RPC endpoint at `POST /v1/host/openwop-app/mcp` that lets external MCP clients (Claude Desktop, Cursor, conformance harness) discover and invoke workflows as MCP tools/resources/prompts, with bidirectional `sampling/createMessage` + `elicitation/create` bridged into `ctx.callAI` / `ctx.suspend`. Env-gated on `OPENWOP_MCP_SERVER_ENABLED=true`. OFF by default; the boot log emits a `NEVER enable in production without auth review` warning when ON. All 6 `mcp-server-*.test.ts` conformance scenarios pass behaviorally against this mount.
- **Full `core.openwop.*` + reference `vendor.myndhyve.*` palette out of the box** — every core pack in the repo (`a2a, agents, ai, crypto, data, db, examples, files, flow, hitl, http, integration, mcp, messaging, obs, rag, storage, triggers`) **plus the reference vendor packs** (`chat, canvas, kanban, knowledge-tools, launch-studio, web-research`) surfaces in the visual builder — the app now wires their `host.{chat,canvas,kanban,knowledge,launchStudio,webResearch}` surfaces (+ `host.a2a`, `host.triggers`, `host.db.nosql`) so those nodes run, not just render. Unsigned packs from the repo are mounted as dev-mode symlinks alongside signed registry installs; the catalog response marks any node whose host surface isn't advertised so the UI can dim it and the inspector can explain. See `ARCHITECTURE.md §"Pack coverage"`.
- **In-memory host surfaces (non-durable)** — `ctx.storage.{kv,table,cache,blob,queue}`, `ctx.db.{sql,vector}`, `ctx.fs`, `ctx.queueBus`, `ctx.observability` are wired with process-local adapters so most core-pack nodes execute end-to-end. State is wiped on restart. The interface contracts match what a real-backend host (`examples/hosts/postgres`) implements, so swapping any surface is a one-file change. See `ARCHITECTURE.md §"Path to real backends"`.
- **`aiProviders` host surface end-to-end** — packs that declare `peerDependencies: { aiProviders: "supported" }` (e.g., `core.openwop.ai`) execute via `ctx.callAI(...)` per `spec/v1/host-capabilities.md §host.aiProviders`. All four policy modes (`disabled` / `optional` / `required` / `restricted`) gated per `spec/v1/capabilities.md:246-289`; credentials resolved by convention (`secrets[provider]` then `<provider>-*` / `<provider>:*` prefixes); cleartext API keys never cross the result boundary or land in events; provider-specific error bodies are NEVER forwarded (they get mapped to the 15 canonical error codes from `host-capabilities.md:141-154` so upstream credential-shaped error payloads can't leak through). `OPENWOP_AI_POLICY_<PROVIDER>` env-vars drive the resolver.
- **Prompt-library composition seam (RFC 0027 Phase A)** — advertises `capabilities.prompts.{supported: true, endpointsSupported: false, observability: "full"}`. The composition pipeline (`src/host/promptCompose.ts`) implements RFC 0027 §E's secret redaction (`[REDACTED:<credentialRef>]` markers) + untrusted-content wrapping (`<UNTRUSTED>...</UNTRUSTED>`) + sha256 deterministic hashing for `prompt.composed` events. Exercised end-to-end via `POST /v1/host/openwop-app/prompt/compose` (host-extension test seam) by the conformance scenarios `prompt-composed-secret-redaction.test.ts` + `prompt-composed-trust-marker.test.ts`. The spec'd Phase B `/v1/prompts*` REST surface (RFC 0028) is **not** implemented — `endpointsSupported: false` is honestly advertised so clients see the spec'd `501 capability_not_provided` instead of a 404 (route missing).
- **OTel under `openwop.*`** with W3C `traceparent` propagation
- **Cloud Run shape** — single container, `$PORT`, `/health` + `/readiness`, multi-stage Dockerfile with esbuild bundle
- **Conformance harness** — `npm run test:conformance` runs `@openwop/openwop-conformance` against the local service
- **Multi-member B2B workspace tenancy + RBAC (ADR 0015)** — the tenant *is* the workspace. A signed-in user gets a personal workspace, can create **shared workspaces**, **invite members** with RFC 0049 roles (`owner` / `admin` / `editor` / `viewer`), and **switch** the active workspace — membership-gated and fail-closed, so one session only ever holds one active workspace (RFC 0048 §D cross-workspace isolation). A **≥1-owner invariant** is enforced atomically on member demote/remove (`updateMember` / `deleteMember`, post-write re-check) with an **ownership-transfer** escape hatch (`POST /v1/host/openwop-app/orgs/:orgId/members/:memberId/transfer-ownership`); **account deletion cascades** the user out of their shared workspaces and *refuses* — rather than orphaning — any workspace they solely own. Intra-workspace role-scoping on the *protocol* surface is gated on `OPENWOP_AUTHORIZATION_ENFORCEMENT` (advertised via `capabilities.authorization` only when honored). See [`docs/adr/0015-workspace-as-tenant-b2b.md`](docs/adr/0015-workspace-as-tenant-b2b.md).
- **Real enterprise auth — OIDC, password, MFA (TOTP), SAML 2.0 SSO + SCIM 2.0 provisioning (ADR 0002 / RFC 0050)** — sign in with a federated OIDC issuer, an email/password local account (with optional TOTP MFA), or **enterprise SSO** against a real IdP (Okta / Azure AD / Ping) via a production SAML Service Provider (real XML-DSig); **SCIM 2.0** endpoints sync joiner/mover/leaver lifecycle out-of-band (fail-closed deactivation). Both are env-gated OFF until configured and advertised honestly (`openwop-auth-saml` / `openwop-auth-scim` appear in `/.well-known/openwop` only when the host can back them). Every method resolves to one durable `User` with a stable `user:<id>` subject (ADR 0003). See [**Enterprise SSO (SAML 2.0)**](#enterprise-sso-saml-20--okta--azure-ad--ping) below to configure it.
- **DAG executor with concurrent paths** — workflows are no longer limited to a single linear chain. The scheduler (`src/executor/scheduler.ts`) drains a topological ready-queue with bounded concurrency (`OPENWOP_MAX_CONCURRENT_NODES`, default 8) and honors the five canonical `WorkflowEdge.triggerRule` values from `spec/v1/workflow-definition.schema.json` (`all_success` / `any_success` / `all_complete` / `none_failed` / `any_failed`). Edge `condition` predicates filter per-edge input contributions. Per-node outputs land in a port-keyed map (`{ output: ... }`); downstream nodes read by `targetInput` from any incoming edge. Suspended branches keep the run alive while other branches drain; on resume, the resolved node flips to `completed` and the scheduler re-enters. Cycles reject at run-start with `cycle_detected`. Linear workflows are a degenerate case of the same scheduler — back-compat preserved bit-for-bit.
- **Enterprise Work-Twin agent suite (ADR 0031/0032/0033)** — a seeded portfolio of **ten role-based work twins** (Chief of Staff, Executive Operations, Sales Execution, Customer Success, Finance Close, IT Service Desk, Internal Communications, Recruiting Coordinator, People Operations, Contract & Procurement) built entirely on the existing roster / workflow / scheduler / connections seams — not a parallel system. Each twin carries a rich **`agentProfile`** (`GET/PUT /v1/host/openwop-app/agents/:id/profile`: config params, permissions, HITL, escalation, channels, metrics, `requiredConnections`, autonomy + `capabilities`), binds a portfolio from a pinned **44-template workflow pack** (`tmpl.*`, approval-gated), and runs at draft/recommend autonomy with **`requiredConnections` activation gating** (fail-closed / `supported:false` until a Connection is configured). The **assistant operating-rhythm capability is core + profile-activated** — decoupled from `roleKey` so any agent (Iris, Exec-Ops) activates it over the shared tenant work-graph (ADR 0023 §Correction). See [`FEATURES.md`](FEATURES.md) § "Enterprise Work-Twin agent suite".

### Frontend (`frontend/react/`)

- **`@openwop/openwop` SDK consumption from the browser** — same package as the BE for wire types
- **Run lifecycle UI** — create, status, cancel, fork from any event
- **SSE event stream rendering** with `Last-Event-ID` resume across reconnect
- **Interrupt rendering for all four `kind`s** — reference cards demonstrating the host-extension renderer pattern
- **Capability discovery panel** — live render of `GET /.well-known/openwop`
- **BYOK key entry + policy explainer** — visualizes the resolution order
- **Branching + merging in the builder** — drag a second outgoing edge from any node for fan-out; multiple edges into a single target node form a fan-in. The right-hand inspector exposes the edge's `triggerRule` (`all_success` / `any_success` / `all_complete` / `none_failed` / `any_failed`) and optional `condition` predicate (`path`+`op`+`value` over the source's output). Cycles still reject at save time.

## What this app is NOT

- **Not a fifth reference host.** Conformance is owned by `examples/hosts/postgres/` (production-profile, 91.9% of 850 scenarios). **Re-measured 2026-06-23 against `@openwop/openwop-conformance` v1.34.0** (full-catalog basis, `OPENWOP_CONFORMANCE_ROOT=../openwop`): this app passes **2105 / 2195 scenarios with 0 host-attributable failures**, the remaining 89 being capability-gated soft-skips for surfaces it intentionally stubs (production-profile audit chain, sandbox isolation, durable-webhook queue, …). See the pass-matrix under "Conformance" below.
- **Not normative.** Reference implementation of an OpenWOP host; not part of the v1.1 spec corpus.
- **Not coupled to one cloud.** The single container image runs on any platform, and [`deploy/`](./deploy/README.md) ships ready-made packs for **Docker Compose** (the cloud-free default), **Fly.io**, **Render/Railway**, **AWS**, **Azure**, and **Google Cloud**. Storage, BYOK key-wrapping (KMS), identity (OIDC), and object storage are env-selected behind interfaces; the cloud SDKs are *optional* dependencies loaded only when chosen. Real KMS backends exist for **AWS KMS**, **Azure Key Vault**, and **Google Cloud KMS** (`OPENWOP_BYOK_KMS_KEY=aws-kms:… / azure-keyvault:… / projects/…`), plus a portable local-AES fallback.
- **Not a fork of the production-grade postgres host.** It deliberately omits the audit-log integrity profile, durable webhook queue, multi-region partition handling, and other production concerns outside this app's scope.
- **Tenancy invariants over the in-memory tier.** The workspace ≥1-owner guard (and other read-then-write invariants) are enforced over the in-memory / portable `DurableCollection` with a **post-write re-check + compensating restore** — correct (it never leaves a workspace ownerless, even across instances under read-committed reads), but a concurrent collision returns a *retryable* `409` rather than serializing, and a reader can transiently observe the mid-operation state. A production multi-region host should back these with a real DB transaction or a `CHECK`/uniqueness constraint. The public demo also runs with `OPENWOP_AUTHORIZATION_ENFORCEMENT=off` — role-scoping is *previewed*, not enforced, on the protocol surface (flip it on for enforced B2B; see the ADR 0015 "Deployment postures" table and [`ARCHITECTURE.md §"Path to real backends"`](ARCHITECTURE.md)).

### `aiProviders` known limits

- **Embeddings, image generation, video generation** — advertised as `false`; the corresponding `core.ai` pack nodes throw `host_capability_missing`. The app's `providers/dispatch.ts` only wires the three chat-completion endpoints.
- **Tool-calling is Anthropic-only** — advertised via `aiProviders.toolCalling.providers: ['anthropic']`. OpenAI / Google tool-use wire shapes are not implemented. Packs requesting tool-calling on other providers fail with `host_capability_missing`.
- **Tool-calling is single-round** — `ctx.callAIWithTools(...)` returns `{ content, toolCalls[], finishReason, usage, model }` from one Anthropic round trip. The pack (or downstream workflow nodes) is responsible for executing the tools and re-invoking the LLM with results appended to `messages`. The app's chat tab uses a separate multi-round helper (`dispatchAnthropicWithTools`) for its in-bubble tool-use loop; that is not exposed on `ctx`.
- **Per-tenant policy uses env-var defaults** — `OPENWOP_AI_POLICY_<PROVIDER>` env vars apply to every `(tenantId, scopeId)` tuple. Real hosts persist per-tenant policy in their tenants table; the policy resolver's signature accepts `{tenantId, scopeId}` so swapping the impl is a one-file change.
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
  -d '{"workflowId":"openwop-app.uppercase","tenantId":"demo","inputs":{"text":"hello"}}'
```

### Conformance

```bash
cd backend/typescript
npm run test:conformance
```

Honest pass-matrix vs. `@openwop/openwop-conformance` **v1.34.0** — **measured 2026-06-23**
(full-catalog basis, `OPENWOP_CONFORMANCE_ROOT=../openwop`; supersedes the prior
v1.1.0 / 2026-05-15 snapshot):

> **2105 passed · 89 capability-gated skips · 0 host-attributable failures** — of 2195
> scenarios (370 files). The lone non-pass was a measurement artifact, not a defect:
> `spec-corpus-validity` flagged a broken link in `plans/named-workflow-agents-and-org-chart.md`,
> an **untracked orphan file** left on disk in the local sibling `../openwop` checkout but
> already deleted from the canonical corpus (`origin/main` post-migration). Against a clean
> `origin/main` it does not exist, so the corpus check passes there too — **0 real failures,
> host or corpus**. The 89 skips are capability-gated soft-skips for surfaces this sample
> host intentionally stubs.

The per-family breakdown stays qualitative:

| Suite | Pass | Skip-equivalent | Reason for skip |
|---|---|---|---|
| `openwop-core` | ✅ all | — | — |
| `openwop-stream-sse` | ✅ all | — | — |
| `openwop-interrupts` | ✅ all | — | — |
| `openwop-replay-fork` | ✅ all | — | — |
| `openwop-node-packs` | ✅ all | — | — |
| `openwop-realtime-voice` (RFC 0106) | ✅ all | — | non-vacuous via the test-seam arm (ADR 0109) |
| `openwop-audit-log-integrity` | — | ❌ all | Stubbed auth; no Ed25519 checkpoint signing |
| `openwop-production-profile` | — | ❌ all | This app doesn't claim production-profile (no SLA, no claim acquisition) |
| `openwop-sandbox-isolation` | — | ❌ all | No pack sandbox (no process/network/env isolation gate) |
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

## Enterprise SSO (SAML 2.0 — Okta / Azure AD / Ping)

The backend ships a **production SAML 2.0 Service Provider** (`src/host/auth/samlSso.ts`,
real XML-DSig via `@node-saml/node-saml`) so a company can turn on real enterprise
SSO alongside OIDC + password (ADR 0002, riding the accepted RFC 0050
`openwop-auth-saml`). It is **OFF until configured** — honest gating: when the four
required `OPENWOP_SAML_*` vars are unset, the host does **not** advertise
`openwop-auth-saml` in `/.well-known/openwop`, the "Sign in with SSO" button is
hidden, and every SP route `404`s. Setting them flips all three on at once.

On a validated assertion the ACS provisions a durable `User` keyed `saml:<NameID>`
(the stable, opaque RBAC subject — ADR 0003) and issues a session cookie; IdP
groups are captured verbatim for host-side group→role mapping (ADR 0006).

**SP routes** (pre-auth — the assertion signature is the credential):

| Route | Purpose |
|---|---|
| `GET  /v1/host/openwop-app/auth/saml/sso/login[?returnTo=/]` | SP-initiated redirect to the IdP |
| `POST /v1/host/openwop-app/auth/saml/sso/acs` | IdP POSTs the `SAMLResponse` → validate → session |
| `GET  /v1/host/openwop-app/auth/saml/sso/metadata` | SP metadata XML (upload to the IdP) |

### Configure (two sides — IdP + this host)

**1. In your IdP (Okta example) — create a "SAML 2.0" app:**

- **Single sign-on URL (ACS):** `https://<your-host>/api/v1/host/openwop-app/auth/saml/sso/acs`
- **Audience URI (SP Entity ID):** a stable value, e.g. `https://<your-host>/saml`
  (use the **same** value as `OPENWOP_SAML_SP_ENTITY_ID` below)
- **Name ID format:** `EmailAddress` (recommended); add a `groups` attribute if you
  want IdP groups captured.
- *(Optional)* instead of typing the above, import this SP's metadata URL:
  `https://<your-host>/api/v1/host/openwop-app/auth/saml/sso/metadata`

Then, from the app's **Sign On** tab, copy the **Identity Provider Single Sign-On
URL** and the **X.509 Signing Certificate**.

**2. On this host — set five env vars** (the first four are required; the fifth
defaults to `default`). Locally, drop them in `backend/typescript/.env`:

```bash
OPENWOP_SAML_IDP_SSO_URL=https://<your-org>.okta.com/app/<app-id>/sso/saml
OPENWOP_SAML_IDP_CERT=<X.509 signing cert — full PEM, or one-line base64 body>
OPENWOP_SAML_SP_ENTITY_ID=https://<your-host>/saml
OPENWOP_SAML_ACS_URL=https://<your-host>/api/v1/host/openwop-app/auth/saml/sso/acs
OPENWOP_SAML_TENANT=<workspace SAML users land in; default `default`>
```

**On Cloud Run**, add them **incrementally** so the rest of the live config (the
7-secret + env binding) is preserved — use `--update-*`, never `--set-*`, and keep
the certificate in Secret Manager rather than a plaintext env var:

```bash
gcloud run services update openwop-app-backend \
  --region us-central1 --project openwop-dev \
  --update-env-vars OPENWOP_SAML_IDP_SSO_URL=https://<org>.okta.com/app/<id>/sso/saml,OPENWOP_SAML_SP_ENTITY_ID=https://app.openwop.dev/saml,OPENWOP_SAML_ACS_URL=https://app.openwop.dev/api/v1/host/openwop-app/auth/saml/sso/acs,OPENWOP_SAML_TENANT=<tenant> \
  --update-secrets OPENWOP_SAML_IDP_CERT=<secret-name>:latest
```

**Verify:** `curl https://<your-host>/api/.well-known/openwop` lists
`openwop-auth-saml` under `auth.profiles`, the SSO button appears on the sign-in
card, and a full IdP-initiated login lands you in the `OPENWOP_SAML_TENANT`
workspace. The complete knob inventory + Okta walkthrough also lives in
[`backend/typescript/.env.example`](backend/typescript/.env.example).

### SCIM 2.0 provisioning (joiner / mover / leaver)

SSO authenticates a *login*; **SCIM** provisions and de-provisions the *account*
out-of-band, so when someone joins, changes teams, or leaves in the IdP, the host
reflects it without anyone signing in. The backend exposes bearer-authed SCIM 2.0
endpoints (`src/routes/authScim.ts`) — also **OFF until configured** and advertised
honestly (`openwop-auth-scim` appears only when `OPENWOP_SCIM_BEARER` is set).

| Route (IdP base `https://<host>/api/scim/v2`) | Purpose |
|---|---|
| `POST   /scim/v2/Users` | create/upsert a principal (`scim:<userName>`) |
| `PATCH  /scim/v2/Users/{id}` `{ active }` | reactivate / deactivate |
| `DELETE /scim/v2/Users/{id}` | deactivate (leaver) — **fail-closed**: a disabled user stops resolving |
| `POST   /scim/v2/Groups` | group-membership sync (→ host-side roles, ADR 0006) |

Each request must present the IdP's SCIM bearer (constant-time compared against
`OPENWOP_SCIM_BEARER`); the routes self-authenticate and bypass the session layer,
so they work even under the hardened bearer-required posture
(`OPENWOP_AUTH_ENFORCE_BEARER=true`) a real provisioning client runs.

**Configure (Okta example):** on the SAML app's **Provisioning** tab, enable API
integration with **SCIM Base URL** `https://<your-host>/api/scim/v2` and
**Authentication → HTTP Header → Bearer** = your `OPENWOP_SCIM_BEARER`; enable
Create / Update / Deactivate Users and Push Groups. Then set the host vars (keep
the bearer in Secret Manager):

```bash
gcloud run services update openwop-app-backend \
  --region us-central1 --project openwop-dev \
  --update-secrets OPENWOP_SCIM_BEARER=<secret-name>:latest \
  --update-env-vars OPENWOP_SCIM_TENANT=<tenant>
```

`OPENWOP_SCIM_TENANT` defaults to a dedicated `scim` namespace (so a SCIM bearer
can never address password/OIDC accounts it didn't provision); set it to your
`OPENWOP_SAML_TENANT` if SCIM-provisioned and SSO users should share one workspace.
Full setup in [`backend/typescript/.env.example`](backend/typescript/.env.example).

## Connections (third-party app integrations)

**Connections** (ADR 0024) is a per-user / per-org credential broker for external
apps — Google Workspace, Slack, ServiceNow, Zoom (built-in), plus example RFC 0095
connection packs for Microsoft 365, Jira, Salesforce, Notion and Workday under
`examples/connection-packs/` — that feeds the existing MCP/HTTP/integration nodes. It lives at **Admin → Access & data → Connections**
(`/connections`). Two kinds of provider:

- **Token providers** (ServiceNow `api_key`, Zoom `bearer`) — **no host setup**. A
  user just pastes their API key / token on the Connections page; it's stored
  KMS-enveloped and scoped to them.
- **OAuth providers** (Google Workspace, Slack) — need a **one-time host OAuth app
  registration**. Until that's done the "Connect" button is greyed out (honest
  gating: `oauthConfigured: false`). You register an OAuth app with the provider,
  then give this host its **client id + secret** — either through the in-app
  operator panel (below) or env vars.

### Configure an OAuth provider (two sides — provider + this host)

**1. Register an OAuth app with the provider.** Register this **redirect URI**
(exact — the host builds the same path):

```
https://<your-host>/api/v1/host/openwop-app/connections/<provider>/callback
```

| Provider | Where | Scopes (read defaults · write re-consent) | Notes |
|---|---|---|---|
| **Google Workspace** (`google`) | [Cloud Console](https://console.cloud.google.com) → enable Drive/Calendar/Gmail APIs → *Credentials* → **OAuth client ID → Web application** | `drive.readonly`, `calendar.readonly`, `gmail.readonly` · `gmail.send`, `calendar.events` | Gmail/Drive are *restricted* scopes — set the OAuth consent screen to **Testing** + add yourself as a test user (full Google verification is only needed for public external users). |
| **Slack** (`slack`) | [api.slack.com/apps](https://api.slack.com/apps) → *Create New App* → **OAuth & Permissions** | `channels:read`, `channels:history` · `chat:write` | Client ID + Secret are on the app's **Basic Information** page. |

**2a. Give this host the credentials — the operator panel (recommended).** On the
**Connections** page, a superadmin sees an **"OAuth client setup (operator)"**
panel. It shows each provider's exact redirect URI to copy, takes the **Client ID**
and **Client Secret**, and the button goes live on save — **no env vars, no
redeploy**. The secret is sealed server-side (the BYOK envelope) and never shown
again. Superadmin = a tenant in `OPENWOP_SUPERADMIN_TENANTS` (or the admin bearer).

**2b. …or env vars (the fallback).** The host also reads
`OPENWOP_OAUTH_<PROVIDER>_CLIENT_ID` / `…_CLIENT_SECRET` (provider upper-cased), so
a deploy can bind creds without the UI. Locally, drop them in
`backend/typescript/.env`; on Cloud Run, bind **incrementally** (`--update-*`, never
`--set-*`; keep the secret in Secret Manager) and set the two base URLs so the
redirect URI the host builds matches the one you registered:

```bash
gcloud run services update openwop-app-backend \
  --region us-central1 --project openwop-dev \
  --update-env-vars OPENWOP_PUBLIC_BASE_URL=https://app.openwop.dev,OPENWOP_OAUTH_CALLBACK_BASE_URL=https://app.openwop.dev/api,OPENWOP_OAUTH_GOOGLE_CLIENT_ID=<id>,OPENWOP_OAUTH_SLACK_CLIENT_ID=<id> \
  --update-secrets OPENWOP_OAUTH_GOOGLE_CLIENT_SECRET=<secret-name>:latest,OPENWOP_OAUTH_SLACK_CLIENT_SECRET=<secret-name>:latest
```

The UI-managed store takes precedence over env vars when both are set.

**Verify:** `curl https://<your-host>/api/v1/host/openwop-app/providers` shows
`"oauthConfigured": true` for the provider, its **Connect** button enables, and the
consent round-trip returns you to `/connections` with the app connected. The token
is stored KMS-enveloped, scoped to the connecting user (or shared to an org for an
admin-managed connection); write access (e.g. Gmail send) is a separate re-consent.

## Architecture

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for component diagram, boundary discipline, and the file-by-file map between this app and `MYNDHYVE-ON-OPENWOP-SHOULD-BE-ANALYSIS.md` §3.

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

- `plans/openwop-reference-app-plan.md` — the analysis this app was built from
- `examples/hosts/postgres/README.md` — the production-profile reference host
- `MYNDHYVE-ON-OPENWOP-SHOULD-BE-ANALYSIS.md` (in the MyndHyve repo) — the should-be guide that informed this app's scope
