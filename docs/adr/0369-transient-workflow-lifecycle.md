# ADR 0369 — Transient ("dynamic") workflows: spin up on the fly, archive on completion

Status: implemented (Phases 1–6, 2026-07-15/16). Phase 6 GC was DEFERRED pending a
run-retention policy; that trigger landed as ADR 0371, so the GC shipped as ADR 0371
Phase 4 (#1863, `__runTransientDefGcOnce`) and is deployed ON — see the phase table.
(Correction: the header previously read "Phase 6 GC deferred"; the deferral's named
trigger has since been met, so all six phases are now implemented.)

| Phase | PR | Landed |
|---|---|---|
| 1 lifecycle metadata + the ONE catalog filter | #1837 | registry filter, marketplace integrity opt-in, ownership denormalization |
| 2 archive/unarchive/promote + DELETE 409 | #1839 | hasRunForWorkflow probe (pg mig 32 / sqlite mig 34), OQ5 promote gate |
| 3 dashboard lifecycle UI | #1840 | Archived filter/chip/verbs + honest-delete fix |
| 4 builder promotion flow | #1841 | drafts transient from birth, Save=promote, owner-visible-draft correction |
| 5 compose-and-run agent tool | (this PR) | core-level tool, shared capability gate, transient cap |
| 6 GC sweeper | ADR 0371 P4 (#1863) | archived transient defs with zero remaining runs hard-delete on the retention tick (`__runTransientDefGcOnce`); referenced defs stay protected |
Date: 2026-07-15
Lane: cross-cutting seam (workflow catalog lifecycle) — NO new feature package, NO new toggle
RFC verdict: **host work only.** Workflow CRUD + listing are host-extension surfaces
(`/v1/host/openwop-app/workflows/*`, `routes/workflows.ts:9`), not the OpenWOP wire.
The one wire-adjacent rule this ADR imposes (archived ≠ unresolvable) exists precisely
to keep the normative runs/replay/fork contract intact. Inline definitions on
run-create (the alternative rejected below) WOULD be a new `../openwop` RFC.

## Why this exists

The question (in-conversation PRD, 2026-07-15): *"Do we have dynamic workflows —
spun up on the fly and disposed of when completed?"* Use cases: an agent
composing a bespoke DAG per task, record-mode generating a one-off guided tour
(ADR 0368 Phase 6), a planner emitting a custom chain for a single job. Today
this half-works — definitions CAN be created programmatically at runtime (the
builder UI and AI workflow author already `POST /workflows` just before
dispatch, `workflowsRegistry.ts:4`) — but nothing owns the lifecycle: generated
definitions accumulate in every catalog list forever, and the only exit is
DELETE, which is architecturally wrong (below).

## The load-bearing constraint: disposal breaks replay

A run does NOT snapshot its definition. Run creation resolves the definition
from the catalog (`routes/runs.ts:193`), and **replay/`:fork` re-resolve by
`workflowId`** — the durable-recovery design explicitly depends on this (the
dispatch sweeper previously "abandoned orphans whose workflow id no longer
resolves", fixed by making the registry a write-through cache over kv,
`workflowsRegistry.ts:7-15`). Deleting a definition after its run completes
orphans that run's history: no replay, no fork, a dangling `workflowId` in the
run record. Therefore:

> **The run is the disposable thing; the definition is durable.**
> "Dispose when completed" becomes **archive when completed** — hidden from
> every list, resolvable forever.

## Decision

Add a **lifecycle facet** to the workflow catalog, owned entirely by
`workflowsRegistry` (single owner — the four list consumers inherit it):

### 1. Lifecycle metadata (rides `definition.metadata`, no new row shape)

```
definition.metadata.lifecycle = {
  transient: true,            // generated-per-task; catalog-hidden by default
  generatedBy?: string,       // producer id: 'guided-tours.recorder', 'agent:<id>', …
  archivedAt?: string,        // ISO — set on archive; absent ⇒ live
}
```

Riding `metadata` keeps the stored row = the definition JSON (the `wfreg:` kv
shape is untouched), travels with export/import, and stays inside the
`workflow-definition.schema.json` metadata extension point — no schema change.

### 2. Visibility is filtered at the ONE list layer

`listRegisteredWorkflows()` (`workflowsRegistry.ts:72`) gains
`{ includeArchived?: boolean, includeTransient?: boolean }` (both default
false) and every consumer — the workflows routes/catalog, marketplace routes,
`workflow-author/surface.ts`, `exampleDataSummary`, **and `mcpServerRegistry`**
(agent-visible tool listings must not fill with one-shot DAGs) — inherits the
filter by default. Admin/debug surfaces opt in explicitly. `getWorkflow` /
`getRegisteredWorkflowAsync` are UNTOUCHED: archived definitions always
resolve (the replay contract).

### 3. Lifecycle verbs (host-ext routes, same IDOR guard as DELETE)

- `POST /v1/host/openwop-app/workflows/:id/archive` (and `/unarchive`) —
  owning tenant only (the ADR 0163 R2 guard at `routes/workflows.ts:150`).
- `DELETE` gains a referential-integrity check: **refuse (409) when any run
  references the definition**; the error suggests archive. Today's DELETE is
  an orphan-maker (`deleteRegisteredWorkflow`, `routes/workflows.ts:156`).
- Run completion does NOT auto-archive in v1 (a transient def may be re-run
  for retry); instead `transient: true` definitions are catalog-hidden from
  birth, so there is nothing to clean up in the common case. Producers MAY
  archive explicitly when they know the task is closed.

### 4. GC — deferred WITH ITS TRIGGER (now met — see correction note)

Hard-deleting archived transients requires "no referencing run inside
retention", and **the app has no run-retention/purge policy today** (a known
DATA-ASSESSMENT gap). GC is therefore deferred WITH ITS TRIGGER: when a run
retention policy lands, a sweeper may hard-delete archived transient
definitions whose runs have all aged out. Until then archived rows are small
(one kv row each) and invisible — acceptable debt, recorded.

> **Correction (2026-07-16): trigger met — GC shipped.** The named trigger (a
> run-retention policy) landed as **ADR 0371**. The GC sweeper is now
> `__runTransientDefGcOnce` (`host/runRetentionSweeper.ts`), run on the retention
> tick AFTER the run sweep (`host/retentionSweepDaemon.ts`): it hard-deletes an
> archived transient def only once `storage.hasRunForWorkflow` is false (its last
> run has aged out), and removes the ownership rows with it. Shipped as ADR 0371
> Phase 4 (#1863), tested in `test/run-retention-sweep.test.ts`, deployed ON.

**Competitive research (2026-07-15, architect-reviewed) — the deferral is
right but retention itself is overdue.** Every comparable platform ships a
run/execution retention policy; the absence here is the outlier:

| Platform | Run/execution retention | Definition lifecycle |
|---|---|---|
| Temporal | Closed-workflow histories purged after namespace retention — default **72 h** self-hosted / 30 d Cloud (min 1 d); blob **Archival** (off by default) as the compliance escape | definitions are versioned code — durable; the RUN is the ephemeral unit |
| n8n | Prunes at **14 d** (`EXECUTIONS_DATA_MAX_AGE=336h`) OR **>10 k** executions; 1 h hard-delete buffer; running executions and **annotated executions are NEVER pruned** | workflow entity persists independently |
| AWS Step Functions | **90-day HARD** execution-history limit (export via `GetExecutionHistory` to keep more) | a state-machine **version cannot be deleted while an alias references it**; state-machine delete is async and waits for executions |
| Airflow | history lives in the metadata DB; deleting DAGs/tasks loses run history in the UI (documented pain) | ecosystem guidance: **DAG-factory / params** — "separate structure from configuration" |

Implications adopted: (a) the follow-up is NAMED — a **run-retention ADR**
is the next data program, proposed posture = age+count pruning (n8n shape)
with a **pinned/annotated exemption** and an **export/archival hook before
hard delete** (Temporal shape); this ADR's GC sweeper is a consumer of that
policy, never its author. (b) The DELETE-409-while-referenced rule has direct
precedent (Step Functions' version/alias refusal). (c) Airflow's params
guidance independently confirms §7's turn-workflow front door.

### 5. Promotion: Workflow Builder drafts are transient until saved
*(refinement 2026-07-15, same-day PRD extension)*

The pipeline the PRD names — **Workflow Builder → Dynamic Workflows → Saved
Workflows** — becomes the builder's default flow, and fixes an existing wart:
today the builder/AI-author registers a PERMANENT catalog entry just to
test-run a draft (`workflowsRegistry.ts:4` — "the builder UI calls this just
before dispatching a run"), so every abandoned experiment lives in the
catalog forever. With this ADR:

- The Workflow Architect's drafts (and any builder test-run registration) are
  stamped `lifecycle.transient = true`, `generatedBy: 'workflow-author'` at
  creation — runnable immediately for review (real runs, real gates), visible
  only in the builder session, absent from every catalog list.

  > **IMPLEMENTED 2026-08-21 (ADR 0595 §6), with two corrections this line did
  > not anticipate.** Until then this decision was **entirely unimplemented** for
  > `persistAuthoredWorkflow` — the literal `'workflow-author'` appeared only in
  > a doc comment — so authored definitions were born permanent, structurally
  > GC-immune (`runRetentionSweeper.ts:192`) and cap-exempt.
  >
  > **(a) "at creation" is load-bearing and was nearly missed.** Stamping on
  > *every* write DEMOTES an already-promoted workflow the moment its owner asks
  > the AI to tweak it — silently pulling a saved workflow out of the `/` picker
  > as a side effect of an edit, with re-promotion gated behind a fresh green run
  > and green evals. The stamp fires only when the tenant does not already own
  > the id; a revise inherits the head's lifecycle verbatim.
  >
  > **(b) "absent from every catalog list" is too strong for the OWNER's own
  > list.** Applied literally it hid a tenant's fresh draft from
  > `listAuthoredWorkflows`, so the Architect could not `get`-list the workflow
  > it had just authored — breaking read-before-write on the very next turn. The
  > scoped REST list had already made the opposite call in so many words
  > (`routes/workflows.ts`: *"Transient DRAFTS stay VISIBLE here — this is the
  > owner's own scoped list"*); the authored index now matches it. The intended
  > rule is **absent from every SHARED catalog list**, present in the owner's own.
- **Save = promote**: `POST /v1/host/openwop-app/workflows/:id/promote`
  (owning tenant; same IDOR guard) clears `transient` — the definition
  becomes an ordinary saved workflow, id stable, its review-runs' history
  intact (nothing re-registers, so replay/fork continuity is free).
- Discarding a draft = archive (or the hardened DELETE once its review runs
  are gone). Abandoned drafts are invisible either way.

### 6. Agent capability: any agent can compose→run a dynamic workflow
*(refinement 2026-07-15)*

> **Correction (2026-07-23) — this section under-delivered the original intent;
> superseded as the DEFAULT lane by ADR 0473.** The in-conversation PRD this ADR
> §Why quotes was the lifecycle half of a larger ask: the maintainer's full
> request was that an LLM composes a workflow and the user **reviews it in the
> AI chat or the builder BEFORE it executes**. `compose-and-run` runs
> immediately (no pre-run review), renders as raw JSON in chat, and shipped with
> zero grants — the review-before-execution capability did not exist. ADR 0473
> adds the missing lane: `openwop:workflows.propose` (register transient draft +
> `composed-workflow` PendingApproval; structurally cannot start a run) with a
> chat review card + builder banner, approve-to-run via the shared approval
> decision core. `compose-and-run` is repositioned as the AUTONOMOUS lane for
> explicitly-granted headless agents, still zero-granted by default. This
> section's run-level safety argument (ordinary runs, ordinary gates) is
> unchanged and inherited by the approved run.

A core agent tool — `workflows.compose-and-run` (working name), registered at
the CORE level via the `registerFeatureAgentTool` seam
(`host/agentToolProvider.ts:441`) and granted per-agent through ADR 0104
overrides (never hard-coded to a named agent, per the agent-capability law):

1. the agent supplies a candidate definition (JSON, validated against
   `workflow-definition.schema.json` BEFORE registration — invalid ⇒ tool
   error, nothing stored);
2. the tool registers it `transient: true, generatedBy: 'agent:<id>'`;
3. creates the run through the NORMAL runs surface — every existing gate
   applies unreduced: capability-gated node-type refusal
   (`routes/runs.ts:223`), approval gates, the ADR 0028 governance boundary,
   ADR 0357 budgets/circuit breaker, replay stamping;
4. returns the run handle; the agent (or the user, via the run surface)
   observes results. The definition stays transient — promotion to a saved
   workflow is a USER act (the §5 verb), never the agent's.

The tool is a THIN composition: no new run path, no new validation layer, no
agent-special catalog. What makes agent-composed DAGs safe is precisely that
they are ordinary runs of (transient) ordinary definitions — the run-level
gates are the security boundary, and they already exist.

### 7. The turn-workflow pattern stays the front door

This ADR does not change the recommendation for recurring on-the-fly work:
a **static, parameterized turn-workflow** (one registered definition, all
dynamism in the run's `configurable`/inputs — `scheduledChatTurnWorkflow.ts`,
the ADR 0089 @mention workflow, ADR 0313 D2) remains the right shape whenever
the DAG's *structure* doesn't vary per task. Transient definitions are for
genuinely per-task structure (a generated tour's step list, an agent-composed
DAG). Producers should reach for a turn-workflow first.

## Boundaries audit

- **Single owner confirmed:** `workflowsRegistry` is the only definition
  store (in-memory write-through cache over `wfreg:` kv; `workflowsRegistry.ts:26-28`);
  the catalog consults it after the hardcoded samples. No second store is
  added; visibility lives at its list function, not per-consumer.
- **List consumers enumerated** (grep `listRegisteredWorkflows`):
  `mcpServerRegistry.ts`, `features/marketplace/routes.ts`,
  `features/workflow-author/surface.ts`, `routes/exampleDataSummary.ts` —
  all inherit the default filter; none re-implements listing.
- **No route collision:** `/workflows/:id/archive` is unclaimed.
- **No wire impact:** CRUD + listing are host-ext (`routes/workflows.ts:9`);
  runs/replay/fork behavior is *protected*, not changed.
- **Capability honesty:** nothing new advertised.

## Feature evaluation matrix (answered honestly for a core seam)

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | **None** — this is a core catalog seam (`host/workflowsRegistry.ts`, `routes/workflows.ts`). Producers (guided-tours recorder, agents) are the features. |
| 2 | Toggle | **None.** The seam is inert until a producer stamps `lifecycle.transient`; archive verbs are owner-gated. (Precedent: ADR 0366, infra above the toggle system.) |
| 3 | `ctx.<feature>` | None in Phase 1–3. §6's compose-and-run is an AGENT tool (chat/tool-loop surface), not a workflow-callable `ctx` op — a workflow spawning workflows is out of scope (recursion/budget semantics would need their own decision). |
| 4 | Node pack | None in this ADR. |
| 5 | Chat envelopes | None. |
| 6 | Agent pack | No pack. §6's `workflows.compose-and-run` is a CORE-level tool via `registerFeatureAgentTool` (`agentToolProvider.ts:441`), granted per-agent (ADR 0104) — capabilities live at core, never on a named agent. |
| 7 | Public surface | None. |
| 8 | RBAC | Archive/unarchive = owning tenant only (same guard as DELETE, `routes/workflows.ts:150`); DELETE hardened with the runs-reference 409. |
| 9 | Replay / fork | The POINT of the ADR: archived stays resolvable; DELETE refuses while referenced. Strictly improves replay safety. |
| 10 | Frontend | Workflows tab: archived hidden by default + an "Archived" filter chip; archive/unarchive actions on owned workflows; transient badge. Tokens/i18n ×4 per DESIGN.md. |

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| 1 | `lifecycle` metadata type + list-layer filter + consumers inherit (test: a transient def is invisible to all four consumers, still resolvable by id) | backend vitest |
| 2 | Archive/unarchive routes + DELETE runs-reference 409 (test: delete-while-referenced refused; archived def replays) | backend vitest |
| 3 | FE workflows tab: filter chip, badge, archive actions, i18n ×4 | FE build + /ux-review |
| 4 | Builder promotion flow: AI/builder drafts register transient; Save = promote verb; discard = archive; FE Save/Discard wiring (test: an unsaved draft is invisible to every catalog consumer; promote preserves id + run history) | backend vitest + FE build + /ux-review |
| 5 | `workflows.compose-and-run` agent tool (schema-validate → register transient → run via the normal surface; ADR 0104 grant; test: capability-gated node types + approval gates fire identically for agent-composed runs) | backend vitest + /architect |
| 6 (✅ shipped — trigger met) | GC sweeper — the run-retention ADR (ADR 0371) landed, so this shipped as **ADR 0371 Phase 4** (#1863): `__runTransientDefGcOnce` hard-deletes archived transient defs whose last run has aged out (`hasRunForWorkflow` false), ownership rows removed with them; runs on the retention tick after the run sweep; deployed ON | backend vitest (`run-retention-sweep.test.ts`) ✓ |

## Alternatives weighed

1. **Hard delete on completion** (the PRD's literal "disposed of") — breaks
   replay/fork (no definition snapshot; re-resolution by id). Rejected;
   corrected to archive.
2. **Snapshot the definition into every run record** — makes delete safe but
   duplicates every definition per run, changes the run record shape (wire-
   adjacent), and still leaves catalog pollution. Heavier for less. Rejected.
3. **Inline definitions on run-create** (never stored) — cleanest "dynamic"
   semantics but changes the runs endpoint contract + replay semantics =
   a new `../openwop` RFC, and every host must then solve replay-of-inline.
   Rejected for now; re-open on the wire if cross-host demand appears.
4. **Per-consumer filtering** (each list site checks the flag) — drift
   guarantee. Rejected; the filter lives in `listRegisteredWorkflows`.

## PRD-vs-architecture corrections

- *"disposed of when completed"* → **archived on completion** (hidden, never
  unresolvable) — forced by replay/fork re-resolution (`routes/runs.ts:193`).
- *"spun up on the fly"* is already true mechanically (`POST /workflows` at
  dispatch time); what this ADR adds is the missing lifecycle so that
  capability stops leaking permanent catalog entries.
- Recurring dynamic work should prefer the existing **turn-workflow** pattern
  (static definition, dynamic run parameters) — new structure per task is the
  only case that needs a transient definition.

## Open questions

1. Should `transient: true` also suppress the definition from marketplace
   export/white-label manifests (ADR 0366)? Proposed: yes (they're per-task
   artifacts), confirm at Phase 1.
2. Retry ergonomics: should archive-on-completion be an opt-in flag on the
   run (`archiveDefinitionOnSuccess`) for producers that know the task is
   one-shot? Proposed: defer; explicit producer archive covers v1.
3. The runs-reference check for DELETE needs an efficient "any run references
   workflowId" lookup — confirm the run store has/needs an index (Phase 2).
4. §6 rate/abuse bounds: per-tenant cap on live transient definitions from
   `generatedBy: agent:*` (a runaway agent must not flood the kv store) —
   propose a simple count cap + tool error, size at Phase 5.
5. ~~Whether §5 promotion should require the draft to have ≥1 successful
   review run (a "tested" gate) or stay a pure user choice~~ — **DECIDED
   (David, 2026-07-15): promotion REQUIRES ≥1 successful review run.** The
   `promote` verb verifies a completed-successful run referencing the
   definition exists (the same runs-reference lookup Phase 2's DELETE guard
   needs — one index serves both) and refuses otherwise (409, "run it once
   first"); the builder UI disables Save until a green review run exists and
   badges the state. Tours (ADR 0368 record-mode) inherit the same gate.
