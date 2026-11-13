# ADR 1112 — scheduleSim: grouped decisions, a replay in place of the live clock, and an honest lead-time rule

Status: implemented (2026-11-12, P1 and P2 in #5827; P3, AI translation in parts, in #5854; P4, stored rows through system writes, in #5855; P5, a deadline on the submit sweep, in #5856; P6, AI rewrite in parts, in #5858). The correction notes below record where
the implementation differs from the decision as first written.

Extends [ADR 1080](1080-design-led-site-sections.md) D16 (the `scheduleSim` section) and its
D17–D19 rows (#5780: axis, start mode, sticky summary). Requested in #5816 by a white-label
adopter (CasaVoga, its ADR CV-0191, casavoga PR #276), which measured the stock section live,
replaced it locally with a `decisionSim` section, and will drop its copy for the stock one.
Host CMS rendering only: no wire change, so no RFC.

## Context

`frontend/react/src/features/cms/ProjectSimulator.tsx` (`runProject`, the live clock) has four
defects every adopter meets, measured on a live page and re-run in Node:

| Defect | Cause |
|---|---|
| Live mode (the default) cannot be played: six seconds after "Start the clock", 23 decisions are late | the clock adds 3 days every 400 ms, and decisions fall due faster than anyone can read them |
| Live mode never ends: unattended, the clock reached day 12,000 | an unanswered decision accrues lateness by the day, so `result.end` recedes a day per day and `clock >= result.end` never holds |
| It opens on nothing | `focus` starts at `milestones[0]`, which often owns no decisions |
| A lead time is subtracted from every lock, and an unknown one exempts the decision | `decideBy = lockDay + shift − leadDays − APPROVAL_DAYS` (clamped at 0: 173 of 1,145 CasaVoga decisions land on day 0), and `dated: false` is never late (a quarter of a catalog silently dropped) |

Month ticks overlapping on long plans was fixed by #5780 (`monthTicks` thins labels and keeps
the year); it is re-checked here, not re-fixed.

The section also stops at 80 decisions (`DESIGN_MAX.simDecisions`) with one control per
decision, so it cannot carry a real catalog. CasaVoga's `decisionSim` reads ~1,100 decisions by
phase × category, sets lateness per party, per cell or per decision, replays the result on a
clock, and reports the finish, the locks missed (each with the decision that held it longest
and its rework) and the late decisions and orders. Its model is two pure functions
(`runDecisions`, `delayFor`) with tests.

## Options weighed (architect review)

| Option | Cost now | Debt it leaves | Forecloses |
|---|---|---|---|
| A. Add `decisionSim` as a second stock type, fix `scheduleSim` beside it | port ~450 lines + validators; fix the old one too | **two simulators of one thing** (lock-day arithmetic, prerequisites, float) that will drift — the parallel-system shape | nothing, but every fix lands twice |
| **B. Evolve `scheduleSim` into the grouped model** (one type, one model) | port the model and the grouped view into the existing type; keep existing authored data working | none new | a pure live "answer against the clock" game (replaced by replay; see D3) |
| C. Fix the four defects only; `decisionSim` stays adopter-side | small | every adopter with a real catalog rebuilds CasaVoga's section | an upstream fix to the arithmetic CasaVoga already proved |

**Decision: B.** The dominant force is one source of truth for the schedule arithmetic. The
adopter's model is a strict improvement on the stock one (it fixes the lead-time and
unknown-lead defects by construction), so it becomes the model, under the existing type name,
so no published page breaks.

## Decision

### D1 — One model: `runSchedule` (from CasaVoga's `runDecisions`)

A pure function, unit-tested on both halves the way ADR 1105's worksheets are (one case table,
the backend importing the frontend module for parity):

- **decide-by** = the decision's lock day plus the slip so far; minus `leadDays + APPROVAL_DAYS`
  **only when `back` is true** (the lock is the day the item is needed on site). Never before
  day 0.
- **made** = decide-by + its own delay; a LATE prerequisite holds it, by no more than the
  prerequisite's own lateness (unchanged rule); a loop in the links holds nothing.
- **late** = made − decide-by. A milestone waits for its latest decision; float absorbs what it
  can; the rest slips that milestone and every one after it (unchanged).
- **An unknown lead time** (`leadUnknown`) is dated to its lock and labelled "lead time not
  known"; it is never exempt from lateness. (Today `dated: false` is never late: a defect.)

> **CORRECTED 2026-11-12 (P1):** the model runs only in the frontend
> (`ProjectSimulator.tsx` `runSchedule`). The backend never computes a schedule: it validates
> the section and projects milestone dates and counts for crawlers, so there is no second
> copy for a parity test to hold, and none was written. The unit cases sit in
> `frontend/react/src/features/cms/__tests__/adr1112Schedule.test.tsx`. Two rules were made
> explicit there: a milestone is settled before what lies ahead of it is dated, and each row
> names the decision that drove it.

### D2 — Grouping, and lateness set at three levels

Optional section fields: `phases`, `categories`, `roles` (each `key` + `label`), and per decision
`phase`, `category`, `role` (who decides; the existing `decider` stays as its label) and
`back` (boolean). Lateness resolves per decision: **its own setting, else its cell's
(phase × category), else the larger of its role's and the scenario's other rules** (CasaVoga's
`delayFor`). A section with no grouping fields renders as today (milestone list, per-decision
controls) and the model treats it as one cell.

Scenarios (`presets`) gain role-only rules that **fill the role controls**, so a visitor sees
what a scenario means and can change it (CasaVoga's `presetRoles`).

### D3 — A replay replaces the live clock

The default mode stays "what if" (#5780 `startMode`). `startMode: 'live'` (and an unset value on
a section authored for live) becomes **replay**: after the visitor sets lateness, a clock crosses
the schedule at a readable pace (a week per tick at 600 ms, `prefers-reduced-motion` → no
animation, a "next missed lock" step button instead), and it **stops at the finish**, which is
a fixed date once the settings are fixed. There is no answering against the clock, so nothing
can accrue lateness while the visitor reads, and both live defects disappear by construction.

> The live "answer each decision as it comes due" mode is removed. It is the mode the adopter
> measured as unplayable; keeping it would mean re-deriving the end date on every tick. A page
> authored with `startMode: 'live'` opens on the replay, which shows the same timeline.

> **CORRECTED 2026-11-12 (P1):** there is one view, not a "what if" mode and a replay mode.
> The settings and the replay controls sit together, so `startMode` has nothing to choose and
> the validator drops it. Under reduced motion there is no Play button: "Next missed lock"
> steps to the earliest missed lock ahead, then "Go to the finish". The replay's status is one
> `role=status` line, not a live region updated on every tick.

### D4 — Three outcomes, and an opening that shows something

The summary reports the finish date, the locks missed (each naming the decision that held it
longest and its rework) and the count of late decisions and late orders. The detail panel opens
on the **first milestone that owns a decision** (and, grouped, on the phase × category grid of
counts), never on an empty milestone.

### D5 — Scale: up to 1,500 decisions

`DESIGN_MAX.simDecisions` 80 → 1,500 with milestones ≤ 40, phases/categories/roles ≤ 20 each.
The grouped view renders the grid of counts and only the expanded cell's decisions (the first
12, then "show all"), so the DOM stays small. The no-JavaScript projection (prerender and
markdown) is counts by phase and the milestone dates, not 1,500 rows. **P1 gate:** measure the
saved page JSON for 1,500 decisions against the CMS write body limit and the published-page
size; if it does not fit, the cap is lowered and the ADR corrected, not the limit raised.

> **CORRECTED 2026-11-12 (P2, the D5 measurement):** rows are not the binding limit; bytes
> are. Measured: 1,500 decisions save as 411,343 B (274 B each), and one full translation
> takes a section to 821,644 B, while the write body limit is 1 MB. So the 1,500-row cap stays,
> and two byte limits hold the rest: `DESIGN_MAX.simSectionBytes` (850,000) for a section with
> all its translations, checked when a section or its translations are saved, and
> `PAGE_SECTIONS_MAX_BYTES` (975,000) for all of a page's sections. System writes and erasure
> (the kernel structure check, `baseLocale === ''`) skip both, so a size limit can never block
> a deletion. The AI translate and rewrite lanes refuse a section over 12,000 characters with a
> typed `too_large` failure; the translation sweep skips that section and goes on.

### D6 — Overlays

Locale overlays translate labels only. `back`, `leadDays`, `lockWeek`, `phase`, `category`,
`role` and every number follow the base (added to `ITEM_BASE_KEYS` with ADR 1105 D5's rule).

> **CORRECTED 2026-11-12 (P2):** these keys are not added to the global `ITEM_BASE_KEYS`: a
> quote's `role` is prose and must stay translatable. They are a per-type list,
> `SECTION_ITEM_BASE_KEYS.scheduleSim`, restored from the base as any JSON value (booleans and
> `dependsOn` arrays as well as strings and numbers). A translation is aligned to the base by
> id or key: items the base no longer has are dropped, items it gained take the base copy, and
> a list without ids is aligned by position only when the lengths match (otherwise it becomes
> the base copy). A rule's `decider` follows the translated decider of its decision. The
> validator mints `d<n>` ids for saved decisions without one, `startDate` is base-only, and the
> outdated check compares the stored translation after the same alignment.

### D8 — A stored row keeps its references through system writes (P4, added 2026-11-12)

P2's referential rules (no two milestones or decisions sharing an id, no reference to a
milestone, decision or group key the section lacks, no two group rows sharing a key) also ran in
the kernel's structure check, `validateSections(value, '')`, which re-validates the stored row on
every system write: publish, scheduled publish, unpublish and subject erasure. A page saved
before those rules failed all of them, and the only guard was PROBE-1112-1 on every host before
each deploy (DG-1112-4, CG-1112-15, WG-1112-2).

The structure check now keeps those references as they are: no refusal, and no repair. The
author's save (`baseLocale` set) keeps every refusal, so the next edit names the problem and the
author fixes it. The renderer treats such a row as it did before P2. Repairing in the structure
check (re-minting a duplicate id) was weighed and not taken: it would change an author's content
inside an erasure or a publish, with no one to review it.

PROBE-1112-1 stays, as a hygiene probe: a hit is a page whose author will be asked to fix it.

### D7 — AI translation in parts (P3, added 2026-11-12)

P2 refused AI translation of any section over 12,000 characters, because the model replies in
at most 2,000 tokens (about 8,000 characters of JSON). That stopped a scheduleSim at about 40
decisions (`CG-1112-12`, `WG-1112-4`). The call-budget question it was waiting on is decided:

- **Send words and ids only.** A scheduleSim's list items lose every `SECTION_ITEM_BASE_KEYS`
  key but `id` and `key` before the prompt. D6's alignment puts them back from the base and
  matches the reply by id, so nothing is lost. This alone takes one call to about 100 decisions.
- **Parts.** A payload still over 12,000 characters is split, in order, into parts of at most
  5,000 characters: the first carries everything but the later decisions, the rest carry
  decisions only. Each part gets the usual typed failure and one repair. A part must return
  every decision it was sent (`items_missing` otherwise), because a list without ids aligns by
  position. The replies are joined, then restored, aligned and sanitized once, against the
  whole base.
- **Budget: 8 parts per section-locale** (about 340 decisions at CasaVoga's field lengths).
  Past that the typed `too_large` refusal stays, with the count. A 1,500-decision catalog
  would take about 35 parts per locale, so it is still translated by hand or imported. The
  submit sweep charges a section its parts against its 20 attempts, and leaves a section that
  would overrun the budget whole for the next submit rather than half translated.
- **Time: 4 parts at a time, under one 45-second deadline,** so the editor's request returns
  inside the hosting proxy's 60 seconds. The first failed part stops the others (no more
  tokens spent on a translation that cannot finish). A deadline is a typed
  `translation_invalid` (`timeout`, 504), which the sweep skips like any unusable pair and the
  agent tool returns as `translation_timeout`. The editor says "A large schedule can take up to a
  minute" while a scheduleSim translates.
- **A part must return its decisions with the same ids**, not only the same count: a renamed id
  aligns to nothing and would leave that decision in the base language with no error.

Weighed and not taken: raising the reply size (it is the provider seam's, shared by every
caller), and an asynchronous job (a second lane beside the one-shot route; worth it only if
catalogs over 340 decisions need AI translation).

### D9 — The submit sweep has a deadline (P5, added 2026-11-12)

The submit-time auto-translate sweep (ADR 0064, `autoTranslateMissingOverlays`) runs inside the
submit request, after the page has already moved to review, behind the hosting proxy's 60 s.
Twenty attempts in a row, or a few large schedules in parts, could take longer. The client then
got a 502 for a submit that had succeeded, and the merge-save could land after it gave up
(WG-1112-5).

The sweep now has a 40 s deadline (`AUTO_TRANSLATE_DEADLINE_MS`). Past it, it starts no new pair
and aborts the call in flight, which `translateSectionData` now accepts as a caller's signal for a
one-part translation as well as for parts. What it drafted is kept and merged as before, the
response reports `autoTranslateDegraded.timedOut`, and the editor's toast says the time limit was
reached. The rest is translated on the next submit or by hand.

Weighed and not taken: running the sweep after the response (the reviewer could see the page
before its drafts land, against ADR 0064's review-before-publish rule; and a detached continuation
is the wrong shape on Cloud Run), and a durable job (a new lane, worth it only if submits still
time out with the deadline).

### D10 — AI rewrite in parts, on one shared runner (P6, added 2026-11-12)

AI rewrite (ADR 0828) kept P2's 12,000-character refusal, so the same large schedule that
translate now handles in parts could not be improved, shortened or fixed (CG-1112-17). It is the
translate shape: JSON values edited, keys kept, protected keys and non-text restored
(`keepNonText`), one repair.

The part machinery moves out of `translate.ts` into `features/cms/aiParts.ts`, and both lanes use
it: what the model is sent (`sectionPayload`), the plan and its 8-part budget (`planParts`), the
runner with one 45 s deadline, a caller's signal and abort-on-first-failure (`runParts`), the
per-part reply check for count and ids (`partReplyMismatch`), and the join (`joinParts`). Each
lane keeps its own prompt, attempt, repair, typed errors (`translation_invalid` / `rewrite_invalid`
and `validation_error`), and its restore and clean-up, run once on the joined reply.

A schedule small enough for one call changes too: it is now also sent as words and ids, and its
reply is checked for every item and id, so a reply that drops an item gets the repair instead of
a proposal misaligned by position. A rewrite in parts edits each part on its own. That is acceptable because a rewrite can never add
or remove an item: the structure is fixed. While a schedule is rewritten, the editor's AI bar says
"A large schedule can take up to a minute."

## Implementation

| Phase | Ships | Gate |
|---|---|---|
| P0 | This ADR | architect review (above) |
| P1 | `runSchedule` on both halves with the parity test; the lead-time rule (`back`), the unknown-lead rule; the replay (D3), the opening focus (D4); the three outcomes; tick spacing re-checked | unit cases for every rule; sabotage of `back`, unknown-lead, replay end; the live defects reproduced red on the old code first |
| P2 | Grouping (D2), the grid view, scale to 1,500 (D5), validators, overlays (D6), prerender/markdown counts, editor defaults, catalogs (4 locales) | the D5 size measurement; ADR 0384 golden; `adr1029-mirror-parity`; UX review |

P1 touches the files #5780 changed and is based on `main` after train 250 merges.

### Implementation record

| Phase | Commits | Witnessed by |
|---|---|---|
| P1 | `ababec7e56`, `d55fa1e0ab`, `5780709cc8` | `adr1112Schedule.test.tsx`, `projectSimulator.test.tsx`; 11 sabotages red |
| P2 | `ce41132d64`, `0fac2ec8c4`, `e9da1ff7d1`, `f82ebd4c0a` | `adr1112Grouped.test.tsx`, `backend/typescript/test/adr1112-schedulesim-scale.test.ts`, `adr1080-design-sections.test.ts`; 21 sabotages red |
| Grades | `d687adc732` | `docs/steward/*-adr1112.md`, `workflows-assessment/2026-11-12-adr1112.md` |
| P3 | #5854 (`904f17ecd7`, `b53d749466`) | `backend/typescript/test/adr1112-p3-translate-parts.test.ts`, `cms-agent-translate-success.test.ts` (`translation_timeout`), `aiProvenance.test.tsx` (the long-wait hint); 9 sabotages red |
| P4 | #5855 | `backend/typescript/test/adr1112-p4-stored-rows.test.ts`; 2 sabotages red |
| P5 | #5856 | `backend/typescript/test/adr1112-p5-sweep-deadline.test.ts`; 3 sabotages red |
| P6 | #5858 | `backend/typescript/test/adr1112-p6-rewrite-parts.test.ts`, `sectionAiBarLongWait.test.tsx`; 4 sabotages red |
| Residue | #5872 | `backend/typescript/test/adr1112-residue.test.ts`, `adr1112Residue.test.tsx`; 6 sabotages red. D5's page limit now also holds for the page as readers get it (shared sections resolved, at publish); byte refusals carry `details.reason`; scheduleSim `currency` |
| Data residue | #5873 | `backend/typescript/test/adr1112-versions-realign.test.ts`; 4 sabotages red. Stored overlays realign through the `cms-overlay-realign` background job (off unless `OPENWOP_CMS_OVERLAY_REALIGN` is `report` or `apply`); page history reads the version collection's tenant index |
| History summaries | #5875 | `backend/typescript/test/adr1112-version-summary.test.ts`, `frontend/react/src/features/cms/__tests__/cmsWorkspace.test.tsx`; 5 sabotages red. History lists `?summary=1`; Compare reads `GET …/versions/:versionId` (DG-1112-12, UXG-1112-15) |
| Resolved size on every reader lane | (this PR) | `backend/typescript/test/adr1112-resolved-size-lanes.test.ts`, `frontend/react/src/features/cms/__tests__/adr1112Residue.test.tsx`; 3 sabotages red. Approval decide (before its CAS), experiment start and promote, and a shared-section edit meet `assertResolvedPageFits` (DG-1112-13) |

Open after this ADR (tracked in those files): duplicate ids in sections saved before P2
(PROBE-1112-1; since P4 a hygiene probe, not a deploy gate), AI translation of sections over 12,000
characters (needs a call-budget decision), and the UX residue UXG-7, UXG-8, UXG-12.

> **CORRECTED 2026-11-13 (data residue):** UXG-7, UXG-8 and UXG-12 closed in #5872. DG-1112-6
> and RI-1112-1 were held for a user decision on the grounds that a backfill is a production
> CMS write. They are closed by an env-gated background job instead: the code ships complete, and
> turning it on in production is the operator's env write. DG-1112-8 asked for a version cap
> that already existed (`MAX_VERSIONS = 50`); the cost it pointed at was the cross-tenant
> version scan, now DG-1112-11, fixed.

## Open questions

- None blocking P1. CasaVoga's `decisionSim` field names (`q`, `el`, `ph`, `cat`, `m`, `lw`, `lu`)
  are compact for a 1,100-row catalog; this ADR keeps `scheduleSim`'s readable names and maps
  them in CasaVoga's migration note (its re-pin).
