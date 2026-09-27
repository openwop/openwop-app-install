# Workflow Author (unit B1) — chat-first port review

**Scope:** `backend/typescript/src/features/workflow-author/` + its packs
(`packs/feature.workflow-author.{nodes,agents}`) + the builder's AI-authoring
frontend surface (`frontend/react/src/builder/CreateWithAiPanel.tsx` and its one
consumer `BuilderShell.tsx:449`). Single-feature mode.

**Headline:** This feature is already a strong RIDES / A+ reference (LLM-EXCHANGE-AUDIT
line 17) — the chat path is the ONE chat scoped to a real agent whose ACTION tools
drive the shared `draft → validate → persist` node pipeline over the shared validator +
registry; there is no bespoke chat, no orphaned workflow, no toothless agent. **One
real blocker:** the persist/read surface rides the workflow *definition registry* but
skips the *ownership/authz layer* the canonical route pairs with it — AI-authored
workflows are unowned host-global rows and the Architect's `get` tool reads every
tenant's registered workflows with no tenant scope (authority-parity IDOR).

---

## Contract scouting (pinned)

- **Declared orchestration + its igniter (Ignition test — PASS).** The meta-workflow
  `openwop-app.workflow-author` (`metaWorkflow.ts:25`, `draft→validate→persist`) is a
  feature **built-in** (`feature.ts:43`), dispatched through the SAME core seam as
  `POST /v1/runs` — `buildRunRecord` + `insertRunWithStartContext` +
  `dispatchRunInBackground` (`routes.ts:68-97`). Two honest igniters: the programmatic
  `POST .../workflow-author/draft` route (eval/API front door) and the **chat agent**
  (below). Not theater.
- **Agent tools vs what they can do (Agency test — PASS).** The Workflow Architect
  (`packs/feature.workflow-author.agents/pack.json`) allowlists
  `schema.lookup` + the four `feature.workflow-author.nodes.{get,draft,validate,persist}`
  nodes-as-tools. These are `role:"action"` (node pack header) — `draft` calls the LLM,
  `persist` writes the registry. A real persona with acting tools, not read-only.
- **Owners instantiated vs shadowed (RIDES grep).**
  - Node catalog → `buildNodeCatalog` (`workflowAuthorService.ts:62`) — the SAME source
    the palette uses. RIDES.
  - Validation → shared `validateWorkflowDefinition` + `findUnknownTypeIds`
    (`workflowAuthorService.ts:117,122`). RIDES (one validation path).
  - Run dispatch → `host/runDispatch.ts` (`routes.ts:24`). RIDES.
  - The ONE chat → `EmbeddedChatPanel` **lazy-imported** to avoid the builder→chat cycle
    (`CreateWithAiPanel.tsx:21-23`), scoped to the agent via `agentId`. RIDES ADR 0073;
    the old bespoke `AiAuthorPanel` was demolished (no FE reference remains — grep clean).
  - Workflow **definition** registry → `registerWorkflow` (`workflowAuthorService.ts:150`).
    RIDES the registry owner **but** (see blocker) NOT the ownership/authz layer over it.
- **Chassis constraint that bounds the port.** The repair loop lives INSIDE the `draft`
  node (`index.mjs:174-191`, ≤5 attempts, errors fed back) because the scheduler forbids
  cycles (`metaWorkflow.ts:6`). Correct.

---

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Author a workflow from NL intent, in chat | Workflow Architect agent in `EmbeddedChatPanel`, opened from builder "Create with AI" (`CreateWithAiPanel.tsx:43`) | **RIDES** | Leave alone — reference implementation |
| Author via programmatic API | `POST .../workflow-author/draft` → meta-workflow run via `runDispatch` (`routes.ts:47`) | **RIDES** | Leave; honest eval/API front door, not a 2nd user entry |
| Read the node catalog (the closed-world menu) | `GET .../catalog` + `getCatalog` surface (`surface.ts:27`) | **PAGE-LEGIT** | Keep (read; tenant-curated via `resolveDisabledPacks`) |
| Validate a draft (closed-world) | `validateDraft` surface → shared validator (`surface.ts:59`) | **RIDES** | Leave |
| Persist / register the authored workflow | `persistDraft` → `persistAuthoredWorkflow` → `registerWorkflow` ONLY (`workflowAuthorService.ts:139-153`) | **PARALLEL** | Reconcile: route persist through the same `registerWorkflow`+`recordOwnership` pairing the canonical route uses (`routes/workflows.ts:338-342`) |
| Read an existing / list registered workflows (`get` tool) | `getWorkflow`/`listWorkflows` → global registry, **no tenant filter, no `ownsWorkflow` guard** (`surface.ts:36-55`) | **PARALLEL** | Reconcile: scope reads through `getOwned`/`listOwned(scope.tenantId)` (the ADR 0163 IDOR gate) |
| Open the authored workflow on the canvas | `BuilderTab` load-by-id → `loadBackendWorkflow` (per-tenant, ownership-gated) | **RIDES** | Leave |
| Ambient Work-Graph handoff (recurring pattern → author it) | `seedPrompt` auto-submitted ONCE into the Architect (`CreateWithAiPanel.tsx:44`, `BuilderShell.tsx:127`) | **RIDES** | Leave (ADR 0137) |

**Counts: RIDES 5, ADAPTER 0, PARALLEL 2, THEATER 0, PAGE-LEGIT 1.**
(The two PARALLEL rows are the two halves of ONE defect — the ownership/authz layer.)

---

## Blockers (from scouting) — each with the honest alternative

### BLOCKER-1 (authority-parity, real IDOR) — the persist/read surface rides the definition registry but skips the ownership/authz layer over it

ADR 0163 (`host/workflowOwnership.ts:2-16`) is explicit: the per-tenant ownership index
(`workflow:ownership`, keyed `${tenantId}:${workflowId}`) is **"the security gate …
the ownership/authz layer OVER the global registry"**, with `ownsWorkflow`/`getOwned` as
the IDOR guard. The canonical route uses BOTH layers together:

- **Write:** `POST /v1/host/openwop-app/workflows` → `registerWorkflow(def)` **then**
  `recordOwnership(tenantOf(req), …)` (`routes/workflows.ts:338,342`), gated by a
  `getOwned` self-overwrite check (`:324`).
- **Read-by-id:** `GET /v1/workflows/:workflowId` gates on `getOwned` (`:367`).
- **List:** `GET .../workflows` uses `listOwned(tenantOf(req))` (`:213`). The ADR 0369
  agent compose-and-run tool ALSO lists via `listOwned(scope.tenantId)`
  (`host/workflowComposeTool.ts:115`) — that is the sanctioned agent-tool pattern.

The workflow-author surface uses ONLY the registry layer:
- `persistAuthoredWorkflow` calls `registerWorkflow(def)` alone (`workflowAuthorService.ts:150`)
  — **no `recordOwnership`, no overwrite guard.** Every AI-authored workflow is an
  **UNOWNED** host-global row (exactly the case `routes/workflows.ts:174` warns about).
- `getWorkflow` → `getRegisteredWorkflow(id)` (`surface.ts:38`) and `listWorkflows` →
  `listRegisteredWorkflows()` (`surface.ts:45`) read the global registry with **no tenant
  filter and no `ownsWorkflow` guard**. Exposed as the Architect's
  `feature.workflow-author.nodes.get` tool, so any tenant's agent can enumerate every
  tenant's registered workflow ids + names + descriptions, and fetch any full
  `WorkflowDefinition` by id.

This falsifies the `feature.ts:20-22` / `surface.ts:5-8` claim that persistence goes
"through the SAME … registry the POST route uses" and that "tenant isolation … is enforced
by the shared registration path" — it shares the validator + registry but NOT the authz
layer the route pairs with them.

**Honest alternative (small, no new store):** the surface is built with `scope`
(`buildWorkflowAuthorSurface(scope)`), so `scope.tenantId` is already in hand.
(a) `persistDraft` → after `registerWorkflow`, call `recordOwnership(scope.tenantId, …)`
and apply the `getOwned` overwrite guard (reuse `routes/workflows.ts`'s helper, don't
re-implement). (b) `getWorkflow`/`listWorkflows` → filter through
`getOwned`/`listOwned(scope.tenantId)`. This is a compliance-seam fix, land it FIRST.

### BLOCKER-2 (SSoT / lifecycle, lower severity) — persist has no CAS collision guard

`registerWorkflow` is an unconditional `registry.set` + kv write (`workflowsRegistry.ts:31`).
`persistAuthoredWorkflow` does no existence/CAS check, so a model-chosen `workflowId`
(the sanitized id is used verbatim when the model supplies one — `index.mjs` `sanitizeId`)
can silently OVERWRITE an existing registered definition. The canonical route at least
gates overwrite on `getOwned` (`routes/workflows.ts:324`). *Mitigant:* when the model
omits an id, `draft` mints a **deterministic** `authored.<slug>-<runIdSuffix>`
(`index.mjs parseDefinition`), so a run replay REPLACES rather than duplicates
(lifecycle test #9 — PASS for the generated-id path). Fixing BLOCKER-1's overwrite guard
closes this too.

---

## Non-blockers verified (honesty / HITL / card mechanism)

- **HITL (test #5) — acceptable, no gate needed.** `persist` writes durable state through
  closed-world validation (`validate→persist`, `triggerRule:all_success`,
  `metaWorkflow.ts:34`); the human reviews on the canvas afterward. A registered
  *definition* is an inert template — **running** it (spend/tools) still requires the
  human to open it and dispatch. So "closed-world validation, human review post-hoc" is
  the sanctioned AND/OR path. NOTE for the future: if authored workflows ever
  **auto-run**, a shared interrupt/approval gate becomes mandatory.
- **Card mechanism (test #10.5) — N/A.** The feature renders NO bespoke chat card; it
  reuses `EmbeddedChatPanel`'s feed/composer/interrupt cards. Correct.
- **Honesty loop (test #8) — PASS.** `draft` returns `{definition, validation, attempts}`
  with the real validation errors verbatim (`index.mjs`), and excluded nodes are logged
  with reasons (`workflowAuthorService.ts:80`) rather than silently guessed.
- **Exchange non-negotiables — PASS.** Live catalog in the call-time prompt from the SSoT
  (`buildSystemPrompt` ← `getCatalog` ← `buildNodeCatalog`), `RESPONSE_SCHEMA` +
  shared validator, ≤5 error-fed repair, `get` read-before-edit (added Wave 4). Tracked
  A+ in `docs/steward/LLM-EXCHANGE-AUDIT.md:17,114`.

---

## Demolition list (with regression pins)

Nothing to demolish — the bespoke `AiAuthorPanel` + `workflowAuthorClient` were already
removed (ADR 0073 Phase 3; no FE reference survives). **Pin to keep it gone:** a test
asserting `frontend/react/src/builder` contains no `useChatSession`/second chat panel and
that "Create with AI" resolves to `EmbeddedChatPanel` scoped to
`feature.workflow-author.agents.workflow-architect`.

---

## New-code inventory (small — the port is a reconciliation, not a build)

1. `persistDraft` (surface.ts): after `registerWorkflow`, call `recordOwnership(scope.tenantId,…)`
   + the `getOwned` overwrite guard — reuse the `routes/workflows.ts` helper.
2. `getWorkflow`/`listWorkflows` (surface.ts): scope through `getOwned`/`listOwned(scope.tenantId)`.
3. Two regression tests: (a) a second tenant's Architect `get` tool CANNOT read/list
   tenant-A's authored workflow; (b) an AI-authored workflow appears in the author-tenant's
   `listOwned` (WorkflowsDashboard) index.
4. The demolition pin above.

No new stores, nodes, workflows, or envelopes. No RFC (host-extension only; ADR 0072 gate holds).

---

## Phased plan (gated on real gates)

- **Phase 1 (compliance seam FIRST) — close BLOCKER-1.** Wire `recordOwnership` into
  `persistDraft` and `getOwned`/`listOwned` into the read ops; add the two authz regression
  tests. Gate: `npm run ci` green + a cross-tenant IDOR test that fails on `origin/main`.
  Close with `/code-review` + `/ux-review`.
- **Phase 2 — close BLOCKER-2.** Overwrite-guard/CAS on persist (falls out of Phase 1's
  `getOwned` guard); pin the deterministic-id replay-idempotency test. Gate: `npm run ci`.
- **Phase 3 — correction notes.** Update `feature.ts`/`surface.ts` header claims to state
  the ownership layer is now wired (correct-don't-rewrite per CLAUDE.md); refresh the
  LLM-EXCHANGE-AUDIT row.

---

## Deferred honestly

- **Host-global workflow *definition* registry is a platform property**, not a
  workflow-author defect — `workflowsRegistry` is keyed by `workflowId` alone by design
  (replay/`:fork` re-resolve by id; `workflowsRegistry.ts:75`). The port does NOT change
  that; it re-applies the ownership/authz layer ADR 0163 already built ON TOP of it. If a
  future decision wants tenant-scoped *definition* keys, that is a separate cross-cutting
  ADR, filed — not a local workaround here.
- **`DEFAULT_MODEL='claude-sonnet-4-6'`** in the pack (`index.mjs`) is a pack-local mirror
  of the providers.json SSoT, maintained by `/refresh-model-catalog` — out of scope for
  this port; noted only so a reviewer doesn't "fix" it locally.
