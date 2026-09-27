# ADR 0443 — KickTodo participant rhythm & planning (schedule preference, Plan view, depth facet, journal)

| | |
|---|---|
| **Status** | Implemented — 2026-07-20 |
| **Feature** | EXTENDS `kicktodo-core` (+ a read touch on `kicktodo-integrations` reminders). **No new toggle, no new package.** |
| **Source** | `docs/kicktodo-original-intent-coverage.md` §5 gaps **1, 2, 6, 7** (deck slides 6/10/5; business-plan "time to do" reminders + notes) |
| **RFC verdict** | **Host work, no RFC.** All routes are host-ext under the existing `/v1/host/openwop-app/kicktodo/*`; no wire surface, capability, event, or envelope kind. |
| **Composes** | ADR 0414 (`kicktodo-core` enrollment/materialization), ADR 0429 (missed-window + substitution — the flexibility law this must not fork), ADR 0421 (`kicktodo-integrations` reminders + ICS feed), ADR 0436 (§5.5 Plan destination, deferred there as data-limited — this ADR supplies the data), ADR 0415/0437 (the Factory authors the depth facet) |

## 1. Why this exists

The original concept's core promise was that the daily rhythm *fits your life*
(deck slide 6: morning/afternoon/evening, weekdays-only; slide 10: one calendar
view across challenges). The implementation materializes everyone at a fixed
`0 5 * * *` slot (`enrollmentService.ts` `DAILY_LOOP_CRON`, KTFULL-B5) with no
per-enrollment preference, and the cross-challenge Plan view (ADR 0436 §5.5) was
deferred for lack of a forward-looking read. Depth levels (slide 5) and the
participant journal (business-plan notes) are small original intents with no
deliberate-drop record.

## 2. Boundaries audit (verified 2026-07-20)

- **Enrollment is the single owner of cadence state** — `ChallengeEnrollment`
  (`kicktodo-core/types.ts:105`) already carries `timezone` + `startDateLocal` +
  `planRevision` + ADR 0429's `missedWindowAskedFor` point-write precedent. The
  schedule preference is a **field on this row**, never a second store.
- **Occurrence ids are deterministic** (`${tenant}::${enrollmentId}::${localDate}::
  ${stableActivityId}::r${rev}`) — any date-mapping change MUST stay a pure
  function of durable enrollment state or it breaks idempotent materialization.
- **Reminders already route via consent** (`kicktodo-integrations` `routeReminder`,
  quiet hours at platform) — timing honors the preference; no second reminder path.
- **The ICS feed already projects the schedule** (`/public/kicktodo/feed`) — the
  Plan view and the feed MUST render the same mapping (one projection function).
- **Challenge definition is owned by `kicktodo-core/challengeService`**; the
  Factory (`kicktodo-creator` plan → decompose) is the authoring path for any new
  definition facet. Immutability: published versions are frozen — the depth facet
  is set at authoring, never edited post-publish.
- **Check-ins are owned by `todayService`** (`submitCheckIn` note/measurement
  evidence) — the journal is a **read projection** over existing rows, no store.

## 3. Decision

### D1 — Enrollment schedule preference (gap 1)
`schedulePreference?: { daypart?: 'morning' | 'afternoon' | 'evening';
daysOfWeek?: number[] }` on `ChallengeEnrollment` (optional; absent = today's
behavior). Set at enroll or from Today (point-write, owner-only, CAS).
- **Phase R1 (daypart):** affects **reminder timing** and Today's presentation
  ordering only — materialization unchanged (safe, no date math).
- **Phase R2 (allowed days):** day-index → local-date mapping becomes
  `mapDayToDate(startDateLocal, daysOfWeek, dayIndex)` — a **pure deterministic
  function** of durable fields, so occurrence ids stay idempotent and replay-safe.
  Interacts with ADR 0429's missed-window policy (a skipped non-allowed day is
  NOT "missed"); a preference change mid-flight maps **forward only** (past
  occurrences keep their dates — the plan-revision discipline, not a rewrite).

### D2 — Plan view (gap 2)
`GET …/kicktodo/plan?from&to` — a **derived, bounded read** (no store): upcoming
occurrences across the caller's active enrollments, computed from definitions +
`mapDayToDate` (the SAME function the materializer and ICS feed use — one
projection, three renderers). FE: the ADR 0436 §5.5 **Plan** destination (week
default), checkbox state from real occurrences for past/today, derived for
future; actions stay honest — completing is Today's job, re-planning is KickBot's
(ADR 0429); no drag-and-drop in v1 (WCAG 2.2 alternative first).

### D3 — Depth facet (gap 6)
`depthLevel?: 'beginner' | 'intermediate' | 'advanced'` on `ChallengeDefinition`
+ `ChallengePlan` (Factory-authored, gate-visible, frozen at publish). Discover
gains a §4.5-canon facet (self-describing select, gated on catalog size) +
Challenge Detail chip. Absent = unlabeled (honest for pre-existing content).

### D4 — Journal (gap 7)
`GET …/kicktodo/journal?before&limit` — the caller's own check-in notes (+
measured values) across enrollments, newest-first, keyset-paged. FE: a Journal
page reached from Progress (no new nav weight). Self-data only (`ownerSubject`
= caller); notes never leak into circles beyond the existing ADR 0419 scopes.

## 4. Feature-evaluation matrix (deltas only)

| Dim | Decision |
|---|---|
| Package/toggle | Extends `kicktodo-core` — toggle stable, default posture unchanged |
| Workflow surface | `ctx['kicktodo-core']` gains `getPlan` + `setSchedulePreference` (same gate) |
| Node pack | `feature.kicktodo.nodes`: `plan-read` + `schedule-set` nodes (KickBot can honor "remind me in the evenings") |
| Agent | No new agent — KickBot (0442) + existing packs |
| Public | None new (ICS feed already public; Plan is authed) |
| RBAC | Owner-only mutations (`ownerSubject === caller`); tenant-scoped reads; fail-closed |
| Replay | Date mapping pure-deterministic over durable fields; preference changes forward-only |
| Frontend | `kicktodoClient` + PlanPage/JournalPage + Discover facet; 4-locale; §4.5 canon |

## 5. Phased plan

| Phase | Ships | Gate |
|---|---|---|
| R1 | Preference field + daypart reminder timing + Today ordering | — |
| R2 | Allowed-days mapping (materializer + ICS + missed-window interplay) + tests pinning determinism | /architect on the mapping function before build |
| R3 | Plan read + Plan FE destination (§5.5) | R2 |
| R4 | Depth facet (Factory plan → definition → Discover facet + detail chip) | — |
| R5 | Journal read + FE | — |

## 6. Alternatives, corrections, open questions

- **Alternative (rejected):** per-activity "time to do" (the business plan's
  habit-app framing) — per-*enrollment* preference matches the challenge model
  (one daily rhythm), avoids N-per-day reminder sprawl; a per-activity override
  can layer later without schema change.
- **Correction to the original:** slide 6's "just at the start of the month /
  only Mondays" cadences conflict with the day-N-builds-on-day-N−1 challenge
  contract; supported cadence = daypart + allowed weekdays (stretching), not
  arbitrary calendars.
- **OQ1:** should a preference change mid-enrollment require the ADR 0429
  re-plan approval loop (KickBot proposes the remap) instead of a silent apply?
  Leaning yes for R2 — recorded for the R2 architect gate.

## 7. Implementation record (2026-07-20)

| Phase | Shipped | PR |
|---|---|---|
| R1 daypart reminders | `schedulePreference.daypart` (CAS, owner-only) + `reminder-loop` builtin workflow + `remind-today` node (integrations owns `remindToday`; consent gate inside; snooze pauses) + TodayPage daypart chips | #2243 |
| R4 depth facet | `depthLevel` on definition/plan (outside contentHash) + catalog chip | #2245 |
| R5 journal | `journalFor` self-data evidence-bearing check-ins + JournalPage | #2245 |
| R2 allowed-days | `daysOfWeek` frozen at enroll; `mapDayToDate`/`dayNumberFor` pure pair; non-allowed dates materialize nothing (never "missed"); weekday picker | #2247 |
| R3 plan view | `planFor` (≤31-day window, completion truth from check-ins) + PlanPage week view | #2248 |

Corrections vs the proposal: `setSchedulePreference` MERGES the preference
(an R1 wholesale replace dropped `daysOfWeek` — caught by the R2 gate,
test-pinned). The reminder job is a SECOND `registerJob` with its own
deterministic id — `armContinuation` hardcodes the daily-loop id and must
never be reused for a second job per goal (architect gate). OQ1 (mid-flight
day changes = KickBot re-plan lane) remains open.
