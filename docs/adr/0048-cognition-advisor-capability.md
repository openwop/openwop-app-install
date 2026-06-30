# ADR 0048 — Cognition & advisor as capabilities (ADR 0045 Phase 5)

**Status:** implemented (vocabulary completion + recognition)
**Date:** 2026-06-15
**Toggle:** none.
**Depends on / composes:** ADR 0045 (the Subject model — this is its Phase 5), ADR 0031
(`agentProfile.capabilities`), ADR 0040 (advisory board), ADR 0023 (assistant), ADR 0038 (knowledge).
**Surface:** host-internal. **Host-only — no RFC** (the `AgentRef` wire is unchanged — see § Wire gate).

## Why this exists

ADR 0045's reframe split two axes the original "agent with `type[]`" conflated: **`kind`** (what a
subject IS) vs **`capabilities[]`** (what it can DO). The capability axis already existed
(`AgentProfile.capabilities`, `AgentCapabilityId = 'assistant' | 'knowledge'`). Phase 5 **completes
its vocabulary** so cognition and advisor — the remaining "agent things" the original proposal
listed as types — are correctly expressed as *capabilities*, not kinds.

## Decision

1. **`AgentCapabilityId` gains `cognition` and `advisor`** (`types.ts`), with the axis documented:
   - **`cognition`** — the agent's inherent ability to take model turns (dispatch). It is implied by
     an agent's `kind:'agent'` projection (`rosterSubject`, ADR 0047). A `person`/`project` Subject
     does NOT have it (no heartbeat-dispatch — ADR 0045 §3).
   - **`advisor`** — eligibility for an advisory board (ADR 0040). A *capability* on a cognitive
     subject, **NOT a kind** (an advisor is an agent). This corrects the original proposal, which
     listed `advisor` as a type alongside `person`/`project`.
2. **`RosterEntry` is the `kind:'agent'` projection** (`rosterSubject`, ADR 0047) — recognized, not
   migrated. A standing agent is a Subject (owns boards/schedules/memory/knowledge) that ALSO has
   the cognition capability; that combination is what "an agent" means.

## What is recognition vs. deferred (deliberate)

- **Recognized now (additive, no regression):** the capability vocabulary + the kind↔capability
  orthogonality + the agent projection. Widening the union is safe — no exhaustive switch reads it.
- **Deferred follow-ons (behavior changes that would regress existing data):**
  - *Gating dispatch on `cognition`* — today dispatch is gated by the agent manifest
    (`memoryShape`, tool surface), which works; hard-gating on the flag would require stamping every
    existing agent. A clean follow-on, not worth the migration risk to land with the vocabulary.
  - *Gating advisory-board membership on `advisor`* — today any roster agent can be added; gating it
    would require auto-granting `advisor` to every seeded advisor. Deferred for the same reason.

## Wire gate (the ADR 0045 Phase-5 caveat — resolved)

**Host-only, no RFC.** The Phase-5 open question was: *does a non-agent subject become a run's
`AgentRef`?* **Decision: no.** Subjects only OWN work surfaces; runs stay attributed to agents via
the existing `AgentRef` (RFC 0002) — unchanged. So the subject model is host-internal throughout,
and no wire RFC is needed. (If a future feature makes a `person`/`project` a run's agent, that
single change re-opens the wire gate — flag it then.)

## Implementation status — and ADR 0045 closeout

| Item | Status |
|---|---|
| `cognition`/`advisor` capability vocabulary | implemented (`AgentCapabilityId`) |
| kind↔capability orthogonality documented | implemented |
| RosterEntry → `kind:'agent'` projection | implemented (`rosterSubject`) |
| dispatch/advisory gating on the new capabilities | deferred (documented follow-ons) |

**With Phase 5, the ADR 0045 Subject model is fully realized:** one `Subject {kind, id}` owns the
work surfaces (Phases 1–2); `project` (ADR 0046), `person` (ADR 0047), and `agent` are its kinds;
capabilities are the orthogonal "does" axis; authority stays `person`-only; the wire is untouched.
