# ADR 0072 - AI workflow authoring (the workflow-builder brain)

**Status:** Accepted (implemented)
**Date:** 2026-06-18
**PRD:** in-conversation plan — "Workflow Builder meta-workflow" (AI-driven authoring of workflows from a natural-language automation intent).
**Depends on / composes:** ADR 0001 (feature-package architecture), ADR 0014 (workflow orchestration surface), ADR 0006 (RBAC), ADR 0015 (workspace-as-tenant), the existing **core builder surface** (`frontend/react/src/builder/`), the node-catalog endpoint (`routes/nodeCatalog.ts`), the workflow-registration endpoint (`routes/workflows.ts`), the DAG scheduler (`executor/scheduler.ts`), and the sample author node (`vendor.openwop-app.chat-responder`, `bootstrap/nodes.ts`).
**Surface:** host-extension under `/v1/host/openwop-app/workflow-author/*` (a new `workflow-author` feature-package) + a node pack whose nodes read the catalog, author a graph, validate it, and register it. No wire change.
**RFC gate:** **no new RFC.** "Workflow" is not a normative wire object — only the run lifecycle is. The catalog read (`/v1/host/openwop-app/node-catalog`) and the workflow registration (`POST /v1/host/openwop-app/workflows`) are non-normative host-extension routes. Making "AI workflow authoring" or node-schema introspection a **portable, cross-host advertised capability** would require an OpenWOP RFC — out of scope here.

> **Correction (2026-07-22) — the `BackendFeature.builtinWorkflows` contract this
> ADR introduced is DEPRECATED.** Workflows are never hard-coded: a workflow ships
> as a **chain** (nodes + edges, an RFC 0013 / ADR 0163 workflow-chain pack, loaded
> via `host/workflowChainPackLoader.ts` → surfaced in the builder + the `/` picker,
> instantiated tenant-owned + editable via `…/workflows/from-chain`) or as a
> **stack** (todos on a kanban board, ADR 0311; a chain can be *stacked* as a card).
> A code-pinned `builtinWorkflows` definition is invisible to `/builder` + `/` (both
> list only the tenant ownership index) and is not user-editable. The ~18 existing
> in-tree builtins (this ADR's meta-workflow included) are **legacy to migrate**;
> new features MUST NOT declare `builtinWorkflows`. Where a workflow's shape exceeds
> today's chain format (composes `core.subWorkflow`, or threads run-produced
> `variables[]`), extend the chain format via a new RFC 0013 revision — do not revert
> to hard-coding. Governing docs: `ARCHITECTURE.md` § "Agents, workflows, and
> schedules" + `CLAUDE.md` § "Workflows — never hard-code".
>
> **Correction 2 (2026-08-21, ADR 0596) — "deprecated" now UNDERSTATES it, and
> this ADR's own meta-workflow has already migrated.** The seam is not merely
> discouraged: the `BackendFeature.builtinWorkflows` FIELD is GONE (declaring one
> is a TypeScript error), `host/builtinWorkflows.ts` is DELETED, and
> `LEGACY_PINNED_WORKFLOWS` is frozen EMPTY by the ADR 0472 P4 ratchet. The
> meta-workflow described at §Phase 3 and §"New seams" below is now the RFC 0013
> chain pack `core.openwop.workflows.workflow-author`
> (`examples/workflow-chain-packs/workflow-author/`), registered same-id via
> `registerChainBackedWorkflow` in `metaWorkflow.ts`. Those two sections are left
> as written — they record what shipped in June 2026, which is the point of the
> record — but nothing below describes a live mechanism. **Three** *current-state*
> doc sites still asserted otherwise and had their prose REPLACED by ADR 0596:
> `FEATURES.md`'s row, this feature's `feature.ts` docblock (which contradicted
> its own `registerRoutes` body twelve lines later), and its `routes.ts` header.
> `ROADMAP.md`'s Done row is a HISTORICAL record like this one, so it carries an
> APPENDED correction note instead — the same treatment as this note.
> *(Count corrected 2026-08-21, ADR 0596 §Correction 10: this said "four … and
> `ROADMAP.md`", which contradicted ADR 0596 §9's own account of what it did. In
> a doc-rot PR, the record of the fix drifting from the fix is the same defect
> one level up.)*

## Why this exists

The app already ships every mechanical piece needed to *build and run* a workflow: a node catalog with inlined JSON Schemas, a workflow-registration endpoint, a DAG executor, and a full xyflow visual builder. What it lacked is the **authoring brain** — the thing that turns "when a new high-value lead comes in, summarize it and notify the deal owner" into a connected, schema-valid node/edge graph that materializes in the builder. This feature is the one capability that makes every *other* workflow cheaper to build and maintain.

The user framing is load-bearing: this is a **meta-workflow** — a workflow whose job is to author other workflows — not merely a backend codegen endpoint. The authoring brain ships as a **node pack** so it is itself runnable in the engine (replayable, auditable, composable like any other workflow), with a thin host-extension route as the synchronous front door the UI calls.

## Feature-refinement audit (prove nothing is "new" that already ships)

| Concept | Existing owner (`file:line`) | Decision |
|---|---|---|
| List of legal node types + their config/input/output schemas | `GET /v1/host/openwop-app/node-catalog` → `routes/nodeCatalog.ts` (`CatalogNode[]`, schemas inlined <8KB, `requiresHostSurfaces`/`missingHostSurfaces`) | **Extracted** the catalog builder to `host/nodeCatalogBuilder.ts`; the route and the feature both consume it (one source). |
| Workflow definition shape | `WorkflowDefinition` → `executor/types.ts:450-511`; `EdgeDef` → `executor/types.ts:427-448` | **Emit this exact shape.** No parallel definition type. |
| Workflow persistence + validation | `POST /v1/host/openwop-app/workflows` → `routes/workflows.ts` (incl. RFC 0022 §C `core.dispatch`/`core.subWorkflow` gate) | **Extracted** the validator to `host/workflowDefinitionValidation.ts`; the route now delegates, and the feature persists through the SAME validator — one validation path, no drift. |
| DAG execution / trigger rules | `executor/scheduler.ts` (Kahn topo-sort, `triggerRule`, `condition`) | The authored graph runs on the existing scheduler unchanged. |
| Visual canvas + dynamic catalog fetch + serialize | `frontend/react/src/builder/` (xyflow v12), `palette/catalogRegistry.ts`, `schema/serialize.ts`/`deserialize.ts` | **Extended, not forked.** A "Create with AI" entry dispatches the run and loads the authored definition via the existing deserialize path. The builder stays a core, ungated surface; only AI authoring is toggle-gated. |
| An LLM-calling node in the vendor namespace | `vendor.openwop-app.chat-responder`; pack pattern `packs/feature.documents.nodes/index.mjs` (`ctx.callAI`) | **Reference pattern** for the `draft` node (same `callAI` plumbing + structured output). |

**No route collision** (`grep workflow-author` → only the new feature). **No concept duplication** — the catalog and registration routes remain the sole owners; this feature is a consumer/composer with zero new storage for the catalog or workflow definitions.

**Builder gating note (PRD-vs-architecture correction):** the existing builder is *not* a feature-package (no `feature.ts`, absent from `FRONTEND_FEATURES`). It is core/ungated. So the AI authoring capability is its own toggle-gated feature-package (`workflow-author`); it must not retroactively gate the hand-build builder.

## Decision

Add a `workflow-author` feature-package whose deliverable is a **catalog-grounded authoring pipeline**, exposed two ways over one implementation:

1. **Node pack** (`feature.workflow-author.nodes`) — the meta-workflow building blocks:
   - `feature.workflow-author.nodes.draft` — reads the live catalog, calls the LLM, emits a candidate `WorkflowDefinition`, repairing on validation errors up to `maxAttempts` (the loop lives INSIDE the node — the scheduler forbids cycles).
   - `feature.workflow-author.nodes.validate` — re-checks against the catalog + registration contract; FAILS the run (so persist never fires) when invalid.
   - `feature.workflow-author.nodes.persist` — registers the validated definition through the shared path; output carries the authored `workflowId`.
   Wired `draft → validate → persist` (with `validate → persist` carrying `triggerRule: all_success`) they ARE the meta-workflow (`openwop-app.workflow-author`, pinned at boot).

2. **Host-extension routes** (`POST .../workflow-author/draft`, `GET .../workflow-author/catalog`) — the synchronous front door the "Create with AI" UI calls. `draft` dispatches the meta-workflow run and returns its `runId`; the FE subscribes and loads the authored definition (the `persist` node's output) into the canvas.

### Hard invariants (enforced in code + tests)

- **Closed-world typeIds.** Every emitted `node.typeId` MUST exist in the catalog — `validate`/`persist` reject any out-of-catalog typeId (would `unknown_typeid` at run time). *(test: `workflow-author-service.test.ts`)*
- **Schema-conformant config + wiring.** The author prompt injects each node's schemas; the FE derives ports from `required` schema props the same way `catalogRegistry.ts` does.
- **Capability-gate honesty.** RFC 0022 §C gate runs via the shared validator before persist; an authored graph that would 400 on registration is rejected first. *(test: gate via `setCapabilityOverlay`)*
- **Schema-too-large.** Nodes whose schema (>8KB) the catalog couldn't inline are EXCLUDED from the authoring menu + logged (`workflow_author_catalog_excluded`), never guessed at.

## Phased plan → as-built

| Phase | Scope | Status |
|---|---|---|
| 1 | Node pack + service + surface + `draft`/`catalog` routes; `BACKEND_FEATURES`; tests | ✅ |
| 2 | AI-chat path = agent pack + nodes (this host's envelope path, ADR 0058 precedent — no separate envelope-acceptor seam) | ✅ |
| 3 | FE "Create with AI" entry (gated) → dispatch run → load authored `workflowId` into canvas | ✅ |
| 4 | `ctx.features['workflow-author']` surface (`getCatalog`/`validateDraft`/`persistDraft`) + `feature.workflow-author.agents` "Workflow Architect" | ✅ |

Verification: backend `node node_modules/vitest/vitest.mjs run` → 1988 passed / 0 failed; `frontend/react && npm run build` → all gates green.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package (ADR 0001)** | `src/features/workflow-author/` (service + surface + routes + feature.ts) + FE builder entry; appended to `BACKEND_FEATURES`; no core route/nav edits (core builder untouched). |
| 2 | **Toggle + admin UI** | **None — always-on** (graduated 2026-06-19; toggle retired in `RETIRED_TOGGLE_IDS`). The builder is a core ungated surface, so AI authoring rides alongside it without a flag. Supersedes the earlier toggle + §Correction. |
| 3 | **Workflow orchestration (ADR 0014)** | `ctx.features['workflow-author']` surface — `getCatalog` (read), `validateDraft` (read), `persistDraft` (write) — ungated (`featureSurfaces` alwaysOn, no toggle default). The meta-workflow is a feature **built-in** (`builtinWorkflows` → catalog source A). |
| 4 | **Node pack** | `feature.workflow-author.nodes.{draft,validate,persist}` — the meta-workflow. |
| 5 | **AI-chat integration** | the agent pack + nodes ARE the chat path (no separate envelope seam, ADR 0058). |
| 6 | **Agent pack** | `feature.workflow-author.agents` — "Workflow Architect" persona, tool-allowlisted to the node pack. |
| 7 | **Public surface** | None. Authed-only; no `PUBLIC_PATH_PREFIXES` addition. |
| 8 | **RBAC + isolation (ADR 0006)** | authed-only (always-on); the `draft` dispatch carries the same per-IP run-creation quota (`runQuotaMiddleware`) + concurrency-slot reservation + audit record (`workflow-author.draft`) as `POST /v1/runs` (cost-abuse guard); persist runs through the shared validator (RFC 0022 §C gate); tenant from the run scope. |
| 9 | **Replay / fork safety** | the authoring run is a normal run (`metadata.source='workflow-author'`) dispatched via the core `host/runDispatch.ts` seam; the authored workflow is data, deterministic given the same catalog + intent + model. |
| 10 | **Frontend** | `workflowAuthorClient.ts` + `AiAuthorPanel.tsx` + an always-shown toolbar button; `ui/` cohesion + i18n (en + pt-BR) + token-based CSS. |

## §Correction — toggle removed; feature is always-on (2026-06-19, supersedes the bucket correction)

The feature first shipped behind a `workflow-author` toggle, then a follow-up corrected `bucketUnit` `user`→`tenant` (surfaces gate at tenant granularity). Both are now **moot: the toggle was removed and the feature graduated to always-on.** Rationale: the builder is itself a core, *ungated* surface, so gating only the "Create with AI" affordance behind a flag was incongruent; always-on also removes the surface-gating/bucketing question entirely (`featureSurfaces` is alwaysOn when no toggle default is registered). The toggle id is listed in `RETIRED_TOGGLE_IDS` so any lingering durable override is reconciled at boot (the cms/connections/users precedent). The earlier bucket reasoning is preserved above for the trail.

## Alternatives weighed

- **Plain backend codegen service (no node pack).** Simpler but abandons the "meta-workflow" intent and forfeits replay/audit/composability. Rejected as primary; the synchronous route is kept as a thin front door over the node-pack pipeline.
- **Author into the FE builder's local format then save.** Would duplicate serialize logic and bypass the server validator (drift). Rejected — author the canonical `WorkflowDefinition` and persist through the shared validated path.
- **New normative node-catalog-introspection capability on the wire.** Unnecessary for this host; would gate the feature on an RFC. Deferred.

## Follow-on (post-merge batch, 2026-06-19)

- **Demo seed** — `host/workflowAuthorSeed.ts` + a `workflow-author-examples` entry in `EXAMPLE_DATA_SEEDERS`: two showcase workflows built from deterministic demo nodes (`local.sample.demo.mock-ai`, `core.approvalGate`), `metadata.showcase`-badged illustrative, idempotent seed + clear-by-id. Auto-seeds in `OPENWOP_DEMO_MODE`, loadable from `/example-data`.
- **Provenance (resolved Open Q4)** — instead of a separate `WorkflowAuthoringRecord` store (no-parallel-architecture), the `draft` node stamps `metadata.authoring = { authoredVia, intent, model, attempts }` onto the candidate, and the shared validator now **preserves `metadata` / `variables` / `inputSchema` / `configurableSchema`** through registration (previously dropped — a latent gap for any API caller, now fixed for every registration path).
- **Eval harness** — `scripts/eval-workflow-author.mjs` (`npm run eval:workflow-author`): runs a battery of intents against a live app + provider, scoring registered / closed-world / structurally-sane; skips cleanly with no `OPENWOP_EVAL_BASE_URL`. Guards authoring quality against prompt regressions.
- **Validation errors surfaced** — the "Create with AI" panel now shows the `validate` node's structured error instead of a generic failure.

## Follow-on (always-on + core-seam batch, 2026-06-19)

Driven by a review of "is every piece built at a reusable core seam, not isolated to this feature?":

- **Always-on** — removed the `workflow-author` toggle (retired); routes + surface are ungated. Removes the bucketing question entirely.
- **`BackendFeature.builtinWorkflows` seam (NEW, reusable)** — any feature can now contribute always-present, restart-safe, cross-instance built-in workflows via the standard feature contract; `registerBackendFeatures` populates the core `host/builtinWorkflows.ts` registry and `host/index.ts` (catalog source A) resolves it. The meta-workflow moved here from the in-memory `registerWorkflow()` boot call, aligning it with how every other built-in (`openwop-app.*`, demo role-workflows) is declared.
- **Closed-world check → core** — `runnableNodeTypeIds()` + `findUnknownTypeIds()` now live in `host/nodeCatalogBuilder.ts` (reusable by any caller — builder pre-flight, linters), not trapped in the feature service.
- **Run dispatch → core** — `host/runDispatch.ts` (`buildRunRecord` + `dispatchRunInBackground`) is now shared by `POST /v1/runs` AND the workflow-author draft route, removing the duplicated record-construction + dispatch glue.

## Open questions

1. **Draft↔validate loop budget** — default 2 retries (3 attempts), capped at 5 via `maxAttempts`.
2. **bucketUnit** — moot; feature is always-on (see §Correction).
3. **Schema-too-large nodes** — still excluded from the authoring menu (kept for prompt economy; a `?full=1` catalog mode remains the deferred option, host-ext, no RFC); they stay legal/registrable.
4. **Provenance record** — resolved (see Follow-on): stamped on `metadata.authoring`, no separate store.
5. **Real-model verification + deploy** — the live `ctx.callAI` path still needs an end-to-end run against a configured provider (`npm run eval:workflow-author`), and a backend+frontend deploy to expose it on `app.openwop.dev`. Operational (needs provider key + deploy auth).

## RFC verdict

**Host-extension; no new RFC.** All surfaces ride non-normative `/v1/host/openwop-app/*` routes and accepted behavior (run lifecycle, node packs, the registration contract, RFC 0022 §C gating). Only a portable, cross-host advertised authoring/introspection capability would need an OpenWOP RFC via `/prd`.


## § Follow-on — Conversation Compiler (innovation strategy, 2026-06-24)

The innovation strategy proposes a "Compile" action turning a chat thread into a
workflow / agent / form / dashboard / report / task-board / API endpoint / prompt-pack /
chat-card-pack. This **extends THIS ADR**: the workflow-author already does NL-intent →
closed-world `WorkflowDefinition` via the shared catalog + validator + RFC 0022 §C gate;
the compiler generalizes the *source* (a whole conversation) and the *targets*
(multi-surface), reusing the same closed-world authoring discipline + draft-first UX per
target. Start with the workflow + prompt-pack targets (already-modeled artifacts);
form/dashboard targets compose the relevant feature packs. Host-extension, no new RFC.
