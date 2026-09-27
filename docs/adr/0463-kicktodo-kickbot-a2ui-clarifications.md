# ADR 0463 — KickBot structured clarifications via A2UI (replan)

Status: implemented — 2026-07-21 (branch `feat/adr0463-a2ui-clarify`; agents pack 1.6.0→1.7.0, nodes pack 1.20.0→1.21.0 + 8 repins, `replan-clarify` node between compose and enrich, `test/kicktodo-replan-a2ui.test.ts`)
Extends: ADR 0459 (KickBot participant-loop replan — the flow this adds a clarification round to)
Composes: ADR 0051 (A2UI clarification pattern), RFC 0102 (`ui.a2ui-surface`, Accepted), ADR 0014 (workflow surface), ADR 0426 (opaque subjects)
TODO refs: `docs/steward/TODO.md §6` KT-PORT-9

## 1. Context

When the KickBot replan-composer can't resolve a participant's intent to a concrete
plan-revision — "move my rest day" without saying *which* day — it has **no
structured way to ask**. Today it either returns an honest EMPTY `commands` array
with a plain-language `rationale` (`packs/feature.kicktodo.agents/schemas/plan-revision.schema.json`:
"An intent the composer cannot honestly express … yields an EMPTY commands array")
or the outer KickBot asks in chat **free text**. The sanctioned upgrade (ADR 0051 /
RFC 0102) is a structured `ui.a2ui-surface` clarification form on the interrupt —
model-VARIABLE capture is exactly A2UI's column.

The reference implementation already exists and is copyable: the assistant feature's
`feature.assistant.nodes.enqueue-action` (`packs/feature.assistant.nodes/index.mjs:404-452`)
raises `ctx.suspend({ reason:'clarification', resumeKey, question, catalogVersion,
surface })`, the participant's chat renders the day-1 catalog form, and the collected
values resume inline into the next step. Proven end-to-end by
`test/assistant-calendar-a2ui.test.ts`.

## 2. The PRD-vs-architecture correction (the design decision this ADR exists to make)

KT-PORT-9 framed this as a **small deterministic** clarification: a pre-compose node
that detects a "known-ambiguous pattern" and raises a day-picker. **The scoping
falsified that as the honest shape.** The composer's input `participantIntent` is
**raw free text** (`agentTools.ts:283` — `The participant wants: "<intent>"` + a
state summary). A deterministic detector would be **keyword-parsing free text** — it
fires on the wrong intents and misses others. Shipping that is exactly the
heuristic-theater this program's honesty discipline forbids (ADR 0458 "no painted
status").

**Correction:** the honest trigger is the composer *itself* deciding it needs to ask
— the LLM that already understands the intent + read the real state. That requires a
small, structured **clarification signal** on the composer's closed-world output (not
a free-text heuristic), and a **one-round two-pass loop**. This is bigger than
"small," but it is the only honest version. Recorded here rather than silently
shipping the brittle detector.

## 3. Boundaries audit (compose, don't fork)

- **The A2UI clarification machinery already exists — reuse it whole.** `ctx.suspend`
  (`backend/typescript/src/executor/suspendSignal.ts` — the `clarification` interrupt
  kind is already accepted), the surface transport/validation
  (`host/a2uiSurfaceDelta.ts`), the day-1 catalog (`frontend/react/src/chat/a2ui/catalog.ts:28-36`
  — `field.select`/`field.date`/…), and the ONE renderer
  (`frontend/react/src/chat/a2ui/A2uiSurfaceCard.tsx`, bridged by `interruptBridge.ts:42-48`).
  **DESIGN.md bans a second renderer** — this ADR adds none.
- **The chat already renders surface-bearing interrupts** (`MessageFeed.tsx:129` →
  `a2uiInterruptCard`). The replan run binds `metadata.chatSessionId = conversationId`
  (`agentTools.ts:346`), so a clarification raised in the run surfaces in the
  participant's own conversation — **zero frontend work**.
- **The replan flow is owned by kicktodo-core** (`builtinWorkflows.ts:96-203`, ADR 0459)
  and the composer by `feature.kicktodo.agents.replan-composer`. This EXTENDS both;
  it forks neither.
- **No executor work** — the suspend/resume + a2ui-surface primitives are all present;
  nothing new on the run loop.

## 4. Decision

A **one-round clarification loop** on the replan builtin, LLM-triggered:

1. **Composer signals a clarification-need (closed-world, not free text).** Extend
   `plan-revision.schema.json` with an OPTIONAL `clarification` field:
   `{ question: string, field: { id, type: 'select'|'date', label, options?: [...] } }`
   — day-1 catalog primitives only. The composer emits it INSTEAD of guessing/empty
   when the intent is under-specified within the ADR 0429 lanes (e.g. a rest-day move
   with no target day). `commands` stays empty when `clarification` is present
   (mutually exclusive: ask XOR act). Closed-world — an off-shape object is a typed
   failure, never success-with-empty.
2. **A new `feature.kicktodo.nodes.replan-clarify` node** sits AFTER the first compose:
   if the composer's result carries `clarification` AND `ctx.suspend` is present, it
   builds the surface from the signalled field (mirroring `enqueue-action`) and
   `ctx.suspend`s; the resumed value is folded into an augmented `participantIntent`
   ("…; the participant clarified: <field>=<value>"). Passthrough (emit the intent
   unchanged) when there's no clarification.
3. **Second compose pass** re-runs the composer with the augmented intent → a concrete
   revision → the existing enrich → approve → apply path (unchanged). **Bounded to ONE
   round** (no re-clarify loop — a second under-specified result falls back to the
   honest empty-commands rationale, exactly as today).

Everything downstream of the first compose (enrich/approve/apply/reject) is untouched.

## 5. Evaluation matrix (deltas only)

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | EXTENDS `kicktodo-core` (ADR 0459 replan). No new package. |
| 2 | Toggle | none — rides `kicktodo-core`. |
| 3 | Workflow surface | the replan builtin (`builtinWorkflows.ts`) gains the clarify node + the two-pass edge; host code, no pack bump for the graph itself. |
| 4 | Node pack | `feature.kicktodo.nodes` +1 node (`replan-clarify`) → bump `1.20.0 → 1.21.0` + repin the **7** `feature.ts` pins (accountability/community/engagement/core/creator/metrics/organizations). |
| 5 | AI-chat / envelopes | no new envelope; the a2ui surface rides the existing `clarification` interrupt → `a2uiInterruptCard` bridge in the participant's own conversation. |
| 6 | Agent pack | `feature.kicktodo.agents` — extend `plan-revision.schema.json` (+ the composer prompt) with the `clarification` field → bump `1.6.0 → 1.7.0` + repin (kicktodo-core). |
| 7 | Public surface | none. |
| 8 | RBAC / isolation | inherits the replan run's acting-user authorization (participant-owned; the composer's read tools already authorize under the run's user). Fail-closed unchanged. |
| 9 | Replay/fork | the clarification interrupt + resumed values are durable via the interrupt machinery; no new `run.metadata`. The composer run is deterministic per its inputs. |
| 10 | Frontend | **none** — reuses `A2uiSurfaceCard` (no new renderer, DESIGN.md §compliant). |

## 6. RFC verdict

**Host-extension only — no new RFC.** Rides Accepted **RFC 0102** (`ui.a2ui-surface`)
+ **ADR 0051** (the A2UI clarification pattern). The `plan-revision` schema change is
pack-internal (a pack's own closed-world contract), NOT the OpenWOP wire. No
run-event field, capability flag, or normative MUST changes.

## 7. Phased plan

| Phase | Contents | Gate |
|---|---|---|
| 1 | Agents pack: extend `plan-revision.schema.json` + the composer prompt with the `clarification` signal (ask XOR act); bump `feature.kicktodo.agents` + repin. | — |
| 2 | Nodes pack: `replan-clarify` node (surface builder + `ctx.suspend` + intent-augment; passthrough when absent) mirroring `enqueue-action`; bump `feature.kicktodo.nodes` + repin the 7 pins. | P1 |
| 3 | Host: wire the clarify node + the two-pass edge into the replan builtin (`builtinWorkflows.ts`), bounded to one round. | P2 |
| 4 | Tests: `test/kicktodo-replan-a2ui.test.ts` (catalog-valid surface, resumeKey, resume-merge into the second compose, passthrough when unambiguous, one-round bound) cloned from `assistant-calendar-a2ui.test.ts`; pack manifest↔impl + `requiredPacks` pin-parity tests updated for the bumped versions. | P3 |

No new ADR beyond this one (no executor/wire work); reviews + grade rhythm per ADR 0458.

## 8. Coordination note — the collision surface (READ before implementing)

This lands on the **two hottest ADR-0459 shared assets**: `feature.kicktodo.nodes`
(version + 7 pins) AND `feature.kicktodo.agents` (version + pin) AND the ADR-0459-owned
replan builtin (`builtinWorkflows.ts`). A concurrent pack bump by the active ADR 0459
session is a **guaranteed version/pin conflict**. Implementation MUST be coordinated
with the ADR 0459 owner (or sequenced when they are off those packs), and the
pack-version bumps + repins done LAST, right after a fresh `origin/main` re-sync. This
ADR is authored so that owner can pick it up cleanly rather than a parallel build
stranding their work.

## 8b. Implementation correction — LINEAR insertion, not a two-pass recompose (2026-07-21)

§4 proposed a **two-pass recompose**: the clarify node folds the answer into an
augmented `participantIntent` and a SECOND compose pass re-grounds it (OQ1's
proposal). At the /architect gate this was overturned in favour of a **LINEAR,
single-compose** shape — it is simpler, cheaper (no second LLM call), and equally
honest:

- The composer emits the `clarification` with a **`pendingCommand` shell** — the
  lane command with exactly ONE slot (keyed at `field.id`) left unfilled.
- The `replan-clarify` node sits BETWEEN `compose` and `enrich` (not looping back
  to compose). On resume it fills the slot directly
  (`{...pendingCommand, [field.id]: answer}`) and emits the completed revision;
  with no clarification (or no `ctx.suspend`) it passes the revision through
  **unchanged**. The clarified-or-passthrough revision is what reaches BOTH enrich
  and apply — one compose, one clarify, no graph forking.
- Schema delta (P1) therefore adds `clarification.pendingCommand` (not present in
  §4's `{ question, field }`); the composer completes the command shape, the node
  just fills the one slot. Everything downstream (enrich/approve/reject/apply) is
  untouched, and the round is still hard-bound to ONE (OQ3).

This keeps the ask-XOR-act closed-world contract while removing the second
compose pass §4 assumed. Recorded here per the ADR "correct, don't rewrite
history" rule.

## 9. Open questions

- OQ1: two-pass **re-compose** (re-run the composer with the answer) vs. directly
  applying the clarified value into a revision (proposal: re-compose — the composer
  re-grounds against real state with the answer; simplest honest loop).
- OQ2: `clarification` as a single optional structured field on the composer output vs.
  a separate output kind (proposal: one optional field, mutually exclusive with a
  non-empty `commands` — ask XOR act — to keep the closed-world contract simple).
- OQ3: hard-bound to ONE clarification round (proposal: yes — a still-underspecified
  second result falls back to the existing honest empty-commands rationale; never loop).
- OQ4: which intents may clarify — confine to the ADR 0429 flexibility lanes
  (schedule/substitution/recovery) so the surface only ever asks a bounded, answerable
  question (proposal: yes, lane-confined).
