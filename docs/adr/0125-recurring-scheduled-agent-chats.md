# ADR 0125 — Recurring / scheduled agent chat runs (B16)

**Status:** in-progress — **Phase 1 implemented** (2026-06-24): the config entity + scheduler binding. `features/scheduled-agent-chats/` — `ScheduledChat` CRUD (DurableCollection); create → ONE `registerJob` on the EXISTING scheduler (no parallel scheduler) with `configurable:{agentId,prompt,conversationId}`; pause → `setJobEnabled`; delete → `deleteJob`. Routes `/scheduled-chats/orgs/:orgId/chats` (authorizeOrgScope, IDOR-404), toggle OFF/tenant. Horizon-refusal rolls the config back. Phases 2–4 (tick→chat-turn dispatch, frontend, fire-once/replay tests) pending. **Date:** 2026-06-23
**Toggle:** `scheduled-agent-chats` · default **OFF** · `bucketUnit: tenant` (a B2B automation surface — digests, monitors). When OFF, every route/surface here is inert (the standard `requireEnabled` 404 gate).
**Surface:** host-extension `/v1/host/openwop-app/scheduled-chats/*` (non-normative) — a small config entity binding an agent + a cadence + a prompt to a conversation. No new wire contract. The recurring tick **enqueues a chat-turn run through the existing scheduler daemon**; run history surfaces in the bound conversation.
**Depends on / composes (all implemented — this is assembly):** ADR 0025 (roster schedules / user-agent orchestration — `schedulingService.ts`, `ScheduledJob`), the **scheduler daemon** (`host/scheduleDaemon.ts` — `claimIdempotency` fire-once, RFC 0052), ADR 0089 (chat-driven agent tool loop — a scheduled turn runs the agent's loop), ADR 0103 (priority-schedule-status — the priority-`ScheduledJob` precedent for status/health surfacing), ADR 0067 (conversation-run dispatch), ADR 0043 (persistent conversations — the run history lands in a durable session), ADR 0031 (`agentProfile` — autonomy + replay stamp).
**RFC verdict:** **host-extension — NO new RFC.** A scheduled chat is host orchestration over the existing scheduler + conversation + agent-dispatch seams; no run-event field, capability flag, event type, endpoint contract, or normative MUST. (`docs/research/...` §9 B16: "*RFC:* none (host orchestration).")

> **Origin.** `docs/research/2026-06-23-ai-chat-competitive-analysis.md` §9 (B16, P2, MEDIUM) + §11 (Open WebUI / LobeHub / AnythingLLM → "Enhance (B16)"; OpenWOP "Partially exists — roster schedules + ADR 0089"). Competitor impl paths: Open WebUI **Automations** (Mature) — RRULE timezone-aware scheduler, atomic claim `FOR UPDATE SKIP LOCKED`, execution history (`models/automations.py`, `utils/automations.py`, `src/lib/components/automations/`); LobeHub **Fleet** 24/7 scheduler; AnythingLLM **Scheduled jobs (cron agents)** — cron-scheduled agent runs w/ preset prompt + tools + run history (`server/models/scheduledJob.js`). The gap: OpenWOP has roster schedules + nested agentic run, but **not recurring CHAT runs** (a cadence that produces a conversation turn + run history — a digest / monitor).

---

## Context — boundaries audit first (MANDATORY)

The naïve build is "an automations subsystem with its own RRULE evaluator, its own job queue, its own atomic claim, its own run history." **OpenWOP already has every one of those** — the scheduler daemon's whole point is fire-once-across-the-fleet cron dispatch, and ADR 0107 Phase-3b is the recorded lesson that even a *focused* parallel poller is a smell to avoid where the real scheduler fits. The naïve build is the [[no-parallel-architecture]] violation four times over.

| Concern | Existing owner (file:line) | How scheduled-chat reuses it |
|---|---|---|
| Cron/cadence + next-fire | `host/schedulingService.ts` — `ScheduledJob.cronExpr` + `timezone` (`:49`,`:82`), `computeNextFire` (`cronSchedule.ts`), `registerJob`/`updateJob`/`markJobFired` | A scheduled chat **is** a `ScheduledJob` whose bound workflow is the agent-mention/chat-turn workflow. No new cadence model. (Open WebUI's RRULE → our `cronExpr`+`timezone`; if RRULE-richness is ever needed it's an additive `cronSchedule` enhancement, not a new scheduler.) |
| Fire-once across the fleet | `host/scheduleDaemon.ts` — `claimIdempotency(key=(jobId,nextFireAt-slot))` (`:12-21`), missed-window collapse (`:22-25`), `FIRE_BATCH` backstop | **Reused verbatim.** This is *exactly* Open WebUI's `FOR UPDATE SKIP LOCKED` atomic claim — OpenWOP already has it. **Do NOT build a second poller** (the ADR 0107 Phase-3b correction: even a focused cadence daemon was a deliberated exception; here the *real* scheduler fits, so use it). |
| Starting a run from a tick | `scheduleDaemon` → `host/runStarter.ts` `startWorkflowRun` (the same recipe "Run now" uses, `:7-9` doc) | A due scheduled-chat job starts a **chat-turn run** for the agent via the same run-starter — replay/fork/observability inherited. |
| The agent's reply (with tools) | ADR 0089 — `runChatToolLoop` / the gated `runAgentDispatchLive`; the synthetic `openwop-app.agent-mention` workflow + the `local.openwop-app.agent-runner` node (ADR 0089 Phase 4) | A scheduled tick dispatches **the same agent-mention workflow** that an interactive @mention does — a recurring tick is just a non-interactive trigger of the existing path. No second agent runtime. |
| The conversation it posts to | ADR 0043 persistent conversations + ADR 0067 conversation-run | Each scheduled run **appends its turn to a bound durable conversation** (a per-schedule "Daily digest" session), so run history surfaces where the user reads it — no new transcript store. |
| Run budget / autonomy | `host/runBudgetService.ts` (`checkAutonomousRunBudget`, wired in `scheduleDaemon`) + ADR 0031 autonomy mapping | Reused — a scheduled chat is an autonomous run, already budget-gated by the daemon. |
| Status / health surfacing | ADR 0103 priority-`ScheduledJob` overlay precedent (last-run state, ahead/behind) | The schedule list shows last-run status/error the same way (`recordJobRun` already stores `runId`). |

**Net new (small):** one `ScheduledChat` config entity (agent + cadence + prompt + bound conversation), the routes under `/v1/host/openwop-app/scheduled-chats/*`, a thin **binding** that registers a `ScheduledJob` whose workflow is the agent-mention/chat-turn workflow targeting the bound conversation, and the UI to create/list/pause one. Everything that actually *runs* — the poll, the atomic claim, the run-start, the agent tool loop, the conversation append — already exists.

---

## Decision

Ship a **`scheduled-agent-chats` feature-package** that binds an **agent + a cron cadence + a prompt + a target conversation**, and registers it as a **`ScheduledJob` (ADR 0025) fired by the existing scheduler daemon**. Each due tick starts a **chat-turn run** that dispatches the agent's mention/tool-loop (ADR 0089) and **appends the turn to the bound durable conversation** (ADR 0043/0067), so the cadence produces an ongoing conversation + first-class run history (digests, monitors). **Reuse the scheduler daemon — never a new job queue or poller** (the ADR 0107 Phase-3b lesson). The run is the state machine; autonomy/budget/replay all ride it.

### Data model — one config entity over the existing scheduler

```ts
ScheduledChat                         // tenant/org-scoped config
  { id, tenantId, orgId?,
    agentId,                          // the roster/definition agent to run on cadence (ADR 0031)
    cronExpr, timezone,               // → registered as a ScheduledJob (schedulingService)
    prompt,                           // the recurring turn's instruction ("Summarize today's …")
    conversationId,                   // the bound durable conversation the turn appends to (ADR 0043)
    scheduledJobId,                   // → the backing ScheduledJob (the SINGLE source of cadence truth)
    status,                           // active | paused | error
    lastRunId?, lastRunAt?, lastError?,
    createdBy, createdAt, updatedAt }
```

`cronExpr`/`timezone` are **not** a second cadence store — they are the inputs to `registerJob`; `scheduledJobId` is the live owner of next-fire (single-source-of-truth, the ADR 0031 "schedules stay owned by the scheduler" discipline). Pausing the `ScheduledChat` calls `setJobEnabled(false)`.

### The scheduled run (NOT a new queue)

1. **Tick** — `scheduleDaemon` finds the due `ScheduledJob`, wins the `claimIdempotency` lease (fire-once across the fleet), and `startWorkflowRun` the bound **agent-mention/chat-turn workflow** with `{ agentId, prompt, conversationId }` configurable.
2. **Dispatch** — the run enters the gated `runAgentDispatchLive` / `runChatToolLoop` (ADR 0089) — the agent's tool loop runs exactly as an interactive @mention.
3. **Append** — the resulting turn is recorded onto the bound conversation (a `conversation.exchanged` turn, ADR 0067), so the digest appears in the user's chat thread.
4. **Record** — `recordJobRun(jobId, runId)` + `ScheduledChat.{lastRunId,lastRunAt,lastError}` for the status surface.

### Replay / fork

The scheduled run **stamps its decision-bearing inputs into `run.metadata` at creation** — the `agentId`, the resolved autonomy/`withinPolicyActions` (ADR 0031 invariant: autonomy is read from the persisted profile and stamped at creation), the prompt, the `conversationId`, and the schedule attribution block (`run.metadata.schedule`, already stamped by the daemon, `runStarter.ts:46`). **`:fork` reads them verbatim** and never recomputes the cadence or re-resolves a since-edited profile. The agent's reply is live (recorded as the turn); replay reads the recorded turn and never re-runs the tools (ADR 0089 §Q4). A scheduled run carries **no `actingUserId`** (system-fired) ⇒ org/user Connections fail closed (ADR 0024 §4 correction) — a digest agent uses workspace/managed credentials, the existing scheduled-run posture.

### RBAC & isolation

Creating/editing a `ScheduledChat` = `workspace:write` in the org + the right to drive that agent (the agent must be in the tenant's roster); the bound conversation must be writable by the creator. The scheduled run is **tenant-trusted, system-fired** (the existing scheduled-run trust boundary, ADR 0024 §4 correction — reserved metadata keys stripped, no `actingUserId` spoofing). Uniform 404 on insufficient scope. Autonomy is enforced by the profile mapping (ADR 0031): a `review`-level agent's scheduled picks queue for approval rather than auto-sending.

---

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (0001) | `features/scheduled-agent-chats/` — config entity + routes + the scheduler binding + UI. features→core only; no core scheduler edits (it already exposes `registerJob`/`setJobEnabled`). |
| 2 | Toggle + admin UI | `scheduled-agent-chats` toggle, OFF default, `bucketUnit:'tenant'`; standard `requireEnabled` 404 gate; managed in the existing feature-toggle admin. |
| 3 | Workflow surface (0014) | None new — reuses the ADR 0089 synthetic agent-mention/chat-turn workflow as the bound workflow. |
| 4 | Node pack | None new — the agent's existing tool allowlist runs (ADR 0089). |
| 5 | AI-chat envelopes | Inherits ADR 0067 conversation dispatch; the scheduled turn is an ordinary recorded conversation turn. |
| 6 | Agent pack | None new — binds an existing roster agent; capability stays core ([[agent-capability-core-not-named]]). |
| 7 | Public surface | None. Authed config + a system-fired run. |
| 8 | RBAC + isolation (0006) | `workspace:write` to manage; agent-in-roster + conversation-writable checks; tenant/org scoping; uniform-404 IDOR; system-fired run trust boundary (ADR 0024 §4). |
| 9 | Replay / fork safety | `agentId`+autonomy+prompt+`conversationId`+schedule attribution stamped in `run.metadata` at creation (ADR 0031), read verbatim on `:fork`; live reply recorded as the turn, never re-run (ADR 0089 §Q4). |
| 10 | Frontend | A "Scheduled chats" surface (on the agent / conversation page): create (agent + cadence + prompt + target conversation), list with last-run status/error + next-fire, pause/resume/remove; status→chip via `ui/`, tokens/a11y, light+dark. |

---

## Phased plan

1. **Config entity + the scheduler binding.** `features/scheduled-agent-chats/`: `ScheduledChat` CRUD (`DurableCollection`), and on create → `registerJob({cronExpr,timezone,workflowId:agent-mention, configurable:{agentId,prompt,conversationId}})`; pause → `setJobEnabled`. Routes `/v1/host/openwop-app/scheduled-chats/*`, toggle OFF/tenant, RBAC + IDOR-404. Tests: create registers exactly one `ScheduledJob`; pause disables it; delete deregisters.
2. **The scheduled tick → chat turn.** Confirm `scheduleDaemon` firing the agent-mention workflow with the configurable lands a turn on the bound conversation (ADR 0067/0089). Stamp the decision-bearing `run.metadata`. Record `lastRunId`/`lastError`. Tests: a due job fires once across two daemon instances (the existing `claimIdempotency` test pattern); the turn appears on the conversation; replay reads the stamped metadata.
3. **Frontend.** The "Scheduled chats" surface + last-run status chip + next-fire display; `/ux-review`.
4. **Tests + docs.** Fire-once, missed-window collapse (inherited), autonomy-gating (a `review` agent's scheduled pick queues), org/user-credential fail-closed for a system run, replay/fork stamp.

## Alternatives weighed

1. **A bespoke automations subsystem with its own RRULE + atomic claim (Open WebUI `FOR UPDATE SKIP LOCKED`).** Rejected — `scheduleDaemon`'s `claimIdempotency` fire-once IS that mechanism (`scheduleDaemon.ts:12-21`); a second one is the [[no-parallel-architecture]] / ADR 0107 Phase-3b violation.
2. **A focused per-feature poller (the ADR 0107 Phase-3b exception).** Rejected here — that exception existed because the scheduler fires *workflows* and a KB sync wanted a non-workflow cadence; a scheduled chat **is** a workflow run (the agent-mention workflow), so the real scheduler fits with zero impedance. Use it.
3. **RRULE instead of cron.** Cron + IANA timezone (`schedulingService`) covers digests/monitors. If a user needs true RRULE (e.g. "2nd Tuesday"), that's an additive `cronSchedule.ts` enhancement — not a new scheduler. (OQ-1.)
4. **A new run-per-turn outside any conversation.** Rejected — binding to a durable conversation (ADR 0043) is what makes the digest *readable* and gives free history; an orphan run is a worse UX and a second transcript.

## Open questions

1. **OQ-1 — RRULE richness.** Cron+timezone v1; RRULE ("2nd Tuesday", end-of-month) as an additive `computeNextFire` enhancement if demand appears.
2. **OQ-2 — One conversation per schedule, or per fire?** Lean: one **durable** conversation per schedule (a rolling "Daily digest" thread) so history accretes; a per-fire fresh conversation is a config option.
3. **OQ-3 — Credentials for a system run.** A scheduled chat has no `actingUserId`, so org/user Connections fail closed (ADR 0024 §4). A digest agent uses managed/workspace credentials; if a schedule needs a specific human's connection, the design needs an explicit "run as <user>" attribution — deferred (the confused-deputy tripwire).
4. **OQ-4 — Catch-up vs collapse.** The daemon collapses a missed backlog to one recovery run (`scheduleDaemon.ts:22-25`). For a "send the digest I missed" case, confirm collapse is the right default (it is for monitors; a digest may want skip-if-stale). Lean: collapse, with a per-schedule `skipIfMissed`.
5. **OQ-5 — Notification on completion.** Should a finished scheduled chat raise an ADR 0050 notification ("Your daily digest is ready")? Compose, don't build — out of scope v1, an easy follow-on.

## RFC verdict (Step 5)

**Host-extension — NO new RFC.** This is host orchestration assembling Accepted/implemented seams: the scheduler daemon (RFC 0052), conversation-run dispatch (ADR 0067 over already-advertised `conversationPrimitive`), and the agent tool loop (ADR 0089, agent.* = RFC 0064). The `ScheduledChat` config + routes are non-normative under `/v1/host/openwop-app/*`; no run-event field, capability flag, event type, endpoint contract, or normative MUST is added. (Only a future *cross-host* "scheduled conversation" advertisement would touch the wire — out of scope, RFC-gated then.)

> **Phase 2 (2026-06-24) — fire-ability:** `createScheduledChat` now threads an optional `workflowId`; the scheduler daemon only dispatches jobs that carry one, so the job registers ENABLED only when a turn-workflow is wired (else INERT-but-visible — no silently-broken enabled-yet-never-fires job). The turn-workflow itself (an agent-run node that posts `prompt` to `conversationId` as `agentId`) is the remaining Phase 2b deliverable; until it exists, an operator supplies their own workflowId.

> **Phase 3a (2026-06-24) — FE client:** `scheduledChatsClient.ts` — list/create/delete recurring agent chats for the scheduled-chats admin panel. The panel component is Phase 3b.

> **Phase 3b (2026-06-24) — admin panel:** `features/scheduled-chats/ScheduledChatsPage.tsx` (+ routes + i18n×4 + a component test), registered under the Workspace nav (`featureId: scheduled-agent-chats`). Lists agent · cron · active/inert (labeled StatusBadge) with a delete action via the canonical `confirm` (no window.confirm); all states; toggle-gated. /architect GO (reviewed admin-page precedent), /code-review + /ux-review clean (incl. §5.3 status-as-label + §11 confirm).

> **Phase 2b (turn-workflow + firing) implemented** (2026-06-24):** a scheduled chat now FIRES. A built-in turn-workflow `openwop-app.scheduled-chat.turn` (a single ADR-0089 `agent-runner` node) is registered at feature boot (idempotent seed, reusing `registerWorkflow`). `createScheduledChat` DEFAULTS `workflowId` to it (an explicit operator workflowId still overrides) — **correction to Phase 1's inert-until-wired stance**, now that the turn-workflow exists. The job `configurable` maps `task=prompt` + `credentialRef='managed:openwop-free'`, so on tick the daemon (claimIdempotency fire-once) runs the turn-workflow → the agent-runner dispatches `agentId` on the prompt using the HOST-OWNED managed key (no user/BYOK at the autonomous tick — the same boundary as the widget) → the reply is recorded in the run. Reuses the existing scheduler + agent-runner + managed provider (NO parallel scheduler/dispatch/run model). /architect GO (security focus — managed-key-autonomous-dispatch never reaches a user BYOK; claimIdempotency + live-once agent-runner = fire-once, no double-charge; default-workflowId is the right Phase-2 call). /code-review clean. 6 service+seed tests (default+configurable+managed key; explicit override; the turn-workflow shape; CRUD). Surfacing the reply AS a turn in the bound conversation (the `conversationId` projection) is Phase 2c/3.

> **Phase 2b wiring correction** (2026-06-24):** the built-in turn-workflow def shipped without node-input mapping, so `agent-runner.resolveParams` (which reads NODE INPUTS, not the run configurable directly) saw no `agentId` and the run would fail ("requires an agentId"). Fixed: the def now maps `agentId`/`task`/`credentialRef` from run variables onto the node inputs + declares those `variables` — mirroring the ADR-0089 @mention workflow. A strengthened test asserts the mapping (guards the defect). The tick's `configurable` populates the run variables → the node inputs → the agent dispatch. /architect (the original Phase-2b review covers the seam; this corrects the def to the verified @mention shape), /code-review clean.

> **Phase 2c (conversation projection) implemented** (2026-06-24):** the fired scheduled run's reply now surfaces AS an `assistant` turn in the bound conversation. /architect options-eval chose **Option A** (extend the agent-runner) over a generic daemon post-fire seam (YAGNI — one consumer) or a new conversation-post node: when the run TARGETS a conversation (the tick passes `conversationId`; the @mention path does NOT, so it's unaffected — confirmed by the deep-investigation + exchange regressions), the agent-runner `appendChatMessage(conversationId, reply, role:'assistant', authorSubject:agentRef(agentId))`. Hardened: a DETERMINISTIC `sched:<runId>` messageId (idempotent — a re-run can't duplicate the turn) + a try/catch (BEST-EFFORT — a conversation-write failure never fails the produced turn). Replay-safe (the node runs live-once → appends once; fork returns cached). The turn-workflow def maps `conversationId` (variable + node input). /code-review clean. 6 scheduled-chat tests (incl. the conversationId-wiring guard) + @mention/exchange regressions green. ADR 0125 is now functional end-to-end (tick → agent run → reply in the conversation).

> **Phase 3c (schedule status) implemented** (2026-06-24):** the ScheduledChatsPage now shows each schedule's **Next run** — `listScheduledChatsWithStatus` joins the scheduler job's `nextFireAt`/`lastRunAt` (the scheduler is the single owner of fire timing; no parallel schedule state) into the list response, and the page renders a Next-run column via the shared `formatDateTime` (NOT raw toLocaleString — the check-i18n formatting gate). /architect (inline — joins the existing scheduler getJob; no new state), /code-review + /ux-review clean (shared formatter, i18n×4, no hex). 1 backend test (the status join surfaces nextRunAt) + the page builds green. ADR 0125 is now substantially complete (config + firing + conversation projection + status); only broader fire-once/replay tests (Phase 4) remain.

> **Phase 4 (fire-once/replay test) implemented** (2026-06-24):** an end-to-end integration test (`scheduled-chat-firing.test.ts`) drives a created scheduled chat through the EXISTING scheduler daemon (`processDueSchedules`): the due tick dispatches exactly ONE run of the turn-workflow, and a second tick in the same slot does NOT re-fire (the job advanced nextFireAt on the first fire). Generic claim-dedup/missed-window/disabled are already covered by schedule-daemon.test.ts; this guards the scheduled-chat path specifically (no parallel scheduler). /code-review clean (test-only, backend). ADR 0125 is now COMPLETE (config + firing + conversation projection + schedule status + fire-once test).
