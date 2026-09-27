# ADR 0425 — `kicktodo-engagement`: opt-in leaderboard, awards, and accountability-effectiveness experiments

Status: **implemented** (P1–P5, 2026-07-18; record below)

**Requirements source:** `docs/kicktodo-prd.md` §12 Wave 2 ("Optional opt-in leaderboard and achievements"; "Accountability effectiveness experiments using tenant-safe variant stamps").
**Depends on:** ADR 0414 (check-ins/completions are the signal source), ADR 0419 (the projection allowlist is the privacy law), the feature-toggle variant system (ADR 0001 §run-metadata correction).
**Surface:** host-extension. **NO new RFC.**

## Why this exists

Wave 2's engagement layer is the PRD's retention lever — but it is also the second-highest privacy risk after accountability itself: a leaderboard is a broadcast surface, and a broadcast surface built carelessly un-does ADR 0419's consent model. The design rule here is the same one 0419 established: **nothing is visible without an explicit opt-in row, and what is visible is a field-allowlist projection, never the record.**

## Naming correction (PRD-vs-architecture)

The PRD word "achievements" is already TAKEN: `kicktodo-creator`'s `ChallengePlan` models outcome→**achievement**→action alignment (`artifactSchemas.ts`, `planService.ts`), and 12 factory nodes speak that vocabulary. The gamification concept ships as **awards** in code and routes (`KicktodoAward`), with the PRD term kept only in user-facing copy where unambiguous. Two systems must not share one noun.

## Boundaries audit (verified against live code)

- **No route collision:** nothing registers `/kicktodo/engagement` (grep clean); joins `ALL_KICKTODO_ROUTE_TABLES` and the reserved-namespace guard.
- **Signal ownership:** check-ins/completions stay owned by `kicktodo-core` (`todayService.submitCheckIn`); this feature READS via the existing service seam — it never writes core rows.
- **Privacy law reuse:** display fields ride the ADR 0419 `projectFields` allowlist discipline — leaderboard entries carry display name + counts ONLY (never notes, measured values, or challenge instructions).
- **Variant stamps:** experiments reuse the established `run.metadata.featureVariant` pattern (the ADR 0001 correction — annotations don't survive `:fork`); no second experiment framework.

## Decision + data model

New feature package `src/features/kicktodo-engagement/`:

```text
LeaderboardOptIn      tenantId, ownerSubject, scope: tenant|circle:<id>, displayName, optedInAt, revokedAt?
KicktodoAward         tenantId, ownerSubject, awardId (deterministic: kind+subject+challengeId), kind
                      (first-check-in|streak-7|streak-30|challenge-complete|comeback), earnedAt, enrollmentId
ExperimentAssignment  — NOT a new row: the toggle-variant assignment stamped into run.metadata at run creation
```

- **Leaderboard** — one AGGREGATE endpoint (`GET /kicktodo/engagement/leaderboard?scope=`) computing rank from opted-in members' completion counts; k-floor: renders only when ≥3 opted-in members in scope (below that it shows the caller alone). Opt-out is immediate and removes history from display (rows persist for the owner only).
- **Awards** — derived idempotently from check-in/completion state with DETERMINISTIC award ids (a re-evaluation never duplicates); evaluated on check-in submission via a registered observer in `kicktodo-core` (the enroll-guard/observer inversion pattern from ADR 0420 — core never imports engagement).
- **Experiments** — a variant on the `kicktodo-engagement` toggle (e.g. nudge-tone A/B) stamped at run creation, read verbatim on `:fork`; effectiveness read = completion-rate by variant, counts only, tenant-scoped.

## Phased plan

| Phase | Ships |
|---|---|
| **P1** | Package + opt-in CRUD + the aggregate leaderboard endpoint (k-floor, allowlist projection, immediate opt-out) + collision/tenant tests. |
| **P2** | Awards: deterministic derivation + the check-in observer seam in kicktodo-core (`registerCheckInObserver`) + idempotency tests. |
| **P3** | Experiments: variant stamp + counts-only effectiveness read; replay/fork test. |
| **P4** | Frontend: leaderboard + awards on the Today surface (opt-in gate UI is the disclosure); i18n ×4. |
| **P5** | `ctx.features.kicktodo-engagement` (reads: leaderboard, awards) + node additions to `feature.kicktodo.nodes` (pack bump + pin lockstep); LLM-EXCHANGE row. |

## Implementation record

| Phase | Landed |
|---|---|
| P1 — opt-in CRUD + the ONE aggregate leaderboard read (k≥3 floor, closed `{displayName, completedCount, rank, you}` projection test-pinned, immediate opt-out, stat-row cache maintained by observer recompute-from-source) | kicktodo/0425-p1p3 |
| P2 — `registerCheckInObserver`/`__clearCheckInObservers` seam in kicktodo-core (post-first-write only, best-effort per observer) + deterministic awards (first-check-in / streak-7 / streak-30 / comeback / challenge-complete; duplicate submission never re-awards, test-pinned) | kicktodo/0425-p1p3 |
| P3 — counts-only effectiveness read by resolved variant (deterministic bucketing, no stored assignment). Review note: member-readable counts-only — same exposure class as the leaderboard | kicktodo/0425-p1p3 |
| P4 — Leaderboard page in the KickTodo nav group (`/kicktodo/leaderboard`, gated on the toggle): the opt-in gate IS the disclosure (exact-two-fields copy, 4 locales), ordered-list standings with labeled rank chips, below-floor stated plainly, immediate leave; awards as labeled chips. React-free client (ADR 0413 seam). ux-review CLEAR (0 hex/inline/emoji; §5.1 primitives) | kicktodo/0425-p4p5 |
| P5 — read-only `ctx.features.kicktodo-engagement` (leaderboard, awards) + `feature.kicktodo.nodes.engagement-summary`; pack **v1.6.0** pin-lockstepped across core/creator/accountability/engagement (parity-enforced); LLM-EXCHANGE row added | kicktodo/0425-p4p5 |

## Feature matrix

1. Package ✔. 2. Toggle `kicktodo-engagement`, **OFF**, `bucketUnit: tenant`, dependsOn `kicktodo-core`. 3. `ctx` surface: P5 reads. 4. Node pack: extends `feature.kicktodo.nodes`. 5. Envelopes: none. 6. Agent pack: none new (KickBot reads awards via existing tools). 7. Public surface: none. 8. RBAC: opt-in rows owner-subject-scoped; leaderboard readable by scope members only; fail-closed. 9. Replay/fork: variant in `run.metadata`; award ids deterministic. 10. Frontend: Today-surface composition, no new nav group.

## Alternatives weighed

- **Default-on leaderboard with opt-OUT** — rejected: inverts the PRD's consent posture (§6.6) and 0419's law.
- **Awards as run events** — rejected: no run is involved at check-in time; a derived DurableCollection row with a deterministic id is simpler and replay-neutral.
- **A separate experiments service** — rejected: the toggle-variant + run.metadata stamp already IS the experiment framework.

## Open questions

1. Circle-scoped leaderboards at launch or tenant-scope only first? (Recommend tenant-scope P1, circle scope with 0419 grant checks in P4.)
2. Award taxonomy beyond the launch five — product decision; ids are strings, no enum lock.

## RFC verdict

**Host work, no new RFC.** Everything rides existing host surfaces; nothing is advertised on the wire.
