# ADR 0412 — Productionize the RFC 0097 standing-goals controller

Status: **implemented** — all phases P0–P5 landed 2026-07-18 (phase record at the end of this file)

**Extends:** ADR 0039 (the `features/goals` owner) **in place** — no fork, no new feature, no new toggle.
**Consumed by:** ADR 0414 (`kicktodo-core`) — one bounded goal per enrollment; and any future host feature that needs a durable judged outcome.
**Rides RFCs:** 0097 (standing goals + judge continuation), 0090 (verifier/convergence), 0058 (bounds + budget), 0052 (scheduling continuation).
**Surface:** the existing non-normative `/v1/host/openwop-app/goals[...]` host-extension routes. **NO new RFC** — this hardens the *already-accepted* RFC 0097 owner; it advertises nothing new on the wire.

## Why this exists

KickTodo's entire participant loop (enroll → daily action → check-in → frozen evidence → **judged completion**) rests on RFC 0097 standing goals being a real controller. Today they are not. This ADR is the **critical-path prerequisite** the KickTodo PRD names in §9.5 — it must land before any KickTodo participant work.

## Boundaries audit (Step 3 — verified against live code)

`features/goals` is a single-owner feature-package, but it is a **reference-host conformance seam, not a controller**. Audit findings (`backend/typescript/src/features/goals/`):

- One store, one owner: `new DurableCollection<Goal>('goals')` keyed `${tenant}::${id}` (`goalsService.ts:17`); `goalsService.ts` is the sole writer. **Nothing outside the package imports it** — no run engine, scheduler, or verifier feeds it.
- **Judge write path is orphaned:** `putGoal` (`goalsService.ts:121`) is exported but never called; `progress.contributingRunIds` is initialised `[]` (`goalsService.ts:70`) and never appended; `completion.lastVerdict` (`types.ts:23`) is never written.
- **No verifier invocation:** `completion.verifierRef` is a stored string only (`types.ts:20-24`); the app's real RFC 0090 verifier ladder is entirely separate and never wired to goals.
- **No runtime bound enforcement:** bounds are validated at *create* (`BoundsRequiredError` → 422, `goalsService.ts:40-44,61-76`); `progress.iterations` is set `0` and never incremented; the `bound-exceeded` state (`types.ts:12`) is declared but no code transitions into it.
- **No lifecycle events:** `goal.evaluated`/`goal.closed` payloads exist (`schemas/run-event-payloads.schema.json:246,260`) but have **zero emitters** in `backend/src`.
- **No continuation:** `continuation.armRef` is stored, never read; `heartbeat` mode is deliberately un-advertised (`discovery.ts:788,795`); `scheduleDaemon.ts` has zero `goal` references. pause/resume both merely set `state:'active'` (`goalsService.ts:105-119` — the "arming flag" is a no-op comment).
- Create/state-guard invariants that DO hold and must be preserved: `goal-completion-judge-only` (client-set `satisfied|escalated|bound-exceeded` → 422, `goalsService.ts:78-93`) and `goal-continuation-bounded` (create-time bounds required).
- **Advertisement is AHEAD of behavior (second-pass review finding, 2026-07-18):** `routes/discovery.ts:791-798` *already* emits `goals: { judge: 'verifier', continuation: ['schedule','commitment','manual'], requiresBounds }` whenever `OPENWOP_GOALS_ENABLED=true` — claims this very audit proves are unhonored (no verifier call; continuation arming is a no-op). The claim is latent (the flag ships unset in every deploy config), and conformance is non-vacuous only on the `requiresBounds` 422 — i.e. the judge/continuation claims would be **vacuously green**. The honesty risk is therefore *inverted* from what a P5 "honesty flip" implies: the work is not to start advertising at the end, it is to **guard the existing over-advertisement now** (see P0).

**Conclusion:** the single owner exists but is under-powered. Extending it in place (per the invariants it already guards) is the correct move — **not** a `kicktodo-goals` fork (which would create a second completion truth).

## Decision

Extend `features/goals` so it owns the full RFC 0097 lifecycle. Six additions, each behind the existing `OPENWOP_GOALS_ENABLED` gate with honest advertise/enforce parity:

1. **Bind contributing runs** — a service API to attach a run id to a goal; append to `progress.contributingRunIds` (dedup, CAS).
2. **Invoke the verifier** — after a declared checkpoint, read `completion.verifierRef`, call the RFC 0090 verifier against an **immutable evidence snapshot** (not live collections), persist `completion.lastVerdict`, and transition `active → satisfied|escalated`. Reuse the orphaned `putGoal` as the judge-write path. **Snapshot contract (decided — was open question 3):** goals accepts an **opaque immutable snapshot ref + content hash**; the consumer owns the snapshot schema (KickTodo's `kicktodo.progress-evidence`, ADR 0414 P3). Goals stores the ref+hash on the verdict for replay and never dereferences consumer schema internals.
3. **Enforce bounds at runtime** — increment `progress.iterations`; accumulate wall-clock + cost; transition to `bound-exceeded` when an RFC 0058 bound is crossed.
4. **Emit lifecycle events** — content-free `goal.evaluated` / `goal.closed` on the host-extension event bus (schemas exist); redaction-safe objective/verdict only.
5. **Arm/disarm continuation** — wire `continuation.mode`/`armRef` to the existing scheduler (`host/scheduleDaemon.ts`) and/or the heartbeat work-loop; implement the pause "arming flag" that is currently a no-op.
6. **External ownership seam** — a typed `ctx`/service API so a host feature (KickTodo) can create/enroll/consume a goal with principal/workspace ownership + resource authorization (not tenant-only sample rows).

### Data-model deltas (all additive to `Goal`)
`progress.contributingRunIds` (now appended), `progress.iterations` (now incremented), `progress.accumulatedCostMinorUnits` + `progress.wallClockMs` (new, for bound checks), `completion.lastVerdict` (now written), `continuation.armedJobRef` (new, links the scheduler job). ~~No wire-schema change — `goal.schema.json` already declares these optional.~~

> **Correction note (P1 implementation, 2026-07-18).** The claim above was wrong: `goal.schema.json` is `additionalProperties: false` at every level and declares NONE of the new fields — `lastVerdict` allows exactly `{satisfied, confidence, runId}`, `progress` exactly `{iterations, contributingRunIds}`. Extending the wire shape would be a spec change (RFC gate). The implemented shape instead keeps the extended state (evidence ref+hash now; P2 cost/wall-clock accumulators; P4 `armedJobRef`) in a **host-private `host` sidecar field on the stored row** (`GoalRow`), stripped by `toWireGoal()` before every route/tool/surface output — one store, one owner, honest wire.
> A second P1 correction: the orphaned `putGoal` was **not** reused as the judge-write path — a last-write-wins put racing a client update could drop or resurrect state. The judge write is a bounded `compareAndSwap` loop inside `evaluateGoal` (and `bindContributingRun`); `putGoal` was removed.

## Phased plan

| Phase | Ships |
|---|---|
| **P0 (do FIRST)** | **Honesty guard for the existing over-advertisement:** a test asserting `OPENWOP_GOALS_ENABLED` stays unset/false in every shipped deploy config until P5, plus a corrected `discovery.ts` comment (it currently claims schedule/commitment/manual are "honored" — they are not). Narrowing the ad itself is not an option short of not advertising (the capability shape requires a `judge` claim), so the flag-off guard is the honest interim. |
| **P1** | Run-binding + verifier invocation against a caller-supplied immutable evidence snapshot (opaque ref + hash per the decided contract above); `putGoal` becomes the judge-write path; `lastVerdict` persisted; `satisfied/escalated` transitions. Route + service tests for convergence + cross-tenant denial. |
| **P2** | Runtime bound enforcement (iterations/cost/wall-clock → `bound-exceeded`); exact-bound-termination tests. |
| **P3** | `goal.evaluated`/`goal.closed` emission (content-free); replay invariant test (no recompute at replay). |
| **P4** | Continuation arm/disarm wired to `scheduleDaemon`; pause/resume arming flag real; daemon integration + escalation tests. |
| **P5** | Principal/workspace ownership + resource authorization; the external `ctx`/service consumption API; the honesty flip — remove the P0 guard and advertise **exactly the wired set**. The currently-advertised `commitment` mode has no wiring plan: either P4 wires it or P5 **drops it from the advertisement** (recommend: advertise only `judge:verifier` + `schedule`/`manual` at P5; re-add `commitment` when a commitment seam actually arms it). `OPENWOP_REQUIRE_BEHAVIOR=true` must be green **non-vacuously** for every advertised claim. |

**Core-app extension surface:** no new node/agent pack (the existing read-only `openwop:goals.list` tool stays); the new surface is the **`ctx` consumption API** (P5) that ADR 0414 calls. `/.well-known/openwop` advertises the RFC 0097 capability honestly *after* P5 — `OPENWOP_REQUIRE_BEHAVIOR=true` must stay green.

## Feature matrix (delta only)

Feature-package ✔ (extends `goals`, no new package/toggle) · Workflow surface: new `ctx` consumption API + verifier integration · Node/agent pack: none new · RBAC: principal/workspace ownership + IDOR-guarded resource authz (was tenant-only) · Replay/fork: verifier judges a **frozen** snapshot; verdict read verbatim on `:fork`, never recomputed; events not re-emitted · Public surface: none.

## Alternatives weighed

- **Fork `kicktodo-goals`** — rejected (PRD §9.5): two completion truths that drift; violates single-source-of-truth and ADR 0079 (strategic-planning) / ADR 0272, which already refuse to reuse `goals` precisely because it is "judge-owned runtime machinery." (Citation note: the repo has two files numbered 0079; the reference here is `0079-strategic-planning.md`. Per the duplicate-number policy the later-created `0079-streaming-llm-interactions.md` should be renumbered — tracked separately, not this ADR's work.)
- **Leave goals as a seam, judge in KickTodo** — rejected: puts completion authority in a product feature (or worse, an agent's confidence), breaking RFC 0097's judge-owned contract.

## Open questions

1. Does continuation arm through `scheduleDaemon` (time-based) or the heartbeat work-loop (pull-based), or both per goal? (Recommend: scheduler for cadence checkpoints; heartbeat off by default.)
2. Cost accounting source of truth for the RFC 0058 budget bound — run metadata vs a metering seam?
3. ~~Evidence-snapshot format~~ — **decided** (2026-07-18 second-pass review; see Decision §2): goals accepts an opaque immutable snapshot ref + content hash; the consumer owns the schema. Closed here because ADR 0414 P3 already depends on this answer — a cross-ADR interface must not stay open in the provider while committed in the consumer.

## RFC verdict

**Host work — no new RFC.** RFC 0097/0090/0058 are Accepted; this productionizes the reference host's own owner. The only wire-facing act is the honest capability advertisement in P5, gated on real behavior.

## Implementation record (phase → PR)

| Phase | Landed |
|---|---|
| P0 — honesty guard (`test/goals-advertisement-guard.test.ts` + corrected `discovery.ts` comment) | #2070 |
| P1 — run-binding + verifier invocation (`goalVerifiers.ts` registry port; CAS judge-write in `evaluateGoal`; `GoalRow` host-private sidecar + `toWireGoal` projection; `/goals/:id/runs` + `/goals/:id/evaluate` routes; `ctx.features.goals` surface slice; `test/goals-verifier.test.ts`) | #2072 |
| P2 — runtime bound enforcement (iterations increment on non-replayed evaluations, exact-bound termination; wall-clock pre-judge check, judge NOT invoked past a bound; cost accumulation at `bindContributingRun(runId, costUsd)` — the OQ2 answer: cost attaches to the contributing run, dedup never double-counts; `test/goals-bounds.test.ts`) | #2075 |
| P3 — lifecycle events (`goalEvents.ts`: `host.goals.evaluated`/`host.goals.closed` on the ADR 0208 host bus — RFC 0086 §E host-namespaced since the run event log requires a runId; payloads mirror the canonical §goalEvaluated/§goalClosed schemas exactly; emission gated on the advertised capability per the schemas' MUST-NOT; content-free + replay-never-re-emits tested in `test/goals-events.test.ts`) | #2076 |
| P4 — continuation arm/disarm (`armContinuation` → ONE deterministic `goal:<tenant>:<goalId>:continuation` scheduler job wrapping the CONSUMER-supplied checkpoint workflow+cadence; pause/resume are real `setJobEnabled` toggles — the no-op arming flag is retired; every terminal path disarms, incl. the bind-time cost flip; OQ1 answered: scheduler only, heartbeat stays off; `commitment` remains un-wired → CONFIRMED dropped from the P5 advertisement; daemon-integration tests in `test/goals-continuation.test.ts`) | #2077 |
| P5 — ownership + honesty flip (create stamps `owner.principal` from `callerSubject`; principal-owned goals deny foreign-principal mutations with uniform not-found — the denial precedes the replay short-circuit so no verdict leaks; absent principal = tenant-trusted internal caller; surface completed with `list`/`transition`; discovery now advertises EXACTLY the honored set `judge:verifier` + `schedule`/`manual` — `commitment` dropped; the P0 repo-scan guard leg deleted per its own instruction, replaced by ad↔behavior parity tests incl. a non-vacuous judge round-trip; `test/goals-ownership.test.ts`) | kicktodo/a5-goals-ownership-honesty |
