# KickTodo Creator (Challenge Factory) — chat-first port review

**Unit G2** · backend `backend/typescript/src/features/kicktodo-creator` · frontend `frontend/react/src/features/kicktodo-studio` (+ the `challenge-outline` canvas feature it owns).
Context: the Challenge Factory (ADR 0415) after the ADR 0458 chat-first authoring remediation and ADR 0461 Studio embedded-chat — both marked COMPLETE + deployed. This review verifies the remediation held and hunts for residue/regressions.

**Headline verdict: this feature already rides the engine.** It is one of the reference chat-first ports in the app — the ADR 0458/0461 remediation held end-to-end. There is no PARALLEL architecture and no user-facing THEATER. The single real finding is **dead residue**: two superseded standalone builtin workflows the factory composite replaced but nobody removed. A short list of watch-items follows.

---

## Contract scouting (what it declares vs what actually runs)

**Workflows declared** (`builtinWorkflows.ts:337-406`), registered via `feature.ts:51`:
| Workflow id | Igniter? | Evidence |
|---|---|---|
| `openwop-app.kicktodo.challenge-factory` (the composite) | **YES** — `runFactoryRunTool` → `startWorkflowRun` | `agentTools.ts:177-191`; assigned to the Challenge Author roster `challengeAuthorService.ts:99` |
| `openwop-app.kicktodo.lesson-batch` (child) | **YES** — invoked per slot via `core.subWorkflow` | `builtinWorkflows.ts:194-208` (`build-N` nodes) |
| `openwop-app.kicktodo.plan-generation` | **NO igniter** | no `startWorkflowRun` caller, not roster-assigned, not tool-referenced (grep clean) |
| `openwop-app.kicktodo.research` | **NO igniter** | same — grep for the id returns only its own definition |

The composite **fully subsumes** both orphans: research (`research-frame → core.web.search → source-normalize → evidence-graph`, `builtinWorkflows.ts:129-151`) and plan-generation (`generate → decompose`, folded into the composite spine `builtinWorkflows.ts:153-231`). ADR 0415-D5 shipped the two standalone workflows; ADR 0458-P2 folded them into the one packaged factory ("never generated per challenge, PRD §6.1" — `builtinWorkflows.ts:47-49`) and left the originals declared.

**Nodes**: every `feature.kicktodo.nodes.*` typeId the workflows reference exists in `packs/feature.kicktodo.nodes/pack.json` (verified: `research-frame`, `source-normalize`, `evidence-graph`, `plan-generate`, `plan-validate`, `checkpoint-plan`, `decompose`, `sim-collect`, `submit-publication`, `lesson-batch-build` all present). Core types resolve too — `core.web.search`, `core.chat.approvalGate`, `core.subWorkflow`, `core.fail`, `local.openwop-app.agent-runner` (`bootstrap/nodes.ts`, `host/agentRunnerNode.ts`). **No orphaned node typeId.**

**Agent + tool allowlist parity** (the cross-cutting drop check): the Challenge Author's `toolAllowlist` is exactly `["openwop:kicktodo.candidates", "openwop:kicktodo.factory.run"]` (`pack.json:30-33`). Both are `registerFeatureAgentTool` **chat-time tools** (`agentTools.ts:202-235`), not node typeIds — so they project into conversational tools and are **not** silently dropped at dispatch. The repo-wide "node typeId in an allowlist gets dropped" pattern does not bite here. The three `sim-*` agents carry `toolAllowlist: []` and are dispatched as `agent-runner` nodes with `config.offerTools:[]` (`builtinWorkflows.ts:233-240`) — a deliberate zero-tool surface, correct.

**Authorization parity**: `hasKicktodoManageAuthority` is the ONE predicate. Both chat tools call it (`agentTools.ts:112, 136`); every REST route calls `requireKicktodoManage` via the single `gate()` (`routes.ts:73-83`); the canvas chassis routes call the SAME predicate through the `authorize` hook (`routes.ts:463`) — the ADR 0458-B1 "chassis surface you forgot" is closed. Read tool fails EMPTY (`agentTools.ts:113`), action tool fails typed (`agentTools.ts:137`).

**Owners instantiated (not shadowed)**: approvals → `createChallengePublishApproval`/`resolveApproval` (`publishService.ts:239, 299`); challenge store → `kicktodo-core`'s `publishChallenge` (`publishService.ts:302`) — "never a second challenge store" (`feature.ts:8-9`); roster/profile → `createRosterEntry` + `activateAgentCapability` (`challengeAuthorService.ts:94, 135`); canvas → `registerCanvasEditorRoutes`/`ensureCanvasForTenant` (`routes.ts:451, 324`); subject erasure → `registerSubjectEraser` (`publishService.ts:350`); exception ledger → `registerExceptionSource` (`exceptionSources.ts`); the ONE chat → `EmbeddedChatPanel` (ADR 0073, `StudioPage.tsx:21,153`, `CandidateWorkspacePage.tsx:26,566`).

**Executor constraints handled honestly**: the acyclic no-re-entry executor can't express per-day nodes for a variable batch, so lessons are built by ONE internally-iterating pack node (`lesson-batch-build`) and cadence is approximated by ≤4 checkpoint batches — recorded in the ADR, not hidden (`builtinWorkflows.ts:15-27, 68-72`). Child-run interrupts are opaque in the parent chat, so ALL human gates live in the PARENT run; the child has none (`builtinWorkflows.ts:24-26`). The reject-safe barrier (`decompose ← fail-0..3` with `none_failed`) is load-bearing and documented (`builtinWorkflows.ts:277-299`).

---

## Verdict table

| Capability | Today | Verdict | Notes / port target |
|---|---|---|---|
| Ignite the Challenge Factory from chat | agent tool → `startWorkflowRun` + inline `workflow_run` turn | **RIDES** | `agentTools.ts:132-199`; assigned-workflow ignition, no bespoke trigger |
| Candidate intake (create from topic/audience) | tool + POST route, both `createCandidate`, prohibited-topic refused | **RIDES** | `agentTools.ts:151-168`, `routes.ts:92-114`; intake IS the conversation |
| Research → evidence spine | `research-frame → core.web.search → source-normalize → evidence-graph`, fail-closed on stub | **RIDES** | composed from the existing catalog `builtinWorkflows.ts:129-151` |
| Plan generate + decompose | `plan-generate` (`ctx.callAI` + validate + 1 bounded repair) → `decompose` | **RIDES** | validated closed-world, never a placeholder (`feature.ts` D1 note, `builtinWorkflows.ts:341-345`) |
| Approve/reject the outline (HITL) | `core.chat.approvalGate` in the parent run, inline card | **RIDES** | `builtinWorkflows.ts:164-176`; durable decision record |
| Per-lesson checkpoint approvals (HITL) | ≤4 parent-run `approvalGate`s over `subWorkflow` batches | **RIDES** | `builtinWorkflows.ts:192-226`; cadence is an input (`checkpointEvery`) |
| Simulation (3 personas) + gate | `agent-runner` nodes (`offerTools:[]`) → `sim-collect` → real `simulation` gate | **RIDES** | `builtinWorkflows.ts:233-248`, `publishService.ts:151-157`; fail-closed on coverage |
| Submit → separation-of-duties publish | `submit-publication` raises ONE `challenge-publish` approval; distinct approver enforced | **RIDES** | `publishService.ts:239-249, 289`; never publishes in-run |
| Structured outline canvas editing | canvas chassis; ensure→edit→apply (validate→persist→re-derive) | **RIDES** | `routes.ts:304-368, 451-474`; published-immutable = typed 409 |
| Kill switch / retire published challenge | confirm dialog + required audited reason → `killSwitch` | **RIDES** | `routes.ts:290-303`, `CandidateWorkspacePage.tsx:120-134`; retires the core version |
| Source-health monitor + admin exception feed | guarded egress probe → monitor report → `registerExceptionSource` | **RIDES** | `routes.ts:258-284`, `exceptionSources.ts`; SSRF-guarded (`guardedEgressFetch`) |
| Converse with the Challenge Author | `EmbeddedChatPanel` scoped to the agent, in Studio + candidate | **RIDES** | `StudioPage.tsx:153-159`, `CandidateWorkspacePage.tsx:562-573`; full-chat deep-link escape hatch |
| Challenge Author provisioning | roster + profile get-or-create, deterministic id, autonomy heal | **RIDES** | `challengeAuthorService.ts`; capability at core, activated on profile (David's law) |
| Candidate-death sidecar cleanup | keyed death seam fired on the `withdrawn` flip | **RIDES** | `candidateLifecycle.ts`, `candidateDeathSubscribers.ts` |
| Subject erasure (DSAR) | `registerSubjectEraser` anonymizes person-links in provenance rows | **RIDES** | `publishService.ts:338-350` |
| Creator insights & earnings | reporting over `revenueProjectionFor` + derived share ledger; no fabricated money | **ADAPTER** | `CreatorInsightsPage.tsx`; thin honest wrapper over billing/commerce owners — watch for drift |
| Studio overview / portfolio collection | faceted collection, "Needs you" queue | **PAGE-LEGIT** | `StudioPage.tsx`; honest empty state, read fan-out capped |
| Candidate workspace / provenance spine | read-only spine, each stage shows only server-backed state | **PAGE-LEGIT** | `CandidateWorkspacePage.tsx`; gate actions explicitly NOT bespoke (`:348-353`) |
| Gate-matrix / simulation / lessons honesty reads | display-only, re-derived from the SAME predicates the write path enforces | **PAGE-LEGIT** | `creatorReads.ts`, `publishService.ts:180-196`; no painted status |
| `openwop-app.kicktodo.plan-generation` builtin | declared workflow, no igniter | **THEATER** | superseded by the factory composite — demolish |
| `openwop-app.kicktodo.research` builtin | declared workflow, no igniter | **THEATER** | superseded by the factory composite — demolish |

**Totals: RIDES 15 · ADAPTER 1 · PARALLEL 0 · THEATER 2 · PAGE-LEGIT 4.**

---

## Blockers (from scouting) — with the honest alternative

**None.** Every assumption a port would need held: real igniter, shared authz predicate, real HITL gates in the parent run, closed-world validation with a bounded repair, no shadowed owner, chassis authz parity closed. The ADR 0458/0461 remediation is intact. This unit needs cleanup, not a port.

---

## Demolition list (with regression pins)

1. **Remove the two orphaned standalone builtin workflows** — `openwop-app.kicktodo.plan-generation` and `openwop-app.kicktodo.research` (`builtinWorkflows.ts:340-405`). They are ADR 0415-D5 originals fully subsumed by the ADR 0458 factory composite; nothing creates runs of them (no `startWorkflowRun` caller, not roster-assigned, not tool-referenced). They are dead declarations that register into the workflow catalog on every boot.
   - **Regression pin**: add a test asserting `kicktodoCreatorBuiltinWorkflows` contains exactly `challenge-factory` + `lesson-batch` (a resurrected standalone fails the suite), and a parity test that every builtin workflow id is either roster-assigned OR sub-invoked OR tool-ignited (a generic "no orphaned builtin" guard).
   - **Caveat before deleting**: confirm neither id is referenced by a seed, a template-gallery entry, a manual-test page, or a demo pack. Builtins are catalog-registered and *could* be started via a generic run route even without an in-feature igniter; if a gallery/seed surfaces them, that surface is the igniter and they become RIDES-but-redundant (reconcile by pointing that surface at the composite) rather than pure dead code. Grep across `packs/`, `frontend/react/src` template galleries, and seeders first.

No bespoke UI to demolish — the ADR 0458-P4 finding ("a bespoke approve button here would duplicate a first-class primitive") was already actioned: the workspace's publication section only *states* status and links to the reviews inbox/chat (`CandidateWorkspacePage.tsx:348-367`); the only action buttons are the canvas open/apply (RIDES), the audited kill switch (RIDES), and the chat toggle (RIDES).

---

## New-code inventory

**Empty.** No new tools, nodes, workflows, reads, or seams are required — the feature already expresses its intelligence through the engine. The only change is a **deletion** (the two orphaned workflows) plus its regression pin.

---

## Phased plan

- **Phase 1 (cleanup, low-risk):** verify no seed/gallery/manual-test references the two orphaned workflow ids; if clean, delete them from `kicktodoCreatorBuiltinWorkflows` and add the "no orphaned builtin" parity pin. Close with `/code-review`. No UX phase needed (no user-facing change).

That is the entire remediation. Everything else is a leave-alone.

---

## Deferred honestly (already deferred visibly in the code — not faults)

- **`enriched` lesson-body signal**: deliberately NOT surfaced — the rich lesson body is ephemeral node output with no host SSoT, so the day-strip shows only `planned` + `hasMedia` (`creatorReads.ts:16-19, 34-43`). Correct honesty, not a gap.
- **Per-day checkpoint cadence**: approximated by ≤4 batch checkpoints because the acyclic executor can't re-enter per-day nodes — recorded in the ADR (`builtinWorkflows.ts:68-72`). Honest constraint, not theater.
- **Earnings dollars vs entitlement reach**: the reach projection carries no monetary field, so the insights summary reports units and says so; real currency renders ONLY from the derived share ledger (`CreatorInsightsPage.tsx:9-17, 114-116`). Measurement-honesty rule respected.
- **Reject-safe barrier UX wart**: after a checkpoint reject, sibling gates still resolve before the run finalizes as failed — an accepted, documented UX wart; the submit invariant holds unconditionally (`builtinWorkflows.ts:83-86`).

---

## Bottom line

"Already rides the engine" is the falsifiable outcome here, and it is evidenced: real igniter, shared predicate across routes/tools/chassis, parent-run HITL gates, closed-world validation with bounded repair, single owners instantiated for approvals/challenges/roster/canvas/erasure/exceptions, and the ONE chat embedded (never a second panel). The only residue is two superseded builtin workflows nobody removed after the ADR 0458 fold — a delete plus a regression pin, not a port.
