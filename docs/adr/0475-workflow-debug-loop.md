# ADR 0475 — The workflow debug loop: input pinning, execute-from-step, failed-run→editor, bulk redrive

Status: implemented (P2a + P2b + review fold-in, 2026-07-23 — one PR, three commits)
Date: 2026-07-23
Lane: cross-cutting seam (builder/runs debugging) — NO new feature package, NO new
toggle (owner-gated draft tooling; inert until used)
RFC verdict: **host work only, no new RFC.** Pins are a host-ext
`DurableCollection`; the debug-run and redrive routes are non-normative
`/v1/host/openwop-app/*`; the synthetic resume snapshot rides `executeRun`'s
EXISTING `resumeSnapshot` option (the branch-fork mechanism — host-internal);
nothing on the OpenWOP wire changes.

## Why this exists

Phase 2 of `docs/WORKFLOW-ORCHESTRATION-COMPETITIVE-ASSESSMENT.md`: debug-on-
production-data is the highest-leverage UX investment in the 2026 field (n8n's
benchmark trio — data pinning, execute-step, failed-run-into-editor) and our
grade there is C+ despite owning the superior recovery primitive (branch-fork).
The seam exploration (2026-07-23) found the whole loop COMPOSES from what
exists: branch-fork already IS execute-from-step with recorded data — this ADR
generalizes it to *pinned* data.

## Boundaries audit (seam exploration, file:line verified)

- **Synthetic snapshots**: `executeRun(..., {resumeSnapshot})` accepts any
  `SerializedSnapshot` (`executor/executor.ts:1713-1720`); `hydrateSnapshot`
  overlays it on a fresh snapshot (`:1738-1753`); completed-marked nodes never
  re-execute and their `nodeOutputs` feed downstream input assembly
  (`buildNodeInputs`, `executor/scheduler.ts:357-387` — skips non-completed
  predecessors, reads `snapshot.nodeOutputs`). NO definition validation exists
  on snapshots — the debug route OWNS that validation.
- **Output extraction**: `node.completed.payload.outputs` is the ONE output
  carrier; `snapshotFromEventPrefix` (`executor/executor.ts:1008-1036`) is the
  existing fold — reused verbatim for pin prefill.
- **Redrive**: no bridge-level redrive exists (dedup would block it) — fresh
  runs from stored `run.inputs` modeled on the fork-branch path
  (`routes/runs.ts:1071-1133`): clear `idempotencyKey`, never copy
  `causationId`, re-stamp `actingUserId` (confused-deputy guard), COPY the
  ADR 0474 revision pin so the redrive runs the AS-RUN definition.
- **Canvas paint**: `startOverlay(runId, backendIdToBuilder)` +
  `applyRunEvent` (`builder/store/builderStore.ts:589-633`) — the debug run
  paints through the existing overlay; a `pinned` node status is additive.
- **Pin storage precedent**: `host/uiStateStore.ts:47-50` (ADR 0071) — a
  tenant-scoped composite-key `DurableCollection` for draft-side state that is
  deliberately OFF the definition. Pins must never move `revisionHashOf`
  (the ADR 0474 invariant), so they live in their own store, never in
  `definition.metadata`.
- **No collisions**: `grep debug-pin|debug-run|redrive` — greenfield.

## Decision

### 1. The pin store — `host/workflowDebugPins.ts`
`DurableCollection('workflow:debug-pin', key =
${tenantId}:${encodeURIComponent(workflowId)}:${nodeId}, tenant extractor)`.
Row: `{key, tenantId, workflowId, nodeId, output (Record — the node's pinned
OUTPUT), sourceRunId?, createdAt, createdBy?}`. Writes pass the executor's
secret-strip + free-text sanitize (the event-log write discipline,
`executor.ts:917`); per-row size cap (64KB) + per-workflow pin cap (200).
**Pins are draft-side debug state: the ONLY consumer is the debug-run route —
published/production launches never read them** (the n8n honesty rule).
CRUD: `GET/PUT/DELETE /v1/host/openwop-app/workflows/:workflowId/pins[/:nodeId]`
+ `POST …/pins/from-run {runId}` (bulk prefill: fold the owned run's
`node.completed` events) — all owner-gated (the lifecycle-verb 404 posture).
> **Correction (P2a):** the prefill verb landed as `POST …/pins/from-run`, not
> `PUT …/pins:from-run` — an Express 4 colon-suffix path parses `:from` as a
> param (the `:fork` route needs a regex for this reason), and the plain
> segment costs nothing: `POST /pins/from-run` cannot collide with
> `PUT /pins/:nodeId` (different method). The prefill folds ONLY the run's
> `node.completed` events (the full-prefix fold refuses on an open interrupt,
> but completed outputs are real data for prefill regardless).
Cascade: pins delete with the definition (the ADR 0474 registry deletion hook)
and at tenant teardown (tenant extractor).

### 2. Execute-from-step — `POST …/workflows/:workflowId/debug-run`
Body `{fromNodeId, mode: 'from-here'|'only', inputs?}` — owner-gated. The
route:
1. resolves the HEAD (draft semantics — debugging edits);
2. validates `fromNodeId` exists; computes the node partition: TARGET =
   `fromNodeId` (+ descendants when `from-here`); PREDECESSORS = direct
   upstream of the target set; REST = everything else;
3. **pin coverage check**: every PREDECESSOR must have a pin — missing pins ⇒
   422 listing the exact nodeIds (the bulletproof bar: the error names the
   next action); covered predecessors are marked `completed` with their
   pinned outputs; REST nodes marked `skipped`;
4. the run is otherwise ORDINARY: the same capability-gated typeId refusal as
   `POST /v1/runs`, `metadata: {launch:'draft', debug:{fromNodeId, mode,
   pinnedNodes[]}}`, the ADR 0474 revision pin, the ADR 0099 insert seam,
   `executeRun(..., {resumeSnapshot: synthetic})`. Debug runs are visible in
   the run list (honestly tagged), replay/fork-safe (the snapshot is the
   recorded prefix semantics), and GC with their transient drafts.

> **Correction (P2a):** the run is built through the SHARED seam
> (`buildRunRecord` → `insertRunWithStartContext({definition: head})` →
> fail-closed dispatch), not hand-rolled, and before dispatch the route writes
> a **self-describing synthetic event prefix** — `run.started` plus one
> `node.completed {outputs, pinned:true}` per pinned predecessor (the
> fork-copied-prefix semantics). Folding THIS run's own prefix therefore
> reproduces the checkpoint, so a later `:fork` of a debug run is honest.
> Two mechanism corrections vs the sketch above: (1) `executeRun`'s
> `resumeNodeId` option is the INTERRUPT-resume path (it marks the named node
> completed instead of executing it) — the debug run passes `resumeSnapshot`
> ONLY (the fork-checkpoint path, which re-derives readiness from settled
> nodes). (2) REST nodes are not snapshot-marked `'skipped'`; the run executes
> a **pruned subgraph definition** (predecessors + target + their edges), so
> the scheduler's completion rule ("a terminal-by-graph node must complete")
> holds naturally — in `'only'` mode the target is the subgraph's terminal.
> The ADR 0474 pin still stamps from the FULL head (the content being
> debugged); `metadata.debug` records the mode, and a branch-fork of a debug
> run re-resolves the full revision (descendants re-execute live — accepted).
> Additionally, the run-provenance stamps (`launch`, `launchResolved`,
> `debug`, `redriveOf`) are surfaced on the EXISTING host-ext
> `GET /v1/host/openwop-app/runs/:runId/revision` read (the normative
> `RunSnapshot` deliberately omits `run.metadata`) — one provenance surface,
> no second endpoint.

### 3. Failed-run→editor (FE)
Run detail gains **Debug in builder** on failed runs: navigates
`/builder/:workflowId?debugRun=:runId`. The builder, on that param: calls
`pins:from-run` (bulk prefill from the run's real outputs), shows a debug
banner (source run link + pin count + Clear pins), badges pinned nodes on the
canvas, and the node inspector gains a **Pinned output** section (view/edit/
unpin + "Execute from here"), painting results through the existing overlay.

### 4. Bulk redrive — `POST /v1/host/openwop-app/runs/redrive`
Body `{runIds: string[≤25]}`. Each: `loadOwnedRun` (+ `runs:create` scope),
must be TERMINAL failed/cancelled; mints a FRESH run — same
workflowId/inputs/configurable, metadata `{redriveOf, definitionRevision:
<source pin — copied>, launchResolved}`, definition via
`resolveRunDefinition(sourceRun)` (the AS-RUN revision), `idempotencyKey`
cleared, `causationId` NOT copied, `actingUserId` re-stamped. Response: per-run
`{runId, redriveRunId? , error?}` — partial success is explicit, never silent.
> **Correction (P2a):** the pin is not literally *copied* — `buildRunRecord`
> strips reserved metadata keys (the review-M1 spoof guard), and the insert
> seam re-stamps `definitionRevision` from the definition
> `resolveRunDefinition` returned, which for a pinned source IS the as-run
> hash (same value, one authority). The honesty stamp is
> `definitionResolvedFrom` (the existing fork key), not a new `launchResolved`
> value — one vocabulary for "how was this run's definition re-resolved".
FE: runs-index failed-bucket multi-select → Redrive with per-run outcome
notice.

## Matrix
| # | Dimension | Decision |
|---|---|---|
| 1-7 | package/toggle/ctx/packs/envelopes/agents/public | None — core seam; owner-gated host-ext routes |
| 8 | RBAC | pins + debug-run: owning tenant (404 posture); redrive: `loadOwnedRun` + terminal-state check per run |
| 9 | Replay/fork | debug runs record ordinary event logs (snapshot = settled prefix, the fork-checkpoint semantics); redrive copies the revision pin — as-run content |
| 10 | Frontend | builder debug session (banner, badges, inspector pin section, execute-from-here), run-detail Debug button, runs-index redrive; i18n ×4; BULLETPROOF BAR states |

## Phased plan
| Phase | Scope | Gate |
|---|---|---|
| P2a ✅ | pin store + CRUD + from-run prefill + debug-run route (partition/coverage/snapshot) + redrive route + tests (17 in `workflow-debug-loop.test.ts`: pin CRUD/caps/sanitize; missing-pin 422 names nodes; from-here runs ONLY the subgraph with pinned data flowing; 'only' skips descendants; redrive pins the as-run revision + fresh identity + provenance shed; published runs never read pins; oversized prefill skip-and-report) | backend vitest ✅ |
| P2b ✅ | FE: debug session (banner/badge/inspector/run-from-here + `?debugRun` deep-link) + Debug-in-builder + bulk redrive UI (DataTable `rowSelectable` seam) + `/` picker draft chip (ADR 0474 F6) + i18n ×4 | FE gates ✅ + `/ux-review` folded ✅ |

## Alternatives weighed
1. **Pins in `definition.metadata`** — rejected: moves `revisionHashOf`, minting
   phantom revisions per pin edit (the exact noise class ADR 0474 excluded).
2. **A new executor start-node mode** — rejected: `resumeSnapshot` already
   expresses it; a second entry mode would fork replay semantics.
3. **Redrive through the trigger bridge** — rejected: delivery dedup blocks
   re-fires by design; redrive is a RUN-layer act.

## Review fold-in (P2, adversarial code + ux rounds — 2026-07-23)

Independent reviews found 3 HIGH + 5 MED (code) and 2 CRITICAL + 7 HIGH/MED
(ux); all applied on the branch:

- **code H1** — the builder's `?debugRun` effect keyed off the module-global
  store's (possibly stale, last-opened) workflowId, so the flagship
  failed-run→editor deep link prefilled against the WRONG workflow and then
  stripped the param. Now gated on store-id === routed-id (which also
  guarantees `loadFromSaved`'s debugSession reset has already run).
- **code H2** — debug-run now enforces `requireProtocolScope('runs:create')`
  (the POST /v1/runs floor; it was ownership-only).
- **code H3** — redrive charges the run quota PER MINTED RUN
  (`res.locals.runQuotaUnits`, read by the middleware's commit hook) and both
  run-creating routes call `reserveConcurrentSlot` per run (they never counted
  against `sessionConcurrent`).
- **code M1/M2** — the redrive metadata copy now DELETES `debug`, `launch`,
  the ADR 0371 `pinned` retention flag, and `actingUserId` (a redrive is a
  fresh FULL run acting as the caller — it must not claim its source's debug
  provenance, inherit retention exemption, or keep a stale acting identity).
- **code M3** — `pins/from-run` is skip-and-report per node (`skipped:
  [{nodeId, reason}]`): one oversized LLM output no longer fails the whole
  prefill after earlier pins were written.
- **code M5** — `resolveLaunchWorkflow`'s head fallback now logs a warning
  (a store error silently changing WHICH definition a published launch runs
  needs an operator signal).
- **code L1/L7** — pin keys encode the nodeId segment; the delete cascade
  matches on the row's `workflowId` field only (no key-substring over-delete).
- **code L4** — debug-run + each redriven run record `run.create` audit rows.
- **ux C1/H7** — the canvas pin badge was invisible in dark mode
  (`--color-ai` fill + `--color-ai-text` glyph ≈ 1.06:1) and mis-claimed the
  AI category token; now `--color-info` + `--color-on-scrim`.
- **ux C2** — the banner's source-run link (`inline-link`) and the run-detail
  "Redriven" chip-link (`a.chip:focus-visible` ring entry) are keyboard-visible.
- **ux H1** — `btn-secondary` is not a defined class (renders as the filled
  primary); all new buttons use the sanctioned `secondary`.
- **ux H2** — `.binspector-debug-pin-json/-editor` defined in global.css
  (tokened chrome; no inline static geometry).
- **ux H3** — the runs-index bulk-select adopts DataTable's ONE selection seam
  (extended with a `rowSelectable` per-row predicate) instead of a hand-rolled
  checkbox column; selection clears on grid-view switch.
- **ux H4/H5/H6** — raw wire codes (`pin_put_404`) never reach the user: the
  inspector maps status → localized next-action copy (404 ⇒ "save/run this
  workflow first"), the prefill distinguishes a deleted workflow/run, and
  per-run redrive failure reasons are localized. The >25 selection is capped
  honestly (first 25 redriven, remainder KEPT selected + reported).

**Recorded limitation (code M4):** a pinned predecessor never executes, so
side-band writes it would have made to the per-run VARIABLE BAG
(`ctx.variables.set`) do not happen — a target node reading `{type:'variable'}`
from a pinned producer sees the seed value. This is the documented HVMAP-2
fork-prefix limitation surfacing on the debug path; variable production is
imperative (not statically declarable), so the route cannot warn precisely.
Revisit if/when produced-variables become declarable on nodes (RFC 0013
`producedVariables` is chain-level today).

## Open questions
1. OQ1 — should `pins:from-run` accept a FOREIGN-revision run (pins from a run
   of an older revision may reference renamed nodes)? v1: allow + report
   unmatched nodeIds in the response (the honest partial).
2. OQ2 — debug-run inputs for SOURCE nodes inside the target set (they read
   `run.inputs`): body `inputs` covers it; default `{}`.
