# ADR 0374 — Tours as a first-class surface (`/tours`) + guided tutorials

> **Terminology (2026-07-16, ADR 0376):** "tour" → **"walkthrough"** in source; the
> surface moved `/tours` → `/walkthroughs`. Persisted ids (the `guided-tours` toggle,
> `tour.campaign-studio.first-brief`) keep their pre-migration values — see ADR 0376.
> Read "tour" as "walkthrough" here.

Status: implemented (Phases 1–3, 2026-07-15)
Date: 2026-07-15
Feature: extends `guided-tours` (ADR 0368) + `tutorials` (ADR 0301); new FE surface `/tours`
RFC verdict: **host work only — no new wire.** Reuses the already-shipped tour
engine (`ui.tour.step`/`ui.tour.checkpoint` workflows, the interrupt-driven
player, ADR 0369 transient lifecycle). A FE surface reorganization + one
optional tutorial-data field. No `../openwop` RFC.

## Why this exists

ADR 0368 shipped the tour engine but hung its authoring affordance ("Record a
tour") on the **`/test`** manual-test runner — because tests and tours share
the same backend wiring (workflow-driven click-through). Live use (2026-07-15)
proved that placement wrong: a QA testing surface is the wrong home for a
tour-authoring capability, and the two are conceptually distinct. The
maintainer's framing:

> "Click-through tests and tours are two things, but the automated/manual
> tests and the tours are basically using the same wiring on the back end."

And the forward idea: the **`/tutorials`** section (ADR 0301) is today a
*passive* read-along (authored data, checked off by hand); it should be able to
*drive* the app — "guided tutorials" — by launching a tour.

## The model: three surfaces, ONE engine

| Surface | Audience | Purpose | Home |
|---|---|---|---|
| Manual/automated **tests** (ADR 0183) | QA | Verify behavior; automated ones run/replay as workflows | `/test` |
| **Tours** (ADR 0368) | Authors | Record/manage narrated click-throughs | **`/tours` (new)** |
| Guided **tutorials** (ADR 0301) | Learners | Teach; passive read-along → *active* "Show me" | `/tutorials` |

All three ride the SAME backend — `ui.tour.step` DAGs + the player/replay +
the ADR 0369 transient lifecycle. The difference is the SURFACE and the
AUDIENCE, not the wiring. This ADR does NOT add a second engine; it gives the
authoring/consuming surfaces their correct homes.

## Decision

### 1. `/tours` — the first-class Tours surface (admin-tier)

A new FE page at `/tours` (the maintainer's chosen path; admin tier like
`/test`, gated by the `guided-tours` toggle) that owns the tour LIFECYCLE UI:

- **Record** a tour (the `requestTourRecord` bus + the record panel — MOVED
  here from the `/test` suite headers, which are reverted);
- **list** the tenant's tour workflows (transient drafts + promoted), reusing
  the ADR 0369 lifecycle list (a filter for `metadata.tour === true`);
- **review/play** a tour (the existing player via `requestTourLaunch`);
- **promote** a draft (run-once → the OQ5 gate; the existing builder path, or
  a play-through here).

No new backend: it composes the existing workflows list + player + recorder +
transient verbs. `/test` keeps ONLY its legitimate tour use — automated
click-through *tests* that assert outcomes (the Phase 5 `TOUR_E2E` replay
posture), not authored tours. The `CSTOUR-01` "Campaign Studio (guided)" case
is a TOUR, not a test — it moves to `/tours`.

### 2. Guided tutorials — a tutorial step launches a tour

`TutorialStep` (ADR 0301, authored data) gains one optional field:

```
interface TutorialStep {
  id: string; title: string; content: TutorialStepContent[];
  tourId?: string; // ADR 0374 — a tour that DRIVES this step ("Show me")
}
```

The tutorial renderer shows a **"Show me"** button on a step with a `tourId`
(gated on `guided-tours` enabled); it calls `requestTourLaunch(tourId)` — the
same player, same durable run, same honest failure/needs-update states. The
tutorial stays authored content (never JSX); the tour is the *active layer by
reference*. A learner reads the step, then watches it happen. Zero new backend.

### 3. The Tour Author (Enrich-with-AI) grant — resolve the open decision

ADR 0368 P6c's `openwop:tours.register-draft` tool is not reachable by a
default agent (not in the ADR 0315 default-on baseline nor a default manifest),
so Enrich-with-AI currently fails. This ADR records the decision (maintainer's
call — the baseline is explicitly maintainer-curated):

- **Recommended:** add `openwop:tours.register-draft` to the ADR 0315 default-on
  baseline — it has the SAME posture as `documents.draft`/`email.draft` already
  there (produces a catalog-hidden transient draft; promotion is a user act; no
  data mutation). Consistent, one-line, reversible; update the two baseline
  guardrail tests deliberately.
- **Alternative:** a dedicated Tours agent whose manifest grants the tool, with
  Enrich deep-linking `/?agent=<tours-author>` (narrower; needs the agent).

The recorder's deterministic **Save** path (ADR 0368 P6b) needs no grant and
stays the default; Enrich is the AI enrichment on top.

## Boundaries audit

- **Route:** `/tours` is unclaimed (grep clean). Admin-tier via the chrome
  feature table; no core edits beyond the route registration (ADR 0001).
- **Single engine:** no second tour/workflow/player model — composes
  `useTourPlayer`, `tourBus`, `tourRecorder`, `tourSynthesis`, the ADR 0369
  workflows list + transient verbs, and the ADR 0301 tutorial renderer.
- **`/test` reversion:** remove the Record affordance from `/test`
  (`ManualTestsPage` SuiteList + SuiteRunner headers, added #1873/#1880) and
  relocate it to `/tours`. Move `CSTOUR-01` out of the test suites.
- **Tutorials:** additive optional field; existing tutorials unaffected;
  authored-data contract preserved.
- **Capability honesty:** nothing new advertised; the tour engine is host-ext.

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| 1 | `/tours` surface (record + list + play + promote), reusing the engine; REMOVE Record from `/test`; move CSTOUR-01 → a `/tours` sample | FE build + /ux-review |
| 2 | Guided tutorials: `TutorialStep.tourId` + "Show me" launch; one reference guided tutorial | FE build + /ux-review |
| 3 | ✅ Tour Author grant (architect options-eval → **Option A**: added `tours.register-draft` to the ADR 0315 default-on baseline — consistent with documents.draft/email.draft's draft-a-thing posture; two guardrail tests updated to seven). Enrich-with-AI's tool is now reachable by any agent. Latent chat tool-loop robustness on unknown-tool calls flagged as a separate follow-up. | backend vitest + /architect ✓ |

## Alternatives weighed

1. **Keep Record on `/test`** — rejected by the maintainer; conflates QA with
   authoring, and the tour-vs-test distinction is real.
2. **A new tour DATA model for tutorials** (tutorials embed tour steps
   inline) — rejected: forks the tour definition. A `tourId` REFERENCE reuses
   the one engine; the tour stays a workflow, the tutorial stays authored data.
3. **Tours under `/admin`** — the maintainer chose a top-level `/tours`
   (a first-class surface, not buried in admin).

## Open questions

1. Should `/tours` list ALL tenant tours or only `metadata.tour === true`
   workflows? Proposed: the latter (a tour is a tagged workflow) — the ADR 0369
   list already filters by lifecycle; add a `tour` facet.
2. Guided-tutorial HITL: when a tour step is HITL (the learner must type), the
   tutorial "Show me" pauses for them — same player semantics. Confirm the UX
   reads well in a learning (vs demo) context at Phase 2.
3. Should a promoted tour be publishable as a SHARED/global tour (other
   tenants' tutorials reference it)? Deferred — v1 tours are tenant-owned;
   cross-tenant tour publishing is a later decision (a real gate).
