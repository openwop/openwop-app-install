# ADR 0695 — The usage rollup lost 49 of 50 concurrent increments, in ONE process

Status: Proposed

Feature loop 2026-09, iteration 35 — Usage analytics (`FEATURES.md` ordinal 203,
ADR 0118). Graded at `origin/main` `79a38937e`. Ids continue the 2026-08-27 passes
(`UAC-`/`UAWF-`).

## Context

The 2026-08-27 passes graded this feature **A− / A− / B+** — a well-graded surface,
and this is deliberately a small iteration. One filed row was worth reopening, and
measuring it changed what it says.

## D1 (Blocker, `UAC-3` — severity raised on measurement)

`recordUsage` was a plain read-modify-write: `rollups.get(key)` then `rollups.put(next)`
with no compare-and-swap.

**MEASURED, in-memory backend, SINGLE process:** 50 concurrent `recordUsage` calls
for one `(tenant, provider, model)` produced **`calls=1, inputTokens=1`**. Forty-nine
of fifty increments were dropped — every caller awaited the same `get`, all read `0`,
all wrote `1`.

### The filed row understated it, and the understatement was the load-bearing part

`UAC-3` said increments drop "on a **multi-instance** deploy". That framing makes it
a scale problem you would reach for `maxScale` to reason about. It is not: **the
interleave is the Node event loop**, so a single instance serving concurrent chat
turns already loses nearly everything. `host/exchange/dispatchTurn.ts:108` fires
`recordUsage` per turn, detached — precisely the concurrent shape.

Had I taken the row at its word I would have reasoned about instance counts and
written a witness that could not fail on one process. **Documented defects are
understated; measure the instance before believing the description.**

### Decision

- **D1a** — a bounded CAS loop, shape copied from the closest in-repo sibling,
  `host/workflowBudgets.ts:192-222` (a spend accumulator): 8 attempts, jittered
  backoff on retries, and **re-read + rebuild inside the loop**.
  `DurableCollection.compareAndSwap` compares the **whole row by value**
  (`hostExtPersistence.ts:659`, `JSON.stringify(expected)`), so a stale `next` can
  never win a swap — rebuilding is not optional.
- **D1b — on exhaustion, THROW; never return the last computed row.** It was never
  persisted, so returning it is success-with-wrong-data: the reporting equivalent of
  the success-with-empty failure this repo forbids on model paths. The only caller is
  fire-and-forget (`void … .catch(…)`), so throwing cannot break a chat turn.
- **D1c** — `logger.warn('usage_rollup_contention')` **inside** `recordUsage`, so a
  systematic loss is visible regardless of what the caller does with the rejection.
- **D1d** — raise the caller's swallow from `debug` to `warn`
  (`dispatchTurn.ts`). Sustained CAS loss is exactly the condition under which usage
  figures silently drift; it must not sit at a level nobody ships.

**MEASURED after the fix:** 50 / 100 / 200 concurrent writers all land with **zero
rejections**, so 8 attempts absorbs well past a realistic turn burst. The witness
asserts **conservation** (`landed + rejected === N`) rather than "never rejects" —
a rejection is visible, a lost update is not, and pinning the weaker invariant keeps
the test honest if the ceiling is ever reached.

## D2 (recorded, NOT fixed here) — this is a CLASS, and the count is a floor

Enumerating by call graph rather than fixing the instance in front of me:

- **212** read-modify-write pairs without CAS corpus-wide. **Most are not defects** —
  last-writer-wins is the intended semantic for an ordinary field set (editing a CMS
  page). The lost-update hazard is specific to **accumulators**, where a dropped
  write loses data permanently and silently.
- Narrowing heuristically to accumulators: **13 candidates**.

**Reported as "13 heuristic candidates, 1 confirmed sibling, 1 confirmed false
positive, 11 unverified" — never as "13 defects".** I spot-checked two, and both
results were corrective:

- `features/kb/embedBudget.ts:45` — **CONFIRMED sibling, and an enforcement gate.**
  `recordEmbedUsage` accumulates `prior + tokens` with a plain put, and
  `checkEmbedBudget:34` reads that counter to decide `exceeded` — so lost increments
  let a tenant **exceed the cap**. *But* the function is documented "best-effort" and
  the check is documented **fail-open**, so the feature already accepts approximate
  accounting by design. That makes it an **Improvement, not a Blocker**: the
  fail-open posture is documented for *errors*; a silent undercount from a *race* is
  a different thing and is undocumented. **Its own iteration, with that nuance
  engaged — not a drive-by fix here.**
- `host/triggerBridgeService.ts:282` — **FALSE POSITIVE.** `dedupCol.get(dedupKey)`
  is a plain existence check, not an accumulator; the regex matched a `+` elsewhere
  in the window. (There does appear to be a genuine TOCTOU there — two concurrent
  deliveries both reading `null` and both firing — but that is a **different class**
  and folding it into this count would corrupt both numbers.)

## Re-verified and dispositioned (do not re-spend)

- **`UAC-4`** ("`usage:rollup` has no `tenantOf` extractor") — **not a teardown gap.**
  `purgeTenantRows` falls back to `jsonTenantId(parsed)` when a collection has no
  extractor, and the row carries `tenantId`. Established in it.34. The CAS path is
  likewise unaffected: `compareAndSwap`'s marker branches are `tenantOf`-guarded and
  simply skipped. A performance note (full scan) at most.
- **`UAC-2`/`-6`** (`:orgId` is a membership proof; stale `costUsd` docstring) —
  unchanged, still Nice-to-have, untouched here.
- **`UAC-5`** (no route-level RBAC/toggle/tenant test) — real and still open. Not
  bundled: it is a route-surface gap, this ADR is a data-integrity fix, and merging
  them would make one witness answer two questions.

## RFC verdict

**No RFC.** Host-ext throughout: an internal write path behind an existing
non-normative route, no wire shape, no capability advertisement, no conformance
claim, no event.

## Open questions

1. Whether `CAS_ATTEMPTS = 8` should be shared with `workflowBudgets` rather than
   duplicated. Two constants is the smaller evil today; a third accumulator is the
   point at which a shared `mutateWithCas` helper earns its place.
2. `embedBudget`'s fail-open posture (D2) — a product call, not a bug fix.
