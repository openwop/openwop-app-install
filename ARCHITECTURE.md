# workflow-engine — Architecture

> Companion to [`README.md`](./README.md). This file documents the *shape* of the app — what each layer is for, what stays neutral, and the boundary discipline that keeps the app from drifting into a private fork.

## Architecture contract for new work

This application is an OpenWOP host plus a feature-package platform. New
features must extend that architecture; they must not create parallel systems
for concepts the app already owns.

Use this as the first review checklist for every new feature, agent, workflow,
schedule, integration, public route, or admin surface:

- **Follow the OpenWOP wire.** Runs, events, interrupts, workflow definitions,
  schedules, agents, BYOK credentials, host capabilities, replay, fork, and
  provider calls must use the existing OpenWOP protocol shapes and host
  extension patterns. Do not invent a second run model, event stream,
  scheduling model, agent registry, workflow registry, credential path, or
  capability document inside a feature.
- **Do not fork the protocol in this app.** If a change needs a new run-event
  field, capability flag, endpoint contract, auth profile, error semantic, agent
  wire shape, workflow-definition shape, schedule wire shape, or normative
  `MUST`, that belongs in the upstream OpenWOP RFC/spec process before or with
  the host implementation. Host-local product APIs live under
  `/v1/host/openwop-app/*` and remain non-normative.
- **Use the feature-package seam.** Product features live under
  `backend/typescript/src/features/<id>/` and
  `frontend/react/src/features/<id>/`, then append to the backend and frontend
  feature registries. A feature owns its service, routes, UI, tests, optional
  packs, optional `ctx.features.<id>` workflow surface, and ADR.
- **Let the backend be the authority.** Feature toggles, variants, RBAC,
  connection resolution, consent decisions, BYOK secret resolution, and
  capability support are server-side decisions. The frontend can render the
  backend's resolved view, but it cannot be the source of truth.
- **Prefer the existing owner for every concept.** Organizations, members,
  roles, scopes, and workspaces are owned by `accessControl` / workspace
  tenancy. Users and canonical subjects are owned by the identity/session
  layer. Credentials are owned by BYOK and Connections. Agents are owned by the
  agent registries, roster, and pack loaders; an agent's *capabilities*
  (e.g. the assistant operating-rhythm) live at the **core agent level** and are
  **activated per named agent via its `agentProfile`**, never hard-coded to a
  `roleKey` (ADR 0023 §Correction / ADR 0031). Workflows are owned by the
  workflow catalog and executor. Schedules are owned by the scheduler service
  and daemon. Notifications, approvals, comments, CMS, media, publishing,
  governance, and trigger delivery each already have an owner. Extend those
  owners instead of rebuilding them in a feature directory.
- **Advertise only honored behavior.** `/.well-known/openwop`, the node catalog,
  host-surface flags, auth profiles, and feature workflow surfaces must reflect
  behavior the host actually enforces. A disabled or unwired behavior should
  fail closed or advertise `supported: false`, not silently pretend to exist.
- **Keep replay and fork deterministic.** If a feature changes run behavior,
  stamp the resolved choice into run metadata at creation and read it back
  verbatim on replay/fork. Do not recompute feature variants, provider choices,
  agent bindings, or prompt bindings for historical runs.
- **Use pinned packs and existing loaders.** New executable node/agent behavior
  should ship as OpenWOP packs through the signed registry/dev-mount pipeline.
  Feature toggles gate activation, not pack presence, so historical runs can
  still resolve their node and agent types.
- **Use the shared storage and host-surface seams.** Durable state goes through
  the `Storage` interface, `DurableCollection`, or an established feature
  service. Host capabilities go through the host-surface registry/adapters. Do
  not add private one-off databases, queues, vector stores, credential stores,
  search adapters, or background dispatch loops unless the architecture first
  records why the existing seam cannot carry the requirement.
- **Record non-trivial decisions.** New architecture, cross-cutting seams,
  auth/RBAC/BYOK/replay behavior, public unauthenticated surfaces, workflow
  surfaces, connector behavior, and anything touching the wire need an ADR under
  `docs/adr/`. Protocol changes additionally need an OpenWOP RFC.

The practical rule: a new feature should make the existing system more capable,
not create a smaller second copy of the system beside it.

## Layers

```
┌────────────────────────────────────────────────────────────────────┐
│  frontend/react/                                                   │
│  React UI — consumes @openwop/openwop SDK, renders interrupts,    │
│  streams events, displays capabilities, handles BYOK input        │
├────────────────────────────────────────────────────────────────────┤
│              ↑ HTTPS + SSE + Bearer auth (wire only)              │
├────────────────────────────────────────────────────────────────────┤
│  backend/typescript/                                               │
│  Express server                                                   │
│    ├── routes/         REST + SSE wire surface                    │
│    ├── middleware/     auth, traceContext, errorEnvelope          │
│    ├── bootstrap/      one-shot boot installers                   │
│    ├── executor/       node-module dispatch loop                  │
│    ├── host/           HostAdapterSuite — 15 neutral adapters     │
│    ├── byok/           secret resolver + ephemeral run secrets    │
│    ├── packs/          tarball loader + SRI/Ed25519 verify        │
│    ├── observability/  OTel tracer + cost emitter                 │
│    └── storage/        sqlite (default) | memory (tests)          │
└────────────────────────────────────────────────────────────────────┘
                          ↓ depends on (npm)
                @openwop/openwop          (wire types + SDK)
                @openwop/openwop-conformance  (test harness)
```

**Dependency direction is strict and downward.** The frontend never imports backend internals. The backend never imports frontend code. Both layers consume `@openwop/openwop` for wire types — same package, different surface.

## Existing extension seams

New work should normally enter through one of these seams:

| Need | Existing seam |
|---|---|
| Product feature with routes/UI/data | `backend/typescript/src/features/<id>/` + `frontend/react/src/features/<id>/` |
| Backend feature composition | `BACKEND_FEATURES` in `backend/typescript/src/features/index.ts` |
| Frontend feature composition | `FRONTEND_FEATURES` in `frontend/react/src/features/registry.ts` |
| Core route module | `ROUTE_MODULES` in `backend/typescript/src/routes/registerAllRoutes.ts` |
| Frontend route/nav/admin rail/command palette | `FEATURES` in `frontend/react/src/chrome/features.tsx` |
| Feature toggle / beta / variant | `backend/typescript/src/host/featureToggles/` |
| Workflow-visible feature API | `ctx.features.<id>` via `backend/typescript/src/host/featureSurfaces.ts` |
| Workflow execution | `backend/typescript/src/executor/` and `workflowCatalog` |
| Agent templates and installed pack agents | `AgentRegistry`, pack `agents[]`, and agent routes |
| Standing agent instances / named coworkers | `rosterService`, agent workspace routes, heartbeat daemon |
| Agent config + capability activation | `agentProfile` host-ext (`/v1/host/openwop-app/agents/:id/profile`) + `AgentProfile.capabilities` (ADR 0031) |
| New third-party provider | RFC 0095 connection pack under `examples/connection-packs/<id>/pack.json` (ADR 0033) — no code |
| Schedules / recurring work | scheduler routes, `schedulingService`, `scheduleDaemon` |
| Human approvals | approval service/routes and interrupt/approval-gate primitives |
| Credentials and third-party app auth | BYOK secret resolver + Connections broker |
| Durable feature data | `Storage`, `DurableCollection`, or the owning feature service |
| Host capabilities for pack nodes | host-surface registry and selected surface adapters |
| Public content | CMS, Media, Publishing, Sharing, Forms, Consent, and Analytics public-route patterns |
| Governance / policy / audit | governance service and `storage.listAudit` |

If a proposed feature does not fit any seam, treat that as an architectural
decision to document before implementing, not as permission to add a parallel
path.

## Agents, workflows, and schedules

Agents, workflows, and schedules are first-class OpenWOP/application concepts,
not feature-local inventions.

- **Agents** must come from the existing agent surfaces: pack-declared manifest
  agents, user-authored agents in the persisted agent registry, or standing
  roster members. A feature may add agent templates or bind variants to agents,
  but it should not add a private agent table, private dispatcher, or private
  tool loop.
- **Agent capabilities are CORE, not named.** A capability (the assistant
  operating-rhythm graph + perception/action loops, etc.) belongs at the
  core-agent level and is activated per agent through `agentProfile.capabilities`
  — NEVER special-cased to a named agent or `roleKey`. Iris (Chief of Staff) and
  the Executive Operations twin are both just agents with the `assistant`
  capability activated; there is no "Iris's graph," only the tenant work-graph any
  capability-activated agent operates on (ADR 0023 §Correction, ADR 0031).
- **Workflows** must be workflow definitions executed by the shared executor.
  A feature may provide workflow templates, node packs, feature workflow
  surfaces, or UI to author workflows, but it should not create a separate
  workflow engine or alternate run lifecycle.
- **Schedules** must use the scheduler service and daemon. A feature may create
  scheduled jobs, expose scheduling UI, or provide scheduled workflow templates,
  but it should not poll its own private cron loop for work that the scheduler
  already models.
- **Run side effects** must flow through the existing run/event/interrupt/
  approval/idempotency machinery. Feature-specific actions should compose those
  primitives rather than bypassing them.

This keeps agent activity, workflow history, approvals, replay/fork, audit,
notifications, governance, and capability discovery aligned across the app.

## Feature-package architecture

The design of record is
[`docs/adr/0001-feature-first-package-architecture.md`](./docs/adr/0001-feature-first-package-architecture.md)
and the living catalog is [`FEATURES.md`](./FEATURES.md). A new product feature
is expected to follow this shape:

```text
backend/typescript/src/features/<id>/
├── feature.ts        # BackendFeature: id, routes, toggle, packs, surface
├── routes.ts         # /v1/host/openwop-app/<id>/*, backend-gated
├── <id>Service.ts    # domain logic and durable data access
└── surface.ts        # optional ctx.features.<id> workflow API

frontend/react/src/features/<id>/
├── routes.tsx        # FrontendFeature: route/nav fragment
├── <Id>Page.tsx      # user/admin surface
└── <id>Client.ts     # API client for host-extension routes
```

Feature route modules should gate their behavior by resolving the backend
toggle and by enforcing the existing tenant/RBAC/consent/connection rules for
the data they touch. Frontend routes use `featureId` for visibility, badges, and
page state, but the server remains authoritative.

Some features have graduated to always-on substrate. That does not mean they
leave the architecture; they still remain `BackendFeature` / `FrontendFeature`
modules for ownership and composition. It only means they do not declare a
runtime `toggleDefault`.

## Protocol and host-extension boundary

The OpenWOP protocol surface is the contract clients and conformance depend on:
run lifecycle endpoints, stream modes, interrupts, replay/fork behavior,
capability discovery, auth profiles, host capabilities, BYOK semantics, pack
execution, canonical errors, and workflow definitions.

Product features may add host-extension routes under `/v1/host/openwop-app/*`.
Those routes can be rich and durable, but they are not allowed to mutate the
OpenWOP wire by accident. When a host-extension pattern becomes generally
needed by OpenWOP clients, promote it through an RFC rather than quietly
depending on app-local behavior.

Capability honesty is mandatory:

- Do not advertise a capability unless the route, enforcement, storage, replay,
  and failure semantics are implemented.
- Do not add a feature workflow surface to discovery unless workflow nodes can
  actually call it under the same toggle and RBAC rules as the REST/UI surface.
- Do not expose a provider, connector, auth profile, MCP surface, search/vector
  backend, or production posture unless the selected backend is configured and
  fail-closed.
- Do not relax an OpenWOP `MUST`, required field, error meaning, event shape, or
  endpoint contract in app code.

## What's a "thin host wrapper"?

The MyndHyve `services/workflow-runtime/` is ~17K LOC because it wires a private engine package into a product host with Firebase auth, Firestore storage, KMS BYOK, Cloud Tasks dispatch, MyndHyve canvas types, and 47 vendor packs.

This app is target ~2–3K LOC because it:

- Implements the wire surface from scratch (like `examples/hosts/postgres/`), since the public `@openwop/openwop` SDK is a *client*, not an engine.
- Stubs auth (any non-empty Bearer token → synthetic principal).
- Stubs storage at sqlite (in-process; one node).
- Stubs BYOK at an in-memory map.
- Stubs Cloud Tasks dispatch with `setImmediate`.
- Registers only `core.*` packs + one example pack (`local.openwop-app`).
- Has no canvas types, kanban, brand, entities, or product surface.

A real deployment swaps each stub for a real implementation. The route handlers and the executor stay.

## The 15 host adapter slots

Mirrors the MyndHyve `HostAdapterSuite` triage. Each slot has a neutral implementation in this app:

| Slot | Real wrap (8) | Implementation |
|---|---|---|
| `tenantResolver` | ✅ | sqlite table `tenants` |
| `scopeResolver` | ✅ | sqlite table `scopes` |
| `workflowCatalog` | ✅ | sqlite table `workflows` + filesystem fallback |
| `principalAuthorizer` | ✅ | role-based, sqlite-backed |
| `identityResolver` | ✅ | stub: any-non-empty-Bearer → synthetic principal |
| `observabilitySink` | ✅ | OTel console exporter |
| `auditSink` | ✅ | sqlite append-only `audit_log` |
| `secretResolver` | ✅ | in-memory map (BYOK) |

| Slot | Minimal wrap (3) | Implementation |
|---|---|---|
| `artifactResolver` | ✅ | `local-fs:///` URI scheme only |
| `contextProviderRegistry` | ✅ | in-memory `Map` |
| `extensionManifestRegistry` | ✅ | sqlite (empty by default) |

| Slot | Throw-on-use stub (4) | Implementation |
|---|---|---|
| `enterprisePolicyResolver` | ⛔ | throws `host_capability_missing` |
| `environmentResolver` | ⛔ | throws `host_capability_missing` |
| `connectorInvoker` | ⛔ | throws `host_capability_missing` |
| `providerPolicyResolver` | ⛔ | throws `host_capability_missing` |

A pack that declares `peerDependencies: ["host.connectors"]` will be refused at register-time when its required surface is `throw-on-use`. This is the OpenWOP `host.*` capability contract working as designed (see `spec/v1/host-capabilities.md`).

## Boundary discipline

Three rules:

### 1. No frontend imports in the backend, no backend imports in the frontend

The two `package.json`s have disjoint dependency trees. The frontend declares `@openwop/openwop`; the backend declares its server deps + `@openwop/openwop` for wire types only. There is no shared local package between them.

### 2. All app-local additions live under `local.*` or `openwop-app.*` namespaces

- Example pack: `local.openwop-app` (NOT `core.*`, NOT `vendor.openwop.*`)
- Example workflow: `openwop-app.uppercase`
- Discovery's extension block: `extensions.openwop-app.*` only

This protects the `core.*` and `openwop.*` namespaces from app-local drift.

### 3. The Cloud Run shape is a deployment archetype, not a coupling

The Dockerfile is multi-stage Node 22-slim + esbuild bundle, listening on `$PORT`, with `/health` + `/readiness` probes — i.e., the canonical Cloud Run shape. But the code statically imports **no** cloud SDK: the AWS/Azure/GCP KMS clients are *optional* dependencies, dynamically imported only when `OPENWOP_BYOK_KMS_KEY` selects that backend (`src/byok/kmsBackends.ts`), so `npm install --omit=optional` yields a cloud-SDK-free image. A deployer who runs the same image on Fly.io / Render / ECS / Kubernetes gets the same behavior — and [`deploy/`](./deploy/README.md) ships a ready-made pack for each (compose, fly, render, aws, azure, gcp).

## Component-by-component map vs. the should-be doc

For each requirement in `MYNDHYVE-ON-OPENWOP-SHOULD-BE-ANALYSIS.md` §3, here's where the app implements it:

| Should-be requirement | Location |
|---|---|
| Engine kernel via `@openwop/openwop` | `src/executor/` (implements wire surface; `@openwop/openwop` consumed for types) |
| `/.well-known/openwop` advertisement | `src/routes/discovery.ts` |
| Run lifecycle endpoints | `src/routes/runs.ts` |
| 4 interrupt kinds + signed-token callback | `src/routes/interrupts.ts` |
| 4 stream modes + Last-Event-ID resume | `src/routes/streams.ts` |
| `Idempotency-Key` + `invocationId` | `src/routes/runs.ts` + `src/executor/invocationLog.ts` |
| BYOK end-to-end with strip-on-persist | `src/byok/` + `src/storage/sqlite/runStore.ts` (strip-on-persist invariant tested) |
| Pack consumption (SRI + Ed25519) | `src/packs/tarballLoader.ts` |
| OTel under `openwop.*` | `src/observability/tracer.ts` |
| Cloud Run shape | `Dockerfile` + `src/index.ts` (`$PORT`, health probes) |
| Conformance harness | `conformance/` |

| Frontend should-be | Location |
|---|---|
| `@openwop/openwop` browser consumption | `src/client/` (thin wrappers) |
| Run lifecycle UI | `src/runs/` |
| SSE event stream rendering | `src/streams/EventStreamView.tsx` |
| 4 interrupt renderers | `src/interrupts/` |
| Capability discovery UI | `src/discovery/CapabilitiesPanel.tsx` |
| BYOK key entry + policy explainer | `src/byok/` |

## Crash recovery + delivery durability (multi-instance-safe)

Two former "next step" gaps are now closed in the app itself — both built on
an atomic, lease-based claim that works across instances (Postgres `FOR UPDATE
SKIP LOCKED`, sqlite a single write transaction):

- **Run dispatch.** `executor.executeRun` — the single chokepoint every dispatch
  path funnels through — stamps a dispatch lease (`storage.setRunDispatchLease`)
  for this instance, expiring past the maximum legal runtime, so a live run is
  never re-dispatched. The `runDispatchSweeper` re-claims and re-runs
  `pending`/`running` runs whose lease expired (the owning instance crashed); the
  re-run is idempotent against the Layer-2 invocation log. A `createdAt` grace
  window keeps fresh dispatches from being raced; `waiting-*`/terminal runs are
  excluded by status.
- **Webhook delivery.** Routes enqueue a durable `webhook_deliveries` row per
  subscriber; the `webhookDeliveryWorker` claims due rows under a lease, signs +
  POSTs them, and retries with exponential backoff until dead-lettering — so a
  crash or transient receiver failure no longer drops a delivery (the prior
  `setImmediate` path did).

Both workers run only in the long-lived server entry (`main`); tests drive the
exported `sweepOrphanedRuns` / `processDueWebhookDeliveries` deterministically.

## Failure modes the app explicitly does NOT guard against

These are valid critiques of the app as a *production* artifact, but in scope only for the documented "next step" follow-ups:

- **Audit-log integrity.** No hash chain, no Ed25519 checkpoint signatures. Use the postgres reference host for that profile.
- **Production SLA claims.** This app doesn't advertise `openwop-production-profile`.
- **Pack publishing.** Read-only catalog only. Publishing lives in the postgres host's `pack-consumer.ts` story + `examples/node-pack-publishing/`.

When swapping a stub for a real implementation, also update the relevant `capabilities` block in `src/routes/discovery.ts` so the advertisement stays honest.

---

## Surfaces added after the initial scaffolding

### AI chat surface (`frontend/react/src/chat/` + `backend/.../bootstrap/nodes.ts` `vendor.openwop-app.chat-responder`)

A vertical slice from chat input → real provider dispatch → streamed tokens back into the bubble. Components:

- `ChatTab.tsx` — state machine that routes between BYOK wizard (no key) and `ChatSidebar` (key present).
- `ChatSidebar.tsx` + `ChatHeader` + `MessageFeed` + `MessageBubble` + `ChatInput` + `WelcomeCard` — the sidebar UI.
- `useChatSession.ts` — message thread state + per-turn dispatch. Each turn = one `POST /v1/runs` with `workflowId: 'openwop-app.chat.turn'`. Subscribes to SSE; appends `node.message` deltas to the in-flight assistant bubble; on `node.suspended` fetches the open interrupt and renders the matching card via the registry.
- **Card registry** (`chat/registry/`) is the extensibility seam. Adopters call `registerCard({cardType, Component, ...})` from any module to add their own card type. Built-in registrations cover the 4 interrupt kinds (approval / clarification / refinement / cancellation). Cards wrap in `CardErrorBoundary` so a broken third-party card doesn't crash the panel.

BE-side: `vendor.openwop-app.chat-responder` node calls Anthropic / OpenAI / Google providers via raw `fetch` (no SDK deps). Each token delta becomes a `node.message` event through `ctx.emit()` — strip-on-persist applies automatically.

### Host-extension HTTP routes (vendor-prefixed)

Per `spec/v1/host-extensions.md` §"Canonical prefixes", anything outside the OpenWOP v1 wire contract MUST be vendor-prefixed. This app's additions:

- `GET / POST / DELETE /v1/host/openwop-app/byok/secrets[/:ref]` — runtime BYOK key management (replaces the env-only flow).
- `GET /v1/host/openwop-app/runs/:id/interrupts` — authed list of open interrupts with their resume tokens. Necessary because `node.suspended` events strip the token from the public event log so SSE / webhook fanout can't leak a resolution capability. Strong candidate for future RFC promotion — every host that strips tokens needs this surface.

### BYOK persistence (`backend/.../byok/`)

- `secretResolver.ts` delegates to sqlite via new `Storage` methods (`upsertEncryptedSecret` / `getEncryptedSecret` / `deleteSecret` / `listSecretRefs`).
- `encryption.ts` provides AES-256-GCM with master-key resolution: `OPENWOP_BYOK_ENCRYPTION_KEY` env var → auto-generated `data/.byok-master-key` (0600 perms) on first boot.
- Security boundary documented at the top of `encryption.ts`: protects against backup leaks and database extraction; does NOT protect against full filesystem access (master key on disk) or process memory inspection (decrypted plaintext cached in-process). This local-AES path is the portable fallback; for production set `OPENWOP_BYOK_KMS_KEY` to a managed KMS key (AWS KMS / Azure Key Vault / Google Cloud KMS — `src/byok/kmsBackends.ts` + `kmsEncryption.ts`), which never lands the wrapping key on disk.

### Pack coverage: all `core.openwop.*` nodes in the builder palette

On boot the server runs three layered pack-loading steps:

1. **`ensureRegistryPacksInstalled()`** — fetches published, Ed25519-signed packs (`core.openwop.ai`, `core.openwop.http`, …) from `packs.openwop.dev` and verifies them per spec. Trust anchor: registry public keys at `<repo>/registry/keys/<keyId>.pub`.
2. **`ensureLocalPacksMounted()`** — dev-mode fallback (`src/bootstrap/mountLocalPacks.ts`). Symlinks every `core.openwop.*` directory from the repo's `packs/` tree into the same `OPENWOP_PACK_DIR` the registry installer writes to. Two refinements:
   - **Skip-if-installed** — never clobbers a registry-installed pack with the same name.
   - **Shadow-if-newer** (default; opt out with `OPENWOP_STRICT_REGISTRY=true`) — when the repo manifest version is greater than the registry-installed version, rename the installed dir aside (`<name>.registry-<oldVersion>`) and symlink the repo dir in its place. Logged loudly; reversible by deleting the symlink and `mv`-ing the `.registry-*` dir back.
3. **`seedDefaultHostSurfaces()`** + **`initInMemorySurfaces({ dataDir })`** — declares the full RFC 0014–0019 surface list with `supported=false` defaults, then wires in-memory adapters (`src/host/inMemorySurfaces.ts`) and flips each wired surface to `supported=true`.

The catalog endpoint (`GET /v1/host/openwop-app/node-catalog`) cross-references each node's typeId against `bootstrap/hostSurfaceMap.ts` to compute `requiresHostSurfaces` + `missingHostSurfaces`. The UI dims palette items whose surfaces aren't advertised and shows a warning banner in the inspector; runs of those nodes return a friendly `host_capability_missing` envelope (augmented in `packs/tarballLoader.ts`).

### In-memory host surfaces (non-durable)

`src/host/inMemorySurfaces.ts` builds one surface bundle per run, scope-bound to `tenantId`:

| Field on `ctx` | Backing impl | Used by packs |
|---|---|---|
| `ctx.storage.kv` | `Map<tenantId, Map<key, entry>>` with TTL | `core.openwop.storage` (kv-*) |
| `ctx.storage.table` | tenant-scoped Map, table namespacing via key prefix | `core.openwop.storage` (table-*) |
| `ctx.storage.cache` | KV under a separate state Map | `core.openwop.storage` (cache-*) |
| `ctx.storage.blob` | Map of base64 blobs, synthetic `presign()` URL | `core.openwop.storage` (blob-*) |
| `ctx.storage.queue` | FIFO array per (tenant, queue) | `core.openwop.storage` (queue-*) |
| `ctx.db.sql` | `better-sqlite3` `:memory:` DB per tenant + parametric heuristic | `core.openwop.db` (sql-*) |
| `ctx.db.vector` | brute-force cosine over an in-memory Map | `core.openwop.db` (vector-*), `core.openwop.rag` (vector-*) |
| `ctx.fs` | sandboxed local fs under `<dataDir>/host-fs/<tenant>/` with path-escape rejection | `core.openwop.files` (read/write/stat/list/delete) |
| `ctx.queueBus` | in-memory publish/ack/nack/streamPublish | `core.openwop.messaging` (publish/ack/nack/stream-*) |
| `ctx.observability` | delegates to the workflow-engine structured logger | `core.openwop.obs` (log/metric/span/alert) |

Surfaces NOT wired (advertised honestly as `supported=false`): `host.mcp`, `host.a2a`, `host.triggers` (subset), `host.db.nosql`, `host.db.search`. The palette badges these as "host?" in the UI and the inspector explains.

### Path to real backends (the surface seam)

The interface contracts in `src/host/inMemorySurfaces.ts` (`KvSurface`, `TableSurface`, `SqlSurface`, …) are the *same* shapes a real-backend host will satisfy. The `NodeContext` typing in `src/executor/types.ts` (`HostStorageSurfaces`, `HostDbSurfaces`, …) doesn't bind to a specific implementation. Each portable surface is selected at build time through the backend seam in `src/host/surfaceBackends.ts`: by default every surface resolves to the `'memory'` (non-durable) tier; a deployment overrides any one via `OPENWOP_SURFACE_<KEY>` (or `OPENWOP_SURFACE_BACKEND` globally). To swap a surface with a real backend:

1. Create `src/host/<backend>/<surface>.ts` exporting a factory `(scope) => KvSurface` (or `SqlSurface`, …) over the real store.
2. Register it: `registerSurfaceAdapter('kv', 'redis', factory)` (typically from the adapter module, imported at boot). `buildHostSurfaceBundle` then resolves the selected backend per surface automatically — no edit to the bundle factory or pack code. Selecting a backend with no registered adapter **fails at boot** (`assertSelectedBackendsAvailable`), never silently falling back to the in-memory tier.
3. The advertised `implementation` tag is computed from the selected backend (`effectiveImplementation`), so once a surface uses `'redis'` / `'postgres'` / `'s3'` instead of `'memory'`, `/.well-known/openwop` reports it and the capabilities-panel non-durable badge self-clears.
4. Re-run `npm run test:conformance` to ensure the openwop-conformance suite still passes against the new wiring.

The reference for *real* backend wiring lives in `examples/hosts/postgres` — that example already pressures the RFC 0014–0019 contracts against actual services, and is the natural place to ship production-grade adapters before they migrate into this app's host suite.

### Shared provider catalog (`providers.json`)

Single source of truth for AI provider + model data. Both BE (`src/providers/catalog.ts` for default-model fallback) and FE (`src/byok/lib/providers.ts` for the wizard) read from the same file. The FE loader includes a runtime validator that fails loud on shape mismatch — better than silent `undefined`/`NaN` rendering.

Edit the JSON to add/remove providers or models. The `_schemaVersion` field hints at versioned schema for future migrations.
