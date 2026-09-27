# A12 — Autonomy loop — chat-first port review

**Scope (single-feature mode):** the autonomy-loop unit — `features/heartbeat-admin`
(ADR 0318), `features/goals` (ADR 0412 / RFC 0097), `features/task-deck` (ADR 0133),
the core work loop they govern (`host/heartbeatService.ts`, ADR 0313), the ADR 0311
commitment-todo tool (`host/agentToolProvider.ts`), and the matching frontend
(`settings/HeartbeatSettingsPage`, `taskDeck/*`, `dashboard/tiles/TaskDeckTile`).

**Headline verdict: this unit already rides the engine.** There is no PARALLEL
architecture and no THEATER. The heartbeat is a *real igniter*
(`runHeartbeatOnce` → `startWorkflowRun`, `heartbeatService.ts:194`), goals is the
*single owner* of standing goals riding the *one* scheduler
(`armContinuation` → `registerJob`, `goalsService.ts:262`) and the *one* approvals
owner is used for HITL, and the commitment-todo path is the reference chat→board→
heartbeat→chat loop. The port work is near-zero. What remains are three
completeness/honesty gaps on otherwise-correct surfaces, plus one deliberately
un-wired continuation mode that the create path still accepts.

---

## Contract scouting (pinned)

- **The work loop DOES create runs.** `runHeartbeatOnce` picks the first eligible
  To Do card on an agent-owned board and calls `startWorkflowRun`
  (`heartbeatService.ts:194-206`); the autonomous pass `processDueHeartbeats`
  (`heartbeatService.ts:318`) and the polling daemon are the igniters. Deployed but
  **pinned OFF** via `OPENWOP_HEARTBEAT_DEFAULT_MS=0` (ADR 0313; OFF is a rollout
  state, not theater). This is a RIDES, not a declared-but-dead workflow.
- **The propose gate rides the approvals owner + shared HITL.** review/guided/auto
  resolve through `resolveAgentPolicy`, and a proposal is a real
  `createApproval(...)` (`heartbeatService.ts:129-146`) that carries
  `conversationId` when the card was chat-filed, so it renders inline in the
  originating conversation's reviews strip (`sourceConversationId`,
  `agentToolProvider.ts:303` → approval → `ConversationReviewsStrip`). No bespoke
  approve/submit button.
- **Goals is the single goals owner.** It owns the store
  (`DurableCollection('goals')`, `goalsService.ts:33`), is the *sole* transition
  authority (`goal-completion-judge-only`; client state writes refused,
  `goalsService.ts:160`, `updateGoal`), and owns the continuation-job lifecycle
  (arm/pause/resume/disarm-on-terminal). Real consumer wired: KickTodo
  (`kicktodo-core/enrollmentService.ts:258` arms; `progressService.ts:202`
  registers the verifier). Not a shadow.
- **Continuation rides the ONE scheduler owner.** `armContinuation` upserts one
  deterministic job `goal:<tenant>:<goalId>:continuation` via `registerJob`
  (`goalsService.ts:261-279`) with opaque roster attribution. It does not shadow
  scheduling.
- **Agent tools share their route's access predicate and fail closed.**
  `openwop:goals.list` (`goals/agentTools.ts:34`) and `openwop:tasks.deck`
  (`task-deck/agentTools.ts:32`) both fail EMPTY without an acting user; the deck
  tool calls the *same* `buildOwnedTaskDeck` the route uses (`routes.ts:58`), so
  the IDOR ownership filter cannot drift. `kanban.add-todo` fails typed without an
  acting user + specific agent (`agentToolProvider.ts:272-274`).
- **Task deck is a pure projection, no parallel store.** `taskDeckProjection` is a
  deterministic read-model over `RunRecord[]` (`taskDeckProjection.ts:82`); the
  feature header explicitly cites `[[no-parallel-architecture]]`.

**Assumption that failed (BLOCKER-class, low severity):** the goals create path
accepts continuation modes (`commitment`, `heartbeat`) that can never continue —
`armContinuation` throws `ContinuationModeError` for anything but `schedule`
(`goalsService.ts:259`), and those modes are dropped from the capability
advertisement. So a `mode:'commitment'` goal is a durable row that silently never
fires. Honestly documented (`types.ts:18`, `goalsService.ts:221-225`) but the
create validator still lets it through (`routes.ts:41`).

---

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Operator governs the work loop (master on/off, cadence, auto-disable window, run-budget) | Superadmin settings page + GET/PUT `…/heartbeat/settings` | **PAGE-LEGIT** | Keep. Config, not intent — correctly page-shaped. Rides `registerHeartbeatConfigProvider` (`feature.ts:29`). |
| Autonomous card pickup → run | `runHeartbeatOnce` → `startWorkflowRun` | **RIDES** | Leave. Real igniter over roster + kanban + run-budget (`heartbeatService.ts:194`). |
| Agents-propose HITL gate (review/guided/auto) | `createApproval`, surfaces in chat reviews strip | **RIDES** | Leave. Shared approvals owner + inline HITL (`heartbeatService.ts:129`). |
| Bare-card agent-turn fallback | `registerAgentTurnFallback` fill-a-seam | **ADAPTER** | Leave; watch for drift. Always routes through the propose gate (`heartbeatService.ts:87,153`). |
| Chat agent files a commitment todo | `openwop:kanban.add-todo` → real card w/ `sourceConversationId` → heartbeat → chat | **RIDES** | Leave. The reference chat-first loop; deterministic id, fail-closed (`agentToolProvider.ts:252`). |
| Standing-goal lifecycle (create/get/list/update/transition/abandon) | routes + `ctx.features.goals` surface | **RIDES** | Leave. Single owner; judge-only completion; CAS (`goalsService.ts`). |
| Goal judge / evaluate | verifier port `registerGoalVerifier` + `evaluateGoal` | **ADAPTER** | Leave. Mirrors the turn-scoped `AgentVerifier` idiom; fail-closed (`goalVerifiers.ts`). |
| Goal continuation arming | `armContinuation` → `registerJob` | **RIDES** | Leave. One deterministic scheduler job per goal (`goalsService.ts:238`). |
| Chat grounding: "what are my goals?" | `openwop:goals.list` (read-only) | **ADAPTER** | Leave. Fails empty w/o acting user; tenant-scoped like the route. |
| Chat grounding: "what am I running / blocked on?" | `openwop:tasks.deck` (read-only) | **ADAPTER** | Leave. Shares `buildOwnedTaskDeck` with the route. |
| Run/task deck view | route + `TaskDeckModal` + `TaskDeckTile` | **PAGE-LEGIT** | Keep; complete the honesty loop (see gap #1). |

**Counts:** RIDES 5 · ADAPTER 4 · PARALLEL 0 · THEATER 0 · PAGE-LEGIT 2 (11 capabilities).

---

## Blockers / gaps (each with the honest alternative)

**Gap 1 — the task deck computes a resume affordance it never renders
(PAGE-LEGIT honesty-loop hole).** `taskDeckProjection` builds
`resumeRef = { runId, nodeId, interruptId }` for every blocked run
(`taskDeckProjection.ts:97`) and it survives into the client type
(`taskDeck/taskDeckClient.ts:18`), but nothing renders it: `TaskDeckModal` shows
only `blockedReason` text (`TaskDeckModal.tsx:79`). A user sees "blocked" and is
given no way to act, and the resume target is dead data end-to-end.
→ *Honest alternative:* either render the resume deep-link (an inline
interrupt/resume affordance pointing at the shared HITL card — the deck's whole
value for a blocked run), or delete `resumeRef` from the projection + client type
so the surface stops carrying a promise it never keeps. This is the only
capability-shaped gap in the unit.

**Gap 2 — no chat path to CREATE or manage a standing goal
(coverage, deferred-honestly).** Chat exposes only `openwop:goals.list` (read).
"Set me a standing goal to keep the weekly digest under 5 bullets" — pure
describe-intent — has no agent tool; a goal is only created via KickTodo's
enrollment saga or the raw route. That is defensible today (goals is a primitive
consumed by a feature, not a user-facing chat verb yet), but by the interface test
it is a real coverage gap, not a design choice to leave unstated.
→ *Honest alternative:* if standing goals become a first-class user concept, add a
`role:action` goals-author agent tool (create + arm through the surface, which
already validates bounds and rides the scheduler) — not a new panel. Until then,
mark it deferred-visibly. Do **not** build a goals page/form.

**Gap 3 — create accepts un-armable continuation modes (low-severity,
theater-adjacent).** `commitment` / `heartbeat` pass create validation
(`routes.ts:41`, `surface.ts:32`) but can never continue (`goalsService.ts:259`
throws on arm; advertisement drops them). A goal filed with those modes is an inert
row.
→ *Honest alternative:* reject `commitment`/`heartbeat` at create with a typed 422
("continuation mode not wired on this host"), matching the advertisement, so create
never mints a goal that structurally cannot continue.

---

## Demolition list (with regression pins)

Nothing to demolish — there is no bespoke UI substituting for a primitive. The two
page-shaped surfaces (heartbeat settings, task deck) are legitimately pages.
Regression pins to ADD alongside the gap fixes:

- **Pin the resume affordance** (if gap 1 is fixed by rendering): a test asserting a
  blocked deck card exposes its `resumeRef` deep-link; OR, if fixed by deletion, a
  test asserting the projection no longer emits `resumeRef` (so it can't silently
  re-accrete).
- **Pin the mode rejection** (gap 3): a route test that `POST /goals` with
  `continuation.mode:'commitment'` returns 422, locking create ⟺ advertisement
  parity.
- **Keep the existing fail-empty pins** for `goals.list` / `tasks.deck` /
  `kanban.add-todo` (acting-user-required) — these encode the authority-parity
  invariant and must not regress.

---

## New-code inventory (small — the unit already rides the engine)

1. Task-deck resume affordance: render `resumeRef` as a shared interrupt/resume
   deep-link in `TaskDeckModal` (+ i18n key in 4 locales), OR delete the dead
   `resumeRef` from projection + client type. ~1 component change or ~2-line
   deletion.
2. Goals create-mode guard: reject un-armable modes at `parseCreate`/`buildGoalsSurface`
   with a typed 422 + one route test. ~5 lines + test.
3. (Deferred) goals-author agent tool: only if standing goals graduate to a
   user-facing chat verb — a `create`+`arm` action tool over the existing surface,
   no new store, no panel.

No new workflows, no new nodes, no new owners, no new stores.

---

## Phased plan (real gates)

- **Phase 1 — task-deck honesty loop (gap 1).** Decide render-vs-delete for
  `resumeRef`; implement; add the regression pin. Gate: `npm run ci` +
  `/code-review` + `/ux-review` (the deck is a rendered surface). No demolition —
  additive or subtractive-of-dead-data only.
- **Phase 2 — create/advertise parity (gap 3).** Reject un-armable continuation
  modes at create with a typed 422 + route test. Gate: backend vitest + `/code-review`.
- **Phase 3 — deferred, gated on product intent (gap 2).** If standing goals become
  a user-facing chat concept, add the goals-author action tool over the surface
  (never a page). Gate: `/grade-ai-exchange` (new model-facing write tool ⇒
  allowlist row + tripwire) + `/code-review`.

Compliance/honesty seams (Phases 1–2) ship first; nothing is demolished before a
replacement works (there is nothing to demolish).

---

## Deferred honestly

- **Work loop stays pinned OFF** (`OPENWOP_HEARTBEAT_DEFAULT_MS=0`) — a rollout
  decision (ADR 0313), not a defect. Activation is `=600000` after the preflight
  (`scripts/heartbeatPreflight.ts`).
- **`agents.goals` capability + `host.goals.*` events remain gated on
  `OPENWOP_GOALS_ENABLED`** (`discovery.ts:796`, `goalEvents.ts:33`) — the honesty
  flip is deliberate: the wire claim is only advertised when the flag is on. Correct.
- **No in-chat goal creation** (gap 2) — deferred until standing goals are a
  user-facing concept; stated, not faked.
- **Stale doc drift (cosmetic, not a port item):** `task-deck/feature.ts` header +
  `TaskDeckPanel.tsx:16`/`:3-8` still describe a per-tenant `task-deck` toggle that
  was removed ("always-on"); harmless but worth a one-line cleanup when the file is
  next touched.

---

### Bottom line

The autonomy loop is a model citizen of the chat-first architecture: a real
igniter, single owners for goals/schedules/approvals/kanban, read tools that fail
empty and share their routes' predicates, and a genuine chat→board→heartbeat→chat
commitment loop. There is no parallel architecture and no theater to remove — only
one dead resume affordance to wire or delete, one un-armable create mode to reject,
and one honestly-deferred chat verb.
