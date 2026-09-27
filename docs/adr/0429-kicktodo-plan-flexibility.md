# ADR 0429 — KickTodo plan flexibility: publisher-declared substitution + per-challenge missed-window policy

Status: **implemented** (P1–P5, 2026-07-19; record below)

**Requirements source:** `docs/kicktodo-prd.md` §12 Wave 1 ("Today screen with Done, Journal, **Substitute**, Snooze, and Ask KickBot"), §4.3 "Recover from a missed day", §13 Scheduling ("Missed-window policy is explicit per challenge: skip, collapse to one recovery action, or ask the user").
**Depends on / extends:** **ADR 0414 `kicktodo-core`** (occurrences, check-ins, Today, the daily loop) — this is an EXTENSION, toggle id `kicktodo-core` stays stable, no new package. Composes ADR 0412 (the goals judge reads frozen evidence), notifications (ADR 0010) for the `ask` policy.
**Surface:** host-extension. **NO new RFC.**

## Why this exists

Two Wave-1 MVP behaviors the PRD names explicitly were never built (verified: `grep -rin "substitut\|missedWindow" backend/typescript/src/features/kicktodo-core/` → zero hits). Both are the same product promise — *the plan bends instead of breaking* — and both live in the same owner, so they ship as one decision:

- **Substitute** — today's action doesn't fit (injury, no equipment, travel), and the participant needs a legitimate alternative that still counts.
- **Missed-window policy** — what a challenge does when a day is missed. Today every challenge implicitly behaves as `skip`; the PRD requires the publisher to choose.

Both are *daily-loop* mechanics, so the risk is identical: an evidence path that a participant can widen at will would break the factory's outcome→achievement→evidence traceability guarantee (PRD §7.3) and the goals judge's determinism (ADR 0412).

## Boundaries audit (verified against live code)

- **Single owner confirmed:** occurrences, cards, check-ins, and Today all belong to `kicktodo-core` (`todayService.ts`, `enrollmentService.ts`). This ADR adds fields + one route there; it introduces **no new store, no new package, no new toggle**.
- **No route collision:** the new participant action rides the existing `${KICKTODO_PREFIX}/today/*` family (the collision test's union already covers it).
- **Snooze is NOT substitution** — `snooze`/`resume` already exist and mean "not today"; substitution means "this instead, today". Distinct verbs, distinct rows; no overlap.
- **Journal is NOT substitution** — the free-text `note` on a check-in already carries "I did something else". Substitution is a STRUCTURED swap that preserves evidence policy; the journal stays the unstructured lane.
- **Scheduler untouched:** missed-window handling runs inside the existing deterministic materialization (the ADR 0414 daily loop), not a new poller — the PRD's "one shared scheduler, no KickTodo poller" rule (§13) holds by construction.

## Decision + data model

### Substitution — publisher-declared alternatives (the correction)

```text
ChallengeActivity (extended, part of the IMMUTABLE published body ⇒ inside contentHash)
  alternatives?: Array<{
    stableActivityId   // kebab, unique within the activity
    title
    instructions
    evidencePolicy     // MUST equal the parent activity's policy (see below)
  }>

DailyOccurrence (extended)
  substitutedActivityId?: string   // the chosen alternative's stableActivityId
```

- A participant may only choose an alternative **the publisher declared** on that activity. Free-form substitution is refused — that is the journal.
- An alternative's `evidencePolicy` **MUST match its parent's**. A `measurement` activity cannot be swapped for an `attestation` one, or the verifier's evidence bar silently drops. Enforced at publish (a deterministic plan gate, the ADR 0415 D2 precedent) *and* at substitution time (defence in depth).
- `substituteOccurrence(cardId, alternativeId)` is idempotent, refuses a superseded or already-checked-in occurrence, and updates the card title. The frozen evidence snapshot (ADR 0414 P3) carries `substitutedActivityId`, so the judge sees exactly what was done and replay is unchanged.

### Missed-window policy

```text
ChallengeDefinition (extended)
  missedWindowPolicy?: 'skip' | 'collapse-recovery' | 'ask'   // absent ⇒ 'skip'
```

- **Optional with a default** by design: every already-published version keeps its exact meaning and its `contentHash` stays valid. No migration of published artifacts.
- `skip` — today's behavior: a missed occurrence stays missed; the plan moves on.
- `collapse-recovery` — N consecutive missed occurrences materialize as **ONE** recovery occurrence with a deterministic id (`recovery::${enrollmentId}::${firstMissedDate}`), never a backlog wall. Deterministic id ⇒ a re-fired daily loop or a replay converges rather than duplicating (the KickTodo idempotency rule).
- `ask` — raises ONE notification through the existing emitter (`getNotificationEmitter`, category `kicktodo-reminder` lane), asking the participant to choose skip-or-recover. **No new inbox, no new interrupt type**; unanswered decays to `skip` after the challenge's window.

## Phased plan

| Phase | Ships |
|---|---|
| **P1** | `alternatives[]` on the activity model + the publish-time evidence-policy-parity gate + `substituteOccurrence` service/route; idempotency + refusal tests (unknown id, superseded, post-check-in, policy mismatch). |
| **P2** | `missedWindowPolicy` on `ChallengeDefinition`; `collapse-recovery` materialization with the deterministic recovery id; `ask` notification lane; replay/re-fire convergence tests + a default-absent test proving published versions are unchanged. |
| **P3** | Today UI: a Substitute control on each action (disclosing the publisher-declared options), recovery-day affordance, and the ask-prompt; i18n ×4; manual-test suite rows. |
| **P4** | Factory: the plan generator/validator emits and checks `alternatives[]` (accessibility alternatives are already a research question — `kicktodo-creator/surface.ts:31`), so factory-authored challenges ship substitutable by construction. |
| **P5** | `ctx.features.kicktodo-core` op + node for substitution (pack bump + pin lockstep); LLM-EXCHANGE row (KickBot may PROPOSE a substitution; the participant commits it). |

## Implementation record

| Phase | Landed |
|---|---|
| P1 — `alternatives[]` on the activity (inside `contentHash`) + the publish-time parity gate (divergent policy / parent-id reuse / >5 / incomplete all refused) + `substituteOccurrence`: occurrence KEY and cardId unchanged, card retitled through the kanban **update** seam, idempotent, uniform denial for unknown-alternative and foreign-owner. All test-pinned | kicktodo/0429-p1p2 |
| P2 — `missedWindowPolicy` (absent ⇒ `skip`, so published versions and their hashes are untouched — test-pinned); `collapse-recovery` materializes ONE recovery riding the SAME key/card-id scheme (synthetic `recovery::<date>` id) with the STRICTEST absorbed evidence policy, converging across re-fires, standing down past the 3-day cap; `ask` notifies ONCE per window via the existing emitter then `acceptRecovery` materializes | kicktodo/0429-p1p2 |
| P3 — Today: a disclosure-style Substitute control (`aria-expanded` + labeled, `role="group"`, `aria-pressed` chips) with alternatives projected by ONE challenge read per enrollment (no N+1); ux-review fixes applied — instructions rendered as VISIBLE text (a `title` tooltip is neither announced nor touch-reachable) and the trigger names its action; i18n ×4 | kicktodo/0429-p1p2 |
| P3 follow-through — Today projects a bounded, read-only missed-window preview for `ask` and over-cap `collapse-recovery` policies; the UI explains the impact before recovery/pause, keeps completed work, and exposes snoozed enrollments so Resume is reachable. The scan is limited to `MISSED_LOOKBACK_DAYS` and is skipped for the default `skip` policy | 2026-09-20 humane-recovery UX |
| P4 — the factory emits `alternatives` on `DailyActionUnit`, `draftFromPlan` maps them through, and the DETERMINISTIC plan validator enforces the same parity rule at authoring time (`alternative-evidence-mismatch` / `-id-collision` / `-incomplete`) | kicktodo/0429-p1p2 |
| P5 — `ctx.features.kicktodo-core.substitute` + `.applyMissedWindow` (automated runs without an acting user fail closed at the owner check) + the two nodes; pack **v1.10.0** pin-lockstepped across all six kicktodo features | kicktodo/0429-p1p2 |

**Architect pre-review findings, all built to:** the occurrence key/cardId embed `stableActivityId` (so substitution is a FIELD); `evidencePolicy` is COPIED onto the occurrence (which is what makes the parity rule load-bearing rather than cosmetic); recovery reuses the existing key scheme; `ask` is marked on the enrollment row (no new store); the missed-day sweep is date-prefix bounded (`MISSED_LOOKBACK_DAYS = 7`), never a whole-enrollment scan.

**Correction discovered in implementation:** `createCard` is idempotent-by-id (B1) and deliberately does not overwrite an existing card, so substitution retitles through `updateCardFields` — a create call silently no-ops. Caught by the test, not by review.

## Feature matrix

1. Package: EXTENDS `kicktodo-core` ✔ (no new package). 2. Toggle: none new — `kicktodo-core`, unchanged. 3. `ctx` surface: P5 (substitute op). 4. Node pack: extends `feature.kicktodo.nodes`. 5. Envelopes: none. 6. Agent pack: none new — KickBot proposes via existing tools; the human commits. 7. Public surface: none. 8. RBAC: owner-only on the occurrence (the existing `CheckInDeniedError` posture, uniform denial). 9. Replay/fork: alternatives are inside `contentHash`; `substitutedActivityId` is on the frozen snapshot; the recovery id is deterministic — replay is byte-stable. 10. Frontend: Today-surface controls, no new nav.

## Alternatives weighed

- **Free-form participant substitution** — rejected: it silently voids the factory's alignment guarantee and lets a participant lower their own evidence bar. The PRD's intent (flexibility) is served by publisher-declared options; the unstructured lane already exists as the journal. **This is the PRD-vs-architecture correction.**
- **Missed-window as a per-enrollment setting** — rejected: the PRD says *per challenge*, and it is a content-safety decision (a medication-adjacent challenge must not invite self-directed catch-up). Publisher owns it; the participant's lever is snooze.
- **A backlog of every missed day** — rejected explicitly by the PRD's own recovery framing (§4.3, "without shame") and by `collapse-recovery`.
- **A new HITL interrupt type for `ask`** — rejected: notifications already own preference/quiet-hours/delivery; a second prompt channel is the parallel-surface failure.

## Open questions

1. Should `collapse-recovery` cap how many missed days can collapse into one (e.g. 3), after which the enrollment escalates instead? Recommend a publisher-set cap defaulting to 3 — an unbounded collapse hides a plan that stopped working, which the PRD wants surfaced.
2. Does a substituted action count toward streak/award mechanics identically (ADR 0425)? Recommend yes — a substitution IS a completion; anything else punishes the flexibility the feature exists to provide.

## RFC verdict

**Host work, no new RFC.** All changes are host-private model fields, one host-extension route, and existing notification/scheduler owners. Nothing is advertised on the wire.
