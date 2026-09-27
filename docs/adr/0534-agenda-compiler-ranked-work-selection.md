# ADR 0534 — ranked work selection: the agent picks the most important card, not the oldest

Status: implemented (P0–P5, 2026-08-09)

Feature id: `work-selection` · Toggle: `work-selection` (default **OFF**) · Bucket: `tenant`
Packs: `feature.work-selection.nodes` (read-only) · agents: **none** (see matrix row 6)

Composes: [ADR 0313](0313-activate-the-autonomous-work-loop.md) (the work loop),
[ADR 0318](0318-heartbeat-admin-settings.md) (the fill-a-seam precedent this follows),
[ADR 0311](0311-agent-commitment-todos-conversation-approvals.md) (how todos arrive),
[ADR 0049](0049-kanban-card-assignment-to-people.md) (card assignment fields),
[ADR 0099](0099-tool-output-compaction.md) (`registerRunStartContributor` — introduced there
alongside the compaction seam; see `ARCHITECTURE.md` § Existing extension seams).
Sibling: [ADR 0535](0535-work-item-lease-stranded-card-recovery.md) (what happens after the pick).

## Context

The autonomous work loop decides what a named agent works on next. Measured, that decision
is **strictly oldest-filed-first**:

| Evidence | `file:line` |
|---|---|
| Card order is insertion order — append to end, never re-sorted | `host/kanbanService.ts:470` (`order: siblings.length` on create) and `:607` (same on move) |
| Listing sorts by column then insertion order only | `host/kanbanService.ts:380` — `.sort((a,b) => a.columnId.localeCompare(b.columnId) \|\| a.order - b.order)` |
| The loop takes the **first** runnable card in that order | `host/heartbeatService.ts:80-95` — `for (const card of cards) { … continue }`, returning on the first pick |
| `card.priority` exists but is **never** consulted for ordering | declared `host/kanbanService.ts:94`; its only read is the guided-autonomy propose split at `host/heartbeatService.ts:158` (`policy.verdict === 'guided' && card.priority === 'high'`) — a decision about *whether to ask a human*, not about *what to pick* |
| No priority-aware sort anywhere | grep for `priority` near `sort`/`order` in `kanbanService.ts` + `kanbanSurface.ts` — **no matches** |

So a card marked `high`, filed this morning, waits behind every `low` card filed since the
board was created. `dueAt` (`kanbanService.ts:96`) is likewise inert for selection: an
overdue task does not advance. The one signal the loop *does* honor — priority — it honors
only to decide whether to bother a human, which is close to backwards.

This is not a bug in `heartbeatService`; it is an absent policy layer. FIFO was the correct
first implementation (ADR 0313 shipped the loop; ordering was out of scope). It becomes
load-bearing the moment a board holds more work than the loop can clear in a cadence — the
steady state for any real workspace.

The useful prior art here recompiles a **ranked agenda** server-side on every cycle from live domain state, with the ranking as a *pure, unit-tested
function* over a constants table (a pure build function over a constants table). Eight test files cover the ordering rules. That testability — not the
specific ranks — is what is worth porting.

## Decision

Introduce a **work-selection compiler**: a pure ranking function over the candidate cards,
supplied by a feature-package through a fill-a-seam provider, with the current FIFO walk as
the literal fallback.

### D1 — Reuse the existing ranking engine; contribute only a criteria set and a projector

**Correction (architecture review, 2026-08-08).** This decision originally proposed a new
pure `compileWorkSelection(input) → SelectionResult` module with its own weights table. That
was a duplication finding: **a pure, generic, replay-deterministic weighted ranking engine
over kanban cards already exists** in `features/priority-matrix/scoring.ts` (ADR 0058/0059),
and its header states the same rationale this ADR was about to restate —
*"a PURE module (no I/O, no store) so it is trivially unit-testable and replay-deterministic."*

What already ships:

| Needed here | Already exists |
|---|---|
| A pure ranker generic over item type | `rankByPriority<T>(set, items, getScores) → Array<Ranked<T>>` — `scoring.ts:84` |
| Weighted aggregation with presets | `computePriority` — weighted-sum + ratio (WSJF / RICE / ICE / Value-Effort) |
| Ranked kanban cards with a computed priority | `ctx.features['priority-matrix'].listRankedIdeas` → `{cardId, title, priority, rank}` — `surface.ts:32` |
| Per-card scores | `DurableCollection<IdeaScore>` keyed `${listId}::${cardId}` — the kanban card id |

So this feature builds **no engine**. It contributes exactly two things:

1. **A built-in work-selection `CriteriaSet`** — the criteria an autonomous pick should weigh
   (card priority, due-date urgency), expressed in the existing `Criterion` shape with the
   existing `direction: 'benefit' | 'cost'` semantics.
2. **A `getScores` projector** — a pure function mapping a card's intrinsic fields onto that
   set's `Record<criterionId, 1..10>`. This is where all of this feature's actual policy
   lives, and it is where the unit tests point.

Ranking is then `rankByPriority(WORK_SELECTION_SET, candidates, projectCardScores)`.

**The engine is hoisted, not imported across features.** `scoring.ts` imports only
`./types.js` (`Criterion`, `CriteriaSet`), so it moves to `host/weightedScoring.ts` with
Priority Matrix re-exporting it for continuity. A direct cross-feature import would work and
is conventional here (see D2), but it would make an autonomous *runtime* path depend on a
*planning* feature's toggle state — a runtime pick must not change because someone switched
off a planning surface. Hoisting makes the shared ownership explicit and removes the
coupling. Trade-off accepted: one PM-internal module becomes core with two consumers, so
changes to it need both in mind.

Per-item reasons reuse the **ADR 0234 per-criterion "why ranked here" breakdown** rather
than inventing a second reason format — see matrix row 10.

### D2 — Fill-a-seam into core, following ADR 0318

`host/heartbeatService.ts` is core, and **core must not import a feature** — that is the
real constraint, and the only one this seam exists to satisfy. Core exposes
`registerWorkSelectionCompiler(fn | null)`; the `work-selection` feature registers its
policy at boot. Same file, same shape, same fail-open posture as the ADR 0318
`registerHeartbeatConfigProvider` precedent.

**Correction (architecture review, 2026-08-08).** An earlier draft also justified this seam
as avoiding a cross-feature import. That premise is false: cross-feature imports are the
house pattern here — 201 files do it, including `features/advisory-board/service.ts:21-22 →
strategyService`/`projectsService` and `features/accessibility/agentTools.ts:18 →
mediaService`. The conclusion (a seam into core) survives on the core-import rule alone; the
false premise is recorded because it is what produced the D1 duplication before review
caught it.

**One correction to that precedent, and it matters.** ADR 0318's provider returns *config*,
so fail-open to `null` restores prior behavior exactly. This provider returns a *decision*,
so "fail-open" must mean **the literal existing walk** — first runnable card in
`(columnId, order)` — not a degraded ranking. An unregistered, throwing, or empty-returning
compiler must produce a pick byte-identical to pre-0534. Otherwise "fail-open" quietly
becomes "rank badly," which is worse than not ranking.

Pinned by test: with no compiler registered, the selection is identical to the pre-change
implementation over the same board.

### D3 — Stamp the selection into `run.metadata`, or `:fork` re-ranks

The toggle admits variants (matrix row 2), so ranking policy can differ per bucket. Anything
that influences a run must be frozen at creation and read verbatim on `:fork` — the ADR 0001
correction that moved the variant stamp to `run.metadata` in the first place.

`host/heartbeatService.ts:186` already stamps `metadata.heartbeat {rosterId, persona,
agentId, boardId, cardId, source}` — enough to say *what* was picked, not *why it won*.
Extend it with the selection decision: the compiler identity/version, the resolved variant,
the item's rank, and its reason. Use `host/runStartContext.ts`
(`registerRunStartContributor`, ADR 0099) — the documented seam for "resolve a cross-cutting
decision once per run and replay it verbatim."

A fork must **not** re-run the compiler. Re-ranking on fork would let a replayed run pick a
different card than the one it originally ran, which breaks replay determinism outright.

### D4 — No agenda snapshot, no version, no TTL (the load-bearing port correction)

the prior art persists the compiled agenda with a `version` uuid and a 5-minute TTL, and claims
validate against that version (`agenda/service.ts`, `claim.service.ts`). **Do not port
this.** It exists because the prior art's agent is a *separate process* that fetches the agenda,
then claims an item some time later — the snapshot is what makes that gap safe.

Here, compile → select → dispatch happens in **one in-process pass** inside
`runHeartbeatOnce`. There is no gap to protect. Adding a snapshot would *introduce* a
stale-read race that does not currently exist, plus a durable store, a TTL, and an expiry
sweep — infrastructure whose only purpose would be to guard a window we would have created.

Concurrency across the fleet stays exactly as it is: the per-`(rosterId, slot)`
`claimIdempotency` guard at `host/heartbeatService.ts` already ensures one instance runs a
given member's pass. Ranking does not change that, and must not be given a second guard.

### D5 — Bound the candidate set before ranking

`host/kanbanService.ts:380` — `listCards` is `(await cards.list()).filter(...)`: a **full
cross-tenant `DurableCollection` scan** filtered in memory, called per board, per member,
per 30-second tick. Ranking must not multiply that.

The compiler receives an already-bounded candidate set (the member's To Do cards, capped),
and the cap is applied at gather time, not after ranking. A future ADR that adds candidate
*sources* must budget its reads explicitly. Recorded as a hard constraint, not a
nice-to-have: this is the hot path of the whole autonomous loop.

### D6 — Name why nothing was picked

`HeartbeatResult.reason` is today `'paused' | 'no_eligible_tasks'`
(`host/heartbeatService.ts:48`). `no_eligible_tasks` conflates "the board is empty," "every
card is policy-denied," "the run budget is spent," and "everything is capped." Extend the
reason vocabulary so the server *names* the cause rather than leaving every consumer to
re-derive suppression rules — the prior art's `emptyReason` (`capReached | awaitingSetup |
clear`), which is one of the cheapest good ideas in that codebase.

### D7 — Scope: rank the existing candidates; do not invent new ones

This ADR ranks **the cards already in the candidate set**. It does not add candidate sources
(due follow-ups, answered approvals, inbox-style work), does not add per-kind caps, and does
not add retry dampers. the prior art has all three, and they are good — but they are meaningful
only once multiple *kinds* of work compete, which is not today's shape. Adding them now
would be building policy for a situation that does not exist, and the audit discipline that
killed [ADR 0536](0536-liveness-gated-sweeper-escalation.md) applies here too. The compiler
signature is extensible so a later ADR can add kinds without reshaping the seam.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package (ADR 0001)** | `backend/typescript/src/features/work-selection/` (`compiler.ts` pure + `service.ts` + `routes.ts` + `feature.ts` + `surface.ts`), appended to `BACKEND_FEATURES`. Core gains only the `registerWorkSelectionCompiler` seam in `host/heartbeatService.ts` — no core route/nav edits. Import direction: feature → core only. |
| 2 | **Toggle + admin UI** | `work-selection`, default **OFF**, `bucketUnit: 'tenant'` (boards are workspace-shared; per-user selection policy on a shared board would be incoherent — ADR 0015). Variants reserved for weighting experiments; resolution stays server-authoritative via `FeatureTogglePanel`. |
| 3 | **Workflow surface (ADR 0014)** | `ctx.features['work-selection']` — **read-only**: `preview(boardId)` returns the ranked list with reasons. No write ops: selection policy is host policy, not workflow-mutable. Behind the same toggle + RBAC; advertised at `/.well-known/openwop` only once wired. |
| 4 | **Node pack** | `feature.work-selection.nodes` — one read node (`work-selection.preview`) so a workflow can reason about the queue without duplicating ranking. Signed via the registry pipeline (Ed25519 + SRI). No trigger/sensor nodes: the heartbeat daemon is the trigger and must stay the only one. |
| 5 | **AI-chat envelopes** | **None.** No new envelope kind — nothing here is in-run structured intent from a model, and a new envelope kind would require an OpenWOP RFC. Selection is host policy the model observes, never authors. |
| 6 | **Agent pack** | **None — honestly.** This is not an AI surface; there is no persona to ship. What *is* worth adding (P4) is a read tool via `registerFeatureAgentTool` (ADR 0308) — "what would you pick up next, and why" — which MUST reuse the route's access predicate through a shared helper and fail EMPTY without `scope.actingUserId`. Allowlisted per pack, never added to the ADR 0315 default-on baseline. |
| 7 | **Public surface** | **None.** Nothing public; no `PUBLIC_PATH_PREFIXES` entry. |
| 8 | **RBAC + isolation (ADR 0006)** | Preview reads require `workspace:read` on the board's org; weight edits require org-admin (a selection policy is a workspace-governance decision). Board access derives from the card's board's `ownerSubject` via `host/subjectAccess.ts` — never from the request. Fail-closed on unknown board or absent org. |
| 9 | **Replay / fork safety** | D3 — selection inputs + resolved variant frozen into `run.metadata` at creation via `registerRunStartContributor`; read verbatim on `:fork`; the compiler is never re-run for a fork. Packs stay decoupled from toggle state. |
| 10 | **Frontend** | `workSelectionClient.ts` + a "why this card?" affordance on the board card. **No new weights editor and no new reason format** (architecture review 2026-08-08): weights are edited through Priority Matrix's existing criteria-set editor (1–10 sliders + named presets, org-admin gated), and the affordance renders the **ADR 0234 per-criterion breakdown** — the same shape as "why ranked here". Building either again would be the config-surface and presentation halves of the D1 duplication. Registered via `FRONTEND_FEATURES` / the menu registry; `ui/` cohesion, tokens, a11y per `DESIGN.md` and `/ux-review`. |

## Alternatives weighed

| Option | Verdict |
|---|---|
| **Sort `listCards` by priority in core** | Rejected. `listCards` is the shared read for every board consumer (21 importers); re-sorting it changes the visual board order for humans, which is a different decision made by a different owner. Selection order ≠ display order. |
| **Give cards a numeric `rank` column the loop reads** | Rejected. Pushes policy into stored data, so every writer must keep it current and it drifts the moment `dueAt` passes. A derived ranking recomputed per pass cannot go stale — the same argument that makes the prior art's recompiled agenda better than a task queue. |
| **Put the compiler in core, no feature-package** | Rejected on rollout, not purity: a selection change alters which work an autonomous agent does. It needs a toggle, a bucket, and variants to land safely — which is what the feature model is for. The ADR 0318 seam makes this nearly free. |
| **Port the prior art's snapshot + version + TTL wholesale** | Rejected — D4. It would create the race it exists to prevent. |
| **Add candidate kinds + caps + dampers now** | Deferred — D7. Policy for a situation that does not yet exist. |
| **Build a second weighted-scoring engine** (the pre-review D1) | Rejected — D1. `features/priority-matrix/scoring.ts` already is one, over the same entity, with the same purity rationale. Two engines over kanban cards would drift and disagree. |
| **Import PM's `scoring.ts` cross-feature instead of hoisting** | Rejected — D1. Conventional (201 precedents) and cheaper, but it makes an autonomous runtime pick depend on a *planning* feature's toggle state. |
| **Fold work-selection into Priority Matrix** | Rejected. PM ranks human planning lists (multi-voter, sessions, agendas); this ranks executable work at dispatch time. Different RBAC, lifecycle, and surface. Shared engine, separate features. |

## Phased plan

| Phase | Scope | Verification |
|---|---|---|
| **P0** | Hoist `features/priority-matrix/scoring.ts` → `host/weightedScoring.ts` (it imports only `./types.js`); PM re-exports for continuity. **No behavior change.** | Existing PM scoring + ranking tests stay green unmodified — that is the whole assertion. `( cd backend/typescript && node node_modules/vitest/vitest.mjs run )`. |
| **P1** | The built-in work-selection `CriteriaSet` + the pure `projectCardScores` field projector, in the feature package. Not wired. | Unit tests over the projector — priority mapping, `dueAt` urgency, unscored/absent fields, determinism (same input → same output, no clock/random). The engine is already tested by P0; the policy is what is new. |
| **P2** | The `registerWorkSelectionCompiler` seam in core + fail-open fallback. | Pinned test: **no compiler registered ⇒ pick is byte-identical to pre-0534** over the same board. Plus: a throwing compiler falls back rather than faulting the pass. |
| **P3** | Toggle + registration + the D3 run-metadata stamp + the D6 reason vocabulary. | Route test through `createApp` (toggle gating and authz are only observable at the HTTP boundary). Fork test: a forked run replays the original selection and does not re-rank. |
| **P4** | `ctx.features['work-selection'].preview` + the node pack + the ADR 0308 read tool (shared access predicate). | Surface test; `promptCatalogParity` if any prompt carries the vocabulary; `agent-prompt-tool-ids` repo-wide lint. |
| **P5** | Frontend: the "why this card?" affordance rendering the ADR 0234 breakdown. **No weights editor** — PM's criteria-set editor is the one. | `( cd frontend/react && npm run build )` — the canonical gate (tsc + token/CSS integrity), never bare `vite build`. |

## Implementation record

| Phase | Commit | Verification |
|---|---|---|
| **P0** — hoist the engine to `host/weightedScoring.ts` | `f6587a731` | 96/96 across 14 files, **no test modified** |
| **P1** — criteria set + card projector | `d37939c75` | `work-selection-compiler.test.ts` (12) |
| **P2** — the core seam + fail-open | `06094fedd` | `work-selection-seam.test.ts` (9) + 5 existing heartbeat suites unmodified |
| **P3** — feature package, toggle, D3 stamp, D6 reasons | `b84e23676` | `work-selection-feature.test.ts` (6); 192/192 regression |
| **P4** — surface, node pack, agent tool | `57fee0ae1` | `work-selection-surface.test.ts` (7); 131/131 pack + tool-id gates |
| **P5** — the "Up next" panel | `089772ba7` | frontend gate green (25 checks + build + budget + CSP) |

### Corrections the implementation forced

1. **P2's seam could not carry the feature.** It shipped synchronous and
   tenant-less; toggle resolution is **async and per-tenant**
   (`featureToggles/service.resolveOne`). P3 made `orderWorkCandidates` async and
   tenant-aware rather than reading a toggle synchronously somewhere. Recorded
   because the original D2 text implied a sync seam was sufficient.
2. **`null` vs throw became load-bearing.** `null` = "toggle off for this tenant"
   (not a fault, no log); throw = "broken". Both fall back to insertion order.

### Open questions resolved by the work

- **OQ-1 (weights)** — resolved from published prior art rather than invented:
  Taskwarrior's urgency coefficients (due 12, priority 6/3.9/1.8, age 2, blocked 8)
  kept in proportion on the engine's 1..10 weight scale.
  <https://taskwarrior.org/docs/urgency/>
- **OQ-2 (starvation)** — resolved. **Age is a first-class criterion**, so the
  permanent tail cannot be starved, with no separate aging mechanism to build or
  tune. Pinned by test: an undated card overtakes a dated one once old enough.
- **OQ-3 (display vs selection order)** — resolved **in the P5 design**. Rank
  badges on cards would have implied the board *is* the queue; the separate "Up
  next" list keeps the human's arrangement and the agent's derived order visibly
  distinct.
- **OQ-4 / ADR 0535 OQ-3 (crash-loop damping)** — resolved **for free**. `blocked`
  is a **cost** criterion and ADR 0535 writes a blocker note when it restores a
  card whose run failed, so a repeatedly-failing card sinks on its own with no
  bespoke retry damper; clearing the note restores its rank. The two ADRs compose.

### Residue (deliberate, not forgotten)

- **The 0-means-unscored trap** is a permanent hazard of the shared engine: a
  criterion scored `0` reads as *unscored* and sinks the item, so every projection
  returns ≥ 1. Pinned by test; anyone adding a criterion must respect it.
- **D7 still holds** — candidate *kinds*, per-kind caps and dampers remain
  deferred until a second kind of work actually competes.

## RFC verdict

**Host work, no RFC.** Nothing touches the wire: no run-event field, no capability flag, no
event type, no endpoint contract, no auth/scale profile, no normative MUST. Routes live
under `/v1/host/openwop-app/work-selection/*` (non-normative host-extension; the prefix is
free — audited against the 40+ registered prefixes, no collision). `run.metadata` is an
existing, already-replayed carrier (ADR 0001 / ADR 0099), not a new field on the wire.

The `ctx.features['work-selection']` surface is advertised at `/.well-known/openwop` **only
once P4 actually wires it** — advertising ahead of behavior is what
`OPENWOP_REQUIRE_BEHAVIOR=true` fails on.

## Open questions

- **OQ-1 — which criteria belong in the built-in set, and how do card fields project onto
  1..10?** (Restated after the D1 correction: aggregation is no longer an open question —
  `computePriority` owns it. What is open is the *set* and the *projection*.) `priority` and
  `dueAt` are the two real signals on a card today. Does an overdue `low` outrank an on-time
  `high`? Note the engine's band is 1..10 with 0 meaning "unscored, ranks last", so a card
  with no `dueAt` must project deliberately — 0 would sink every card that simply has no
  deadline. Start from a defensible default, ship it OFF, tune from measurement.
  **Falsifier for the whole D1 reuse decision:** if due-date urgency cannot be expressed in
  the 1..10 band without distortion, a separate engine becomes defensible again — but that
  must be shown with a worked example, not assumed.
- **OQ-2 — starvation.** Pure ranking starves the permanent tail: a `low` card with no due
  date may never be picked. the prior art solves this with age-based escalation and per-kind caps.
  Needed at launch, or once a real board demonstrates a starved tail? Leaning "measure
  first," consistent with D7.
- **OQ-3 — display vs selection order.** If the agent works cards out of visual board order,
  the board becomes confusing to humans. Does the "why this card?" affordance suffice, or
  does the To Do lane need an optional "agent order" view? A UX call, not an architecture one
  — route to `/ux-review` at P5.
- **OQ-4 — crash-loop damping, owned HERE.** A restored card (ADR 0535) keeps its original
  `order`, so under FIFO it returns roughly where it was; under ranking, a card whose
  workflow deterministically crashes would be restored, re-picked, and crash again every
  pass. **This ADR owns the damping** — it is a selection-policy question, and ADR 0535 OQ-3
  is hereby resolved by pointing here rather than being answered twice. Open: is a
  restore-count penalty in the projector enough (a `restoreCount` criterion with
  `direction: 'cost'` composes cleanly with the existing engine), or does the ADR 0313 run
  budget (`checkAutonomousRunBudget`) already bound the blast radius? Measure before
  building — the discipline ADR 0536 exists to enforce.

## Port-vs-architecture corrections (what changed from the prior art original)

1. **"Agenda" → "work selection."** Their vocabulary, not ours. This app has boards, cards,
   and a heartbeat; importing a foreign noun for the same concept creates a second name for
   one thing. The seam, the feature id, and the toggle all read in this app's terms.
2. **Persisted snapshot + version + TTL → nothing** (D4). Their process boundary needs it;
   our in-process pass does not, and porting it would manufacture a race.
3. **Server-computed `sleepSeconds` / `nextWakeAt` → not ported.** Their server tells the
   agent when to return because the agent owns the loop. Here the daemon owns cadence, and
   ADR 0318 already provides a runtime-editable resolver for it. A second cadence authority
   would contradict the first.
4. **19 item kinds → the existing candidate set** (D7). Rank what exists; extend when a
   second kind exists.
5. **Their ranking is host policy → ours is toggled + bucketed.** They ship one policy to
   one user's machine; we change autonomous behavior for a whole workspace, so it lands
   behind a toggle with a variant lane and an admin surface.
