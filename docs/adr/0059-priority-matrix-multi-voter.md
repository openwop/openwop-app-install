# ADR 0059 — Priority Matrix: multi-voter scoring

**Status:** implemented (this conversation)
**Date:** 2026-06-16
**Toggle:** none new — extends the existing **`priority-matrix`** feature (ADR 0058). The
behaviour is opt-in **per list** via a `votingMode` field, not a separate toggle.
**Depends on / composes:** ADR 0058 (Priority Matrix), ADR 0006 (RBAC — voting is a
`workspace:write` act; switching modes is config-authority).
**Surface:** host-internal, under the existing `/v1/host/openwop-app/priority-matrix/*`.
**RFC gate:** **NO new RFC** — host-extension, no wire change. (Cross-list/portfolio
rollup would be the wire case; it stays parked.)

## Why this exists

ADR 0058 §Open-questions flagged that v1 stores **one `IdeaScore` per idea** — a single
shared, last-writer-wins score. For a real prioritization board a team wants **each member
to score independently** and rank by the **aggregate**, so one loud voice can't silently
overwrite the group. The caller (this conversation, 2026-06-16) greenlit per-user votes +
aggregation; the other two open questions (portfolio rollup, `Urgent`-status overlap) stay
parked.

## Decision

A list opts into multi-voter scoring; nothing else about the feature changes.

- **`PriorityList.votingMode: 'single' | 'multi-voter'`** (default `single` — fully
  back-compatible; existing lists keep their `IdeaScore` shared-score path untouched).
- **`PriorityList.voteAggregation: 'mean' | 'median'`** (default `mean`) — how per-criterion
  votes combine.
- **New `IdeaVote`** record, keyed `(listId, cardId, voterId)` — one row per voter per idea,
  holding that voter's `scores` map. A separate store; the `single`-mode `IdeaScore` store is
  left exactly as-is (no migration, no fork).
- **Scoring path branches on `votingMode`:**
  - `single` → unchanged: the shared `IdeaScore` feeds `computePriority`.
  - `multi-voter` → `setIdeaScore` upserts the **acting user's** `IdeaVote`; ranking
    aggregates every voter's score **per criterion** (mean or median) into one effective
    score map, then runs the **same `computePriority`** engine (Weighted-Scoring / ratio,
    ADR 0058 — the aggregation is upstream of the formula, so WSJF/RICE presets still work).
- **Read shape** (`RankedIdea`) gains `voterCount` and the caller's own `myScores`, so the
  UI can show "your vote" vs the group aggregate. The `scores` field is the **effective**
  (aggregated) map used for ranking; `computedPriority` is the aggregate priority.
- **Authority:** casting/changing your own vote is `workspace:write` in the list's org (same
  as scoring today). **Switching `votingMode`/`voteAggregation`** is a scoring-model change,
  so it rides the **config-authority** gate (list creator or org admin) alongside criteria
  edits.
- **Replay:** votes are live state read at rank time (like the existing scores); planning
  sessions already snapshot the criteria + selected ideas, so a generated agenda is
  unaffected by later vote changes. No `featureVariant` stamp (ADR 0058 reasoning holds).

## Aggregation

Per criterion `c`, over the set of voters who scored idea `i`:
- **mean** — arithmetic mean of `vote.scores[c]` (missing = absent, not 0; a voter who
  skipped a criterion doesn't drag it down).
- **median** — middle value (lower-mid on an even count).

The aggregated map is rounded per existing display rules and fed to `computePriority`. An
idea with **zero votes** aggregates to an empty map → priority 0 (ranks last), same as an
unscored single-mode idea.

## Phased plan

- **Phase 1 — backend:** `votingMode`/`voteAggregation` on `PriorityList` (create + config
  update); `IdeaVote` store + aggregation; `setIdeaScore`/`listRankedIdeas` branch; cascade
  votes on list delete; surface unchanged (the `workflow` voter is just another voter id).
- **Phase 2 — frontend:** voting selector on the create form; in a multi-voter list the
  score grid edits **your** vote (`myScores`) and a "Votes" column shows the voter count; the
  ranked priority is the aggregate.
- **Tests:** two voters' independent scores aggregate (mean + median); a second voter does
  **not** overwrite the first; mode switch is config-authority-gated; single-mode unchanged.

## Alternatives weighed

- **Replace `IdeaScore` with votes wholesale** (every list multi-voter) → rejected: a hard
  migration of existing single-score lists for no benefit to solo boards. Opt-in per list,
  two stores, zero migration.
- **Aggregate by re-computing each voter's priority then averaging priorities** → rejected:
  averaging per-criterion *scores* before the formula keeps WSJF/RICE ratios meaningful
  (averaging final ratios distorts them).

## Open questions

- [x] Vote **visibility** — DONE (2026-06-16): a per-voter breakdown ships at
      `GET .../ideas/:cardId/votes`, **config-authority gated** (list creator or org admin —
      votes can be sensitive; regular members keep aggregate + their own vote). FE: a Modal
      from the "Votes" count. Full-transparency-to-all-members remains a future opt-in.
- [x] **Weighted voters** (e.g. a chair's vote counts more) — DONE (2026-06-16): an
      optional `voterWeights` map on `PriorityList` (voterId → integer 1..10; absent/uniform
      = equal weight, **exact prior behaviour preserved**). When weights differ, `aggregateVotes`
      switches from the equal-weight mean/median to the **weighted arithmetic mean** (WAMM,
      the standard for 1–10 stakeholder scoring) for `mean` mode and a **lower weighted
      median** for `median` mode — weights are never silently ignored in either mode. The
      map is **config-authority-set** (list creator or `host:org:manage`, same gate as
      criteria/mode edits), validated (integers 1..10, out-of-range dropped, capped at 500
      entries), and is plain config like the criteria weights — re-ranking is a live read on
      each `listRankedIdeas`, so **no run-stamp / recompute** is needed and replay/fork is
      unaffected. Host-internal (no wire/RFC). FE: a per-voter 1–10 weight selector in the
      owner/admin vote-breakdown Modal. This follows the established **Limited Weighted
      Votes (LWV)** governance pattern. No parallel system — weights live on the single
      `PriorityList` config record, not a second store or a role-derived RBAC coupling.
- [x] **Mode-switch seeding** — DONE (2026-06-16): on a single→multi-voter switch, `updateList`
      seeds the **creator's** `IdeaVote` from each existing shared `IdeaScore` (idempotent,
      non-destructive), so prior scores survive the switch instead of vanishing. multi→single
      was already lossless. Closes the limitation this list previously flagged.

## Implementation ledger

Shipped 2026-06-16. `votingMode`/`voteAggregation` + `IdeaVote` + `aggregateVotes` +
branched `setIdeaScore`/`listRankedIdeas` (+ cascade) in `priorityMatrixService.ts`;
`votingMode`/`voteAggregation` accepted on create + config-gated on update in `routes.ts`;
FE create-form selector + per-user vote grid + "Votes" column. Tests in
`test/priority-matrix-multivoter.test.ts`. Backend `tsc` + frontend `npm run build` green.

**Weighted voters (2026-06-16):** `voterWeights?: Record<string, number>` on `PriorityList`
(`types.ts`); `weightedMean`/`weightedMedian` + uniform-detection in `aggregateVotes`
(unweighted lists unchanged) + `parseVoterWeights` (1..10, capped) in `priorityMatrixService.ts`;
`voterWeights` accepted on `updateList`, config-authority-gated on the PATCH route (`routes.ts`);
FE per-voter weight selector in the breakdown Modal (`PriorityMatrixPage.tsx` + `priorityMatrixClient.ts`).
Tests: weighted aggregate shifts toward the heavier voter; config-authority 403 + out-of-range
drop in `test/priority-matrix-multivoter.test.ts`.

**Correction (code-review 2026-06-16):** the "unweighted fast path" guard was originally
`every weight === 1`; corrected to `every weight equal to each other`. With equal weights the
weighted *mean* is identical to the plain mean, but the (lower) weighted *median* is not
identical to the averaged unweighted median — so a list whose voters were all set to the same
non-1 weight would have silently changed its median ranking. Now any all-equal-weight list
takes the unweighted path. Regression test added (uniform weight 5 ≡ default, median mode).
