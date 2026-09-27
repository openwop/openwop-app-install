# Run input forms (B4) — chat-first port review

**Scope:** unit B4 "Run input forms" — backend package
`backend/typescript/src/features/run-input-forms` + its matching frontend
surfaces. Reviewed against the app's real primitives: the ONE chat, agent
packs + `registerFeatureAgentTool`, `startWorkflowRun` + the existing node
catalog, the HITL machinery, the shared `lib/formEngine.ts` forms primitive
(ADR 0331), and the single runs-launch owner. Read-only review.

## Headline

**Already rides the engine — no port.** This is not an intelligence surface at
all: no agent, no declared workflow, no node pack, no envelope, no model call
anywhere. It is a *route-less rendering + validation seam* over the CORE runs
launch path. The feature package declares nothing to ignite
(`registerRoutes: () => {}`, no `toggleDefault`;
`backend/typescript/src/features/run-input-forms/feature.ts:31-35`). Every
capability it exposes reuses an owned primitive: the run-launch owner
(`RunsIndexPage`), the run-creation route (`POST /v1/runs`), the workflow
definition's `inputSchema` as the single source of truth, the shared form
engine, and Ajv on the real route boundary. There is no THEATER (nothing
declared-but-un-ignited) and no PARALLEL owner. The one thing to watch is a
documented dual-validator split (FE subset validator vs BE Ajv) with no parity
test — a drift risk, not a demolition.

## Contract scouting (evidence)

- **What creates runs.** The launch form's submit calls `createRun(...)` →
  `POST /v1/runs` → the real engine
  (`frontend/react/src/runs/RunsIndexPage.tsx:204`,
  `onSubmit` at `:184-217`). The chat has its OWN, separate run-ignition path
  (`host/workflowComposeTool.ts:35,133` → `startWorkflowRun`), so conversational
  launch is already covered elsewhere and this surface is the
  direct-manipulation counterpart, not a fake "talk to AI" box.
- **Declared vs ignited.** The feature declares no workflow/node/agent to
  ignite — `feature.ts` is a pure marker with an empty `registerRoutes`
  (`feature.ts:33`). Nothing to fail the ignition test.
- **Owners instantiated vs shadowed.** The launch UI is the ONE
  `RunsIndexPage` create-run form (ADR 0197 boundaries audit,
  `docs/adr/0197-schema-driven-run-input-forms.md:48-49`); the form derivation
  rides the shared `lib/formEngine.ts` primitive (ADR 0331), not a private
  engine — `runs/inputSchemaForm.ts` is a verbatim re-export shim
  (`frontend/react/src/runs/inputSchemaForm.ts:1-5`;
  `deriveFields`/`validateInputs`/`isRenderableSchema`/`compactInputs`/
  `seedDefaults` all live in `frontend/react/src/lib/formEngine.ts:47,71,89,99,138`).
  The builder authoring preview reuses `SchemaInputForm` verbatim
  (`builder/inspector/WorkflowInspector.tsx:7,17,78`). No shadow owner.
- **SSoT / drift.** Both readers read the SAME definition `inputSchema`: the FE
  fetches `GET /v1/workflows/:id` and reads `def.inputSchema` verbatim
  (`RunsIndexPage.tsx:92-95`); the route validates against
  `wf.definition.inputSchema` from the catalog (`routes/runs.ts:198-199`). No
  prompt-copy, no second store. The two editing modes (form / raw JSON) write
  through to the SAME `inputsRaw` string, so state never forks
  (`SchemaInputForm.tsx:30-49`, doc-comment `:5-11`).
- **Executor/chassis constraints.** None relevant — the launch payload is byte
  identical whether typed as JSON or entered via the form, so replay/fork is
  untouched (ADR 0197 decision, `0197-...md:72-74`).
- **Fail-open by construction.** No `inputSchema`, or a schema Ajv can't
  compile, ⇒ the run proceeds exactly as before
  (`host/runInputValidation.ts:35-46`); the raw-JSON textarea is the escape
  hatch on any read failure (`RunsIndexPage.tsx:93,385-395`).

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Render a typed launch form from a workflow's `inputSchema` | `SchemaInputForm` over `ui/Field`, derived via shared `formEngine` (`RunsIndexPage.tsx:385-386`, `SchemaInputForm.tsx:30-75`) | **ADAPTER** | Leave. Thin, honest renderer over the definition SSoT + the shared form engine; writes through to the one `inputsRaw` string |
| Form/JSON mode switch + "Edit as JSON" escape hatch | `.segmented` aria-pressed toggle, same `inputsRaw` (`SchemaInputForm.tsx:56-72`) | **ADAPTER** | Leave. No forked state; power-user escape hatch preserved |
| Server-side Ajv 400 on schema-bearing workflows | `validateRunInputs` on `POST /v1/runs`, fail-open (`routes/runs.ts:198-207`, `runInputValidation.ts:31-51`) | **RIDES** | Leave. Same route + same 400 boundary the shape-check already owns; not a second route |
| Builder-side `inputSchema` authoring + live form preview | Raw-JSON textarea + reused `SchemaInputForm` preview in `WorkflowInspector` (`WorkflowInspector.tsx:63-78`) — OQ-2 now shipped | **ADAPTER** | Leave. Edits the definition SSoT directly; preview reuses the renderer verbatim |
| Schema-less workflow launch | Falls back to the raw `Inputs (JSON)` textarea (`RunsIndexPage.tsx:387-395`) | **PAGE-LEGIT** | Keep — honest degrade, not a gap to paint over |

**Counts:** R=1 A=3 P=0 T=0 PL=1.

## Port-test notes (per the ten tests)

- **Interface test:** launching a workflow with a KNOWN typed schema is
  *structural editing* of a params object, not *describing intent* — the
  page/form is the sanctioned direct-manipulation lane. Conversational launch
  ("run onboarding for Acme") is a distinct capability the ONE chat already
  owns via `workflowComposeTool` → `startWorkflowRun`
  (`host/workflowComposeTool.ts:35,133`). This surface does not fake it.
- **Agency / ignition / composition tests:** N/A — no agent, no declared
  workflow, no node pack. Nothing to ignite, nothing toothless.
- **HITL test:** N/A — no human-decision checkpoint is introduced; the 400 is a
  validation boundary, not an approval.
- **SSoT test:** PASS — one validated source (the definition `inputSchema`),
  form + JSON are working copies of one string, server Ajv is authoritative,
  defects surface as a `validation_error` 400 with `details.errors`
  (`routes/runs.ts:200-206`).
- **Authority-parity test:** the route enforces `runs:create`
  (`routes/runs.ts:182`); the form is a pre-submit affordance that cannot
  bypass it (all writes go through `POST /v1/runs`). No adjacent surface
  escapes the predicate.
- **Honesty-loop test:** PASS — every displayed field/error has a real read
  (client subset validator) and the authoritative check is the server 400;
  fail-open is documented, not painted (`runInputValidation.ts:28-46`).
- **Card-mechanism test:** N/A — nothing renders in the chat feed.
- **Lifecycle test:** PASS trivially — the feature introduces NO new durable
  row (ADR 0197 data model, `0197-...md:77-84`); recorded run inputs are
  identical to the JSON path.

## Blockers (from scouting) — with honest alternatives

None. Every assumption the review would rest a port on (an orphaned workflow, a
toothless agent, a shadow launch surface, a prompt-copied schema, a parallel
form engine) was falsified by the evidence above. This unit is correctly shaped
as page + route seam.

## Demolition list (with regression pins)

Nothing to demolish. The launch form is **PAGE-LEGIT** (the direct-manipulation
counterpart to the chat's workflow-running), not bespoke "talk to AI" UI hiding
a model call. If a future change tried to fork launch state or add a second
launch route, the pin is the existing invariant test
`frontend/react/src/runs/__tests__/inputSchemaForm.test.ts` (form↔JSON write
through one string) plus the 6 route-level validation tests noted in ADR 0197
Phase 3 (`0197-...md:13`).

## New-code inventory

**Empty — the feature is complete and correctly shaped.** The only work this
review surfaces is a **watch-for-drift note**, not new capability (see below).

## Watch-for-drift (the one real finding, not a verdict change)

The FE ships a hand-written **subset** validator (`formEngine.validateInputs`,
`frontend/react/src/lib/formEngine.ts:99`) while the BE is authoritative Ajv
(`host/runInputValidation.ts`). This client/server split is deliberate and
documented (ADR 0197 correction, `0197-...md:18`: "client-side subset
validator... authoritative validation is the backend's real Ajv"), so it is
**not** PARALLEL architecture of an owned concept — it is the standard
best-effort-UX / authoritative-server division. The risk is **schema-keyword
drift**: a keyword the FE subset ignores but Ajv rejects (or vice versa)
produces a form that says "valid" then eats a 400. There is no parity test
tying the FE subset's accepted-keyword surface to the BE Ajv posture (the only
test is FE-only: `runs/__tests__/inputSchemaForm.test.ts`; grep found no shared
fixture). Cheapest mitigation if this ever bites: a shared golden-schema
fixture asserting both validators agree on accept/reject for the v1 keyword
subset. Deferred honestly — low severity while the subset stays small.

## Deferred honestly

- **Conversational launch of a schema-bearing workflow** is intentionally NOT
  this feature's job — it belongs to the chat's existing workflow-running
  capability (`host/workflowComposeTool.ts`). If parity gaps appear there
  (e.g. an agent that pre-fills a workflow's inputs from natural language),
  that is chat-side work driven by an agent tool, not a change to B4.
- **FE/BE validator parity test** — deferred as above; a drift watch, not a
  blocker.
