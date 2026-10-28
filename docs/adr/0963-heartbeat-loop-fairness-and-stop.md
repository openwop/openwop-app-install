# ADR 0963 — The heartbeat loop: serve every member, stop when told, and stamp the pass that ranked

Status: implemented (2026-10-19; Accepted after the adversarial `/architect` pass below — 0 Blockers, 2 High + 4 Medium folded into D2–D5; D8 added after the lead's blast-radius review; D9 is a user decision)

Feature loop round 2, row 54 (`work-selection` + the ADR 0313 heartbeat work loop). Amends
ADR 0313 (the loop), ADR 0534 (ranked work selection), ADR 0535 (stranded-card recovery) and
ADR 0804 (the roster cache). Host-only: no wire change, no new RFC, no advertisement change.

## Context

The round-1 grade of this feature was A / A / A. It graded the work-selection package: one
read node, one read surface, one read tool, and a fill-a-seam compiler. Those are sound. No
row graded the loop the feature ranks for. The round-2 workflow grade
(`WORKFLOWS-ASSESSMENT.md` § row 54) did, and found it at **D**. Seven probes
(`test/ws2-grade-probe.test.ts`) are all red on `ea8f54f81`. These are the findings:

1. **`WS2WF-1` — the loop serves a handful of members and starves everyone else (measured
   in prod).** `processDueHeartbeats` has two compounding defects:
   - **The slot claim key is not tenant-qualified.** The key is
     `heartbeat:${rosterId}:${slot}`. Since ADR 0379, roster ids are persona-scoped
     (`host:<slug>`), so `host:ava` exists in 801 tenants and one tenant's Ava takes the
     claim for all of them.
   - **The batch is the first 50 due entries in listing order.** An entry that is skipped
     (it lost the claim, or its tenant is over budget) is not stamped. It stays due, keeps
     its place at the head of the list, and the same 50 entries are re-examined every
     30 s.

   Prod read-only, 2026-10-20 01:30Z: 10,488 roster entries, 10,482 enabled on the 10-min
   host default, across 815 tenants. **36 entries (two `anon:0…` tenants, the head of the
   key order) were heartbeated in the last 24 h**, re-stamped every slot. 304 have ever been
   stamped. All 12 heartbeat runs ever recorded are on the first few `anon:0…` keys.
2. **`WS2WF-2` — cancelling a run does not stop the agent.** A `cancelled` restore returns
   the card to To Do with no note (ADR 0535 D4 correction: "no blame note"), and the next
   pass picks it up again.
3. **`WS2WF-3` — a failing card re-runs every interval, forever.** ADR 0534 OQ-4 says
   crash-loop damping is "resolved for free" by the `blocked` cost criterion. That is false
   twice:
   - Ranking is a per-tenant toggle. With it off, nothing is damped.
   - A cost only reorders cards. It never stops a pick, so a board whose only To Do card
     fails re-runs that card 144 times a day. The only bound is the 120 runs/h tenant
     budget.
4. **`WS2WF-4` — the ADR 0804 roster cache is defeated by the loop's own writes.**
   `recordHeartbeat` bumps the roster-change token. Any tick that heartbeats a member
   therefore forces the next tick to re-list every tenant: one full `roster` scan plus one
   prefix scan per tenant (815 in prod), every 30 s, on every instance.
   `heartbeat-roster-cache.test.ts:61` pins the bump, so the test suite enforces the
   defect.
5. **`WS2WF-5` — the replay stamp is read from module-global state.** `lastPicks` is
   reassigned by every `orderWorkCandidates` call. A pass that ranks while another pass is
   between its ranking and `startWorkflowRun` erases the other pass's decision. ADR 0534
   D3's stamp is then missing or wrong.
6. **`WS2WF-6` — a machine restore note outlives the run it describes.** Nothing removes
   `[auto:run-restore]` when a later run completes. Prod has 12 such cards, all in
   `working`, and 3 show `lastRunStatus: completed` under a note that says "outcome
   unknown".
7. **`WS2WF-8` — four written claims the code does not keep:**
   - FEATURES.md and ADR 0534 matrix row 10 say "weights are edited in Priority Matrix's
     criteria-set editor". The weights are a code constant.
   - ADR 0534 D3 says the stamp carries the resolved variant via
     `registerRunStartContributor`. It does not.
   - ADR 0534 D5 says a candidate cap is applied at gather time. No cap exists.
   - ADR 0534 OQ-4 calls crash-loop damping resolved. See item 3.

## Decision

### D1 — The slot claim is per member, not per persona

The claim key becomes `heartbeat:${tenantId}:${rosterId}:${slot}`. The `heartbeat:` prefix is
unchanged, so `pruneStaleHeartbeatClaims` covers both shapes.

**Deploy overlap.** For the minutes two revisions run side by side, the old revision claims
under the old key and the new one under the new key, so one member can run twice in one
slot. The second run is harmless in each case:

- **A card pick** is fenced by the ADR 0774 D2 card claim: one CAS out of To Do. The losing
  pass moves to the next card.
- **A review-mode proposal** is guarded by `hasPendingApprovalForCard`. Two passes can both
  get past the check before either writes, so at most one duplicate proposal per card per
  overlap can result. A duplicate is visible and does no work; it is not deduplicated here.
- **The `lastHeartbeatAt` stamp** may be written twice. That is idempotent.

### D2 — The batch is fair: stalest first, and only served members count

`processDueHeartbeats` changes in three ways:

- **Order.** Due entries are sorted stalest-first: never stamped first, then by oldest
  `lastHeartbeatAt`, with ties broken by `(tenantId, rosterId)` so the order is
  deterministic.
- **What counts toward the batch.** `CHECK_BATCH` (50) now counts members actually served,
  meaning `runHeartbeatOnce` was invoked. A member that loses the claim or is refused by
  the budget no longer uses up a batch slot.
- **A bound on work per tick.** `MAX_EXAMINED` (200) caps the members examined in one tick.
  Before any I/O for a member, the pass checks whether that member's tenant was already
  refused by the budget in this pass. If so, the member is skipped and not counted, so a
  tenant that is over budget pays one budget check per pass, not one per member.

A member served this pass is stamped, which moves it behind everyone not yet served. A
skipped member stays at the head and is served as soon as its tenant has budget again. This
round-robin is the fairness the ADR 0313 loop always assumed.

**Throughput is now stated, not hidden.** Each instance serves at most 50 members per 30 s.
In prod, 10,482 due members take about 105 minutes to cycle on one instance, against a
10-minute cadence. That is still a backlog, but a fair one: every member gets served, at a
longer effective interval. When due members exceed the number served, the pass logs
`heartbeat pass saturated {due, served, examined}`, so an operator can see the backlog. Raising
`CHECK_BATCH` is a capacity decision for a measured follow-up, not part of this ADR.

### D3 — A stopped or failed card is held until a person releases it

When recovery returns a card to To Do after a `failed` run, a `cancelled` run, or a run whose
row is gone, it writes the machine restore note (`[auto:run-restore] …`). This now includes
`cancelled`. **The loop does not pick a To Do card that carries the machine restore mark.**
The card is *held*.

- The **cancelled** note is neutral, not a fault report: "Held — its run was cancelled
  (runId). Clear this note to let the agent pick it up again." This supersedes ADR 0535
  D4's "no note on cancel". The objection there was to *blaming*, not to recording the stop.
- The **failed** and **unknown** notes gain the same release instruction.
- **One predicate decides "held"**: `isHeldForReview(card)` in `host/cardRunRecovery.ts`.
  The pick, the manual Check now (it shares `runHeartbeatOnce`) and the ranking preview
  (`readBoardRanking`) all call it. The preview therefore ranks exactly what the pick would
  consider, and returns the held cards separately as `held: [{cardId, title}]`.
- `HeartbeatResult.reason` gains `held`. It ranks just below `awaiting_approval` among the
  reasons a pass reports for picking nothing.
- **Release** is the existing card edit: a person clears or edits the blocker note. The
  human-authored part of a note is preserved, as before (`composeBlockerNote`). Only the
  machine line marks a card as held.

**Why hold and not back off.** A retry backoff needs a durable restore counter (a new card
field and a schema change) and still re-runs a deterministic failure. A human stop must
never be retried. One rule ("the loop does not retry what stopped; a person decides") covers
both cases with no new state, and it is the "agents propose, humans dispose" posture ADR 0313
already takes for bare cards.

**Prod impact, measured.** 0 To Do cards carry the mark; all 12 marked cards sit in
`working`. Deploying D3 holds nothing that is runnable today.

### D4 — A completed run clears the machine note

When a run on a card completes (`stampRunStatus` with `completed`, for every card-bound key:
`heartbeat`, `approval`, `kanban`) and the card still points at that run, the machine restore
lines are stripped from its blocker note in the same write, and any human text is kept. A
note that says "outcome unknown" stops being true the moment a run on that card completes.
The 12 stale prod cards are not backfilled; that would be a prod write. They clear on their
next completed run, or when a person edits the note.

### D5 — Stamping a heartbeat no longer moves the roster token; the cache learns from the pass

- **`recordHeartbeat` stops bumping the roster-change token.** `lastHeartbeatAt` is pass
  state, not membership or config. Create, update and delete still bump it.
- **The cache is corrected from the pass itself.** `cachedRosterEntries` exposes
  `note(entry)`. `processDueHeartbeats` calls it with every fresh read and every stamp it
  makes, so the next tick orders and filters on what this instance last saw.
- **Another instance's stamps** are still invisible to this instance's cache until the
  5-minute backstop. Such an entry looks due: one point read (`getRosterEntry`, which the
  pass already does) shows it is not, and `note` corrects the cache. The cost is bounded at
  one point read per member per instance per backstop.
- **`heartbeat-roster-cache.test.ts`** is changed: `recordHeartbeat` must NOT move the
  token. The old assertion pinned the defect.

### D6 — The ranking decision belongs to the pass

- **No module-level `lastPicks`.** `rankWorkCandidates(cards, now, tenantId)` returns
  `{ cards, decisions }`, and `runHeartbeatOnce` keeps `decisions` in a local variable.
- **The stamp is built from that local map.** `workSelectionStamp(decisions, cardId)` is a
  pure function of the decisions, with `candidates` set to `decisions.size`.
- **`orderWorkCandidates` stays** as a thin wrapper returning `cards`, for its existing
  callers.
- **Every fail-open rule from ADR 0534 is unchanged.** With no compiler, a `null` result, a
  throw, or a result that is not a permutation, the cards come back in insertion order and
  the decisions map is empty.

### D7 — Correct the written claims

All corrections are inline notes, per the house rule:

- **FEATURES.md row:** the weights are a code constant, and there is no editor.
- **ADR 0534:**
  - matrix row 10 and P5: no editor;
  - D3: the stamp carries `{policy, rank, score, scores, candidates}`, with no variant and
    no `registerRunStartContributor`;
  - D5: there is no cap; the candidate set is one board's To Do lane, already in memory;
  - OQ-4: the resolution was false, and D3 above is the real one.
- **ADR 0535 D4:** cancel now writes a neutral hold note.
- **ADR 0804:** the token moved on every heartbeat until this ADR.
- **The work-selection module and panel docblocks** that repeat the Priority Matrix claim.

### D8 — Blast radius: the loop never takes a Work-Twin mock archive on its own

**Added after the lead's blast-radius review (2026-10-19), before the PR.** D1/D2 turn a
loop that served 36 members into one that serves every enabled member. Read-only prod,
2026-10-20 (`scratchpad/row54-ro5.cjs`):

| | anon tenants | signed-in tenants |
|---|---|---|
| Enabled members on the host-default cadence | **10,382** in 805 tenants, 100% seeded (`roleKey` set) | **100** in 7 tenants (90 seeded, 10 hand-made) |
| Autonomy | review 8,177 · guided 2,205 · auto 0 | review 77 · guided 16 · auto 7 |
| Members a PERSON gave a cadence (`heartbeatIntervalMs > 0`) | 0 | 0 |
| Agent boards with To Do work | 7,411 | 61 |
| To Do cards: `tmpl.*` mock archive | **12,668** | 85 |
| To Do cards: bare (agent-turn fallback, always proposes) | 1,456 | 10 |
| To Do cards: other | 0 | 21 (`sample.agents.*`, an id that resolves nowhere in source) |

**What bounds it today:**

- **The 120/h autonomous budget** is per tenant. Across 805 tenants that is effectively no
  bound.
- **The managed daily caps** apply only to model turns. A `tmpl.*` chain is
  `local.sample.demo.mock-ai` and spends nothing.
- **No per-tenant enablement exists** beyond the host-default cadence. Not one member has a
  cadence a person set.
- **Before this ADR, the real bound was the starvation bug itself.**

**What the fix would have done unguarded:**

- Review members would have raised about 14k pending proposals, each with escalation
  notifications.
- The 2,221 guided members would have auto-run their routine `tmpl.*` cards, which fabricate
  "completed" work. The user paused exactly those schedules on 2026-10-19 (ADR 0939).

**Decision.** `runHeartbeatOnce` resolves each card's workflow, by card first and then column
trigger. It neither runs nor proposes a card whose workflow is one of the 44 Work-Twin
mock-AI archives, and it records `reason: 'mock_archive'`. The same applies to the manual
Check now, the ranking preview, and the `heartbeatPreflight` report.

- **The predicate is `isWorkTwinMockArchive`** in `host/workflowTemplates.ts`. It is keyed
  on `WORKFLOW_TEMPLATE_CHAIN_IDS`, the list the pack registration itself uses, never on a
  `tmpl.` prefix. A test pins the difference.
- **Nothing is written to the cards.** The guard is reversible the day ADR 0939 replaces the
  archives with real chains.
- **A person can still run an archive by hand.** Dragging the card into a triggering column
  is a person's act, outside the loop.

**Why this guard, and not "serve only what a person enabled".** No member in prod has a
cadence a person set, so that rule would switch the autonomous loop off everywhere. That is a
product decision (D9), not a fix. The mock-archive guard is the part the evidence settles:
these workflows fabricate work, and the user has already paused them.

**After D8:**

- **What the whole fleet can still produce:** about 1,466 bare-card proposals (no spend until
  a person approves) and the 21 dead `sample.agents.*` cards. Those dead cards fail to start,
  are released, and are held under D3 once a run row records the failure.
- **Who those proposals land on:** about 99% of the work, and of the loop's capacity, is on
  `anon:` demo tenants.

### D9 — The autonomous daemon serves signed-in tenants only (USER decision, 2026-10-19)

Asked through the lead on 2026-10-19. The two options were:

- **(A)** keep serving anonymous demo tenants;
- **(B)** exclude them from the daemon.

The user answered **"No, signed-in only"**: option (B).

**Decision.** `processDueHeartbeats` drops every member whose tenant is an anonymous sandbox
(`isAnonTenantId`, the one host spelling of `anon:<sid>`, ADR 0786 D5) before it orders or
examines anything. The manual "Check now" route calls `runHeartbeatOnce` directly, so it still
works in an anonymous sandbox.

**The nuance, recorded so the decision is not over-read.** The user's option text also said
"where a person turned it on". No member in prod has a cadence a person set (`heartbeatIntervalMs > 0`:
0 members), so read strictly, that clause would serve nobody. On the lead's instruction it is
**not** implemented here. Signed-in tenants keep today's enablement: the host-default cadence,
with `-1` as the opt-out.

**Behaviour on deploy, measured 2026-10-20:**

| | Before | After |
|---|---|---|
| Members served | 36, all on the first two `anon:` keys | about 100 enabled members in 7 signed-in tenants, every interval (well under one `CHECK_BATCH` per tick) |
| Anonymous sandboxes | served | never |
| Mock-archive cards | picked | never (D8) |

What the signed-in members can still pick after D8:

- 10 bare cards, which only propose;
- 21 cards naming `sample.agents.*`, an id that resolves nowhere. Those fail to start, are
  released, and are held under D3 once a run row records the failure.

> **CORRECTED 2026-10-25 (row-54 close-out, measured in prod): "well under one
> `CHECK_BATCH` per tick" in the table above is wrong.** About 100 due members is
> MORE than `CHECK_BATCH` = 50, not under it. Cloud Logging on the deploying
> revision (`01036-lng`) shows the first pass at `due: 110, examined: 51, served: 50`
> (03:12:16Z). The other instance then logged `heartbeat pass saturated` three more
> times, at `due` 58, 63 and 63 (03:33Z, 04:04Z, 10:02Z). The warning is rate-limited
> by `SATURATION_WARN_EVERY_MS`, so those are lower bounds. The five later revisions
> (`01037`–`01041`, about 11 h) logged none. So the expectation handed to the release
> coordinator, ONE saturation line per instance on the first pass and then none, was
> also too strong: saturation recurs whenever most of the signed-in cohort falls due
> in the same tick. It is not a failure. The next 30 s pass serves the rest, and 110
> of 112 enabled signed-in members were stamped within 15 minutes of the
> measurement. It does mean the D2 throughput ceiling (filed under "Not decided
> here") is already reachable with today's signed-in population.

Witnessed by `heartbeat-loop-adr0963.test.ts` § D9 (sabotage S22).

### Not decided here (filed)

- **`WS2WF-7`:** heartbeat proposals never expire. 527 are pending in prod, all on
  `anon:` tenants, the oldest from 2026-07-06. Approvals have no general TTL, so this is an
  approvals-lane decision, not one for this loop.
- **`WS2WF-9`:** a review-mode proposal carries no `workSelection` stamp.
- **The ADR 0939 interaction:** the `tmpl.*` pause covers scheduler jobs, not a card or
  column trigger that names a `tmpl.*` id. Whether a hidden archive id may still run from a
  card is ADR 0939's decision.
- **Capacity:** the D2 throughput ceiling.

## Architect pass (pre-code, 2026-10-19) — folded into the decisions

Track A. Read against `ea8f54f81`: `heartbeatService.ts`, `cardRunRecovery.ts`, `rosterService.ts`,
`kanbanService.ts` (`claimCardForRun`, `releaseCardClaim`, `recordCardRunStatus`,
`applyBoardCommand`), `approvalDecision.ts`, `runCancel.ts`, `pinnedRunDisposition.ts`,
`kanbanSurface.ts`, `features/work-selection/*`. No Blocker in the decision text; these change it:

- **A1 (High, D4) — the note strip as written would lose a person's edit.** `card.patch`
  applies a STATIC patch under a precondition on the fresh card. A note computed from a
  snapshot and written under `lastRunId === runId` alone overwrites a human edit that landed
  in between. And `recordCardRunStatus` returns early when the status is already `completed`
  (reconcile may have stamped it), so a strip riding it would silently never happen.
  **Correction:** the strip is its own write, `clearRestoreNote(cardId, runId)`, conditioned
  on `fresh.lastRunId === runId && fresh.blockerNote === seen`, retried once on a lost race
  from a fresh read, and called independently of whether the status stamp wrote.
  **The same lost update already exists in the restore** (`composeBlockerNote` from a
  snapshot, precondition on run + column only). The restore gains the same
  `blockerNote === seen` precondition; a restore that loses it leaves the card in Working and
  the next pass's reconcile retries from a fresh read.
- **A2 (High, D3) — "cancelled" is not only a person.** `runCancel.cancelRunAndCascade` is
  also called by workflow deletion (`tenantWorkflowDelete.ts`), evals and A2A, and
  `pinnedRunDisposition.ts` cancels inherited runs at a contract cut. Holding after those is
  the safe answer (a deleted workflow must not be re-picked), but the note must not say a
  person stopped it. **Correction:** the note reads "its run was cancelled", never "you
  cancelled", and holds regardless of who cancelled.
- **A3 (Medium, D3) — the hold binds the loop, not every mover.** A person can drag a held
  card into a triggering column, and a workflow can `moveTask` it through the kanban surface
  (`kanbanSurface.ts:327`); both start a run. That is intended: the hold answers "will the
  agent retry this on its own", not "may anyone run it". Stated so nobody reads it as a lock.
  Only the HTTP card routes and the seed write `blockerNote`; no agent tool does, so the
  agent cannot release its own hold.
- **A4 (Medium, D2 × D5) — stalest-first on a stale cache favours other instances' work.** A
  member another instance just served still looks stalest here until the 5-min relist; it
  costs one point read, is counted in `MAX_EXAMINED`, and is corrected by `note`. Bounded by
  the backstop, because a relist reads fresh `lastHeartbeatAt` for everyone.
- **A5 (Medium, D3) — the shared read changes shape everywhere at once.** `readBoardRanking`
  is the one predicate for the route, the surface and the agent tool (ADR 0308). It returns
  `{ ranked, held }` to all three; the tool description names held cards (model-facing text,
  so the tool-id/prompt parity tests must stay green). Held titles are member-authored, and
  the tool is already `contentTrust: 'untrusted'`.
- **A6 (Medium, D2) — a refused tenant still burns one member's slot claim per pass**,
  because the claim precedes the budget check (kept: checking budget first would consume
  budget for a member another instance is already running). Up to one member per refused
  tenant per tick waits for the next slot once budget frees. Stated, not changed.

## Alternatives weighed

- **Keep the persona-scoped claim and add a tenant-level claim instead.** Rejected. It
  serialises a tenant's own members behind each other for no reason. The member is the unit
  the slot fences.
- **Stamp `lastHeartbeatAt` on a skipped member so it falls to the back.** Rejected. "Last
  checked" would then report a check that never happened, which is the dishonest-stamp class
  this loop has already been graded for.
- **Back off failed cards exponentially (`restoreCount`).** Rejected for now; see D3. It
  adds a field and still retries a deterministic failure. It can be added later, on top of
  hold, if a measured case for automatic retry appears.
- **Leave a cancelled card in Working.** Rejected. ADR 0535's point stands: work must not
  strand in a lane the loop treats as in flight.

## Phased plan

| Phase | Change | Witness |
|---|---|---|
| P1 | D1 + D2 (claim key, fair batch, saturation log) | probes `WS2WF-1` ×2 |
| P2 | D3 + D4 (hold predicate, notes, `held` reason, preview `held`, FE panel) | probes `WS2WF-2/3/6` + FE test |
| P3 | D5 (token, cache `note`) | probe `WS2WF-4`; `heartbeat-roster-cache.test.ts` corrected |
| P4 | D6 (pass-local decisions) | probe `WS2WF-5` |
| P5 | D7 (docs) | — |
| P6 | D8 (mock-archive guard) | `heartbeat-loop-adr0963.test.ts` D8 ×5; sabotages S17–S19 |
| P7 | D9 (signed-in only, user decision) | `heartbeat-loop-adr0963.test.ts` D9 ×2; sabotage S22 |

## RFC verdict

Host work, no RFC. Nothing touches the wire: `run.metadata.workSelection` keeps its shape, the
host-extension ranking route gains an additive `held` field, and `/.well-known/openwop` is
unchanged.

## Open questions

- **OQ-1:** should the loop skip members that have no board, without stamping them? Most of
  the 10,482 prod members have none. Skipping them would shrink the D2 backlog, but "last
  checked" is a UI fact today. Deferred until it can be measured.


## Recovery correction — 2026-10-21 (D3 / ADR 0464)

Subject erasure must retain the opaque hold marker while removing every original
human/machine line and run identifier. Card erasure now rereads and conditionally
writes with bounded retries; exhaustion reports incomplete erasure rather than
overwriting a concurrent restore or edit. Editing captures the raw note at form
open and uses that exact precondition at save, so a poll cannot authorize an edit
to unseen text. Behavioral race/UI witnesses added; execution pending the next
serialized validation slot.
