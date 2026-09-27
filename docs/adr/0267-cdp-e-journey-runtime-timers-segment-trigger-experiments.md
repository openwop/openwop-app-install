# ADR 0267 — CDP-E: Journey runtime — self-advancing timers, segment-entered triggers, experiments & canvas

**Status:** in-progress (timer + segment-trigger + holdout + split node + frequency governor; journey canvas FE is the remaining large-UI follow-on)
**Date:** 2026-07-05

> **Graduation:** the journey-canvas FE graduates **second** (after CDP-C segments), on a higher bar — journeys act on data (outbound messaging), so the consent/frequency/purpose controls must be proven on live data first. See [ADR 0262 § Graduation decision](0262-cdp-customer-data-platform-program.md#graduation-decision-added-2026-07-18--the-cdp-graduation-call). Parked until that trigger; the runtime already ships, the palette on the existing `BuilderCanvas` is FE-only.
**Depends on:** ADR 0262 (CDP program + rulings — esp. #2 replay), the workflow executor (`executor/scheduler.ts`, `suspendManager.ts`, `approvalGateTimeout.ts`), ADR 0034 (trigger ingestion) + `host/hostEventDispatcher.ts`, ADR 0222 (journeys-are-workflow-chains), ADR 0099 (run-start-context replay seam), ADR 0211/0265 (segments), ADR 0072 (builder canvas), `host/variantAssignment.ts` (bucketing)
**Part of:** CDP program (ADR 0262). CDP-E, Phases 0/1/3.

## Why this exists

Journeys are the CDP's orchestration surface. The executor already gives A-grade primitives —
conditional `EdgeCondition` branching (`executor/scheduler.ts`), durable suspend/resume
(`suspendManager.ts`), sub-workflow fan-out, and event/webhook/email/form/cron triggers. But the
**journey layer has four holes**, one of them a latent correctness trap:

1. **Timed delays don't self-advance.** `core.openwop.flow` `waitNode` (`index.mjs:372`) emits
   `ctx.suspend({kind:'duration'|'until'})`, but `InterruptRecord.kind`
   (`executor/types.ts:760`) has **no timer member** and there is **no wall-clock wake daemon** — a
   `wait` hangs until a manual `POST /v1/interrupts/:token`. Every "wait N days then send" journey is
   currently non-functional.
2. **No segment-entered trigger** — `resolveSegment` is a live fan-out read, not an entry event.
3. **No journey experiments/holdouts.**
4. **No journey canvas** — Campaign Studio is a form; the real xyflow canvas (ADR 0072) is unused for journeys.

## Decision

Harden the journey runtime by **extending the executor and reusing the trigger bridge, canvas, and
bucketing** — no second engine (ADR 0222; ADR 0262 ruling #6).

### 1. Self-advancing durable timer (Phase 0 — the keystone; ADR 0262 ruling #2)

Add a `'timer'` (duration/until) member to `InterruptRecord.kind` (`executor/types.ts:760`) carrying
a **frozen `resumeAt`** deadline, computed at `ctx.suspend` as `createdAt + duration` — **never
recomputed at wake**, exactly mirroring `approvalGateTimeout.ts:approvalGateDeadlineMs` (which
derives from the frozen `interrupt.createdAt`). A **timer-sweep tick** modeled on
`sweepExpiredApprovalGates` (riding the webhook-delivery-worker tick) resolves the interrupt as
**completed** when `resumeAt` elapses; a lazy check on any interrupt read resolves an overdue timer
first.

**Replay/fork semantics (stated per ruling #2):** the deadline is part of the checkpointed interrupt,
so `:fork` recomputes it identically. A **fork before the timer fires inherits the original
`createdAt`/deadline** (matching approval-gate behavior) — it does *not* re-arm from a new clock. Any
branch-affecting value derived from timing is frozen via `runStartContext` → `run.metadata`
(ADR 0099), read verbatim on fork.

### 2. Segment-entered trigger (Phase 1 — reuse the bridge)

A **membership-diff daemon** on the existing scheduler resolves segment membership
(`crm/segmentsService.resolveSegmentMembers`), diffs against a last-seen snapshot, and calls
`emitHostEvent` (`host/hostEventDispatcher.ts`) per newly-entered contact → fires bound journey
workflows through the existing `HostEventBinding` path (`hostEventDispatcher.ts:51`). **Reuses the
trigger bridge — no parallel trigger source, no `TriggerEvent.source` wire change.**

### 3. Experiments / holdouts (Phase 3 — reuse bucketing)

A **split/holdout node** doing deterministic per-contact bucketing (`host/variantAssignment.ts`,
keyed on `contactId`, replay-stable) → branch edge; the executor's conditional edges route it. A
tenant-level control group reuses `suppressionService`. Coordinated with CDP-C's segment holdout —
one shared bucketing primitive.

### 4. Frequency governor + draft-publish + journey canvas (Phases 1/3)

Promote `campaign-journeys checkFrequency` from an opt-in edge read to an automatic **pre-send gate**
in the email/SMS/push channel-action nodes (keyed on `emailSentLedger.ts`). Extend `snapshotCampaign`
to give journeys a `status: draft|published` + version pair. Point the journey builder at the
**existing** `builder/canvas/BuilderCanvas.tsx` scoped to a journey node palette (trigger/wait/branch/
channel-action/frequency-gate) — **no second canvas**.

## Scope / non-goals

- The timer is a host-ext executor extension; the `waitNode` config surface is unchanged.
- Cross-journey priority arbitration is a later add (the `JourneyEnrollment` CAS is the natural chokepoint) — noted, not built here.

## Phased plan

1. **Phase 0:** `timer` interrupt kind + frozen `resumeAt` + sweep tick + lazy resolve; replay/fork test (fork-before-fire inherits deadline).
2. **Phase 1:** membership-diff daemon + segment-entered host event + frequency governor.
3. **Phase 3:** split/holdout node + journey draft-publish + journey canvas palette.
4. Verify: timer replay/fork determinism test; segment-entry idempotency test; holdout bucketing stability test.

## Open questions

- [ ] Fork-before-timer: inherit original deadline (recommended, matches approval gates) — **decided: inherit.**
- [ ] Membership-diff daemon cadence (per-segment) — inherit scheduler cadence config. Default: 15m/hourly like knowledge-sync.

## Consequences

Journeys gain durable time, behavioral entry, and experiments **on the existing engine** — the single
most leverage-dense CDP change, since the timer unblocks every lifecycle journey. The one real risk
(timer non-determinism) is eliminated by copying the proven approval-gate freeze-at-suspend pattern
and stating fork semantics up front.
