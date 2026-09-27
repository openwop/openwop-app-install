> **Published white-label install bundle.** Auto-synced from `openwop/openwop-app` (source `7faab7190`). Clone or download the release zip, then follow **[WHITE-LABEL.md](./frontend/react/WHITE-LABEL.md)** to deploy your own. Generated — PRs here are not merged; development happens upstream.

# openwop-app — OpenWOP Application

> **The live reference deployment of an OpenWOP host** — and a white-label starting point you can fork and rebrand. Consumes the protocol via the published [`@openwop/openwop`](https://www.npmjs.com/package/@openwop/openwop) SDK; the protocol spec itself lives in [`openwop/openwop`](https://github.com/openwop/openwop). Carved from that monorepo (`apps/workflow-engine`) with full history.
>
> **Status:** Runs in production at [app.openwop.dev](https://app.openwop.dev/). Adopt it as a white-label template (see [`frontend/react/WHITE-LABEL.md`](./frontend/react/WHITE-LABEL.md)); harden against your own security review before your own production use. Productionization state is tracked in the steward assessments (`docs/steward/CODEBASE-ASSESSMENT.md`, `docs/steward/UX-ASSESSMENT.md`, `docs/steward/DATA-ASSESSMENT.md`).
> **SDK:** consumes `@openwop/openwop` `2.0.0` (major 2) plus `@openwop/openwop-v1` (an npm alias of 1.9.0) for the two reads with no major-2 home — discovery and the debug bundle (ADR 0647) — and `@openwop/openwop-conformance` for the black-box suite.
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
- **Operator-configured outbound MCP server** (H21 / ADR 0553) — point the host's MCP *client* at a server you run: `OPENWOP_MCP_SERVER_URL=https://mcp.internal.example` (optionally `OPENWOP_MCP_SERVER_ID` — default `operator-mcp` — `OPENWOP_MCP_SERVER_LABEL`, and `OPENWOP_MCP_SERVER_TOKEN_REF` naming a BYOK credential for the bearer, never a plaintext token). The URL is registered as a curated `reach:'mcp'` Connections provider at boot, so calls travel the ordinary outbound pipeline — governance allow-list, RFC 0093 egress guard, `run.metadata.connectionUse[]` provenance, and the `<UNTRUSTED>` trust boundary on every tool result. Unset ⇒ no server, and a call with no `serverId` fails typed rather than silently doing nothing. A declared-but-unresolvable token ref is refused rather than downgraded to an unauthenticated call; the ref resolves host-global, so it needs `OPENWOP_BYOK_EPHEMERAL=false`. Non-`https` targets require `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true` (test/conformance posture only).
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
- **Not a fork of the production-grade postgres host.** It deliberately omits the audit-log integrity profile, multi-region partition handling, and other production concerns outside this app's scope. (The webhook delivery queue IS durable: `webhook_deliveries` rows with lease-based claims, exponential backoff, `dead` rows, operator retry and retention purge live in the shared `Storage` — sqlite or Postgres — and survive restarts; see `host/webhookDeliveryWorker.ts`.)
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

The harness boots the sample backend in-process on port **18080 by default**. That
port is a scan START, not a fixture: if it is busy — two worktrees running
`npm run ci` on one machine is the common case — the harness moves up to the next
free port and says so in its `[conformance] host port …` boot line. Pin it with
`OPENWOP_CONFORMANCE_PORT=<n>` when something else must know the number in
advance; a **pinned** port that is busy is a hard error, never silently moved.

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

### Who administers the SAML tenant (USERS-19 — changed 2026-09)

**Before** `USERS-19` (ADR 0621 / ADR 0617 D2) every SAML user was the
*implicit owner* of `OPENWOP_SAML_TENANT`: the session's `personalTenant` IS
that tenant, and the route-auth layer treated "active tenant === personal
tenant" as "the caller owns it" — so any SAML member could PATCH, disable or
delete any user, and the tenant's `requireMfa` policy was never enforced on
SAML sessions. **Now** the implicit-owner short-circuit fires only for a
personal-*shaped* tenant (`user:` / `anon:`); in `OPENWOP_SAML_TENANT` (or
`default`) authority is **membership-derived**: `assertTenantScope` →
`resolveSubjectScopesUnion` unions the caller's **member** roles with the
roles of the host **groups** (ADR 0006) the member row belongs to. A SAML login
provisions the durable `User` and captures IdP groups verbatim on it, but it
does **not** seat a member row, and captured IdP groups are **not**
auto-mapped to host roles.

**Deployment impact:** a SAML-only deployment with no member rows now answers
`403 forbidden_scope` on every admin route (`/users/users/*`, members, roles,
governance) until the **first admin is seated**. Seat them once, with the
wildcard operator key — `OPENWOP_API_KEYS=<key>:*` (the `:*` suffix must be
written explicitly; a bare key is scoped to `default`) — against
`POST /v1/host/openwop-app/orgs/:orgId/members` with `roles: ["admin"]` (or
`owner`) and `subject` = the SAML user's `user:<userId>`; that admin then seats
everyone else from **Access → Members**, or through an ADR 0006 host group.
`requireMfa` on the SAML tenant is now enforced on SAML sessions too (the
`/users/me/security` enrollment read and the workspace switch stay exempt so
a refused session can still enroll).

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
can never address password/OIDC accounts it didn't provision). **When SAML SSO is
also configured, it MUST equal `OPENWOP_SAML_TENANT`** — the RFC 0159 leaver
contract (a SCIM deactivation denies the linked SAML login) keys its deny on ONE
tenant, and with differing values it can never fire: the host logs
`subject_link_realms_misaligned` at boot and withholds
`capabilities.auth.subjectLinking` from discovery until they match (`USERS-13`).
Full setup in [`backend/typescript/.env.example`](backend/typescript/.env.example).

## Microsoft sign-in (OIDC via Firebase — optional)

The auth modal ships a **"Continue with Microsoft"** button (Entra ID work
accounts + personal Microsoft accounts) alongside Google/GitHub. It is
**flag-gated OFF by default** so hosts without an Entra app never render a dead
sign-in path. Enabling it is two operator steps — an Entra app registration and
a build flag. (This is sign-in *identity*; connecting Microsoft 365 *data* —
Outlook drafts, OneDrive — is the separate Connections flow below.)

1. **Firebase console** → your project → *Authentication → Sign-in method →
   Add new provider → **Microsoft*** → Enable. Firebase displays the **callback
   URL** to register (`https://<project>.firebaseapp.com/__/auth/handler`) —
   copy it, and leave this tab open.
2. **Entra admin center** ([entra.microsoft.com](https://entra.microsoft.com) →
   *App registrations → New registration*): name it, pick the supported account
   types (choose *"any organizational directory + personal Microsoft accounts"*
   for the broadest sign-in), and add a **Web** redirect URI = the Firebase
   callback URL from step 1.
3. On the new registration: copy the **Application (client) ID**, then
   *Certificates & secrets → New client secret* — copy the secret **Value**
   (shown once).
4. Back in the Firebase Microsoft provider dialog: paste the Application ID +
   secret → **Save**.
5. **Rebuild the SPA with the flag** — set `VITE_AUTH_MICROSOFT=true` (e.g. in
   `frontend/react/.env.production`), then
   `( cd frontend/react && npm run build )` and redeploy hosting. The button
   appears in the sign-in modal; the cross-provider account-link flow (same
   email on Google + Microsoft) is handled like the other OIDC providers.

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

### Quick path: light up "Connect Google Workspace" (~10 minutes)

The most common first setup, end to end. (Generic per-provider details follow;
the demo host's operator runbook lives in
[`DEPLOY.md` § Configuring provider OAuth clients](DEPLOY.md#configuring-provider-oauth-clients-connections).)

1. [Cloud Console](https://console.cloud.google.com) → your project → *APIs &
   Services → Library*: enable the **Google Drive API**, **Google Calendar
   API**, and **Gmail API**.
2. *APIs & Services → OAuth consent screen* — direct link:
   [`https://console.cloud.google.com/auth/overview/create?project=<your-project>`](https://console.cloud.google.com/auth/overview/create?project=)
   — External; app name + support email; authorized domain = your host's
   domain. **Publishing status "Testing" is fine to start** — add yourself
   (and teammates) as test users; Google's full verification is only needed
   once external users are involved (Gmail/Drive are restricted scopes).
3. *Credentials → Create credentials → OAuth client ID → **Web application***.
   Authorized redirect URI (exact):
   `https://<your-host>/api/v1/host/openwop-app/connections/google/callback`.
   Tip: one client can carry several redirect URIs — add
   `…/connections/gmail/callback` on the same client if you also want the
   narrow draft-only `gmail` provider.
4. Copy the **Client ID** and **Client secret**.
5. In the app, signed in as a superadmin (a tenant in
   `OPENWOP_SUPERADMIN_TENANTS`): **Admin → Access & connections →
   Connections** → the **"OAuth client setup (operator)"** panel → pick
   *Google Workspace* → paste ID + secret → **Save**. No env vars, no
   redeploy — the Connect button enables immediately.
6. Verify: click **Connect Google Workspace**, complete consent, land back on
   Connections with the row `active`, then **Test** → green. This also
   activates the first-run vendor setup prompt and the template pre-flight's
   inline Connect buttons (they only appear when a provider is actually
   connectable).

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

## Stripe payments (billing + the Connect seller marketplace)

White-label deployments that want paid plans, AI-token packs, storefront checkout,
or the two-sided **seller marketplace** (ADR 0385) drive everything through **one
Stripe account** you own. Without any of this configured the app runs in honest
demo mode (`demo:` sentinels, no live money) — configure it when you're ready.

### Configure (two sides — Stripe dashboard + this host)

**On the Stripe side:**

1. Create (or reuse) a Stripe account; copy a **secret API key** (`sk_live_…` /
   `sk_test_…`).
2. Add a **webhook endpoint** pointed at
   `https://<your-backend>/v1/host/openwop-app/billing/webhook`, subscribed to:
   `customer.subscription.*`, `invoice.*`, `checkout.session.completed`,
   `payment_intent.succeeded`, `payment_method.attached/detached`, and (for the
   marketplace) `charge.refunded` + `charge.dispute.created/closed`. Copy its
   **signing secret** (`whsec_…`).
3. **Marketplace only:** add a *second* webhook endpoint registration at the
   **same URL** with **"Listen to events on Connected accounts"** enabled
   (`connect=true`), subscribed to `account.updated`, `capability.updated`,
   `account.application.deauthorized`, `payout.paid`, `payout.failed`. Stripe
   gives this registration its **own signing secret** — copy it too. (One URL,
   one handler, two secrets — see ADR 0385's correction notes for why.)

**On this host** (secrets go through the BYOK store — superadmin
`POST /v1/host/openwop-app/byok/secrets` with `{ credentialRef, value }`, or
bulk at boot via the `OPENWOP_BOOT_SECRETS='{"ref":"value"}'` env):

| Credential ref | Value |
|---|---|
| `billing:stripe-key` | the secret API key |
| `billing:webhook-secret` | the platform endpoint's signing secret |
| `billing:connect-webhook-secret` | the `connect=true` endpoint's signing secret (marketplace only) |

Then flip the toggles (Admin → Feature toggles): **`billing`** for
subscriptions/token packs, **`commerce-connect`** for the seller marketplace.
Optional env: `OPENWOP_CONNECT_PLATFORM_REGION` (ISO country of *your* Stripe
account, default `US` — v1 native marketplace payments are limited to sellers in
the same region; others use external payment links) and
`OPENWOP_STRIPE_API_VERSION` (pinned default `2025-12-15.clover`).

### Marketplace semantics you are opting into (ADR 0385)

- Sellers onboard as **Stripe Connect Express** accounts under YOUR platform
  account (Stripe hosts KYC/payouts); buyers pay by **destination charge** — the
  platform is the merchant of record and keeps a **10–15% application fee**
  (superadmin `PUT /v1/host/openwop-app/commerce-connect/fee-config`, clamped,
  default 12%).
- **Both paid listing lanes are operator-approval-gated** (the superadmin
  approval queue on the Commerce Connect page); only free listings ship ungated.
- Under destination charges **the platform eats Stripe fees, refunds, and
  chargebacks**; creator recovery on refund is best-effort `reverse_transfer`.
  The operator console (orders, full refunds, the dispute/platform-loss ledger)
  lives on the Commerce Connect page for superadmins.
- Migrating from an existing platform? The superadmin importers preserve Stripe
  ids verbatim (`POST …/billing/import`, `POST …/commerce-connect/import`) so
  customers/subscriptions/sellers carry over with no re-onboarding.

Verify: `stripe trigger checkout.session.completed` (Stripe CLI) or a test-mode
checkout; the webhook route answers `202` and the order/subscription state
advances. A `503 not_configured` from the webhook means the signing secrets
aren't set yet.

> **⚠ `OPENWOP_BYOK_EPHEMERAL` gotcha — applies to ALL billing secrets.** Billing
> resolves `billing:stripe-key` / `billing:webhook-secret` **host-global** (no
> tenant scope). With `OPENWOP_BYOK_EPHEMERAL=true`, a scopeless/host-global ref
> resolves to **`null`** — so the Stripe key never loads, every checkout falls back
> to `demo`, and the webhook can't verify signatures, no matter where you set the
> secret. **Platform billing REQUIRES `OPENWOP_BYOK_EPHEMERAL=false`** (persistent
> BYOK; pair with `OPENWOP_BYOK_KMS_KEY` for encrypt-at-rest). Trade-off: this flips
> anon-tenant secrets from in-memory-ephemeral to KMS-persistent (still tenant-
> isolated). Set via `--update-env-vars` (never `--set-*`).

> **Where to set the secrets (in-app):** the **Secrets Vault** (`/access?tab=connections`
> → the "Secrets vault" card, superadmin) at **Host-global** scope — NOT the OAuth
> Connections broker on that same page (the Stripe key is BYOK *operator* config, not
> a Connection). The `POST …/byok/secrets` route and `OPENWOP_BOOT_SECRETS` env are
> the non-UI equivalents.

### Sell paid feature bundles (ADR 0419)

Beyond plans and token packs, the **Feature bundles** page (`/marketplace/bundles`)
is a paid store: buying a bundle turns its features ON for the workspace through
runtime entitlements (no download). It rides the same one Stripe account + `billing`
toggle above. Activation is pure operator config — reversible, and **inert until the
`billing` toggle is ON**.

1. **Mint one Stripe Price per bundle you sell** (recurring). A bundle is granted
   **per workspace, unlimited-seat** (one subscription unlocks it for the whole
   tenant), so price it **flat per workspace/month**, not per seat. (Competitive
   framing: this undercuts the per-seat CRM suites and the hub-stacking vendors who
   charge per module — a flat unlimited-seat bundle is the wedge.)
2. **Map prices → bundles + display copy** (operator env — money never lives in
   `bundles.json`):
   - `OPENWOP_BILLING_BUNDLE_PRICES={"price_…":"crm","price_…":"marketing"}`
   - `OPENWOP_BILLING_BUNDLE_DISPLAY={"crm":{"price":"$29","cadence":"/mo","blurb":"…"}}`
     — marketing copy only (never a Stripe id); an absent entry shows the label with
     no fabricated price.
   - `OPENWOP_BILLING_BUNDLE_ONETIME=["<bundleId>"]` for a buy-once unlock (default
     recurring).
3. **Make the paywall bite** by narrowing the plan so the sold features actually
   gate: `OPENWOP_BILLING_PLAN_FEATURES={"free":[…]}`. **The `priced ⟹ gated` rule:**
   the `free` allowlist MUST include every OTHER bundle's features and EXCLUDE the
   features of every bundle you price — else a priced bundle is free (dishonest) or a
   gated feature has no buy path (a permanent 403). Compute it from
   `distributions/bundles.json` (the allowlist = all bundle features minus the priced
   bundles'). Absent plan tiers stay unrestricted (`'*'`); until a plan is narrowed
   the entitlement gate is a no-op.
4. **Set `billing:stripe-key` + `billing:webhook-secret`** (Secrets Vault, host scope
   — mind the `OPENWOP_BYOK_EPHEMERAL` gotcha above) and flip the **`billing`** +
   **`marketplace`** toggles ON.
5. **Smoke, then buy:** a bundle checkout MUST return `mode:"live"` (`demo` means the
   key didn't resolve — fix before arming); then buy with a Stripe test card
   (`4242 4242 4242 4242`) → the webhook grants the entitlement → the bundle's
   features unlock and the store flips to "Owned". Reversible any time by flipping
   `billing` OFF (everything back to `'*'`) or unsetting the env vars.

## White-labeling (rebrand + redeploy as your own product)

The full recipe lives in **[`frontend/react/WHITE-LABEL.md`](./frontend/react/WHITE-LABEL.md)** — brand strings/assets via `VITE_BRAND_*` env vars, colors/typography via `src/brand/brand.css`, backend identity via `OPENWOP_*` env, and the enterprise lockdown recipe (SHELL-1: `VITE_BRAND_APP_GATE_MODE=sign-in` + `OPENWOP_DEPLOY_POSTURE=auth` + SSO). Verify with `scripts/check-branding.sh` before shipping.

The **native shells ship with the project** and follow the same seam (ADR 0291): the desktop app (`clients/desktop/`, Electron) is white-labeled through one `branding.json` (name, app id, icon, accent, hosts) and the iOS app (`clients/ios/`) through `project.yml` Info.plist keys — see each client's README § White-labeling. Both run in either **demo mode** (stock: a hosted-demo quick-connect on the setup screen) or **enterprise mode** (demo affordances removed; `lockedHost` pins the shell to your deployment, which the SPA's sign-in gate + backend `auth` posture then protect). Because the shells load the *server-served* SPA, your web re-brand is automatically the desktop/iOS re-brand — no second theming pass.

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
