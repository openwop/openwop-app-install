# ADR 0137 — Ambient Work Graph (mine recurring work → suggest reusable workflows)

**Status:** implemented — all 4 phases (2026-06-24)
**Date:** 2026-06-24

## Implementation record

| Phase | What | Commit |
|---|---|---|
| 1 | Pure `computeRunSignature` (agent + consecutive-deduped tool-NAME sequence — privacy-safe) + `clusterAndDetect` (recurrence ≥ minCount) + deterministic `suggestionId` (idempotent re-sweep) | `9b30916b` |
| 2 | Suggestion store (upsert PRESERVES dismissed/accepted — no resurrection) + `sweepTenant` (the one sweep owner) + hourly daemon (env-gated, per-tenant toggle check, idempotency claim) | `78535b1c` |
| 3 | REST (`/work-graph/orgs/:orgId/suggestions`; GET reads / explicit refresh sweeps; dismiss/accept by-id tenant-verified) + accept→`draftSeed` handoff to the existing chat-driven author | `b9e34afe` |
| 4 | FE suggestions page (`WorkGraphPage`, lazy; cards + evidence; accept → `navigate('/builder', {state:{workGraphSeed}})`) + i18n | `6de3d936` |

Built under `/goal` with `/architect` before each phase + `/code-review` (+`/ux-review` P4) after; each GO'd. A read-only projection over the run store; no new run model, no new queue (rides the daemon pattern); accept reuses the ADR 0072 author (no second author). Deferred: fuzzy/sequence-similarity clustering; backend auto-persist of the accepted workflow; the FE seed-prefill consuming `workGraphSeed`.

**Graduation (2026-06-24):** the toggle was **removed — always-on**; the suggestions page + on-demand “Scan now” are always available (tenant-scoped; tool-shape only). The **background sweep daemon stays separately env-gated** (`OPENWOP_WORKGRAPH_SWEEP_ENABLED`) — graduating the toggle does not start continuous mining. Id in `RETIRED_TOGGLE_IDS`. Historical toggle rationale retained.

**Toggle (historical):** `ambient-work-graph` · default **OFF** · `bucketUnit: tenant` (a
behavior-analytics surface a workspace explicitly opts into — privacy). When OFF, no run
signatures are derived and no suggestions are produced.
**Surface:** host-extension — a **read-only signature/mining projection** over the
existing run store (`storage.listRuns` + `storage.listEvents`) + a `WorkflowSuggestion`
store (DurableCollection) + REST under `/v1/host/openwop-app/work-graph/*`. A periodic
sweep rides the **existing scheduler daemon** (NOT a new queue). Suggestions convert to
drafts via the **existing** ADR 0072 `workflow-author/draft`.
**Depends on / composes:** the run store + event log (`storage.ts:62/108` — the mining
source, read-only), ADR 0072 AI Workflow Author (`features/workflow-author` — a accepted
suggestion hands its candidate to `/workflow-author/draft` → an editable
`WorkflowDefinition`; the firewall against inventing typeIds is reused), ADR 0133 task
deck / ADR 0068 review (the **projection pattern** — read-model over runs, no new store
for runs), the scheduler daemon (the ADR 0107/0125 "reuse the daemon, don't add a queue"
lesson).
**RFC verdict:** **host-extension — NO new RFC.** A read-only projection over
already-durable runs + a host-internal suggestion store; suggestions convert through the
existing host-extension workflow-author. No run-event field, capability flag, event type,
endpoint, or normative MUST.

> **Origin.** `openwop_ai_chat_innovation_strategy.md` §3/§4 "Ambient Work Graph" (P1/P2)
> — genuinely novel (the codebase fact-check found no run-signature/pattern-mining). The
> insight: teams silently re-run the same prompt+tool sequences; detecting that recurrence
> and offering to **productize it as a workflow/pack** compounds chat into process
> knowledge — and rides OpenWOP's existing durable-run substrate + workflow-author.

---

## Context — boundaries audit first (MANDATORY)

The naïve build is "a new analytics store that records what agents do." That would shadow
the run store ([[no-parallel-architecture]]). A "work pattern" is **derived from existing
runs** — the graph is a *projection + a small suggestion store*, exactly the ADR 0133 /
0068 shape.

| Concern | Existing owner (file:line) | How the work graph reuses it |
|---|---|---|
| Run history (the mining source) | `storage.listRuns` (`storage.ts:62`) + `storage.listEvents` (`:108`) | Signatures are derived **read-only** from recorded runs + their `agent.toolCalled` events. No new run/event model. |
| Projection pattern | `host/reviewProjection.ts` / `features/task-deck/taskDeckProjection.ts` | `runSignature(run, events)` + clustering are pure derivations, same discipline (route fetches, pure functions organize). |
| Suggestion → workflow | ADR 0072 `POST /v1/host/openwop-app/workflow-author/draft` (`features/workflow-author/routes.ts`) | An accepted suggestion's candidate is handed to the existing draft endpoint → a schema-valid, editable `WorkflowDefinition`. **No second workflow compiler.** |
| Periodic mining | the scheduler daemon (ADR 0107/0125) | A cadence sweep recomputes signatures/clusters via the existing daemon — no new job queue. |
| The only new persistence | — | `WorkflowSuggestion` + a per-tenant `dismissed` set (DurableCollection). |

**Net new (bounded):** a pure `runSignature` derivation, a clustering/recurrence detector,
a `WorkflowSuggestion` store (+ dismissals), the cadence sweep step, REST to list/accept/
dismiss, and the FE suggestion card + evidence drawer + convert wizard. **No new run
model, no second workflow authoring path, no new job queue.**

---

## Privacy + determinism design point

- **Opt-in, transparent, suppressible.** OFF by default; behavior mining only runs for a
  workspace that turns it on. Every suggestion carries a `PatternEvidence` (the runs that
  formed it) shown in a drawer; dismissed patterns are suppressed (a durable `dismissed`
  set keyed by signature). No cross-tenant mining (every read is `listRuns({tenantId})`).
- **Deterministic signatures.** `runSignature` is a **pure** function of recorded run
  inputs + the ordered `agent.toolCalled` names + the workflow/agent id (a stable hash) —
  no clock, no randomness — so re-mining is idempotent and a signature is reproducible.
  The work graph is a read-model with **no replay impact** (it never influences a run).

---

## Decision

Add an optional, per-tenant **Ambient Work Graph**: derive a deterministic
**run signature** for each completed run, cluster similar signatures, flag a cluster as a
**recurring pattern** once it crosses a recurrence threshold, and surface a
`WorkflowSuggestion` ("you've done this N times — make it a workflow?"). Accepting a
suggestion hands its candidate to the existing ADR 0072 workflow-author draft path;
dismissing suppresses the signature.

### Data model

```ts
// derived (pure), not persisted as truth — recomputed from runs
RunSignature { signature: string, runId, intentClass?, toolSeq: string[], at }

WorkflowSuggestion                        // the only new persistence
  { suggestionId, tenantId, signature,
    title, candidate: WorkflowDraftInput,  // fed to /workflow-author/draft
    evidence: { runIds: string[], occurrences: number },
    status: 'suggested' | 'accepted' | 'dismissed', createdAt }

// per-tenant suppression
DismissedSignatures { tenantId, signatures: string[] }
```

### The mining stage (pure derivations + a cadence sweep)

`runSignature(run, events)` → a stable hash (pure). `clusterAndDetect(signatures, threshold)`
→ candidate patterns (pure). A scheduler-driven sweep (per tenant with the toggle ON)
recomputes over recent runs, upserts `WorkflowSuggestion`s for fresh recurring patterns
(skipping `dismissed`), and prunes accepted/stale ones. Read routes project the current
suggestions; **accept** calls `/workflow-author/draft` with the candidate; **dismiss**
adds the signature to the suppression set.

### RBAC & isolation

`workspace:read` to list suggestions, `workspace:write` to accept/dismiss; tenant-scoped
(mining + suggestions never cross a tenant); IDOR-404. Accepting inherits the
workflow-author's own RBAC + the RFC 0022 §C registration gate (no unsafe definition is
created).

---

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (0001) | `features/ambient-work-graph/` — pure signature/cluster + suggestion store + the sweep step + REST + FE. features→core (reads the run store via the host `Storage`); composes workflow-author. |
| 2 | Toggle + admin UI | `ambient-work-graph`, OFF, `bucketUnit:'tenant'`; threshold + opt-in note in the admin. |
| 3 | Workflow surface (0014) | None new v1 (it *produces* workflows via 0072; a read-only `ctx.work-graph` is deferred). |
| 4 | Node pack | None. |
| 5 | AI-chat envelopes | None — suggestions surface as cards/a page, not a chat envelope. |
| 6 | Agent pack | None. |
| 7 | Public surface | None. |
| 8 | RBAC + isolation (0006) | `workspace:read`/`write`; tenant-scoped mining; accept rides workflow-author RBAC + RFC 0022 §C; IDOR-404. |
| 9 | Replay / fork safety | None — a read-only projection that never influences a run; signatures are pure/deterministic. |
| 10 | Frontend | `WorkflowSuggestionCard` + `PatternEvidenceDrawer` (the forming runs) + `ConvertToWorkflowWizard` (→ workflow-author draft → builder); `ui/` tokens, a11y. |

---

## Phased plan

1. **Pure signature + clustering.** `runSignature` + `clusterAndDetect` + types. Unit-tested
   (stable hash, recurrence threshold, dismissed suppression). No I/O.
2. **Suggestion store + the sweep.** `WorkflowSuggestion`/`DismissedSignatures`
   (`DurableCollection`); the per-tenant cadence sweep on the existing scheduler daemon.
3. **REST + RBAC.** `/v1/host/openwop-app/work-graph/*` (list/accept/dismiss), tenant-scoped,
   IDOR-404; accept → `/workflow-author/draft`.
4. **Frontend.** Suggestion card + evidence drawer + convert wizard; `/ux-review`.
5. **(Deferred) `ctx.work-graph` read + pack-target suggestions** (suggest a node/agent
   *pack*, not only a workflow).

## Alternatives weighed

1. **A new analytics event stream the agent loop writes to.** Rejected — shadows the run
   store; signatures derive from existing recorded events.
2. **A second workflow generator.** Rejected — reuse ADR 0072 `workflow-author/draft`
   (closed-world catalog + validator + RFC 0022 §C gate); the work graph only *proposes*
   the candidate.
3. **A dedicated mining queue/worker.** Rejected — reuse the scheduler daemon (the ADR
   0107/0125 lesson); a new queue is hostile to stateless Cloud Run.
4. **On by default.** Rejected — behavior mining is privacy-sensitive; opt-in per
   workspace + transparent evidence + dismissal is the posture.

## Open questions

1. **OQ-1 — Signature granularity.** Tool-sequence + intent-class hash vs a coarser shape;
   too fine → no clusters, too coarse → noisy. Lean: tool-sequence + workflow/agent id;
   tune the recurrence threshold per tenant.
2. **OQ-2 — Intent class.** Deriving `intentClass` may want a cheap classifier (cost) — or
   skip it v1 and cluster on tool-sequence only. Lean: tool-sequence v1, classifier later.
3. **OQ-3 — Notification.** Surface suggestions only in the work-graph page (pull), or also
   push an addressed notification (ADR 0050)? Lean: pull-only v1 (avoid suggestion spam).

## RFC verdict (Step 5)

**Host-extension — NO new RFC.** A read-only projection over already-durable runs + a
host-internal suggestion store; conversion rides the existing host-extension
workflow-author. No wire field/event/capability/endpoint/MUST.
