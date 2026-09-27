# ADR 0313 — Activate the autonomous work loop: heartbeat default-on, executable bare todos, and visible silence

Status: implemented (P1–P3, 2026-07-07)

## Context — the investigation (verified in prod, 2026-07-07)

The app has a complete autonomous work loop — roster heartbeats picking cards
from agent-owned boards under autonomy gates (ADR 0033/0036), the schedule
daemon firing workflow jobs, the approval queue for propose-mode agents — and
in production **the kanban half of it has never executed once**. Verified:

- The schedule daemon **works**: both daemons boot on the live revision
  (`00436`, 100% traffic), `schedule fired` events dispatch continuously
  (seeded incident-triage jobs, assistant ingest loops), zero budget drops
  (`OPENWOP_AUTONOMOUS_RUN_LIMIT` default 120/hr, not approached).
- The heartbeat daemon ticks every 30s and has **never logged a pick**. Three
  compounding gates, each individually by-design:
  1. **Opt-in default-off:** `isHeartbeatDue` (`heartbeatService.ts:202`)
     requires `heartbeatIntervalMs > 0`; nothing sets it — not
     `createRosterEntry`, not the seeders (`exampleDataSeed`,
     `advisoryBoardSeed`), and the agent editor initializes the field to 0.
     Every agent is manual-"Check now"-only.
  2. **Unarmed cards are invisible:** the pick loop skips any card without
     `card.workflowId ?? column.triggerWorkflowId`
     (`heartbeatService.ts:78-80`), and `DEFAULT_COLUMNS` ships no column
     trigger — a board full of todos is, to the heartbeat, empty. (The
     ADR 0311 correction documented this; chat-filed todos are deliberately
     unbound.)
  3. **Assignment is notification-only:** `assigneeId`/`assigneeRole` drive
     the assigned rail + notifications, never execution.
- A fourth, adjacent silence: a scheduled job whose cron doesn't parse gets no
  `nextFireAt` and the daemon **skips it silently, forever** — nothing in the
  Schedules UI says so.

The product consequence: boards visibly full of work, schedules visibly
configured, and no explanation anywhere for why nothing happens.

## Decision

Three decisions. Through-line: **turn the loop on by default where that is
free, make bare work items executable only through the propose gate, and make
every remaining silence explain itself.**

### D1 — Heartbeat default-on (opt-out), host-configurable

`isHeartbeatDue` falls back to a host default cadence when
`heartbeatIntervalMs` is **absent**: `OPENWOP_HEARTBEAT_DEFAULT_MS`
(default 600 000 — 10 minutes; `0` disables the fallback host-wide). An
**explicit stored `0` remains opted out** — absent means "never configured"
(default applies), `0` means "someone chose off" (the editor writes 0 when
saved disabled, which is a real choice).

**Why this is safe to flip on existing tenants:** a heartbeat that picks
nothing is a cheap scan — runs only start when gate 2 *also* opens (an armed
card), and even then the autonomy resolver + the per-tenant autonomous-run
budget still gate. Default-on heartbeats cost ~nothing until someone arms
work, which is exactly the consent point.

### D2 — Bare todos become executable, but ONLY through the propose gate (closes ADR 0311 OQ-5)

On an **agent-owned** board, a todo-column card with no workflow binding no
longer `continue`s — it falls back to the ADR 0125/0309 chat-turn workflow
(`SCHEDULED_CHAT_TURN_WORKFLOW_ID`), with the heartbeat's `startWorkflowRun`
gaining `configurable` card context: `{ agentId, task: title + detail,
conversationId: card.sourceConversationId? }` (the agent-runner already reads
exactly these variables and posts its reply into the conversation — the
ADR 0311 P2 chain then surfaces the approval back in the originating chat).

**The safety decision — fallback picks always PROPOSE:** for the bare-card
fallback, `mustPropose` is forced true regardless of the agent's autonomy
level. Rationale: existing boards hold stale, note-like cards humans never
meant to execute; flipping D1+D2 together must not let an `auto` agent start
burning managed-key turns through an old backlog at deploy. Auto-run remains
available exactly where it is explicit today — a card (or column) with a real
`workflowId`. So: **explicit workflow = the agent's autonomy decides; bare
card = a human approves each turn.** Deliberately NOT a new autonomy level —
it composes `createApproval` + the ADR 0311 P2/P3 surfacing unchanged.

Explicit non-ship: per-card variables for *explicit-workflow* picks are
unchanged (those workflows already define their own inputs); the card-context
`configurable` rides only the fallback dispatch. Additive either way.

### D3 — Every silence explains itself

1. **Agent-board header chip:** agent-owned boards show the heartbeat state —
   "Checks every 10 min" / "Heartbeat off — enable in agent settings" (links
   to the existing `AgentDetailsEditor` field). Data already on the roster
   entry; the board knows its owner.
2. **Card hint:** an unarmed todo card on an agent board reads "runs as an
   agent turn — proposed for approval" (post-D2 truth); on a NON-agent board
   "won't auto-run — no workflow bound" (unchanged truth).
3. **Schedules no-fire warning:** a job with `enabled` but no `nextFireAt`
   (unparseable cron; NOT a spent one-shot — distinguish via `cronExpr ===
   ONE_SHOT_CRON`/`lastRunAt`) renders a "won't fire — cadence didn't parse"
   error chip in the Schedules surfaces, and `registerJob` logs it.

**Correction (P3 implementation, 2026-07-07):** two deviations from the D3
sketch above. (a) The card hint renders ONLY on agent-owned boards — a
"won't auto-run" line on every human/CRM/personal card would be pure noise
where nobody expects autonomy; on agent boards the hint reads either the
agent-turn fate or a generic "won't run on its own — see the board's
autonomy chip" (the chip owns the *why*: checks off vs no fallback). (b) The
FE never re-derives the cadence: the roster GET/PATCH responses carry a
read-time `heartbeat: {effectiveIntervalMs, agentTurnFallback}` decoration
computed by the ONE resolver (`effectiveHeartbeatIntervalMs`) — the host
default lives in an env the SPA can't see, so exposing the resolved value
was the only honest option. Never stored. Also: P3's route test exposed a
P1 gap — `updateRosterEntry` cleared the field for ANY value ≤ 0, silently
swallowing the `-1` OFF sentinel (an opted-out agent re-enrolled on its
next unrelated save); `-1` now persists, `0` still clears.

**Correction (P1 implementation, 2026-07-07):** D1's "an explicit stored `0`
remains opted out" was wrong twice over — the details editor always SENT the
field (initialized 0), so a stored 0 would have been form noise, and the PATCH
path actually CLEARS the field on 0 (test-pinned), so no stored 0s exist at
all. Implemented semantics: `0`/absent = "not configured" → the host default
applies; the explicit opt-out is the new `-1` sentinel (`HEARTBEAT_OFF`),
which the editor's "Off — manual checks only" option writes. OQ-1 decided yes:
seeded demo agents ride the same default (the budget is the ceiling).

## Boundaries audit

- All changes land on existing owners: `heartbeatService` (the one pick loop),
  `runBudgetService` (untouched — still gates), `scheduledChatTurnWorkflow`
  (the one agent-turn workflow, reused verbatim), `createApproval`/ADR 0068
  (the one propose path), the kanban + schedules FE surfaces. **No new store,
  no new daemon, no new autonomy level, no new toggle** (daemon behavior is
  host-env-configured, matching the budget envs).
- The D2 fallback deliberately reuses the exact dispatch contract ADR 0309
  froze (`{agentId, task, conversationId}` into the turn-workflow) — one
  workflow, two intakes (time-based and board-based).
- Replay/fork: heartbeat-fired runs already stamp attribution metadata; the
  card-context `configurable` is stamped at dispatch like every schedule fire.

## RFC verdict

Host-extension only (a host env default, the pick-loop fallback, FE chips).
No wire change, no RFC.

## Phased plan

| Phase | Scope | Verify |
|---|---|---|
| **P1** | `OPENWOP_HEARTBEAT_DEFAULT_MS` fallback in `isHeartbeatDue` (absent ⇒ default; explicit 0 stays off) + editor copy reflecting the default + tests (absent/0/explicit interval × due math) | backend vitest |
| **P2** | Bare-card fallback on agent-owned boards → turn-workflow dispatch with card-context `configurable`, `mustPropose` forced; the proposal carries `cardId` + `conversationId` (existing ADR 0311 chain) + tests (fallback proposes even for `auto`; explicit workflow keeps autonomy; non-agent boards unchanged; card context reaches the run) | backend vitest |
| **P3** | The three D3 surfaces (board chip · card hint · schedules no-fire chip) + i18n ×4 | FE gates + CT items |

### Phase record (all landed 2026-07-07, branch `feat/adr0313-work-loop`)

| Phase | Commit | Tests |
|---|---|---|
| P1 — host-default cadence (`OPENWOP_HEARTBEAT_DEFAULT_MS`, `-1` sentinel, editor presets) | `8505d97d` | `heartbeat-default-cadence.test.ts` (resolver ×4), `heartbeat-daemon.test.ts` ADR 0313 trio, `roster.test.ts` sentinel validation |
| P2 — bare-card fallback, always-propose, frozen `configurable` (+ review fix: the seam carries `credentialRef`, feature owns the constant) | `bf58bb0f`, `725a729c` | `heartbeat-daemon.test.ts` D2 block (propose-not-run + frozen configurable + approve→dispatch carries it + unregistered-seam skip) |
| P3 — silence UI (board cadence chip, bare-card hints, schedules won't-fire/one-shot-done chips, roster heartbeat decoration) + the `-1` persistence fix | `ab894753` | `roster.test.ts` decoration pin; FE `npm run build` + lint + vitest green |

`registerJob` unparseable-cron logging (D3 item 3, backend half) was already
present; the FE chip is the new surface.

**Correction (grade-code, 2026-07-07) — P2 was dead on arrival, now fixed.** The
D2 fallback froze `{agentId, task, credentialRef, conversationId}` onto
`PendingApproval.configurable` and `claimApproval` passed it to `startWorkflowRun`
as `configurable`. But `startWorkflowRun`→`seedRunVariables` seeds the run's
variable bag ONLY from `inputs` (the turn-workflow's node reads
`{type:'variable', variableName:'agentId'}` from that bag), so `configurable`
never reached the agent-runner and every approved fallback run failed
"agent-runner node requires an `agentId`". The P2 regression test gave a false
green because it stubbed the workflow catalog and never ran the real executor.
The SAME latent bug affected the deployed ADR 0125 scheduled-chat tick and the
ADR 0309 schedule-followup tool (both pass params via `configurable`; the
@mention/deep-investigation path correctly uses `inputs`). **Fix:**
`agentRunnerNode.resolveParams` now falls back to `ctx.configurable` after
`inputs`/`config` (a single point repairing all three dispatchers; `inputs`
still wins, so @mention is unchanged; both live on the run record →
replay-deterministic). New real regression: `agent-runner-node.test.ts` asserts
the precedence chain + that `configurable` alone resolves `agentId`.

**Activation caveat (grade-code, 2026-07-07):** the "won't surprise-execute at
deploy" guard covers only BARE fallback cards (which always propose). A card with
an EXPLICIT `card.workflowId`/`column.triggerWorkflowId` on an `auto`-autonomy
member is not a bare fallback → it auto-RUNS. So flipping
`OPENWOP_HEARTBEAT_DEFAULT_MS` from `0` to on-value enrolls every enabled member
in the host cadence, and any queued explicit-workflow To Do card on an `auto`
member begins auto-executing within one interval (bounded only by the per-tenant
autonomous-run budget). This is intended (the heartbeat's whole purpose), but the
blast radius is a deliberate operator decision — activate knowingly, or set
`auto` members to `guided`/`review` first if a queued backlog shouldn't run at
activation.

## Open questions

- **OQ-1:** should D1's default also apply to *seeded demo* agents (they'd
  start proposing against seeded boards on demo tenants)? Leaning yes — demo
  should demonstrate the loop — with the budget as the ceiling. Decide at P1.
- **OQ-2:** a "pause all autonomous work" tenant kill-switch (one env exists
  host-wide via the default=0; a per-tenant control may be wanted once
  default-on ships). Defer until asked. *(Still open post-implementation.)*
- **OQ-3:** D2 fallback for `guided` agents — proposal-always matches `review`;
  revisit only if proposal volume becomes noise (the per-card
  `hasPendingApprovalForCard` guard already prevents re-proposing).

## Falsifier

If bare-card proposals prove noisy rather than useful (humans mass-rejecting
them), the fallback should become a per-board opt-in ("work this backlog")
rather than default — the D3 chip is where that switch would live.
