# ADR 0774 — Kanban stacks: one lane vocabulary, an atomic pick, and an honest run status on the card

Status: Accepted — P1 implemented (feature-loop 2026-10 row 4); P2–P4 open

Feature-loop 2026-10 row 4 (kanban stacks / work intake). Grade evidence:
`docs/steward/WORKFLOWS-ASSESSMENT.md` § "Kanban stacks / work intake" (`KSTWF-1..14`,
opening grade **C**). Composes ADR 0025 (personal boards), 0049 (card assignment +
role claim), 0311 (commitment todos / `openwop:kanban.add-todo`), 0313 (bare-card
agent-turn fallback), 0534 (ranked work selection), 0535 (card run recovery), 0617
(tenant-scope predicate), and 0738 (WorkItem execution).

## Context

A **stack** is the half of the chains-or-stacks doctrine that sequences work: an
ordered set of cards on a kanban board that the roster heartbeat picks from To Do,
runs, and moves along. Two engines execute cards:

- the **ADR 0738 WorkItem dispatcher**, which is sound: a leased outbox, a CAS
  execution claim, a deterministic run id per attempt, and bounded retries;
- the **heartbeat pick loop** (`host/heartbeatService.ts:91-296`), which is what every
  default board, every chat-filed todo and every job-search board actually rides.

The heartbeat loop breaks the guarantees a work queue exists to keep. Every row below
was re-read by hand at `a38936ba2`:

| id | Guarantee broken | Where |
|---|---|---|
| `KSTWF-1` | A picked card leaves To Do | Heartbeat, approval dispatch and recovery look for a lane named exactly `working` (`heartbeatService.ts:278`, `approvalDecision.ts:630`, `cardRunRecovery.ts:91`). `DEFAULT_COLUMNS` is `todo / doing / done` (`kanbanService.ts:498`), used by the add-todo board (`agentToolProvider.ts:392`), the career board (`features/job-search/agent/provision.ts:81`) and user-created roster boards. So an `auto` agent re-runs the same card every interval, a review agent re-proposes it after every decision, and recovery is inert. The SPA already treats `doing` as the working lane (`frontend/react/src/kanban/laneKind.ts:14`). The server and the client disagree about the board's vocabulary. |
| `KSTWF-2` | A card is started once | The loop starts the run (`:249`) before it moves the card (`:279`), and the move is unconditional. The daemon's `claimOnce` is per member per slot. "Check now" (`routes/agentOps.ts:228`) has no claim at all. A crash between start and move leaves the card to be re-run. |
| `KSTWF-15` | One engine per card | A WorkItem card carries `workflowId` (`kanbanService.ts:1229`) and may be materialized into an agent board's To Do lane. The heartbeat never checks `workItemId`, so both engines can start it. |
| `KSTWF-3` | Completed work is not redone | A completed heartbeat run leaves the card in Working by design (`cardRunRecovery.ts:227`). Once retention deletes that run, reconcile sees a missing row and restores the card to To Do as "outcome unknown" (`:284-297`), and the next pass runs it again. |
| `KSTWF-4` | One claimer wins a role-addressed card | `POST /cards/:id/claim` checks a stale read (`routes/kanban.ts:787`) and then patches unconditionally, so both claimers get 200. |
| `KSTWF-5` | A read-only member cannot write | `authorizeBoard` (`routes/kanban.ts:154-164`) returns an agent, personal or unowned board to any caller in the tenant whatever `need` is. `POST /boards` checks nothing. A viewer can delete boards, bind a workflow and move a card into a trigger lane to start a run. |
| `KSTWF-6` | A reorder persists | `KanbanPage.tsx:655` drops the `position` argument the board view sends (`KanbanBoardView.tsx:793`). |
| `KSTWF-7` | The model is told the truth | add-todo reports `column: 'To Do'` for a deduped card that has since moved, and says a card "will not run by itself unless a workflow is bound", which ADR 0313's fallback falsified (`agentToolProvider.ts:417-422`). |

## Competitive frame

Agent task queues converged on the same three rules, and our loop breaks all three:

- **The claim is a status TYPE, not a lane name.** Linear's agent contract: when an
  agent is delegated an issue that is not yet started, it moves the issue to *the first
  status of type "started"* when it begins. Every Linear team names that status
  differently. GitHub Copilot acknowledges an assigned issue before it does any work.
  Our loop keys on the literal word `working`.
- **The run's state lives on the work item.** Linear agent sessions carry one of
  `pending / active / error / awaitingInput / complete / stale` on the issue. Copilot
  posts "finished work" and requests review on the linked PR. Our card shows a "View
  run" link and nothing about whether that run is alive, failed or finished.
- **Finishing is not closing.** Copilot finishes by asking for review, not by closing
  the issue. That is ADR 0535's existing rule ("completed is inert"), and this ADR keeps
  it. What it adds is that "finished, awaiting a human" must be durable on the card, so
  retention cannot turn it back into "never started".

Linear, Jira, Trello and GitHub Projects also offer labels, filters, a detail drawer,
comments, activity history and archive. Those are follow-up phases (P3). A queue that
double-executes is not improved by a better filter bar.

## Boundaries audit

- **Single owner.** `host/kanbanService.ts` owns boards and cards, and
  `applyBoardCommand` is the one CAS mutation for a card (ADR 0738 D2). Everything
  below routes through it: no second store, no new collection, no feature package.
  Kanban is core and untoggled, so there is no toggle and no new `ctx` surface.
- **Lane vocabulary.** There are four inline copies of "find the working lane" in the
  backend, and one canonical classifier in the SPA (`laneKind.ts`, BLD-8). The server
  gains the twin; there is no new vocabulary.
- **Tenant authority.** `requireTenantScope` / `assertTenantScope`
  (`features/featureRoute.ts:295`, `host/accessControlService.ts:1700`, ADR 0617) is the
  predicate for tenant-scoped writes with no org in the path. It short-circuits for the
  owner of a personal/anon tenant and for a wildcard operator. Reused, not re-derived.
- **Deterministic run ids.** `startWorkflowRun({ runId })` (`host/runStarter.ts:53-86`)
  is the existing internal idempotency seam. It returns the bound run on a re-presented
  id and refuses one bound to different work. The WorkItem lane already uses it.
- **Run-terminal seam.** `onAnyRunTerminal` (ADR 0535 P1) is the one place a card hears
  about a finished run.

## Decision

### D1 — One lane vocabulary: `columnLaneKind` on the server

`kanbanService.ts` exports `columnLaneKind(column)`, a byte-for-byte twin of the SPA's
classifier. It matches the id or the case-insensitive name: `todo`/"to do" → `todo`;
`working`/`doing` → `working`; `waiting…` → `waiting`; `done` → `done`. It also exports
`todoColumnOf(board)` and `workingColumnOf(board)`, each returning the first matching
column. The heartbeat, the approval dispatch, recovery and add-todo all call these; the
four inline copies are deleted.

A parity test pins the server twin to a table of cases. The SPA's file is not read
across the tree; it has the same table in its own test.

A board with a To Do lane but no working lane is **not pickable** by the heartbeat.
The pass skips it with the new reason `no_working_lane`, because a run the loop cannot
claim is a run it will start again.

### D2 — The pick is a CAS claim, made before the run starts

The heartbeat claims a card before it starts anything. `claimCardForRun` is one
`applyBoardCommand` whose new internal **precondition** requires, on the fresh read:

- the card is still in the To Do lane it was picked from; and
- the card's `version` equals the version the pass saw.

Inside that single CAS the claim moves the card to the working lane and stamps:

- `lastRunId` = a deterministic `kanban-pick-run-<hash(cardId, version)>`;
- `lastRunStatus: 'running'`.

The run then starts with that `runId`. The outcomes:

- **Two passes race** (daemon and "Check now", or two instances). Exactly one CAS
  wins; the loser sees `kanban_card_precondition_failed` and moves on to its next
  candidate.
- **The start returns null or throws.** A compensating CAS returns the card to To Do,
  guarded on `lastRunId` still being the claim's id AND the card still sitting in the
  working lane (a human who moved it meanwhile wins, `A4`), and clears the run status.
- **The process dies between claim and start.** The card sits in Working pointing at a
  run that does not exist. Reconcile (D3) restores it, but only after
  `PICK_CLAIM_GRACE_MS` (2 min) since the claim. Inside that window a peer that is
  still mid-start must not be yanked back.
- **Re-presenting the id.** If the same `(card, version)` is ever re-presented, the
  deterministic id resolves to the same run and never a second one.

A card carrying a `workItemId` is **never** a heartbeat candidate (`KSTWF-15`); the
ADR 0738 dispatcher owns it.

The approved-proposal dispatch (`approvalDecision.ts`) keeps its existing lock (the
approval CAS). It moves the card to `workingColumnOf(board)` and stamps
`lastRunStatus: 'running'`. It does not use the pick precondition, because a human
approved this card explicitly; if a human has since moved it, the run still starts and
the card stays where they put it.

### D3 — A durable run status on the card

`KanbanCard` gains `lastRunStatus?: 'running' | 'completed' | 'failed' | 'cancelled'`.
It is internal, like `lastRunId`: the public card PATCH does not accept it.

The run-terminal seam stamps the terminal status onto the card whose `lastRunId` equals
the run. This covers every card-bound run it can locate by pointer: `heartbeat`,
`approval`, and the trigger-lane `kanban` metadata. The CAS precondition is
`lastRunId === runId`, so a newer pick is never overwritten. **Restore-to-To-Do stays
exactly as ADR 0535 scoped it** (heartbeat + approval, failed/cancelled only), and
`completed` still never moves the card.

`reconcileStrandedCards` changes in two ways:

- a run row it finds `completed` gets its status stamped (the fan-out may have missed
  it);
- a **missing** run row is restored as unknown-outcome only when the card is not
  `lastRunStatus: 'completed'` and the claim is older than the grace window. A card
  whose run is gone but was recorded as completed stays where it is. That is the
  `KSTWF-3` fix.

`setCardLastRun` (used by the human trigger-lane path) records the new `lastRunId` and
clears any stale status in the same CAS, so a chip never describes a previous run.

> **Architect correction (pre-code, `A1`) — restore needs proof the LOOP put the card in
> flight.** D1 makes every `doing` lane a working lane, so reconcile now scans lanes
> that humans also use, and those lanes hold cards with a `lastRunId` from a trigger-lane
> run or from a run older than this ADR's stamp. As first written, D3 would restore any
> of them whose run row is gone and the heartbeat would execute it again: `KSTWF-3`
> re-opened at a wider blast radius, and on the first pass after deploy for every
> legacy card. So reconcile acts ONLY on loop-owned cards:
> - a **present** run is restored only if its `run.metadata` pointer (`heartbeat` /
>   `approval`) names this card, the same proof the terminal handler already demands;
> - a **missing** run is restored only if the card carries `lastRunStatus: 'running'`,
>   which only the pick claim (D2) and the approval dispatch write, and only after the
>   grace window.
>
> A legacy card with no status and no run row is left where it is, with a log line.
> Nothing loop-owned predates the stamp, because the stamp ships with the claim.
>
> **A trigger-lane run that finishes before the route records it** (`setCardLastRun`
> runs after `deliver`) has its terminal stamp refused by the `lastRunId` guard, so
> that card shows no chip rather than a wrong one. This is accepted; P2 moves the
> record inside the delivery.

### D4 — Preconditioned role claim

`POST /cards/:id/claim` runs one `applyBoardCommand` whose precondition is "still
role-addressed and unclaimed" on the fresh read. The loser gets **409**
`conflict` ("Someone else claimed this task"), never a silent overwrite.

The precondition is an **internal** command field: a function the service evaluates
inside the CAS loop. No route accepts it, so it cannot widen what a request may do.

### D5 — Tenant write authority on legacy boards

When `authorizeBoard` is reached for a **write** on a board that is not org- or
project-scoped, and the board is in the caller's active tenant, the caller must pass
`requireTenantScope(req, 'workspace:write')`.

- An **implicit personal/anon owner** passes, as does a **wildcard operator**.
- A **shared-workspace member** passes only with the scope.
- The **personal-owner cross-workspace branch** (ADR 0025) is unchanged: it applies to
  the board's own `ownerUserId`, and that board's tenant is the owner's personal
  tenant.
- A read-only member gets **403 `forbidden_scope`**. The board is readable to them, so
  a 404 would lie about existence.

> **Architect correction (pre-code, `A2`) — `requireTenantScope` would lock out every
> scoped credential.** It resolves authority from `callerSubject(req)`, and neither an
> `OPENWOP_API_KEYS` entry (`bearer:<8>`) nor an `owk_` key (`apikey:<id>`) is an RBAC
> subject (ADR 0601 C3). So a CLI `openwop kanban` call with a tenant-scoped key, which
> writes today, would 403. The check instead composes the provenance classifier
> `credentialAuthority` (`host/protocolAuthorization.ts:171`):
> - `env-key` → the tenant's own principal (operator-configured, not member-mintable):
>   allowed;
> - `api-key` → the ISSUER's current scopes via `assertTenantScope(tenant, issuer, …)`,
>   AND the key's declared scopes must permit `workspace:write` (`keyDeclarationPermits`);
> - otherwise → `assertTenantScope` with the caller's subject.
>
> The wildcard operator and the implicit personal owner short-circuit exactly as
> before. `requireTenantScope` itself is NOT changed: widening it for env keys would
> move BYOK and governance too, which is out of this ADR's scope. The composition is a
> small helper in `routes/kanban.ts` and calls only shared primitives.

`authorizeCard` still tries the ADR 0049 assignee carve-out before surfacing that 403,
so an assignee without write scope can still progress their own card.
`POST /boards` requires the same scope. The refuse side is pinned by route tests: a
viewer's create, delete, card PATCH and trigger move are each refused, and no run is
started.

### D6 — The SPA forwards position, and shows the run status

- `KanbanPage.tsx` forwards the `position` argument (`KSTWF-6`).
- The board card renders `lastRunStatus` as a status chip beside "View run": *Agent
  working* / *Finished — needs review* / *Run failed* / *Run cancelled*. It uses the
  existing chip tone mapping, adds i18n keys in all four locales, and has no raw
  colors.
- `kanbanClient.ts` adds the optional field to `KanbanCard`.
- No `client/**` file changes.

### D7 — An honest add-todo receipt

add-todo reads the card before it files one. The receipt then reports:

- `alreadyFiled: true` when the deterministic id already existed;
- the card's **actual** column name, never a hard-coded `To Do`.

The note is also corrected: the agent's heartbeat may pick the card up, and it will ask
for approval before running a bare todo. The tool id, schema and allowlist posture are
unchanged, so `agent-prompt-tool-ids` is unaffected.

## RFC verdict

**Host extension, no RFC.** Every change sits under `/v1/host/openwop-app/kanban/*` or
in-process host code.

- `lastRunStatus` is a host card field, not a run-event field.
- Deterministic run ids already exist as an internal seam.
- Run metadata keys are unchanged, so `:fork` replays the original pick exactly as ADR
  0534 D3 requires.
- No capability is advertised.

## Phases

| Phase | Scope | Status |
|---|---|---|
| P1 | D1–D7 (`KSTWF-1..7`, `KSTWF-15`), with route- and service-level witnesses on a DEFAULT-column board: two passes, a race, a missing-run-after-completion, a viewer refuse matrix, a claim race | this PR |
| P2 | Grade residue: `KSCD-8` (route witnesses for the env-key and `owk_` lanes of the write gate), `KSCD-9` (check the budget before claiming, so a refused start does not churn the card), `KSCD-11` (a claim timestamp for the grace window), `KSCD-12` (decide whether the kanban gate should use the member-only union), `KSCD-13`; and queue hygiene: an attempt cap on heartbeat cards with a Blocked disposition (`KSTWF-8`); "Check now" gated to roster writers and counted against the autonomous run budget (`KSTWF-9`); trigger-bridge dedup keyed per entry rather than 24 h, and dead-letter recovery (`KSTWF-10`); `POST /boards` column validation (`KSTWF-13`); CAS for rename, WIP limit and erasure, plus a client `If-Match` on card PATCH (`KSTWF-14`) | open |
| P3 | UX residue `KSUX-6..11` (409 copy, trigger-lane chip lifecycle, second-drag desync, run-link names, keyboard in-lane position, a titled status-change announcement); parity with Linear, Jira, Trello and GitHub Projects: labels + estimate UI (fields exist server-side), filter/search bar, card detail drawer with comments (compose ADR 0021 comments) and activity history, archive-not-delete, conflict-specific 409 copy (needs a `client/**` change) | open |
| P4 | One engine: file add-todo intake as ADR 0738 WorkItems and retire the heartbeat's own run-start path (`KSTWF-11`); purge kanban on anonymous-tenant teardown (`KSTWF-12`) | open |

## Alternatives weighed

- **Add a `working` lane to `DEFAULT_COLUMNS`.** Rejected. It fixes only new boards,
  leaves every existing `doing` board broken, and forks the vocabulary from the SPA's
  classifier again.
- **Claim by moving the card after the start, but check `lastRunId` for an in-flight
  run.** Rejected. It costs a `getRun` per candidate on the hot path ADR 0534 D5
  budgets against, and it still races, because the check and the start are not atomic.
- **Auto-move a completed run's card to Done.** Rejected. It contradicts ADR 0535 D4
  and the competitive rule that finishing asks for review. The status chip carries
  "finished" without closing anything.
- **404 instead of 403 for a viewer's write.** Rejected. The board is visible to them,
  so a 404 misreports it as missing and hides the actual fix ("ask for write access").
- **Route all heartbeat work through WorkItems now.** This is the right end state (P4),
  but it changes the intake contract of ADR 0311 and 0313 and every agent board. It is
  too large to land alongside the Blockers it would otherwise gate.

## Architect pass (pre-code, 2026-09-28)

Track A, run against the decision text before any code. Two Blockers and two
Improvements, all folded in above:

| id | Sev | Finding | Fold |
|---|---|---|---|
| `A1` | Blocker | D1 + D3 as written would re-execute legacy and human-lane cards whose run row is gone | reconcile acts only on loop-owned cards (see the D3 correction) |
| `A2` | Blocker | D5 via `requireTenantScope` 403s every scoped env key and `owk_` key, including the CLI's kanban commands | provenance-aware composition (see the D5 correction) |
| `A3` | Improvement | The approval dispatch still resolves the approval before it moves the card, so a pass in that window can re-propose | pre-existing; D1 at least makes the move land. Tracked in P2 |
| `A4` | Improvement | The compensating CAS could yank a card a human had moved | guard on the working lane too (D2) |

Verified clean: deterministic pick ids never collide, because the claim, the
compensation and a restore each bump `version`. A fork gets a fresh run id, so the
`lastRunId` guard makes a forked run inert toward the card. The new heartbeat reason
has no client consumer (`no_eligible_tasks` and its siblings are read nowhere outside
`heartbeatService.ts`).

## Open questions

- [ ] Should `no_working_lane` surface on the board header ("this board has no
  in-progress lane, so the agent will not pick from it")? P1 reports it only in the
  heartbeat result and the "Check now" response.
- [ ] Should the grace window be tied to the dispatch lease (ADR 0585) rather than a
  constant? P1 uses a constant 2 min, which is far above any observed start latency.

## Implementation record (P1)

| Decision | Commit | Witness (each sabotaged red before merge) |
|---|---|---|
| D1 lane vocabulary, `no_working_lane` | `da6c6e4e0`, `21f0fda24` | `test/kanban-stack-claim-heartbeat.test.ts` (the case table, the default-board pick, the two-lane refusal, the KSCD-10 cause); the same table in `frontend/react/src/kanban/__tests__/laneKind.test.ts` |
| D2 CAS claim + deterministic id + release; WorkItem skip | `da6c6e4e0`, `21f0fda24` | the three-way concurrent pass (exactly one run), the unresolvable-start release, the WorkItem skip, KSCD-2 |
| D3 durable run status; loop-owned restore (A1) | `da6c6e4e0`, `21f0fda24` | completed-then-retained (no re-queue), failed restore, the grace window, the legacy card, the KSCD-1 stale-snapshot restore; `test/card-run-recovery*.test.ts` updated to the new contract |
| D4 preconditioned role claim | `da6c6e4e0`, `21f0fda24` | the service precondition test, the route race, KSCD-4 |
| D5 tenant write authority (A2) | `da6c6e4e0`, `21f0fda24` | `test/kanban-stack-claim-routes.test.ts`: the viewer refuse matrix (7 writes, no run), editor, personal owner, the assignee carve-out, KSCD-3 |
| D6 SPA position + chip | `da6c6e4e0`, `21f0fda24` | `movePositionForwarded.test.tsx`, `runStatusChip.test.tsx` |
| D7 honest add-todo receipt | `da6c6e4e0` | `test/kanban-add-todo-tool.test.ts` (dedupe reports the actual column) |
| approval dispatch as one CAS (KSCD-5) | `21f0fda24` | the approve-then-no-re-propose test, and "a card a human moved stays put" |

> **Grade correction (post-implementation).** The grade-code pass found a Blocker in
> this ADR's first cut. D3's restores kept ADR 0535's snapshot-then-`moveCard` shape,
> so a stale reconcile could undo a fresh D2 claim and cause the double execution D2
> exists to prevent (`KSCD-1`). The claim was atomic; its inverse was not. Both
> restores now share the claim release's precondition.
>
> Two D-texts are corrected to match the code:
> - **D5.** The personal-tenant allowance is **ownership** (`isOwnPersonalWorkspace`),
>   not the tenant's shape (`KSCD-3`).
> - **D4.** On a legacy board, a claim additionally needs the addressed role or
>   `workspace:write` (`KSCD-4`), because a claim confers the assignee carve-out.
>
> **Identity spellings (lead review, `21f0fda24` → next commit).** One person has two
> spellings here: an unbound OIDC bearer presents `oidc:<sub>`, and the canonical id is
> `user:<userId>`. MEASURED: both key real memberships. A shared workspace created by
> an unbound caller records its owner as `oidc:<sub>`, while personal owners are keyed
> `user:<id>`. So D5 and the D4 role check judge a person by the UNION of both spellings,
> resolving the canonical one exactly as `requireOrgScope` does.
>
> A canonical-only check locked that owner out of their own workspace's boards. That
> check is sabotaged red in `test/kanban-stack-write-oidc-identity.test.ts`. The case of
> a canonical-keyed member arriving unbound is defensive only: the workspace switch
> refuses that caller, so it cannot reach a shared tenant over HTTP.
>
> Grade-ux found that the D6 chip shipped as a per-card live region, and still said
> "needs review" after the card was moved on (`KSUX-1/2`). Both are fixed.
