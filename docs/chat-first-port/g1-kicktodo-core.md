# KickTodo core (unit G1) — chat-first port review

**Scope:** `backend/typescript/src/features/kicktodo-core`, `frontend/react/src/features/kicktodo`, `frontend/react/src/features/challenge-outline`.
**Context:** KickTodo was the ORIGIN of this method (ADR 0458). G1 is the post-remediation participant core after ADRs 0458 (chat-first authoring), 0459 (participant replan), 0460 (exception ledger), 0463 (A2UI clarify). This review verifies the remediation held.

**Headline verdict:** This unit already rides the engine. Every intelligence-bearing capability expresses through the ONE chat + a real workflow + shared HITL + the single owners. No PARALLEL architecture, no substantive THEATER. The team-lead's silent-drop pattern (agents whose allowlist carries node typeIds never projected as conversational tools) does **not** bite here — every entry in every KickTodo agent allowlist is a registered `openwop:kicktodo.*` conversational tool. Findings are two small honesty/cleanup items, not ports.

---

## Verdict table

| Capability | Today | Verdict | Notes / port target |
|---|---|---|---|
| "Talk to your guide" (AI coaching) | Deep-links the ONE chat scoped to KickBot | **RIDES** | `routes.tsx:6`, `GuidePage.tsx:17`, `TodayPage.tsx:182`, `ProgressPage.tsx:115` all `/?agent=host:kickbot`. No second chat panel. |
| KickBot named agent | Roster/profile agent from existing owners | **RIDES** | `kickbotService.ts:145-309` instantiates roster (`createRosterEntry`), kanban board (`createBoard`), conversation (`ensureConversationMeta`), profile capability. No parallel agent/memory/transcript store. Heartbeat explicit-OFF (`:184`), autonomy `review`. |
| Chat read grounding (Today/Progress) | `registerFeatureAgentTool` read tools | **RIDES** | `agentTools.ts:367-405`. Fail-EMPTY without acting user (`:376`,`:398`); owner-checked (`:401`); pack-allowlisted, not on the ADR 0315 baseline. |
| AI replan (intent → plan change) | Chat tool ignites a real workflow w/ HITL | **RIDES** | `runReplanTool` `agentTools.ts:317-364` → `startWorkflowRun(KICKTODO_REPLAN_WORKFLOW_ID)`; workflow `builtinWorkflows.ts:96-224`: compose (closed-world `plan-revision`) → clarify (A2UI) → enrich → `core.chat.approvalGate` → reject-safe `core.fail` barrier → governed apply. Writes NOTHING directly. Shared enrollment-authority predicate `:331`. |
| Plan-revision approval (HITL) | Shared gate primitive, inline in participant's own conversation | **RIDES** | `core.chat.approvalGate` `builtinWorkflows.ts:181-188`; typed `kicktodo.plan-revision` artifact (humanized, not raw JSON); durable decision record; rejected ⇒ typed run failure, nothing mutates (`:214-221`). |
| Convene specialist (handoff skills) | Shared `agentDispatch` + fire-now scheduler + read-only confinement | **ADAPTER** | `conveneSpecialist` `agentTools.ts:116-225`. Sync contract-check via `runAgentDispatch` then async post-back through the `schedule-followup` seam; ADR 0104 full-replace allowlist override confines the live run to read-only (`:189-197`). Closed specialist set (`:52-57`), bounded pending cap (`:170-177`). |
| Enroll in a challenge | Enrollment saga run + REST | **PAGE-LEGIT** | Domain CRUD, not a primitive shadow. Saga is a real workflow `builtinWorkflows.ts:30-63`; route `routes.ts:224`; one ADR 0412 goal per enrollment. |
| Check-in / evidence capture | Evidence-aware form → POST | **PAGE-LEGIT** | Domain write; `TheOneThing.tsx` ActionCompleter renders exactly the policy's evidence input; route `routes.ts:469`, 422 on missing evidence. |
| Substitute (publisher-declared) | Compact swap control → POST | **PAGE-LEGIT** | `TodayPage.tsx:32-65`; publisher-declared alternatives only; route `routes.ts:424`, uniform-404 posture. |
| Snooze/resume + daypart reminder | Chips → POST | **PAGE-LEGIT** | `TodayPage.tsx:190-269`; reminder = a *second scheduler job* (`reminder-loop` `builtinWorkflows.ts:80-95`), never a second cadence engine; consent-gated. |
| Invite mint/revoke | Buttons → POST | **PAGE-LEGIT** | `routes.ts:188-222`; participant's own resource, one live token per (inviter, challenge). |
| Today / Plan / Progress / Journal / Discover | Read pages | **PAGE-LEGIT** | Projections over the enrollment/occurrence/goal owners; self-data only; honest empty states. |
| challenge-outline canvas | FramesTree canvas type | **RIDES** | `definition.tsx:30-72`; rides the FramesTree chassis + collab element binding; NOT a second plan store (working-draft applied through validate→persist→re-derive, `:9-16`). Creator-unit surface. |
| Admin Exception Ledger | Manage-gated read | **PAGE-LEGIT** | `routes.ts:113-118` over the host `exceptionProjection` seam (`exceptionSources.ts`); degraded sources reported, never dropped. Frontend consumer in sibling `kicktodo-admin`. |
| Daily-loop / evaluate (judged completion) | Continuation job → workflow | **RIDES** | `daily-loop` `builtinWorkflows.ts:64-79` fired by the ADR 0412 `armContinuation` job; `evaluate` is a deterministic host judge through the goals owner (route direct-invoke is acceptable — no model output). |
| Missed-window recovery accept | REST route + client binding, **no igniter** | **THEATER (minor)** | See Finding 1. |
| Legacy `POST /enrollments/:id/replan` (mechanical supersession) | Ungated-by-validation REST, unwired to UI | **PAGE-LEGIT (latent)** | See Finding 2. |

**Tally:** R=7 A=1 P=0 T=1 PL=8

---

## Blockers (from scouting) — none

Every assumption the port method would test holds:
- Declared workflows have igniters: `enrollment` (enroll route/saga), `daily-loop` (`armContinuation`), `reminder-loop` (opt-in scheduler job), `replan` (`runReplanTool` → `startWorkflowRun`, `agentTools.ts:335`). No orphaned `WorkflowDefinition`.
- KickBot's allowlist (`kickbotService.ts:86` = today, progress, convene, replan) is exactly four registered conversational tools — none is a node typeId, so nothing is silently dropped at dispatch. The `kicktodo-kickbot-connections` tripwire test pins this set.
- Every specialist allowlist (`packs/feature.kicktodo.agents/pack.json`) is `openwop:kicktodo.{today,progress,circles}` — all registered (`circles` is owned by sibling `kicktodo-accountability/agentTools.ts:11`, projected only when that toggle is on; the specialist's own allowlist intersects the offered set, so absence is graceful).
- Owners instantiated, not shadowed: roster/profile/kanban/conversation (`kickbotService.ts`), goals (`enrollmentService.ts` `createGoal`/`armContinuation`), scheduler (`registerJob`), approvals gate (`core.chat.approvalGate`), canvas chassis (`challengeOutlineDefinition`).
- Executor constraints respected: the gate lives in the PARENT replan run (not a child); the reject-safe `none_failed` barrier is the documented ADR 0458 pattern; the composer carries NO `conversationId` so it can't pre-empt the approval card (`builtinWorkflows.ts:141-149`).

---

## Findings (small — honesty/cleanup, not ports)

**Finding 1 — Missed-window recovery accept has no igniter (minor THEATER).**
`acceptRecovery` is a REST route (`routes.ts:450-467`) and an exported client binding (`kicktodoClient.ts:320`), but no KickTodo page or chat tool creates the accept action — grep for `acceptRecovery` across `frontend/react/src` returns only the binding itself. The recovery *framing* on Today is snooze/resume (`TodayPage.tsx:242-269`), which is a different path. So the `ask`-policy recovery-accept capability is declared but unreachable by a user. Honest alternative: either surface the recovery prompt on Today (a domain-write control, PAGE-LEGIT — no chat needed) OR fold "recover this window" into KickBot's replan `recovery` lane (it already exists as an ADR 0429 lane) and delete the dead route+binding. Deferred-visibly until then; do not paint it as shipped.

**Finding 2 — Two "replan" surfaces share a name (latent, not a shadow).**
`POST /enrollments/:id/replan` → `applyPlanRevision` (`enrollmentService.ts:608`) is a *mechanical* plan-revision supersession (bump `planRevision`, re-materialize non-terminal occurrences), owner-gated, **not** the AI closed-world replan. It is not wired to the frontend. It is legitimate domain CRUD, not a HITL shadow (no model output flows through it), so it is not a demolition target — but the name collides with the ADR 0459 AI replan and the two could be conflated by a future caller. Recommend a rename (e.g. `/enrollments/:id/advance-revision`) and a doc note that closed-world plan changes ride the workflow only. Low priority.

**Finding 3 — Dead client bindings.** `evaluateEnrollment` (`kicktodoClient.ts:238`) and `acceptRecovery` (`:320`) have no frontend caller; `evaluate` runs via the daily-loop workflow. Cleanup, not a chat-first issue.

---

## Demolition list

None. No bespoke "talk to AI" surface, no bespoke approval/submit button duplicating the HITL machinery, no parallel owner. The one dead route (`acceptRecovery`, Finding 1) is a delete-or-wire decision, not a chat-first demolition. If it is deleted, add a regression assertion that no route resolves to `acceptRecovery` without a UI/chat igniter.

**Existing regression pins already in place** (verified present): `kicktodo-route-collision`, `kicktodo-authz-adversarial`, `kicktodo-authz-scope`, `kicktodo-kickbot-connections` (allowlist tripwire), `kicktodo-replan`, `kicktodo-plan-proposal-card`, `kicktodo-builtin-workflow-dataflow`, `kicktodo-exception-projection`, `kicktodo-outline-canvas-authz`, `kicktodo-artifact-parity`, `kicktodo-challenge-author-prompt-parity`.

---

## New-code inventory

Effectively empty. The unit is the finished product of the method it invented. The only optional work:
- (Finding 1) One Today control OR one recovery lane wiring + delete the dead route/binding.
- (Finding 2) A route rename + doc note.
- (Finding 3) Remove two dead client exports.

---

## Deferred honestly

- **Recovery-accept UI/igniter** — declared route+binding with no user path (Finding 1); stated, not faked.
- **Photo evidence** — the `photo` policy rides the note field "until a media binding exists" (`TheOneThing.tsx:58`); an honest deferral to the media owner, correctly disclosed in code.
- **challenge-outline** is toggled under `kicktodo-creator` (`definition.tsx:35`), so its full authoring loop belongs to the creator unit's review, not G1.
