# ADR 0699 — The extraction runs where CPU is not guaranteed, and its failure is silent

Status: **Accepted — PARTIALLY implemented** (verified 2026-09-17, #3868)

Feature loop 2026-09, iteration 37 — Chat memory auto-extraction (`FEATURES.md`
ordinal 205, ADR 0120/0044/0587). Graded at `origin/main` `093e1ec42`. Ids continue
the 2026-08-27 passes (`MXC-`/`MXWF-`).

## Context

**This is a deliberately small iteration and the report says so.** All three prior
passes graded **A−** with **0 Blockers**, and independent re-verification agrees: the
doctrine is clean, the consent gate is genuinely fail-closed
(`extractionOp.ts:37` — a point-get that returns `skipped:'no-consent'` *before* any
LLM call), and the trust mapping has a real consumer. One filed row is understated,
and the understatement is the whole finding.

## D1 (Blocker, `MXC-1` — severity raised) — detached work, where CPU is not guaranteed

`maybeExtractMemoryOnClose` is fire-and-forget (`exchange/persistExchange.ts:117-118`,
`void … .catch((e) => logger.debug(…))`), called at
`conversationExchange.ts:201` with `return` on the **next line**. So the work that
continues after that point is an **LLM call** — seconds of latency — and it runs after
the response is flushed.

`ARCHITECTURE.md:147` (the "Work that OUTLIVES the thing that started it" seam row) is
unambiguous about what that costs:

> Cloud Run sets `cpu-throttling=true`, so once a response is flushed the instance is
> throttled … and a detached continuation may not resume for a long time — MEASURED at
> 16+ minutes in #3056, with active traffic throughout, **i.e. effectively never for any
> purpose that matters** … Prefer finishing the work IN-REQUEST (`await` it, bounded) —
> **that is the only place CPU is guaranteed.**

The filed row rates this *"Acceptable for best-effort memory."* Against the seam row's
own measurement, "best-effort" is not what this shape delivers — it is closer to "does
not run", and the user has explicitly opted in.

### Two branches, and BOTH are findings

I could not determine the live posture from the repo, and that is itself the result:

- **If `cpu-throttling=true`** (what `ARCHITECTURE.md:147` states as current), the
  extraction effectively never completes and an opted-in user's memory is silently
  never written.
- **If the posture was flipped** via DEPLOY.md's `--no-cpu-throttling` one-liner
  (`DEPLOY.md:705-718`, presented as an opt-in change applied *without redeploying*,
  so it leaves no trace in the tree), then `ARCHITECTURE.md:147`'s current-state claim
  is **stale** — and every reader inherits it, exactly as this one did.

**The fix below is correct under both branches**, so the ambiguity does not have to be
resolved to act. Resolving it is an open question, not a blocker.

### This lane has ALREADY been silently inert once

`extractionBinding.ts:38-49` records ADR 0666 D1: a doubled `user:` prefix meant the
grant check could never match, so **"the lane never wrote in production … the cost was
an inert feature and a consent control that did nothing."** Fail-closed, so nothing
leaked — and nothing surfaced it either.

That is the same *observability* failure in a different mechanism. A feature that has
already been dead in production once, undetected, should not also be running its only
write where CPU is not guaranteed and logging nothing when it does not finish.

### Why the obvious observability fix does NOT work

My first design was to leave the call detached and race it against a timer, logging a
warning if the timer won. **That is wrong, and the reason matters:** under CPU
throttling the *timer callback is throttled too*. An observer built on `setTimeout`
cannot fire under the exact condition it exists to observe. This is the #3056
signature — "ten requests served, **ZERO** fetch failures logged" — reproduced in the
instrument rather than the subject.

### Decision

- **D1a** — **await it in-request, bounded.** `maybeExtractMemoryOnClose` becomes
  `async` and `conversationExchange.ts:201` awaits it. This is the shape
  `ARCHITECTURE.md:147` names as the only one with guaranteed CPU.
- **D1b** — bound it, so a hung provider cannot wedge conversation close. If the bound
  wins, the extraction is abandoned and a **`warn`** is emitted — and that warn is
  reachable, because we are still in-request with CPU allocated.
- **D1c** — the latency is paid by **exactly the users who asked for it**. Without a
  grant, `extractionOp.ts:37` returns after one point-get, so an un-opted-in close
  pays a store read and nothing more. Awaiting is therefore free for the overwhelming
  majority of closes, and honest for the rest.

**Deliberately NOT done:** a durable queue. `host/durableQueue.ts` exists but is a
*pack surface* (`registerSurfaceAdapter('queue', …)`), with no host-side drain for
work of this kind. Building one would be the right answer at higher volume, and the
wrong scope for an A− feature — recorded as an open question, not smuggled in.

## D2 (Nice-to-have, `MXC-3`) — pin the tag→trust mapping

`extractionBinding.ts:30` maps `source:'auto-extract'` ⇒ `contentTrust:'untrusted'` +
`MEMORY_UNTRUSTED_TAG`, and unlike the inert stamp in ADR 0698 **this one has a real
consumer**: `host/memoryTrust.ts:63` `isUntrustedMemoryRow(tags, content)` reads the
tag, and `agentKnowledgeComposition.ts:108-109` partitions on `contentTrust`. No test
proves the mapping surfaces, so a refactor could sever it silently.

**The contrast is the point, and it is why "grep the consumer" is the check rather than
"read the comment":** ADR 0698's stamp and this one look identical at the write site
and have opposite verdicts. One is inert; this one is load-bearing.

- **D2a** — a witness asserting an auto-extracted note is classified untrusted through
  the real predicate, and that a normal note is not.

## Re-verified and dispositioned (do not re-spend)

- **`MXC-2`** (no TOTAL storage cap on accumulated auto-notes) — real and still open.
  **Deliberately not bundled:** it is a capacity/retention decision (a per-subject cap,
  or retention, or neither) with a product judgement attached, and this ADR is a
  correctness fix. Merging them would make one witness answer two questions.
- **`detached-latch-tripwire.test.ts` correctly does NOT cover this call.** It guards
  module-scope promise **latches** — the property that a stuck attempt cannot block the
  *next* one forever. This call holds no latch, so its absence is right, not a gap.
  The rule it does miss ("prefer in-request") is stated as a preference and is
  unenforced — noted below.

## RFC verdict

**No RFC.** Host-ext throughout: a call-site await, a bound, a log level, and a test.
No wire shape, no capability advertisement, no conformance claim.

## Open questions

1. **Which CPU posture is live.** Answerable only against the running service
   (`gcloud run services describe`), not the repo. Worth settling because
   `ARCHITECTURE.md:147` asserts it as current fact and several other seams reason from
   it — `host/runDispatch.ts:105` and four more `setImmediate` dispatches are named in
   `DEPLOY.md:733-737` as "the same shape".
2. **The seam row's rule is broader than its enforcement.** "Prefer finishing the work
   IN-REQUEST" covers all detached work; the tripwire covers only the latch third of
   it. Whether the rest should be enforced (and how, without flagging every legitimate
   `void`) is its own decision.
3. A host-side drained queue for best-effort post-response work (D1's deferred option).

## Status correction (2026-09-17)

This record read `Status: Proposed` while its decision was already merged in **#3868**. It was on the steward staleness baseline (`backend/typescript/test/steward/adr-status-not-stale.test.ts`) as *flagged but unverified*; the status above was established by reading the code, not the commit message.

**Evidence.** D1a `host/conversationExchange.ts:206` awaits `maybeExtractMemoryOnClose` (rationale `:202-205`); D1b `host/exchange/persistExchange.ts:153-172` races the extraction against `memoryExtractionBudgetMs()` (`:112`, `OPENWOP_MEMORY_EXTRACTION_BUDGET_MS`, default 8000, timer `unref`'d), warning `memory_extraction_failed` `:167` and `memory_extraction_abandoned` `:172`, timer cleared in `finally`; D1c un-opted-in close short-circuits before any LLM call `:142-143`.

**D2a was never shipped.** No witness pins the `auto-extract ⇒ untrusted` tag mapping for this ADR — `git grep "ADR 0699"` over `backend/` hits only the two source files and the D1 test. The behaviour IS covered transitively by `backend/typescript/test/memory-extraction-binding.test.ts:73-84` and `:90` (via `host/subjectMemory.ts:82` → `isUntrustedMemoryRow`, `host/memoryTrust.ts:63`), but that file predates this ADR (it came in under ADR 0587 / ADR 0666), so citing it would be a DISPOSITION decision, not evidence D2a shipped. Recorded as outstanding rather than closed by citation.
