# ADR 0667 — Priority Matrix: scoring honesty (completeness, preset fidelity, agenda idempotency)

Status: **implemented** (verified 2026-09-17, #3789)

Supersedes nothing. Extends **ADR 0058** (Priority Matrix), **ADR 0059** (multi-voter),
**ADR 0060** (portfolio), **ADR 0534 P0** (the scoring engine hoisted to `host/`), and
**ADR 0590** (the PM fix batch — whose Decision 4 falsification is load-bearing here, see D3).
Feature-loop 2026-09 iteration 22. Gap ids `PMXWF-7`..`-13` in
`docs/steward/WORKFLOWS-ASSESSMENT.md` § "Priority Matrix — feature loop 2026-09 it.22
re-grade, 2026-09-13" (`d3bab1ac0`).

## Context

Priority Matrix exists to produce **an ordering**. Everything else it owns — criteria sets,
score overlays, planning sessions, the portfolio, the KB projection — is scaffolding around
that one number. The 2026-08-20 `/grade-workflows` pass graded the scaffolding (teardown,
the scenario gate, schedule derivation, federation, chat-drivability) and graded it
correctly; its own Coverage block records `priorityMatrixService.ts` read at ~90 of 1177
lines. **It never graded the number.** This ADR does.

Three of the findings below are arithmetic, and every claim in this section was **measured
on `dc77daae2`**, not read.

### The measurements

**(1) `PMXWF-7` — the ratio lane rewards absence.** `host/weightedScoring.ts:101` refuses
`declaresCost && costAgg <= 0`. The benefit aggregate at `:87` divides by the FULL declared
benefit weight, so an unscored benefit **dilutes** rather than disqualifying:

| WSJF set, unit weights | scores | priority | rank |
|---|---|---|---|
| partially scored | `{value:10, time:10, risk:—, job-size:1}` | **6.67** | **#1** |
| fully scored | `{value:6, time:6, risk:6, job-size:1}` | 6.00 | #2 |

The engine's own narrative at `:89-100` describes an un-estimated idea outranking an
estimated one as **the bug `PM2-B1` fixed**. It fixed the cost axis. The docstring at `:70`
still promises "an empty idea ranks last".

**(2) The `0` sentinel is already overloaded.** A WSJF idea scored 10/10/10 with a blank
job-size returns **exactly `0`** via `:102` — byte-identical to a never-touched idea, which
also returns `0`. Both render as the single word "Unscored". The frontend test
`frontend/react/src/features/priority-matrix/__tests__/priorityListUnscored.test.tsx:4-5`
carries a docblock asserting *"a scored idea can never produce exactly 0 — scores clamp to
1..10"*. **That is false at HEAD** and was true only before `PM2-B1` added the cost guard —
the guard that creates the second way to reach `0`.

**(3) `PMXWF-8` — RICE is additive where the published formula is multiplicative.**
`types.ts:223-232` sets `aggregation:'ratio'`, i.e. `mean(reach,impact,confidence) / effort`.
Measured strict ordering inversion, not a scale difference:

| idea | implemented | true RICE |
|---|---|---|
| `{reach 10, impact 10, confidence 2, effort 1}` | **7.33 → #1** | 200 → #2 |
| `{reach 6, impact 6, confidence 6, effort 1}` | 6.00 → #2 | **216 → #1** |

Aggravating: `types.ts:230`'s `scaleHint` — rendered to the user — reads
`'(Reach × Impact × Confidence) ÷ Effort'`. **The label states a formula the engine does not
run.**

### The blast radius, measured

`aggregation:'ratio'` appears at exactly three sites, all in this feature
(`features/priority-matrix/types.ts:215,225,244`). The other five consumers of the shared
engine — work-selection, CRM propensity, recommendations, job-search ×3 — are all
`weighted-sum`. **The weighted-sum branch is HONEST and must not be "fixed":** measured, a
1-of-2-scored idea returns 5.00 against a complete 6.00, because the missing criterion stays
in the denominator. Partial data is penalized there, not rewarded.

Two of those consumers **depend on that** in writing:
`features/work-selection/compiler.ts:37` and `features/job-search/domain/fitScoring.ts:13`
both document that "`computePriority` treats a criterion scored 0 as UNSCORED and lets it
drag the item down." A work-selection card routinely has no `estimateHours`; demoting every
such card would be a silent behaviour change to two unrelated features. **This is why D1's
ordering change is opt-in rather than global** — see the falsified alternative in D1.

### Why the benefit half survived a fix to the cost half

`features/work-selection/compiler.ts:54-61` documents choosing `weighted-sum` **because**
"the ratio family divides by an effort/size criterion, and a card carries no reliable effort
estimate … so a ratio model would divide by a mostly-missing number." That is the *cost* half
of this exact defect — recognised, and **dodged at the call site instead of fixed in the
engine.** The engine kept the hazard; the next caller inherited it.

## Boundaries audit (Step 3)

- **No new feature package, no new toggle.** Everything here extends `priority-matrix`
  (toggle id stable, `ON`, `bucketUnit: tenant`).
- **No namespace collision.** No new route prefix; D3/D4 change existing handlers under
  `/v1/host/openwop-app/priority-matrix/*`; D5 touches `routes/kanban.ts`, whose single
  registrant is already the kanban feature.
- **Single owner respected.** The scoring engine's single owner is `host/weightedScoring.ts`
  (hoisted by ADR 0534 P0); `features/priority-matrix/scoring.ts` is a pure re-export and
  stays one. **No second scoring path is introduced.**
- **The kanban board stays kanban's** (ADR 0049). D5 does NOT move ownership or fork a board
  store; it adds an inversion seam so an owner of overlay state can be consulted, in the
  shape of the existing `registerTenantPurgeHook` / `registerSubjectEraser` seams.
- **No capability advertisement touched.** Nothing here reaches `/.well-known/openwop`.

## Decisions

### D1 (Blocker, `PMXWF-7` + `PMXWF-12`) — completeness becomes a first-class, wire-carried property; the ratio lane stops ranking absence above estimation

Three parts, all in `host/weightedScoring.ts` plus this feature's consumers.

**D1a — a pure completeness predicate.** New export, no behaviour change of its own:

```ts
export interface ScoreCompleteness { declared: number; scored: number; missing: string[]; complete: boolean }
export function scoreCompleteness(set: CriteriaSet, scores: Record<string, number>): ScoreCompleteness
```

A criterion counts as *scored* when its value is a finite number `> 0`.

**CORRECTED after the pre-implementation `/architect` pass — this paragraph originally
claimed the notion already existed "in three places" and it is 2-for-3.** Two places hold it
exactly: `effectiveScore` (`host/weightedScoring.ts:60-64`) collapses a post-clamp `0` to no
contribution, and PM's validators (`asWeight:147-153`, the score loop at `:757-758`) enforce
`1..10`, so on PM data "absent" and "`0`" can never collide. The third citation was **wrong**:
`quadrant.ts:24-32` tests `typeof s === 'number'`, which **accepts `0`**. It is equivalent to
`> 0` on PM data only *because* of those validators, and it is **not** equivalent for
`recommendations`, which passes a literal `0` today (`recommendationsService.ts:416`).

So D1a does **not** merely name an existing convention — it deliberately pins the `> 0`
reading into a **shared** engine one of whose consumers means `0` as a real score. That is
precisely why D1b's default must be off. The two facts are one decision, not two.

**D1b — completeness-major ranking, OPT-IN.**
`rankByPriority(set, items, getScores, opts?: { completenessMajor?: boolean })`.
Default `false` ⇒ **byte-identical to today** for `work-selection/service.ts:49`,
`work-selection/agentTools.ts:78` and `recommendations/recommendationsService.ts:412`.
Priority Matrix passes `true` at `priorityMatrixService.ts:416` and `:435`, so a complete
idea always outranks an incomplete one, and incomplete ideas are ordered among themselves
by priority.

The justification is the one the cost guard already makes: **you cannot rank what has not
been estimated.** D1b generalises that rule to both axes while *preserving* the information
the cost guard destroys — the score and the list of missing criteria survive, instead of
collapsing to `0`.

**D1c — carry it on the wire and stop lying in the UI.** `RankedIdea` gains
`completeness: ScoreCompleteness`. Every consumer of `rank` as fact is updated to state it:
the list, the portfolio (`inListRank`), the federated portfolio
(`federationService.ts:401`), the KB doc text (`priorityMatrixKnowledgeService.ts:93`, which
advisory boards retrieve) and the planning agenda (`buildAgendaMarkdown:1069-1078`, which
today silently omits unscored criteria from "Top factors" rather than naming them). The
overloaded `'Unscored'` label is split: `0 of 4 scored` vs `3 of 4 scored`. The false
frontend docblock is corrected in place rather than deleted — the reasoning trail is the
point, and this is the second time that file has needed a correction note.

**The `computedPriority` VALUE is deliberately unchanged** (see D2's migration note). D1
changes ORDER and DISCLOSURE, not arithmetic.

**Alternative weighed and rejected — symmetric guard.** Copy the cost guard to the benefit
side: any unscored declared criterion ⇒ return `0`. Rejected on two grounds, both measured:
(i) it funnels a 4-of-5-scored idea into **the same `0` that already means "never touched"**,
deepening the exact overloading in measurement (2) rather than curing it; (ii) it is not the
same situation — an unscored *cost* makes the quotient meaningless (divide by a missing
number), whereas an unscored *benefit* merely depresses a well-defined average. Treating them
identically would be symmetry for its own sake.

**Alternative weighed and rejected — mirror `axisValue` and drop unscored benefits from the
denominator.** This makes the defect **worse**, and arithmetic says so: `{10,10,—}` would
score `10.00` instead of `6.67`, i.e. a 2-of-3-scored idea would beat every complete idea
outright. Recorded because it is the intuitive "make List agree with Matrix" move, and it is
backwards.

**Alternative weighed and rejected — global completeness-major ordering.**
**CORRECTED — the original argument here was FALSE in both of its citations, and the
conclusion survives only on evidence it did not cite.** It claimed work-selection would be
demoted because "a work-selection card routinely has no `estimateHours`". Measured:
`estimateHours` **is not a criterion** of `WORK_SELECTION_CRITERIA` at all (the four are
urgency, priority, age, blocked), `projectCardScores` (`compiler.ts:159-166`) **always emits
all four**, and `band()` (`:108`) floors every projector at `1` with the comment *"Never 0 —
see the module header."* **Work-selection is structurally complete and therefore provably
immune.** The `job-search` citation was worse: it calls `computePriority`, never
`rankByPriority` (`surface.ts:84`, `applications.ts:226`, `pipeline.ts:158`), so it is not on
this code path at all.

The consumer that actually forces opt-in is **`recommendations`**
(`recommendationsService.ts:412-419`): `categoryMatch` is a literal `0` on every anchorless
placement, and `affinity`/`recency` legitimately reach `0` (the oldest candidate scores
`recency = 0`). There, `0` means *lowest*, not *unscored* — a global flip would reorder it and
would call every candidate "incomplete" for a reason unrelated to data absence.

**Bound on the rule (added after review).** "A complete idea always outranks an incomplete
one" is unbounded as first written, and the harmful case is real: **one complete idea among
forty incomplete ones pins that idea to #1 on completeness alone, however weak it is** — worse
than today. The first person to score a newly-added criterion on a single idea would promote
it instantly. So completeness-major applies **only when the complete cohort is at least 2
items and a majority of the ranked list**; otherwise the ranking stays priority-major and
D1c's `n of m scored` label carries the disclosure by itself. The falsifier is recorded so the
bound is not later "simplified" away.

### D2 (`PMXWF-8`) — preset fidelity: implement RICE **in band**, state ICE, document WSJF

**This decision was substantially rewritten after the pre-implementation `/architect` pass.
The original specified a raw `Π(benefit^w) / Π(cost^w)`, which (a) re-implemented as
arithmetic the very "symmetric guard" D1 rejects as policy, (b) could return `Infinity`, and
(c) reached 10^190 on a 20-criterion set. All three are recorded below because each was a
real defect in the decision text, not a drafting slip.**

- **RICE — implement it, bounded.** Add `aggregation: 'product-ratio'`, computed as
  `(Π(benefit_i^{w_i}) / Π(cost_j^{w_j}))^{1/Σw}` over the criteria that are **actually
  scored**. The root is a strictly monotonic transform, so ordering is *exactly* published
  RICE; the exponent keeps the result inside the familiar band. **MEASURED** over five ideas:

  | formulation | ordering | max value |
  |---|---|---|
  | today (mean-based) | `A>E>B>D>C` — **wrong** | 10 |
  | published RICE | `B>A>E>C>D` | 1000 |
  | **this decision** | `B>A>E>C>D` — **matches published** | **5.62** (8.91 even at 20 criteria × weight 10) |

  Because D1b ranks the complete cohort together, `Σw` is constant within it, so within the
  cohort the transform is order-identical to the raw product — which is where RICE ordering
  actually has to be right.

- **Degenerate inputs — an explicit contract (was missing entirely).** MEASURED on the raw
  product: one unscored benefit gives numerator `0` ⇒ result `0`, i.e. **the exact overloaded
  sentinel D1 exists to un-overload**; an unscored cost gives `200/0 = Infinity`, which
  `JSON.stringify` writes to the durable `IdeaScore.computedPriority` as `null`. Therefore
  both products are taken over **scored criteria only**, and `product-ratio` **never returns
  `0`-as-sentinel and never returns a non-finite value.** Incompleteness travels on D1's
  `ScoreCompleteness` channel, which is the whole point of D1.

- **WSJF — document, do not change.** Published WSJF divides a **sum** by job size; the engine
  divides a weighted **mean**. Every idea in a list shares the same `Σw`, so this is a constant
  factor: **ordering identical, magnitude not.** A docstring + `scaleHint` correction.

- **ICE — state the choice.** The implementation is the average of Impact/Confidence/Ease,
  matching the GrowthHackers/Sean Ellis definition and diverging from Itamar Gilad's product
  form. Both are live in the field. Record the chosen one in `types.ts`; change nothing.

**The three-site union widening (was missing, and would have silently corrupted data).**
`Aggregation` is `'weighted-sum' | 'ratio'` at `host/weightedScoring.ts:21`, mirrored at
`frontend/react/src/features/priority-matrix/priorityMatrixClient.ts:22`, and — the dangerous
one — `validateCriteriaSet` coerces **binarily**:

```ts
const aggregation = raw.aggregation === 'ratio' ? 'ratio' : 'weighted-sum';   // :157
```

`updateList:293-296` calls this whenever `criteriaSet` or `presetId` is present, and the
settings form round-trips the whole set. Without widening all three sites, a migrated RICE
list would silently flip to **`weighted-sum` — a different family, not even back to `ratio` —**
on the next rename or weight tweak, and `recomputeListScores:836-844` would rewrite every
cached priority under the wrong model with no signal. `product-ratio` is **migration- and
preset-seeded only**: `:157` must *preserve* an existing `product-ratio` rather than accept an
arbitrary one from the request body.

**Migration boundary — ONE predicate (the original stated two incompatible ones).** The draft
said both "aggregation is still the seeded one" and "a list whose weights were tuned is left
on `ratio`". Those are different predicates over different populations, and the first is true
of essentially every RICE list, so it would have migrated exactly the lists the second
promised to leave alone. Worse, `validateCriteriaSet:186` preserves `presetId` verbatim
through arbitrary edits — it is a **label, not a fidelity marker** — so "tuned" was not
detectable the way the draft assumed.

**Chosen predicate: a list migrates when `presetId === 'rice'` and `aggregation === 'ratio'`.**
Tuned weights migrate too, and *should*: a tuned RICE list is computing RICE wrongly in exactly
the same way, and weights remain meaningful as exponents. This is detectable, total, and has no
"two lists labelled RICE compute differently" problem — which also closes OQ-2.

**Migration consequence, stated.** RICE lists **reorder** — that is the fix — and their
displayed numbers change (7.33 → 3.76 on the measured case). They stay in the 0–10 band, so
every formatter, the `PriorityMeter`, the KB doc text (`priorityMatrixKnowledgeService.ts:93`)
and the agenda markdown remain honest, and no stored value changes type.
`IdeaScore.computedPriority` is a cache refreshed by `recomputeListScores` and every read
re-ranks live, so there is no stale-cache correctness problem. A `PlanningSession` carries a
`criteriaSnapshot`, so historical agendas keep their original numbers while a fresh ranking
disagrees — bounded to a factor of ~2 rather than orders of magnitude. The change is announced
in the list UI on first view.

### D3 (`PMXWF-9`) — reuse the ignition latch the repo already owns, and fix the node's declared role

**This decision was rewritten after the pre-implementation `/architect` pass, which found
that the draft stood up a parallel mechanism for a concept this repo already owns — the
CRITICAL boundary violation. Both halves of the original premise were wrong.**

**Falsified premise 1 — "the agent lane needs a content key."** `host/ignitionGuard.ts`
already exists: a durable, tenant-prefixed, cross-instance CAS latch over a sha256 of stable
business inputs, with a replaceable window, a `releaseIgnition` for failed work, and retention
purging. **And this very verb already uses it** — `agentTools.ts:356-358` claims
`ignitionKey('priority-matrix.generate-agenda', listId, name, n)` today. The draft's bespoke
content key would have been a second dedup mechanism beside the first, inheriting none of its
CAS, window, release or purge semantics.

**Falsified premise 2 — "`role:"action"` makes replay safe; the duplicate is fork-only."**
MEASURED in `src/executor/sideEffectFloor.generated.ts`:
`feature.priority-matrix.nodes.generate-agenda` is present in `MANIFEST_DECLARED_TYPE_IDS` and
**absent from both `MANIFEST_SIDE_EFFECT_FLOOR` and `MANIFEST_FAST_PATH_SERVED`** (whose PM
members are exactly the four nodes declared `role:"side-effect"`). The structural backstop does
not cover it either — every `assertEffectAllowed` call site is a network/email/webhook egress
seam, and `DurableCollection` writes, `createDocument` and `addVersion` are not guarded. **So
the node duplicates its session + Document + version on a plain REPLAY, not only on `:fork`.**
The node's declared role has been wrong since it shipped.

**Chosen — two fixes, because there are two defects:**

1. **Replay half — a declaration, not code.** Declare `role:"side-effect"` on `generate-agenda`
   in `packs/feature.priority-matrix.nodes/pack.json`, bump the pack `1.4.0 → 1.5.0`, and
   regenerate `sideEffectFloor.generated.ts`. `src/executor/sideEffects.ts:57-62` names this as
   the designated instrument: *"For a manifest node the fix is now the DECLARATION."*
   `score-idea` (`pack.json:60`, `role:"action"`, writes a durable `IdeaScore`/`IdeaVote`) is
   assessed in the same pass — D4 touches it.
2. **Fork half — extend the existing latch to the unguarded lane.** A declaration cannot help
   on `:fork`, which re-executes everything past the fork point. Of the three
   `createPlanningSession` callers — `routes.ts:629` (human), `surface.ts:111` (run),
   `agentTools.ts:361` (chat, already guarded) — **the run lane is the unguarded one, and it is
   exactly the lane `PMXWF-9` names.** It claims the same `ignitionKey` seam, with the criteria
   contribution as a digest over the ordered `(id, weight, direction)` tuple rather than a
   serialised `criteriaSnapshot` — Postgres `jsonb` does not preserve object key order, so an
   object-serialising key would pass every sqlite-backed test and never fire in production.

**What plays ADR 0590 Decision 4's "pending approval" role:** the ignition **window**. Decision
4 bounded its dedup on pending state to preserve decision finality; sessions have no such
state, and an unbounded content key would have no exit — a user wanting a fresh agenda for this
week's meeting against an unchanged list would get last week's session returned forever. The
window is the bound, and an honest re-generation after it is allowed by design. Within the
window a deduped session is returned as-is even if scores moved without changing order; the
window bounds that staleness to minutes, and the alternative re-mints a Document for a no-op.

**Still correct from the draft:** ADR 0590 Decision 4 already falsified "a deterministic id
derived from run+node identity" for this family — a fork mints a fresh `runId`, so such ids
diverge per fork exactly like `randomUUID()`. That prescription remains dead; it is simply not
the fix, and neither was the draft's.

**Also:** add `SESSION_CAP`. Lists, ideas, evidence, scenarios, peers and history all carry a
cap; sessions carry none, and this is the one writer a run can drive in a loop.

### D4 (`PMXWF-11`) — the partial-score map must not silently delete

`setIdeaScore` writes a **full replace** on both of its paths — the multi-voter `votes.put`
(`priorityMatrixService.ts:773`) and the single-voter `scores.put` (`:802`).
`agentTools.ts:322` and `surface.ts:73-76` forward the caller's map verbatim, so a model
scoring 2 of 5 criteria **deletes the other three**, and the tool then replies
`'Score recorded. Tell the user the idea's new computed priority.'` (`agentTools.ts:324`). The
frontend is the only caller that compensates, rebuilding the full map with a comment naming
this hazard (`PriorityListPage.tsx:400-418`).

**Chosen: the model-facing lanes MERGE; the contract says so.** `setIdeaScore` gains
`mode: 'replace' | 'merge'`. The HTTP route keeps `replace` (the FE sends a complete map, and a
form submit means replace). The agent tool and the run surface pass `merge`, because a model
naming three criteria asserts three values, not the absence of the rest. The tool description
states which it is.

**`mode` threads through BOTH writes** (the draft described only the single-voter shape). In
`multi-voter`, `merge` merges against **the caller's own prior `IdeaVote` row**, never against
the aggregate — an aggregate merge would attribute scores to a voter who never cast them and
would poison `getVoteBreakdown:829-840`, which is shown to users as "who scored it and how".

**Two accepted consequences, stated rather than discovered later:**
- **Merge removes the agent's only way to CLEAR a criterion.** The validator admits `1..10`
  only (`:757-758`), so clearing is expressed by *omission* — which merge reinterprets. This is
  accepted: an untrusted lane silently deleting scores is the defect being closed. If clearing
  is ever needed it lands as an explicit `clearCriterionIds: string[]`, never as omission.
- **Provenance.** Merging an agent's two criteria onto a human's five must not re-stamp the
  human's three surviving scores as `source:'agent'` — that would falsify the ADR 0590 `PMXU-1`
  attribution. The row retains its prior `source` when any pre-existing score survives;
  per-criterion provenance is out of scope and is recorded here as a known imprecision.

### D5 (`PMXWF-10`) — the kanban doors must not bypass PM's cascade or its authority gate

Two distinct defects behind one boundary. **All three mechanism details below were added after
the pre-implementation `/architect` pass; the draft named outcomes without mechanisms, and two
of the obvious mechanisms would have bricked teardown or recursed.**

**(a) Card delete orphans overlays and leaves a deleted idea retrievable.**
`DELETE …/kanban/cards/:cardId` (`routes/kanban.ts:806-827`) runs no PM cascade, where PM's own
`deleteIdea` (`priorityMatrixService.ts:640-660`) cascades seven stores **including the KB
eviction** (`indexIdea`, no caller outside PM). A card deleted from the board leaves its idea's
document serving in the org's managed PM collection, which is shareable to advisory boards. The
overlay rows stay tenant-resolvable via `listId`, so DSAR and teardown still reach them — **not
a PII-forever orphan**, and not filed as one.

`host/kanbanService.ts` has **no hook registry at all** (`deleteCard:563-565` is a bare
`cards.delete`), so PM could not have registered a cascade. **Chosen:** add the seam, shaped
like the existing `registerTenantPurgeHook`/`registerSubjectEraser` registries.

> **Why not the existing event seam?** `host/hostEventDispatcher.ts` (ADR 0208) is documented as
> *"the ONE seam for record-change events that have no run"*, and kanban already emits through it
> (`routes/kanban.ts:272`, `openwop-app.kanban.card-moved`). It is deliberately **not** used here: its
> two fanouts are outbound webhooks and tenant-*configured* workflow bindings — asynchronous,
> at-least-once, unordered, with no failure propagation and no guaranteed subscriber — so it can
> carry a *notification*, never a *cascade obligation*. Note also that kanban emits **no** host
> event on card or board delete today, so there would be nothing to subscribe to even if the
> semantics fit. Recording the rejection is the point: without it, D5 reads as a parallel
> mechanism.

**Re-entrancy (the draft would have recursed).** `deleteCard` has five callers and **three are
PM's own** (`priorityMatrixService.ts:577`, `:645`, `:695`), plus `kicktodo-core/
enrollmentService.ts:718` and the route. So the registered hook must be an
**overlay-cleanup-only, idempotent** function — score/vote/schedule/intake/evidence removal and
the `indexIdea` eviction — and explicitly **not** `deleteIdea`, which orchestrates the card
delete itself. `deleteIdea` keeps its inline cascade; the hook's idempotence is what makes the
duplicate run harmless. The kicktodo caller is an in-scope fan-out.

**(b) Authority downgrade.** `DELETE …/kanban/boards/:boardId` (`routes/kanban.ts:508-519`)
requires only `workspace:write`, while PM's `deleteList` requires `requireListConfigAuthority`
(creator or `host:org:manage`). **An editor who cannot delete a priority list can delete the
board underneath it**, after which `listRankedIdeas` returns `[]` (`:405`) and the list renders
empty with every score, vote, intake and evidence row intact and no signal. This defeats a
promise `FEATURES.md:190` makes in terms.

**Chosen: refuse (409) at the HTTP ROUTE only — `routes/kanban.ts:508`, and nowhere else.**
A service-level refusal in `kanbanService.deleteBoard` would be a gate with no exit: its callers
include `host/rosterCascade.ts:64` (bulk teardown), `features/projects/projectsService.ts:510`,
`kanbanService.ts:366`, and **PM's own** `:270` (post-cap rollback), `:345` (`deleteList`) and
`:1263` (tenant purge). Teardown and cascade must never be refusable.

The predicate reaches the route through the **same inversion registry as (a)** — core route code
must never import a feature package (ADR 0001), so `routes/kanban.ts` never names PM; it asks
the registry whether any registrant claims the board and, if so, reports the owner's own door.

### D6 (`PMXWF-13`, Nice-to-have) — accept the parameter you cannot prove you don't need

`priorityMatrixKnowledgeService.ts:74` implements `resolveCollectionIds` 2-ary against the
3-ary `ShareableKbProvider` contract (`host/shareableKb.ts:26`), dropping `opts.forUnshare`.
**Filed as forward-risk ONLY, and explicitly NOT as a leak.** Verified inert: PM's shareable
set is a singleton whose only predicate is existence; its project-scoped carve-out is applied
at the DOC layer inside `indexList`, which cannot change which collection id resolves; so the
2-ary and 3-ary results are provably identical for every input and `stale = all \ shareable`
is always `∅`. The collection is `managed:'priority-matrix'` and `assertNotManaged` refuses
deletion on every product lane. The justification for fixing it anyway is that **a provider
which does not accept the parameter cannot be proved inert by its signature** — the next
carve-out added to PM silently skips unshare. Sibling instance:
`features/strategy/strategyKnowledgeService.ts:79`. Both take the parameter; neither changes
behaviour today.

## Explicitly NOT filed (recorded so a later pass does not re-spend the effort)

- **`weight: 0` silently becomes `weight: 1`** (`weightedScoring.ts:83,111`,
  `clampScore(w) || 1`; measured 1.82 where honouring 0 gives 1.00). Unreachable in PM
  (`asWeight` throws outside 1..10) **and** in all five sibling consumers, every one of which
  hard-codes weights 2..10. A hardening comment at the two sites, not a defect row.
- **Erasure / teardown / legal hold.** Clean, and — unlike iterations 20 and 21 — **PM is
  explicitly visible to the destructive-lane census**:
  `test/destructive-lane-census.test.ts:178` carries `purgeTenantPriorityMatrix` as
  `registrant-of:${HOSTEXT_PURGE}` → `inherits-from:ACCOUNT_TEARDOWN` → `asserts`. PM's
  product deletes assert no hold, consistent with every feature and with the census's own
  scoped population. A scoping note, not a row.
- **Routes / authz.** All 40 handlers open with `requireFeatureEnabled`; one exported
  `orgScopeGranted` shared with the agent tools (not a copy); uniform 404 with no existence
  leak; IDOR guarded by `board.tenantId === list.tenantId` plus a per-card
  `card.boardId !== list.boardId`. The one authority hole is D5(b), and it lives on the
  kanban side.

## Tracker-integrity corrections carried by this ADR

1. **`PMXWF-3`'s disposition is stale.** It defers to "the ADR 0584 build-time parity gate".
   That gate **landed** (ADR 0617 D4, `test/host-event-catalog-parity.test.ts`);
   `host.priority.` is baselined SHRINK-ONLY in
   `test/fixtures/host-event-catalog-baseline.json`, and the drain is tracked as **`UAUWF-6`**.
   Still open in substance; its fix-path and owner both moved.
2. **Nodes pack is 1.4.0**, not the tracked 1.3.0. Parity holds in the tree; the tracker line
   did not.
3. **`submit-idea` is `role:"side-effect"`**, not `action`. The prior section's replay/fork
   reasoning leaned on "all 11 verbs are `action`".
4. **FEATURES.md ordinal 22 overstates the authority guarantee** — "deleting a list needs
   list-owner or org-admin authority" is defeated by D5(b). Corrected in lockstep with this
   ADR rather than left for a reader to discover.

## RFC verdict

**Host-extension throughout; no new OpenWOP RFC, and no existing RFC is ridden.** Every
surface touched is under `/v1/host/openwop-app/*` (non-normative) or is internal to the host
(`host/weightedScoring.ts`, `host/kanbanService.ts`). No run-event field, capability flag,
event type, endpoint contract, auth/scale profile or normative MUST changes. Nothing here
reaches `/.well-known/openwop`, so no advertisement becomes dishonest. `RankedIdea` (D1c) is
a host-ext response shape, not a wire type. D5's new hook is an in-process registry, not an
interop seam. **CORRECTED after review — the original flag was mis-aimed.** It said the risk was that D3
changes fork behaviour. The actual risk is that `generate-agenda`'s **declared role has been
wrong since it shipped**: the node is absent from both `MANIFEST_SIDE_EFFECT_FLOOR` and
`MANIFEST_FAST_PATH_SERVED` (measured), so the duplication happens on plain **replay**, and the
fix is a pack-manifest declaration that moves the ADR 0572 served-set ratchet under
`docs/steward/`. That is a host-internal classification change, not a wire change — but it is
the item to watch in P3, and `score-idea` is assessed with it.

## Phases

| Phase | Scope | Gap ids |
|---|---|---|
| P1 | `scoreCompleteness` + opt-in completeness-major ranking + wire/UI disclosure + the false-docblock correction | `PMXWF-7`, `PMXWF-12` |
| P2 | `product-ratio` + RICE migration + WSJF/ICE documentation | `PMXWF-8` |
| P3 | agenda content-keyed dedup + `SESSION_CAP` | `PMXWF-9` |
| P4 | `setIdeaScore` merge/replace mode + tool contract | `PMXWF-11` |
| P5 | card-delete hook seam + board-delete 409 | `PMXWF-10` |
| P6 | 3-ary `resolveCollectionIds` in both inert providers | `PMXWF-13` |

## Open questions — all four CLOSED by the pre-implementation review

- **OQ-1 (show the number for an incomplete idea?) — RESOLVED: keep it.** Suppressing the
  number destroys a genuinely useful provisional signal *and* re-creates the one-label-for-two-
  states defect D1 exists to fix (a suppressed number is indistinguishable from an absent one).
  The disclosure is the `n of m scored` count beside the number, plus a visible tier break
  between the complete and incomplete cohorts.
- **OQ-2 (two lists both labelled RICE computing differently?) — RESOLVED: cannot arise.** D2's
  single migration predicate (`presetId === 'rice' && aggregation === 'ratio'`) is total over
  RICE lists, so there is no tuned/seeded split and `scoringModelOf:482`'s "RICE" label stays
  true for every list carrying it.
- **OQ-3 (does D5(b)'s 409 strand a list?) — RESOLVED: no, with one path to check in P5.**
  `requireListConfigAuthority` is creator **OR** `host:org:manage`, so a departed creator's list
  is still deletable by any org admin. The residual case worth checking during P5 is a
  `projectId`-scoped list whose board carries an `ownerSubject`: an org admin who is not a
  project member may not be able to *see* it in order to delete it.
- **OQ-4 (a future consumer with a legitimate `0`?) — RESOLVED: it is not future.**
  `recommendations` passes a literal `0` for `categoryMatch` today
  (`recommendationsService.ts:416`). This is the live justification for D1b's opt-in default,
  and it is now stated in D1a rather than deferred.

## What the pre-implementation review changed (recorded, not silently fixed)

The `/architect` pass on this ADR's decision text returned **10 Blockers**, and the four most
valuable of them falsified **my own reasoning**, not the code:

1. **D3 stood up a parallel mechanism.** `host/ignitionGuard.ts` already owns idempotent
   ignition, and `generate-agenda` already claims it on the chat lane
   (`agentTools.ts:356-358`). The draft invented a second dedup beside the first.
2. **D3's replay premise was false.** MEASURED: the node is absent from both
   `MANIFEST_SIDE_EFFECT_FLOOR` and `MANIFEST_FAST_PATH_SERVED`, so it duplicates on plain
   replay — the fix is a pack-manifest **declaration**, which the draft never mentioned.
3. **D1b's justification cited two features that cannot be affected.** work-selection is
   structurally complete (`band()` floors at 1, "Never 0"); job-search never calls
   `rankByPriority`. The conclusion (opt-in) was right; the argument was fabricated from
   plausible-looking comments. The real justification — `recommendations` passing a literal
   `0` — was uncited.
4. **D1a's "three places" was 2-for-3**, and the third citation (`quadrant.ts:24-32`) tests
   `typeof s === 'number'`, which accepts `0` — the opposite of the rule it was cited for.

Also corrected: D2's raw product could return `0` (re-implementing the guard D1 rejects) or
`Infinity`, and reached 10^190; its migration boundary was stated two incompatible ways and the
"tuned" half was undetectable because `presetId` is a label, not a fidelity marker. D5 would
have recursed through PM's own three `deleteCard` calls, and a service-level board-delete
refusal would have bricked teardown, roster cascade and PM's own `deleteList`.

**The transferable lesson matches this repo's own doctrine: a citation is a claim, not
evidence.** Every falsified item above read as reasonable prose and collapsed under one grep.
The ADR was reviewed before a line of code was written, which is the only reason these are
corrections to a document rather than defects in a shipped feature.

## Phases

| Phase | Scope | Gap ids |
|---|---|---|
| P1 | `scoreCompleteness` + opt-in, bounded completeness-major ranking + wire/UI disclosure + the false-docblock correction | `PMXWF-7`, `PMXWF-12` |
| P2 | `product-ratio` (bounded, scored-only) + the three-site union widening + RICE migration + WSJF/ICE documentation | `PMXWF-8` |
| P3 | `role:"side-effect"` declaration + pack `1.4.0→1.5.0` + regenerated floor (replay half); ignition claim on the run lane (fork half); `SESSION_CAP` | `PMXWF-9` |
| P4 | `setIdeaScore` merge/replace across both write paths + tool contract | `PMXWF-11` |
| P5 | idempotent overlay-only card-delete hook + route-scoped board-delete 409 via the same registry | `PMXWF-10` |
| P6 | 3-ary `resolveCollectionIds` in both inert providers | `PMXWF-13` |

## Status correction (2026-09-17)

This record read `Status: Proposed` while its decision was already merged in **#3789**. It was on the steward staleness baseline (`backend/typescript/test/steward/adr-status-not-stale.test.ts`) as *flagged but unverified*; the status above was established by reading the code, not the commit message.

**Evidence.** P1 `host/weightedScoring.ts:181,198,223-249` + `features/priority-matrix/priorityMatrixService.ts:435`; P2 `weightedScoring.ts:21,76,94`; P3 pack 1.5.0 + `features/priority-matrix/surface.ts:114-140`; P4 `priorityMatrixService.ts:841-932`; P5 `routes/kanban.ts:516-531`; P6 both inert providers.
