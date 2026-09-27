# ADR 0501 — A coach proposal carries commands, not prose

Status: **Implemented** (2026-09-15; Proposed 2026-07-29) · Supersedes the open half of `KT-HONESTY-1`

## Context — a button that performed a success

The Circles page rendered a coach's suggestion and offered **"Apply"**
(`kicktodo-circles/i18n/en.ts`). Clicking it called `resolveProposal(action:'apply')`
→ `applyPlanRevision` (`enrollmentService.ts:706`), which supersedes non-terminal
occurrences and **re-materializes the plan from the participant's OWN current
preferences**. The coach's `note` is free text (`cohortService.ts:62-76`) and was
never executed — there was nothing structured to execute.

So a participant clicking "Apply" on a coach's suggested swap reasonably believed
the swap happened. It did not. **The plan regenerated, which looks like something
worked.** That is worse than the silent-failure defects this codebase has spent a
month removing: those fail to report a truth, this one *performs* a success.

`KT-HONESTY-1` (found by a peer session, #2676/#2677) named two fixes and called
the choice a product call. It is only half a product call, and the architecture
decides more of it than the note assumed.

## What already exists — audited, not assumed

The execution machinery for the honest version is **already built and governed**:

| piece | where | state |
|---|---|---|
| closed-world command union | `replanService.ts` `RevisionCommand` | built, schema-pinned to `plan-revision.schema.json` |
| validated apply | `replanService.ts:209` `applyRevisionCommands` | built, routed (`routes.ts:329`), shared with chat |
| **preview/compare** | `replanService.ts:297` `previewRevisionCommands` | **built** |
| per-lane authorization | `hasKicktodoEnrollmentAuthority` | enforced route-side on both paths |

The proposal path is the only thing that does not use it. It calls the *blunt*
re-materialize directly, bypassing the seam that exists for exactly this job.

**A correction to the finding note:** it implied `applyPlanRevision` is
unguarded. The *service function* has no owner check, but the **route is gated**
(`routes.ts:311`). Defence-in-depth could improve; there is no live authorization
hole, and this ADR does not claim one.

## Competitive analysis — the shape is settled industry practice

| product | what the proposal carries | what accept does |
|---|---|---|
| **GitHub** suggested changes | a **structured diff**, not prose | commits the stored diff; batches into ONE commit |
| **Google Docs** suggesting mode | structured suggestion threads, exposed via API to accept/reject programmatically | applies the recorded edit |
| **TrainingPeaks** | "suggested threshold changes" as a first-class notified object | coach/athlete review loop |
| **TrueCoach** | coach edits structured workout objects | change lands as data |

**The universal rule: the proposal carries the change, and accept applies exactly
that change.** Nobody ships "accept" against prose. Our current behaviour is not a
weaker version of the pattern — it is outside it.

**What the research did NOT settle, stated plainly:** none of the public
documentation covers *staleness* — what happens when a suggestion's base has moved
between proposal and accept. GitHub's own docs are silent on outdated-suggestion
semantics. So on the documented pattern we would be at parity; on the undocumented
and more dangerous property we are **ahead**, because `applyRevisionCommands`
re-validates closed-world **at decision time**, not at authoring time. That is the
part worth protecting.

## Decision

**A coach proposal MUST carry `RevisionCommand[]`, and accept MUST route through
`applyRevisionCommands`.** Prose remains, as an accompanying `note` — advice for
the human — never as the thing the button claims to execute.

**The product question — "what may a coach propose?" — is already answered by the
closed world.** ADR 0429 defines exactly three flexibility lanes: a
schedule-preference change, a publisher-declared substitution, and a missed-window
recovery collapse. A coach may propose **those three and nothing else**. Never new
activities, never an evidence-policy change. That is not a new decision; it is the
existing closed world applied to a second author.

### Sequencing, and why the stopgap shipped first

1. **Ship the honest relabel NOW** (done, this PR). The lie is live and (a) cannot
   ship until coach-side authoring exists. The relabel is explicitly a **stopgap**,
   labelled as such in-code so the next reader does not mistake it for the design.
2. **Coach-side authoring** — `proposePlanChange` emits commands from the three
   lanes; persistence carries them alongside the note.
3. **Route accept through `applyRevisionCommands`**; delete the blunt path from
   this surface.
4. **Then** compose the preview compare (`ENG-15(a)`), which becomes trivial —
   `previewRevisionCommands` already exists and merely lacks commands to preview.

**Do not ship the preview before step 3.** A compare over a proposal that cannot
be executed makes the false promise *more* convincing, not less — the finder was
right about that and it is the strongest argument in their note.

## Consequences

- **Positive:** one execution seam for participant-authored and coach-authored
  revisions; re-validation at decision time; `ENG-15(a)` unblocked; the closed
  world stays closed.
- **Cost:** a persisted-shape change on proposals (`note` → `note` + `commands[]`)
  and a coach-side authoring surface. Legacy prose-only proposals must remain
  decidable — they render as advice with the stopgap copy, permanently.
- **Not addressed:** whether a coach may propose *across* participants, and
  proposal expiry. Both are out of scope and neither is implied by this decision.

## Data integrity

No migration. `enrollmentService.ts:717` — `if (terminal) continue; // completed
history is never rewritten`. A mistaken apply regenerated *upcoming* occurrences
from the participant's own settings; it never rewrote completed history, and the
next legitimate replan yields the same result. **There is no corrupted data to
repair** — the damage was to the participant's belief, not to the plan.

## Open questions

1. May a coach propose a lane the participant's plan does not currently use?
2. Should a proposal expire? Stale advice is not dangerous the way a stale diff is,
   precisely because re-validation happens at accept.
3. Should accepting a multi-command proposal be all-or-nothing? `applyRevisionCommands`
   is already ordered-and-typed-failure per command index, so partial acceptance is
   representable but not currently exposed.

## Implementation record (2026-09-15)

All four sequencing steps had landed while this ADR still read Proposed (measured:
`routes.ts` "ADR 0501 step 2", `cohortService.ts` `validateRevisionCommands` at
authoring, `resolveProposal` → `applyRevisionCommands`, the owner-only
`previewProposal` + `PlanProposalPreview` on the card). What was missing was the
COACH's side — nothing in the SPA posted `commands[]`.

**The console (`/circles/coach`, `kicktodo-circles/CoachConsolePage.tsx`):** the
caseload as a table (day, completion, the deterministic attention flag), a composer
per row — note plus up to five commands over the `schedule` / `recovery` / `move`
lanes (`substitute` needs activity ids a coach never sees; the composer says so and
points to the note + KickBot) — a dry run, and send. The caseload row now carries
the coach's OWN proposals with state and executability (`CoachProposalView`); another
coach's are theirs.

**The dry run (`POST …/circles/:id/proposals/dry-run`, `dryRunProposal`):** the same
grant check and the same closed-world validation as propose, returning the humanized
lines via a new pure `describeRevisionCommands` (empty title maps). It reads NO plan:
the owner-only `previewProposal` stays the only thing that does, by the privacy
reasoning already recorded above it. Persists nothing.

Open questions 1–3 stand as written.
