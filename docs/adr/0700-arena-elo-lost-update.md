# ADR 0700 — Seven of eight arena verdicts vanish, and the rating endpoint reports it as fact

Status: **implemented** (status corrected 2026-09-17 — see § Status correction)

Feature loop 2026-09, iteration 38 — Evals leaderboard (`FEATURES.md` ordinal 206,
ADR 0123). Graded at `origin/main` `5a846c3d1`. Ids continue the 2026-08-27 pass
(`EVC-`/`EVWF-`).

## D1 (Blocker, `EVC-7` — severity raised on measurement)

`features/evals/arena.ts:86-91` reads two rating rows, computes the Elo pair, and
writes both back with plain `put`s — a read-modify-write accumulator with no
compare-and-swap.

**MEASURED**, in-memory, single process, the same eight identical verdicts (eight
distinct raters, A wins every time, so no rate-limit interaction):

| | alpha's Elo after 8 wins |
|---|---|
| **Sequential** | **1594.95** |
| **Concurrent** | **1516.00** |

Base is 1500, so the truth is **+94.95** and the store reports **+16.00** — exactly one
verdict's worth. **Seven of eight are lost**, an ~83% signal loss, and
`GET …/arena/rating/:model` (`routes.ts:77`) serves the result as fact.

Same shape as `UAC-3` (ADR 0694), where the equivalent measurement was 49 of 50.

### The filed row reasons about one axis

`EVC-7` is Nice-to-have because *"harm is limited — concurrent deltas clobber (lost
updates) rather than compound, and sequential remains the attacker's capped best."*
That is **correct about the attack** and says nothing about correctness: a rating
nobody attacked is still wrong by 83% of its signal. Losing an honest verdict is not
mitigated by the fact that losing a dishonest one is inconvenient for the attacker.

### The blast radius is NARROWER than I first claimed — corrected by tracing the consumer

My own recon said *"this feature's entire output is a RANKING, so the leaderboard is
quietly wrong."* **That is false.** `leaderboard.ts:65-67` `combineLeaderboard` is a
**pure function over `RatedTurn[]` passed in by the caller**, computing Elo via
`computeEloRatings` from message-feedback rows. It never reads the arena `ratings`
collection. The leaderboard is unaffected.

What is actually affected:

- `GET …/arena/rating/:model` — the only exported reader (`getArenaRating`,
  `arena.ts:97` → `routes.ts:77`).
- The `matches` counter on the same row, which loses the same way — **and is read by
  nothing.** An inert field, the ADR 0698 family; noted, not inflated.

**Trace the consumer before asserting the impact.** The recon was written from the
feature's headline description, and the description was not the code.

### Decision

- **D1a** — apply each rating row through a bounded CAS retry that **re-reads that row
  inside the loop** (`DurableCollection.compareAndSwap` compares the whole row by
  value, so a stale `next` can never win). Shape follows `host/workflowBudgets.ts` and
  the `recordUsage` fix in ADR 0694.
- **D1b** — **state what this does NOT give.** Elo is zero-sum across a pair, and two
  independent per-row CAS loops do not make the pair atomic: under concurrent updates
  to the *same pair*, A's gain and B's loss can be computed against slightly different
  snapshots. **No verdict is lost**, which is the defect; exact pairwise conservation
  is not claimed, was not provided before either, and would need a different design
  (a single row per pair, or a per-tenant serialisation point). Recorded as an open
  question rather than silently implied.

  **MEASURED after the fix**, same eight verdicts: concurrent **1628.00** against
  sequential **1594.95**. Concurrent legitimately *overshoots*, because Elo is
  **path-dependent** — run sequentially each win yields a smaller delta as the winner
  rises, while concurrently all eight compute from the same 1500/1500 snapshot and
  eight full +16s land. So the defect (1516, one verdict) is gone and the residual is
  exactly the one predicted above, with a number on it.

  The witness pins the invariant that actually holds — **eight verdicts land, not
  one** — not `concurrent === sequential`. My first version of that leg asserted
  `|conc − seq| < 1`, which demanded a path-independence Elo does not have and would
  have made the test wrong rather than the code.

## D2 — my it.35 accumulator census had FALSE NEGATIVES, and I did not say so

ADR 0694 reported "13 accumulator candidates, 1 confirmed sibling, 1 confirmed false
positive, 11 unverified", and flagged the count as *"a floor with known false
positives."* It was a floor in the other direction too, and that half went unstated.

**`features/evals/arena.ts` was not among the 13.** Mechanism: that census required
`await COLL.get(` followed by `await COLL.put(` — a **direct** get on the collection.
Here the read is `await ratingOf(...)`, a helper one level of indirection away, so the
pattern could not see it.

Re-running with a different signal (an object-literal `put` whose body derives
`field: x + y`) finds **6** sites, **2** of which were absent from the 13 —
`evals/arena.ts:90` and `host/workflowRevisions.ts:169`. But that census **misses
several the first one caught** (cms, commerce-connect, cdp, auditChain, customDomains,
triggerBridge, twinService), because those do not use an object-literal put.

**Neither census is complete; they have different blind spots and the union is larger
than either.** Neither 13 nor 6 is "the population". `host/workflowRevisions.ts:169` is
recorded here as an unverified candidate for its own iteration — not fixed in a feature
pass that does not own it.

## Re-verified and dispositioned (do not re-spend)

- **`EVC-5`** (multi-account ballot-stuffing still clears +200) — real and open.
  **Deliberately not bundled:** the durable fix is an identity-cost control or binding
  a match to two real dispatched run ids, which is a design decision with a product
  cost, not a correctness patch. Note `EVC-2`'s `[x]` means "one identity < +200",
  **not** sockpuppet-proof.
- **`EVC-6`** (`MAX_RATER_MATCHES_PER_MODEL = 8` may over-restrict a thorough rater) —
  a tuning judgement; the cap fails closed with an honest 429. Untouched.
- **Hygiene note, found by breaking my own experiment:** the `matches` collection is
  keyed by `matchId` **alone** (`arena.ts:32`), with tenant only as the index
  extractor. So the idempotency guard at `:66` is a **global** point-get. Server-minted
  ids make a real collision negligible, but it silently invalidated my first
  sequential control — the "sequential" tenant replayed the concurrent tenant's ids and
  recorded nothing. Worth a tenant-scoped key on the next touch; not changed here,
  because changing a durable key shape is a migration, not a drive-by.

## RFC verdict

**No RFC.** Host-ext throughout: an internal write path behind an existing
non-normative route. No wire shape, no capability advertisement, no conformance claim.

## Open questions

1. Pairwise Elo conservation under concurrent updates to the same pair (D1b).
2. `host/workflowRevisions.ts:169` — the other census hit, unverified.
3. Whether `matches` should be read by anything, or dropped. An inert counter that is
   also lossy is the worst of both.

## Status correction (2026-09-17)

This record read `Status: Proposed` while its decision was **already implemented and
merged**. Evidence: `dcc8992aa` is NOT this ADR — that citation belongs to the decision renumbered to **0702** in the #3878 collision. The evidence for THIS one is the code: `features/evals/arena.ts` carries `RATING_CAS_ATTEMPTS` + `compareAndSwap`, and its comment names the defect this ADR describes ("a read-modify-write with no CAS").

Corrected as part of an ADR-status sweep that found **five** such records (0700, 0701,
0703, 0707, 0708). The failure mode is not cosmetic: `Status:` is the field a planner
reads to pick work, so a stale `Proposed` either sends someone to redo finished work
or tells them a closed defect is still open. `docs/adr/adr-status-not-stale.test.ts`
now fails when an ADR with a merged implementing commit still reads `Proposed`.

Verified per-ADR against the code (`features/evals/arena.ts`), not by counting commits — an early pass
of this sweep matched commit BODIES and produced contaminated counts, and ADR 0700's
own citation belongs to a decision that was renumbered away from it.

