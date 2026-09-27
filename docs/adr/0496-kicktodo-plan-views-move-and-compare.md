# ADR 0496 — KickTodo Plan §5.5 completion: Calendar/Challenge views, move-within-window, replan preview-compare

Status: implemented (P1–P4, 2026-07-27; record below)

**Requirements source:** ADR 0436 §5.5 (design law): "Week (default) / Calendar / Challenge
views; move-within-window, publisher-approved substitute (ADR 0429), request re-plan,
**compare current vs proposed and approve/reject**. Drag has a keyboard/touch equivalent
(WCAG 2.2 dragging). KickTodo is the source of truth; external-calendar state is disclosed
(connected/syncing/stale/error/revoked) and a sync failure never hides the action."
This is the LAST open row of the SCREEN_POLISH KickTodo program (every other REMAINING
item closed #2392–#2401); the tracker deferred it as feature-sized because per-day move
is a **new flexibility lane**, not a read.

**Depends on / extends:** ADR 0429 (the three flexibility lanes + the closed-world rule),
ADR 0459 P1 (`replanService` command list + `plan-revision.schema.json` parity), ADR 0443
R2 (the ONE `mapDayToDate`/`dayNumberFor` pair), ADR 0466 (calendar-MCP; the existing
`GET /kicktodo/integrations/calendar-status` read).
**Surface:** host-extension only. **NO new RFC** (the ADR 0429 precedent: occurrences,
enrollment fields, and `/v1/host/openwop-app/kicktodo/*` routes never touch the wire).

## Decision

### D1 — `move` becomes the FOURTH revision-command lane (closed-world, like the other three)

```text
RevisionCommand (replanService, extended)
  | { lane: 'move'; day: number; toDate: string /* YYYY-MM-DD local */ }

ChallengeEnrollment.schedulePreference (extended)
  dayOverrides?: Record<string /* day index, stringified */, string /* dateLocal */>
```

- A move re-dates ONE challenge day (`day` = the 1-based plan day) to an explicit local
  date. The override is stored on the enrollment (a CAS point-write, the
  `setSchedulePreference` idiom) and consulted by BOTH halves of the R2 mapping:
  - forward: `effectiveDateForDay(e, day) = dayOverrides[day] ?? mapDayToDate(...)`;
  - inverse: `dueDaysOn(e, date)` = the natural `dayNumberFor(date)` (unless that day is
    overridden elsewhere) **plus** every day whose override lands on `date`. Bounded by
    `durationDays` (small by construction).
  `materializeOccurrences`, `todayFor`, `planFor`, and the missed-window scan all read
  the mapping through these two helpers — one owner, no second date authority.
  **Architect review:** exactly two raw consumers of the R2 pair exist today
  (`todayService.ts:315`, `enrollmentService.ts:427`); BOTH migrate to the new helpers
  and the raw pair stops being the reachable API for enrollment-dated math (the helpers
  take the enrollment and own the override lookup), so a future caller cannot silently
  bypass overrides. The R2 round-trip property test extends with the multiplicity pin:
  for every day d, the set of dates that materialize d is exactly
  `{effectiveDateForDay(d)}` — an overridden day never also fires at its natural date.
- **Guards (all server-side, typed refusals):** the moved day must not be checked in;
  `toDate` must be ≥ the enrollment `startDateLocal`, ≥ today (the past is the recovery
  lane's jurisdiction, never move's), and ≤ the challenge's natural end + 14 days (the
  "window" — a plan may breathe, not dissolve). Moving a day back to its natural date
  DELETES the override (self-healing, no tombstones). At most `durationDays` overrides
  can exist by construction (one per day).
  **Architect review (pre-impl) added:** a day whose LIVE occurrence sits at a date
  **before today** REFUSES the move — `applyPlanRevision` supersedes non-terminal
  occurrences everywhere and `occurrencesOn` filters superseded rows, so moving an
  already-missed day would silently erase it from missed-window detection; that day
  belongs to the recovery lane. The checked-in guard evaluates the day's occurrence at
  its current EFFECTIVE date (override-aware), not its natural date.
- An explicit move deliberately **overrides `daysOfWeek`** — that is its purpose (the
  participant says "Thursday instead", the enroll-time weekday filter yields).
- **Replay/evidence unchanged:** occurrence keys already carry their date; a moved day
  simply materializes under its new date. The frozen evidence snapshot (ADR 0414 P3)
  records occurrences verbatim — the judge never re-derives dates. `applyRevisionCommands`'
  trailing `applyPlanRevision` re-materializes today when a move affects it.
- **Schema parity is part of the lane, not a follow-up:** the `oneOf` in
  `feature.kicktodo.agents/schemas/plan-revision.schema.json` gains the `move` shape in
  the SAME change, the agents pack version bumps, and the existing schema-parity test +
  the replan-composer persona text are updated together (the prompt↔catalog rule — a
  model told "three lanes" while the validator accepts four is being lied to).

### D2 — preview is a PURE dry-run read, never a shadow apply

```text
previewRevisionCommands(tenantId, { enrollmentId, subject, commands })
  → { valid: true; changes: PlanChange[] } | typed refusal (same validator as apply)
PlanChange = { lane, day?, title?, fromDate?, toDate?, detail }
```

- Same authority predicate, same closed-world validator, ZERO writes: the preview
  computes the affected plan rows before/after from the same owners `planFor` reads.
  Refusals are the SAME typed errors apply would raise (a preview that passes but an
  apply that fails would be a painted status).
- Exposed as `POST ${KICKTODO_PREFIX}/enrollments/:id/revision-preview`, and the apply
  lane as `POST ${KICKTODO_PREFIX}/enrollments/:id/revision-commands` (the surface op
  and these routes share `applyRevisionCommands` — one implementation).
  **Architect review:** both routes pre-check `hasKicktodoEnrollmentAuthority` → 404
  (the sibling no-existence-leak posture; the service's 403 stays for the chat-op
  lane), and preview/apply share ONE validator+guard path structurally — a parity test
  pins that a list apply rejects, preview rejects with the same code and failing index.
- This is the §5.5 "compare current vs proposed": the Plan UI shows the before/after
  rows and the participant confirms — approve/reject for SELF-changes is the confirm
  step (coach-proposed changes already ride the ADR 0459 approval card; that lane is
  untouched here).

### D3 — Calendar and Challenge views are re-projections, not new reads

`planFor` already serves a bounded ≤31-day window. The PlanPage gains a view switch
(Week default / Calendar month / Challenge lanes) over the SAME `getPlan` read — no new
backend, no N+1 (one request per window, exactly as today). Calendar = month grid keyed
by local date; Challenge = the same rows grouped by enrollment with day indices.

### D4 — move UX is keyboard/touch-FIRST; drag is not shipped

WCAG 2.2 §2.5.7 requires a single-pointer/keyboard equivalent for any drag. We ship the
equivalent as the ONLY mechanism (a "Move…" affordance on future, incomplete items →
bounded date choice → preview/compare → confirm). Drag can layer on later without an ADR;
shipping drag-first and retrofitting accessibility is the anti-pattern.

### D5 — external-calendar state is disclosed from the EXISTING read

PlanPage renders the `GET ${KICKTODO_INTEGRATIONS_PREFIX}/calendar-status` state as a
quiet chip (connected/syncing/stale/error/revoked, literal i18n keys per known state,
honest fallback for unknown). A failed status read renders as "status unavailable" —
**a sync failure never hides plan actions** (the §5.5 sentence, verbatim behavior).
Absent integration (toggle off / not configured) renders nothing — disclosure is about
a calendar the participant connected, not an ad for one.

## Alternatives weighed

- **Free-form drag-to-any-date without a lane** — rejected: it would bypass the
  closed-world command validator and the 0459 approval/preview machinery; ADR 0429's
  correction (participant flexibility rides declared lanes) applies to dates exactly as
  it did to substitution.
- **Store the override on the occurrence** — rejected: occurrences are materialized
  daily and superseded by revision; a future day may have NO occurrence yet. The
  enrollment's schedule preference is the existing owner of "when things happen".
- **A new `moves` DurableCollection** — rejected: a second store for schedule truth
  (the parallel-architecture smell); the enrollment row IS the schedule owner.
- **Reusing `applyPlanRevision` alone (no lane)** — rejected: it re-materializes but
  cannot express intent, preview, or guardrails; it stays the blunt trailing step.
- **A generic preview for coach proposals too (approval-card compare)** — deferred, not
  rejected: the plan-proposal card already carries the humanized `display` lines
  (ADR 0459); wiring the SAME preview read into that card is a follow-on once this lane
  exists (recorded in Open questions).

## Phased plan

| Phase | Scope |
|---|---|
| **P1** | Backend lane: `dayOverrides` + `effectiveDateForDay`/`dueDaysOn` (round-trip property test extended), materializer/todayFor/planFor/missed-window consume, `move` command in `replanService` (+ guards + tests), `plan-revision.schema.json` + parity test + replan-composer persona + agents pack bump. |
| **P2** | Preview: `previewRevisionCommands` + the two routes (`revision-preview`, `revision-commands`) + route tests (authority, typed refusals, preview==apply verdict parity). |
| **P3** | FE: PlanPage view switch (Week/Calendar/Challenge), Move… affordance (future+incomplete only) → preview compare → confirm → reload; i18n ×4; component tests. |
| **P4** | FE: calendar-status disclosure chip on PlanPage (5 literal states + unavailable), i18n ×4. |

## Open questions

- OQ1 — surface the same preview compare inside the ADR 0459 plan-proposal approval
  card (coach-proposed changes): follow-on once P2 lands; needs the card to call the
  preview read with the proposal's commands.
- OQ2 — should a move emit a calendar-MCP update for synced calendars (ADR 0466 write
  lane)? Deferred until the write lane is enabled anywhere real.

## Implementation record

All four phases landed in one branch (pre-implementation architect review applied:
H1 past-day refusal, H2 helper migration + bypass prevention, H3 route 404 posture,
M5 shared guard path, M6 CAS byte-equality, M7 atomic pack bump):

- **P1** — `dayOverrides` on `schedulePreference` (types.ts) + `effectiveDateForDay`/
  `dueDaysOn`; both raw R2 consumers migrated (materializer + planFor);
  `assertDayMoveAllowed` (shared guards) + `setDayOverride` (CAS loop);
  `move` lane in `replanService` (validator + humanizer + executor);
  `plan-revision.schema.json` move shape in BOTH oneOf lists + replan-composer
  persona four-lanes text + agents pack 1.7.1 → **1.8.0** (feature.ts pins updated);
  schema-parity cases ×6 + the multiplicity property pin. 50/50 green.
- **P2** — `previewRevisionCommands` (pure dry-run, same validator + same
  `assertDayMoveAllowed`); routes `POST /enrollments/:id/revision-commands` +
  `/revision-preview` (non-owner → 404); route tests incl. preview==apply refusal
  parity (same 409 + failedIndex).
- **P3** — PlanPage: Week/Calendar/Challenge segmented views over the one bounded
  `getPlan` read; Move… on future+incomplete rows only → native date input →
  preview compare → confirm (WCAG 2.2 keyboard/touch-first, no drag); `.kt-month`
  grid (phone falls back to a dated list); i18n ×4; 5 component tests.
- **P4** — calendar disclosure chip from `getCalendarStatus` + `getConsents`
  (connected/revoked/unavailable — the store-backed subset; the full
  syncing/stale lifecycle honestly deferred until sync-run records exist);
  a failed status read never hides plan actions (test-pinned).
