# ADR 1001 — Clarification cards in both lanes

Status: implemented — P1 (PR #5372), P2 (PR #5379); both toggles OFF until the enablement checklist clears

> **Status corrected 2026-10-29.** This ADR was held at `Proposed` until P1
> merged (the lead's instruction). `adr-status-not-stale` refuses a `Proposed`
> ADR with implementing commits, and train 151 caught it: P1's decisions are
> accepted and built. It is not `implemented` while P2 is open.
>
> **Status updated 2026-10-29: `implemented`.** P2 merged as #5379 (train 157,
> merge commit `f382e70d1`) and is live on `openwop-app-backend-01084-bm8`.
> Both toggles stay OFF; enabling either is held to the enablement checklist
> below. Residue R9–R12 are their own rows.

> **AMENDED 2026-10-30 by ADR 1006.** The run lane no longer reads a fenced
> `clarification.request`. Both lanes ask through one tool, `openwop:ask-user`
> (D7's `openwop:chat.ask-user`, renamed). On a run the tool loop handles the
> call itself. So D1.1, D1.2, D5's prompt-block source, D7's scope line "the run
> lane never passes it" and D9's `clarification_not_enabled` are superseded; D2,
> D3, D4, D6 and D8 stand. Those sections are kept as the reasoning trail.

## Phase → commit

| Phase | Commits (PR #5372) | Witnesses |
|---|---|---|
| ADR | `261d2c56c` reserve · `0c782fceb` draft · `74d4c4e21` /architect fold · `7065ebec7` O1–O5 · `a5e8f98a3` B1 API · `106cccda7` #5362 composition · `cf8dfd964` B1 confirmed · `91c183360` R8 | — |
| P1 lift, card | `4d7738f45` · `aef8f3082` | `clarification-lift`, `ClarificationDialog.agentAsk` |
| P1 executor + storage | `dcd7f4191` durable keys + seed · `2a0e9ab03` checkpoint · `0ae4ee67f` visit partition | `adr1001-durable-suspend-keys`, `-ordinal-seed`, `-visit-ordinal-wiring`, `-clarification-checkpoint`, `-checkpoint-run-cascade` |
| P1 wiring | `2fabaf7a8` · `516c48242` O3 | `adr1001-p1-clarification-run`, `-fork`, `-schema-rounds-advert`, `-clarification-lane-ratchet` |
| P1 after #5362 | `c6ebc2196` zero-live-calls · `e66ae2a09` final-head review fold · the train-151 ratchet fix | `adr1001-byok-replay-zero-live-calls`, `adr1001-review-fixes` |
| P2 | `d4a0beaad` (PR #5379, one squashed commit; merged in train 157 as `f382e70d1`) | `adr1001-p2-chat-ask`, `chatClarificationCard`, the tool censuses |

## Context

When an agent cannot continue without information only a person has, today it
says so in English: in a tool error, or in final prose. Nothing structured
reaches the user, nothing pauses, and nothing returns an answer to the agent.

Two lanes need this, and they are different machines:

- **Run lane (in-run).** A workflow node (`host/agentRunnerNode.ts`) calls
  `runAgentDispatchLive` → `runToolLoop` → the shared `runChatToolLoop`
  (`host/agentDispatch.ts`). The node has the real `ctx.suspend`.
- **Chat lane.** A conversation is a run suspended at `core.conversationGate`.
  Each exchange runs inside the RESOLVE handler (`host/conversationExchange.ts`,
  RFC 0005 §D) WITHOUT re-entering the node, so a chat turn has no
  `ctx.suspend`. It reaches the same `runChatToolLoop` through
  `host/conversationToolLoop.ts`.

What exists, MEASURED at `639a4df2c`:

| Site | State |
|---|---|
| `agentDispatch.ts:1097-1103` | Doc comment: "only the `schema.request` kind is handled here (clarifications ride interrupts…)". No code makes a clarification ride an interrupt. |
| `agentDispatch.ts:1145-1157` `extractSchemaRequestEnvelope` | Filters `type === 'schema.request'`; any other fenced envelope is ignored. |
| `agentDispatch.ts:1233-1275` | The only envelope handling in the loop. A `clarification.request` falls through to `answered = true` and becomes the turn's final text. **This is the drop.** |
| `envelopeProjection.ts:99-112` | Lifts an accepted `clarification.request` to `interrupt.requested{kind:'clarification', envelopeId}` with the comment "Resume schema would be lifted from the payload's `responseSchema`" — no questions, no resume schema. Reached only from `routes/testSeam.ts:789` and it writes to `appendTestEvent`, the test log. **This is the stub.** |
| `envelopeAcceptor.ts:476-485` | The `clarificationRounds` counter check exists; no production caller passes `counters.clarificationRounds`. |
| `routes/discovery.ts:1324` | Advertises `limits.clarificationRounds: 5` under the comment "this host genuinely enforces every number below". It does not: nothing counts a clarification round. |
| `interrupts/ClarificationDialog.tsx` + `chat/registry/defaultCards.tsx` `FreeTextClarificationCard` | The two existing clarification renderers (run page / inbox, and the chat feed). Both read ONE `data.question` and resume `{answer}`. Neither reads the wire `ClarificationData.questions[]`. |

The wire is already decided and Accepted (RFC 0021; `spec/v1/interrupt.md`
§`kind: "clarification"`; `schemas/envelopes/clarification.request.schema.json`):

```ts
// envelope payload                        // lifted interrupt data            // resume
{ questions: [{ id, question,              { questions: [{ id, question,       { answers: [{ id, answer }] }
    schema?, context? }],                      schema? }],
  contextType?, reasoning? }                 contextType? }
```

`limits.clarificationRounds` is "a hard cap on total `clarification.request`
envelopes **per node**"; on breach the engine MUST emit
`cap.breached{kind:'clarification'}` AND fail the node (`capabilities.md`
§Engine-enforced limits).

**Correction to the brief.** The brief says the interrupt "carries question,
options and responseSchema". The wire has no `options` or `responseSchema`: it
has `questions[]`, each with an optional answer `schema`. Choices are a
`schema.enum`. This ADR follows the wire.

## Decision

> **Revised after the /architect adversarial pass (2026-10-28).** The first draft
> (`f3ab8bbc3`) had three Blockers and seven Highs, all folded in below and
> listed in § Review findings. The largest change is D3: re-entry
> is now written out step by step. The checkpoint never freezes borrowed recall,
> and a fork resolves through derived rows instead of being served inline.

### D0 — Where the code lives (core never imports a feature)

Every caller is core: `agentDispatch`, `agentRunnerNode`, `envelopeProjection`,
`makeSuspendFn`, `routes/interrupts.ts`. So the mechanism lives in `host/` and
`executor/`, and the feature package holds only what a feature may own:

| Module | Owns |
|---|---|
| `host/clarificationLift.ts` (pure) | D2 vocabulary, caps, `liftClarification`, `resumeSchema` generation, `questionsDigest`, `clarificationPromptBlock()` |
| `host/clarificationCheckpoint.ts` | the D3 checkpoint PORT (interface + late-bound setter). Default impl is a `Storage` table (below) |
| `storage` (both adapters) | checkpoint rows are run-keyed `host_ext_kv` rows under `hostext:runclarify:<runId>:` (`storage/runKvKeys.ts`), deleted by both run-delete paths (`deleteRun`, `pruneTerminalRuns`) on both adapters |

> **Corrected in implementation (2026-10-28): H4's premise was half right.**
> `deleteRun` does have no lifecycle hook a feature can register on. But it
> already hand-lists run-keyed `host_ext_kv` prefixes (`hostext:runartifact:`,
> the ADR 0889 tool-boundary patterns), so a new run-keyed prefix needs one
> line per delete path and no migration. That is what shipped:
> `clarificationCheckpointKeyPattern` in `storage/runKvKeys.ts`, added to all
> four paths. `adr1001-checkpoint-run-cascade.test.ts` pins it on sqlite and
> pg-mem, and each of the four lines plus the LIKE escape was sabotage-witnessed.
| `features/agent-clarification/` | the two toggles, the run-start contributor that freezes the stamp (D5), the expiry sweep (D6) via a late-bound registration, the chat tool registration (D7), the chat ask store (D7) |

### D1 — Run lane: the loop RETURNS a clarification, the node suspends

`runChatToolLoop` cannot suspend mid-iteration (`agentDispatch.ts:1180-1183`,
the ADR 0132 Phase 3 pending-approvals precedent). So:

1. `extractSchemaRequestEnvelope` generalises to `extractEnvelope(text, kinds)`.
   The schema path is unchanged.
2. New loop option `clarification?: { roundsUsed: number; cap: number }`, passed
   ONLY by `agentRunnerNode` and only when the run's frozen stamp (D5) is on.
   Absent: today's behaviour, byte for byte. Present: a no-tool-call reply with a
   fenced `clarification.request` goes through
   `acceptEnvelope(env, { counters: { clarificationRounds: { current: roundsUsed, cap } } })`:
   - `accepted` → `liftClarification` (D2). On success the loop STOPS and returns
     `pendingClarification: { lifted, correlationId, transcript }`.
   - `breached` → routed through the ONE projector (D1.5) → `cap.breached
     {kind:'clarification', limit: 5, observed: 6}` (the ATTEMPTED count, not the
     acceptor's `current`) + node failure `cap_breached`, `retryable: false`.
   - `invalid` / `gated` / lift refusal → ONE error-fed repair round, then a
     typed failure `clarification_envelope_invalid`. Never success-with-empty.
3. `runToolLoop` maps it to `AgentDispatchResult.status: 'awaiting_input'`. That
   status is reachable only through the option above, which only
   `agentRunnerNode` passes. The host-ext dispatch routes
   (`routes/agents.ts:342`, `:816`) serialise the result as-is, so a type-level
   split (`AgentDispatchResult` vs `RunLaneDispatchResult`) keeps the value off
   them, with a test that the route lane can never produce it. It skips the
   §F/§D/verifier tail and `persistTurnSummary`.
4. `agentRunnerNode` — the re-entry algorithm (`ctx.suspend` THROWS on first
   call, `suspendSignal.ts:90-108`; a resume re-runs the node from the top with
   ONE seeded resolution, `executor.ts:2148-2153`):
   1. Run the `agent-hitl` gate as today (now `durable: true`, D3.2).
   2. Read the latest checkpoint for `(runId, nodeId)`.
   3. **Checkpoint present** → rebuild its key from the stored `round` +
      `questionsDigest`; `await ctx.suspend({ …same payload…, key })`. The seeded
      answer returns inline (or it throws again and the run stays suspended).
      Seed the effect-ordinal allocator from `checkpoint.ordinalCursor` (D3.3),
      rebuild the first message LIVE (D3.4), append the fenced answer (D4), and
      dispatch with `resumeFrom` and `roundsUsed: round`.
   4. **No checkpoint** → full dispatch.
   5. On `awaiting_input`: write the checkpoint for `round = roundsUsed + 1`,
      THEN `ctx.suspend({ kind: 'clarification', key, durable: true, profile:
      'openwop-agent-clarification', questions, contextType, round, timeoutMs,
      resumeSchema })`. That is the REAL executor suspend (`executor.ts:1266`),
      which emits the normative `interrupt.requested`. A crash between the write
      and the suspend leaves a checkpoint with no interrupt, and re-entry step 3
      re-raises the same key: idempotent.
   6. On completion or failure: the checkpoint rows stay (D3.3: replay needs
      them). They go with the run.
   > **Composition with ADR 1002 (#5362, planned 2026-10-28).** #5362 wraps the
   > node's `executeTool` in `createReplayToolGuard`, guards `callAIWithTools`
   > the same way, and returns `replayMissFailure` after the dispatch. Both
   > guards allocate from the SAME per-node ordinal allocator. The P1 node
   > orders its post-dispatch checks so the two compose:
   > 1. **The replay miss comes first.** A replay that missed a recorded model
   >    round or tool result fails the node (`replay_source_missing`) BEFORE
   >    any `awaiting_input` is acted on. A clarification asked on a diverged
   >    replay is never suspended on, and never shown to a person.
   > 2. **Then `awaiting_input`:** write the checkpoint and suspend. A replay
   >    fork reaches the ask through recorded rounds only, and its suspend is
   >    resolved from the source's recorded answer through derived rows (D3.5),
   >    so a replay never re-asks.
   > 3. **The continuation is seeded** (`seedNodeActivity`, D3.3) BEFORE the
   >    resumed loop's first model round. The guard's tool-result keys share
   >    that allocator, so the cursor covers the recorded tool calls as well as
   >    the model rounds. The ADR 1002 agent confirmed this condition.
   > Whichever of #5362 and P1 lands second rebases onto the other. The node
   > keeps `createReplayToolGuard` outermost.

5. **One projector.** `envelopeProjection.ts` already emits `cap.breached` +
   `node.failed{code:'cap_breached'}` (`:223-260`) but writes to the test log.
   Its event construction is split from its sink: the test seam keeps
   `appendTestEvent`, and production passes the run's `ctx.emit`. Both call
   `liftClarification`, so the stub at `:99-112` lifts real questions and the
   seam and production cannot diverge.

**Interrupt key:** `clarify:${round}:${digest16}`. `interruptRequestKey` already
prefixes `${runId}:${nodeId}:` (`interruptRequestedPayload.ts:48-50`), and the
wire caps `key` at 256 (`suspend-request.schema.json`). So the key does not
repeat the nodeId, and the digest is the first 16 hex of the sha256 of the
LIFTED (normalised) questions. That is deterministic, because the lift is pure.

### D2 — The closed answer vocabulary (security)

The envelope admits a per-question `schema` of any shape and an open `context`
bag. Compiling a model-authored JSON Schema is a model-controlled `pattern`
(ReDoS) and an unbounded compile, and rendering one is an unbounded UI. So the
host never compiles or renders the model's schema. `liftClarification` maps each
question onto a closed vocabulary and refuses anything else:

| Model `schema` | Lifted answer schema | Card control |
|---|---|---|
| absent, or `{type:'string'}` (+ `maxLength ≤ 2000`) | `{type:'string', minLength:1, maxLength}` | textarea |
| `{type:'string', enum:[…]}` | `{type:'string', enum}` | radio group |
| `{type:'boolean'}` | `{type:'boolean'}` | yes / no |

Caps: ≤ 5 questions per ask, question ≤ 500 chars, ≤ 8 choices, choice ≤ 120
chars, `id` matching `^[A-Za-z0-9_.-]{1,64}$` and unique. `context` and
`reasoning` are dropped (not persisted to the interrupt, not rendered).
Normalisation strips control characters and bidi overrides. The interrupt row
keeps `profile` and `round`. The wire is unaffected: `buildInterruptRequestedPayload`
projects clarification data to `{questions, contextType}` (`interruptRequestedPayload.ts:99-109`).

`resumeSchema` is generated:
`oneOf[ {answers: prefixItems [{id:{const}, answer:<lifted>}…], items:false}, {skipped:true} ]`.
The `const` ids stop a stale round-1 card from landing on round 2. The by-node
resolve takes the LATEST open row for the node, so a round-1 POST would
otherwise reach round 2. The existing `assertResumeMatchesSchema` enforces this
on every external lane (`routes/interrupts.ts:1621`: by-node, token, reviews,
MCP, inbound webhook). A person-submitted `reason: 'timeout'` is refused,
mirroring RFC 0223's refusal of a person-submitted `action: 'timeout'`.

### D3 — Checkpoint, durable keys, fork (replay)

Two hazards follow from the re-invoke model, both measured:

- **The prefix would re-execute.** Tool calls made before the ask would run
  again. So would provider calls. The managed tier (this node's default)
  bypasses the invocation log (`aiProvidersHost.ts:644-651`, tools `:913`), so
  the model might not even ask the same question.
- **A second sequential suspend can never be passed.** With one seeded
  resolution, a node that suspends on A and then on B is re-entered with only
  B's answer. A throws again, forever. `agentRunnerNode.ts:191-205` already
  suspends once (the `agent-hitl` gate) before any clarification would.

1. **Checkpoint row** `(tenantId, runId, nodeId, round)` → `{ transcriptTail,
   roundsUsed, questionsDigest, ordinalCursor, createdAt }`, capped at 256 KB.
   Over the cap, the model is told "too much context to pause here; finish
   with what you have". It is server-only (never in interrupt `data`), lives
   in a run-keyed `host_ext_kv` row, and goes with the run (D0). Subject erasure: the transcript tail
   holds tool output, not the subject's profile. The rows ride the run's
   existing retention and DSAR posture, which is the posture of the run's
   events. That is stated, not new.
2. **Opt-in durable keys in `makeSuspendFn`.** A suspend with `durable: true`
   is served from (a) the seeded resolution, else (b) a RESOLVED interrupt row
   of THIS run and node whose `__resumeKey` matches. There is no read of
   another run, ever. Without the flag nothing changes, so no node that
   deliberately re-asks on one key moves. The `agent-hitl` suspend opts in.
3. **Ordinals.** `beginNodeActivity` rewinds the ordinal to 0 on every re-entry
   (`executor.ts:2532`, `effectIdentity.ts:171-173`). The checkpoint stores
   `ordinalCursor` (the ordinal the next call would take), and step 3 seeds the
   allocator from it through a new `effectIdentity.seedNodeActivity(runId,
   nodeId, attempt, next)`. The continuation's calls then get the SAME ordinals
   in the source, in a crash-resume and in a replay fork. Test: a BYOK replay
   fork of a two-round node makes zero live provider calls.
   **B1 API, exact (`host/effectIdentity.ts`, committed `a031e9d8f`).** This is
   shared with the `managed-tier-replay` agent, whose invocation-log keying
   rides the same ordinal. **Confirmed 2026-10-28:** that agent confirmed the
   visit partition (`fc21f759d`) meets ADR 1002's needs, with nothing
   missing. The live-fold caveat for ADR 0772 loopback is also recorded in
   ADR 1002 D4b, and it fails closed.
   - `peekNodeActivityOrdinal(runId, nodeId): number` returns the ordinal the
     next `nextLogicalInvocationOrdinal` call for `(runId, nodeId)` would
     return within the current attempt, or `0` when there is no state. It is
     READ-ONLY: it allocates nothing and creates no state.
   - `seedNodeActivity(runId, nodeId, next): void` sets the cursor for
     `(runId, nodeId)` to `max(0, floor(next))`. It KEEPS the current attempt
     (`1` when there is no state), so a later attempt still rewinds to 0
     through `nextLogicalInvocationOrdinal`'s attempt check.
   - **Who calls them.** Only `agentRunnerNode`, and only on the
     clarification path. At the pause it records
     `peekNodeActivityOrdinal` as `checkpoint.ordinalCursor`. On every
     continuation from a checkpoint (source re-entry, crash re-entry, replay
     fork), it calls `seedNodeActivity(cursor)` right before the continuation
     dispatch, and AFTER the executor's `beginNodeActivity` rewind.
   - **Opt-in.** Without a seed call, the allocator is byte-identical to main.
     `test/adr1001-ordinal-seed.test.ts` case 3 pins this: peek is read-only,
     an unseeded re-entry rewinds to 0, a new attempt rewinds to 0. The
     existing RFC 0150 §B cases in `effect-identity-v2.test.ts` are unchanged.
   - **The invariant it buys.** Within one attempt, a body that resumes from a
     checkpoint allocates for each logical call the ordinal an uninterrupted
     body would have. Source and fork therefore agree, however many
     invocations each took to get there.
   - **Visit partition (ADR 1002's ask, folded in 2026-10-28).**
     `beginNodeActivity(runId, nodeId, attempt, visit = 0)` starts each VISIT
     at `visit * VISIT_ORDINAL_STRIDE` (2^20). A new attempt, a same-visit
     re-entry and a seed all stay inside the visit's range. Visit 0 is
     byte-identical to main, so existing records keep their identity.
     - **The visit is NOT the ADR 0772 execution ordinal.** A retry opens a
       new execution, but RFC 0150 §B requires attempt 2's first effect to
       have attempt 1's identity (the retry-stable read). So
       `ExecutionOrdinals.visitOf` folds it from the log: the first start is
       visit 0; a start after a FAILED execution is a retry (same visit); a
       start after a COMPLETED one is a revisit (visit + 1); a re-entry of an
       open execution keeps its visit.
     - **Stated edge:** a node re-run after an unretried failure (an error
       edge looping back) reads as a retry.
     - **Where the visit is live, and the trap it leaves.** The executor
       builds `ExecutionOrdinals` on replay forks ONLY (`executor.ts`,
       "Replay only: nothing else reads the ordinal yet (D5 will)"). So a
       live run always passes visit 0, while a replay fork passes the folded
       visit.
       - Today the two agree: nothing re-enters a completed node. The
         scheduler rejects plain cycles, and `core.dispatch` /
         `core.orchestrator.supervisor` iterate inside one execution
         (`scheduler.ts:131-180`). ADR 0772 RRWF-10 bounded loopback is
         unbuilt.
       - The ADR 1002 case ("two visits at the same attempt") is therefore
         unreachable on this host today. Every live re-entry is a
         same-execution re-entry or a retry, and both MUST share identities.
       - **When loopback lands, it MUST fold ordinals on live runs too.**
         Otherwise a source records every visit at base 0 while its fork
         keys visit k at k·2^20, and every revisit replays live.
       - Witnessed by `adr1001-visit-ordinal-wiring.test.ts`: its replay-fork
         retry case reds if the executor passes the execution count instead
         of the visit.
   - **Interaction to settle with `managed-tier-replay`.** Its "a live revisit
     must call live" condition depends on what a re-entry's identities are.
     Seeding changes identities only for the clarification continuation and
     nothing else. If that agent's keying needs the continuation to be
     distinguishable from a fresh body, the seed is the hook. The ordinal
     already differs from a top-of-body call's.

4. **No frozen recall.** Borrowed twin recall, memory and context blocks live
   in `messages[0]` (`agentDispatch.ts:786-791`). The node's own comment
   forbids freezing them (`agentRunnerNode.ts:255-265`: "That live re-read is
   WHY revocation holds"). So the checkpoint stores `messages[1..]` only, and
   every resume, crash-resume and fork rebuilds `messages[0]` LIVE through
   `buildInitialMessages`. A grant revoked during the wait therefore holds. The
   cost: the digest changes and the continuation diverges per RFC 0041 §B,
   which is the existing posture for a revocation-changed prompt. Test: revoke
   the grant mid-wait, resume, and the borrowed block is absent.
5. **Forks resolve through derived rows, never inline.** When a
   `forkMode: 'replay'` run re-executes the node and raises a durable-keyed
   clarification, the suspend goes through the normal branch, so the fork's log
   gets `node.suspended` / `interrupt.requested` like the source. The executor
   then looks up the PARENT's resolved row with the same `__resumeKey`, using
   the `forkReplayResolutions.ts` machinery (the `DERIVED_MARKER` row, a
   deterministic id, inserted already resolved, `interrupt.resolved` recorded
   in the fork's log), and re-invokes. The fork's event sequence matches the
   source, so `replayDivergence.ts:22-37` sees no false divergence, and no
   decision enters the fork without its own log record.
   - **Digest miss on a replay fork** (the model asked something else) → the
     node FAILS `replay_diverged_at_clarification`, `retryable: false`. A
     replay never re-decides (`forkReplayResolutions.ts:1-4`), and a person is
     never re-asked on a replay.
   - **A `branch` fork** (the edited fork) never derives. It raises a live
     interrupt and re-asks. That is the brief's "an EDITED fork re-asks"
     witness.
   - The fork-start derivation (a fork cut while the clarification is open) is
     unchanged, and already correct for this case: one node's resolutions are
     ordered, so the first after the cut is the open round. Matching on
     `__resumeKey` is added as hardening.

   > **Refined during P1 design (2026-10-28): the cut can fall BETWEEN rounds.**
   > Checkpoint rows and interrupt rows belong to a run, and a fork copies
   > EVENTS, not rows. Take a fork cut after round 1 resolved and before round 2
   > was raised. It re-executes the node with no checkpoint of its own. It must
   > neither re-run round 1 live nor re-ask it. So on a `replay` fork, and only
   > for rounds whose `interrupt.requested` (checkpoint) and `interrupt.resolved`
   > (answer) sit INSIDE the copied prefix (sequence < `parentSeq`), the
   > checkpoint read and the durable-key read fall back to the PARENT run's
   > rows, walking `parentRunId`. That is not the inline serving H1 forbids:
   > those events are already in the fork's own log, so serving them keeps the
   > fork's event sequence equal to the source's. Anything at or after the cut
   > goes through the derived-row path above. This case is also why D3.3 seeds
   > the ordinal. The fork reaches the continuation in ONE invocation, while
   > the source reached it in a rewound re-entry.

### D4 — The answer goes back fenced and attributed

The answerer is anyone holding `approvals:respond`, not necessarily the run's
owner. A chosen option is MODEL text, possibly derived from a fenced tool
result. Echoing either back as plain content would launder untrusted text into
trusted prompt structure. So the appended message is host framing ("Answers to
your clarification (round 2 of 5) …") around `fenceUntrustedBlock(answersText,
'a person on this workspace')` (`host/untrustedContent.ts:59`). A skip or expiry
appends instead: "The person did not answer (skipped / timed out). Do not guess
the missing information. Finish with what you have and say what is missing."
Resume values already pass `scrubResumeValue` (`executor.ts:2148`).

**Who may answer (H5).** The question text is written by the model from the
same context the checkpoint protects. When the dispatch consumed borrowed or
untrusted context (`consumedUntrusted`, `agentDispatch.ts:761`) and the run has
an `actingUserId`, the interrupt names that user as the only approver
(`approverRefs`). Otherwise (an unattributed run, no borrowed context), any
workspace responder may answer. **The token lane is refused for a restricted clarification (decided 2026-10-28,
fail closed).** `approverRefs` is not subject binding on
`POST /interrupts/{token}` for single-approver gates (ISWF-23), so an answer
over the token lane could come from anyone holding the link. A clarification
whose interrupt names an approver answers that lane `403` with a pointer to the
in-app card. ISWF-23 itself is not fixed here. The P1 route test pins the
refusal on the token lane and the success on the by-node lane.

The card carries a fixed line: "Never paste passwords, keys or payment
details here." The question is the agent's, attributed by name.

### D5 — The model is told it may ask, from the schema, frozen per run

When the run's stamp enables the feature, the system prompt gains one block
generated by `clarificationPromptBlock()` from the vendored
`clarification.request.schema.json` and the D2 caps. It names the envelope
shape, the caps and the rounds remaining. It is pinned by a parity test in the
`promptCatalogParity` family and listed in `agent-prompt-tool-ids.test.ts`.

The system prompt is part of the semantic digest (`toChatMessages` includes it,
`aiProvidersHost.ts:2619`). A live toggle read would therefore make every fork
of a run recorded before the flip miss its invocation log. So the decision is
frozen at run start through `registerRunStartContributor`
(`host/runStartContext.ts:96`) into `run.metadata.clarification`, and is
inherited by sub-workflow children through `registerInheritedRunMetadataKey`
(`host/inheritedRunMetadata.ts:23`). This follows the `readCompactionDecision`
precedent (`executor/compaction.ts:27`). The four run-creation lanes that bypass
the contributor seam (TOCC-11) carry no stamp, so the feature is OFF for them.
That is stated, and fails safe.

### D6 — Timeout

Clarification interrupts never expire today. Only approvals carry a deadline
(`approvalGateTimeout.ts:53`), and connection prompts expire lazily on read
(`routes/interrupts.ts:166-191`). An agent clarification carries `timeoutMs`
(default 24 h, `OPENWOP_AGENT_CLARIFICATION_TIMEOUT_SEC`), and `mintExpiresAt`
already turns that into `expiresAt` (`suspendManager.ts:36-44`). Expiry
resolves `{skipped: true, reason: 'timeout'}` through:

- the lazy read path. Core gets a small `registerExpiringInterruptProfile(profile,
  onExpire)` seam instead of naming the feature's profile, and the connection
  prompt moves onto it.
- a periodic sweep on `openInterruptsForSweep` with its own cursor name,
  registered by the feature.

A token-link answer after the deadline gets the existing `410 interrupt_expired`,
not a skip. That is stated in the card copy ("This question expired").

### D7 — Chat lane: an `ask-user` tool, the answer is the next turn (amends ADR 0834 D6)

The chat lane asks through a chat-time tool, per the three-lane rule (turn-time
asks are tools; envelopes are in-run): `openwop:chat.ask-user`. Its input
schema IS the D2 vocabulary, imported, not copied. It is pack-allowlisted and
never added to the ADR 0315 default-on baseline.

- **Scope (H7).** The shared scoped tool provider (ADR 0324) would hand the
  tool to voice and, through `runChatToolLoop`, to the run lane. So the tool is
  offered only when `conversationToolLoop` passes `chatAsk: true` into the loop.
  Voice and the run lane never pass it, and a forced call there returns
  `forbidden`.
- **Durable ask store (H6).** Asks live in a `DurableCollection`
  `conversation-clarification-asks`, keyed `(tenantId, conversationId, askId)`,
  holding `{status: open|answered|expired, turnMessageId, lifted, createdAt}`.
  Transitions are CAS on status. The store gets the `onConversationDeleted`
  cascade and a subject eraser (the ADR 0834 D6 approval-ledger precedent). A
  host-ext event `openwop-app.conversation.clarification-requested` is ONLY the
  live UI signal. The precedent append is best-effort (`.catch(() => {})`,
  `conversationExchange.ts:365-367`), and the frontend reads such events live
  only (`conversationTransport.ts:402-411`), so the store is the truth.
- **Ending the turn is a NEW loop mechanism**, not a precedent. `continueTurn`
  extends a turn (`agentDispatch.ts:1289`, `:1452`). `ExecuteAgentTool`'s result
  type (`:326`) gains `endTurn?: { text }`. When a call returns it, later calls
  in the same round are recorded `forbidden` and not executed. The loop sets
  `answered = true` and `lastText` to a plain-text rendering of the questions
  (so `:1494` does not report `TOOL_ROUNDS_EXHAUSTED`) and breaks before the
  next provider call. The tool's RFC 0064 return status stays `ok`. **No new
  tool-return status.**
- **No interrupt record.** ADR 0834 D6's disposition stands. The amendment is
  only that an ask surfaces as a card under the agent turn, rendered by the D8
  component and answered through the conversation's own submit.
- **The answer is the next exchange.** `parseResolveBody`
  (`exchange/validateTurn.ts`) admits `clarificationAnswer: { askId, answers |
  skipped }`. It is host-internal and not wire-validated (the
  `webSearch`/`permissionMode` precedent). The user turn's content is BUILT
  before `validateExchangeContent` (`conversationExchange.ts:264`, which 422s
  empty content). Free text is verbatim, since it is the user's own turn. A
  chosen option is sent by reference and rendered fenced (D4). Ordering, which
  matters because tool-bearing turns always take the async path (`:826`):
  1. `claimExchange`.
  2. CAS the ask `open → answered`.
  3. Ack.
  4. Dispatch.
  5. On async failure, `releaseExchange` (`:841`) and CAS `answered → open`.

  Without the toggle, the field is refused `400`.
- **Hydration.** The feed reads open asks for the conversation from a host-ext
  read (same access predicate as the turns read) on load. A reload keeps the
  card.
- A second ask in one turn, or more than 5 open asks in one conversation,
  returns a tool error to the model.

> **CORRECTED 2026-10-29 (P2 as built).** Four parts of D7 changed on a code
> read; the rest shipped as written (one tool, `endTurn`, no new RFC 0064
> status, no interrupt record, the answer is the next exchange, 400 with the
> toggle off).
>
> 1. **No `DurableCollection` ask store.** D7 chose one because the
>    precedent's host-ext event append was best-effort and the feed read such
>    events live only. Both premises are about the precedent, not the channel:
>    the ask and answer events here are AWAITED in `finishExchange` (after
>    `persistExchangedPair`, before the claim commits), and the feed reads them
>    on hydration from the same `events/poll` slice it rebuilds the turns from
>    (`fetchTurns` → `clarificationStateFromEvents`). The backend folds them in
>    `loadTurns` (`loadClarificationState`). So an ask lives exactly as long as
>    the turn it belongs to: replay-copied, removed with the run, and no second
>    store to cascade or erase. Its erasure posture is the turns' posture
>    (the DSAR chat-post eraser rewrites chat rows, not the run log; same
>    class as `conversation.exchanged`).
> 2. **No status CAS.** At-most-once is the exchange claim, keyed
>    `clarify:<askId>` (`claimExchange`/`commitExchange`/`releaseExchange`), so
>    two concurrent answers race one claim, and an async failure releases it
>    (the ask stays answerable; pinned). An ask is answerable only while it is
>    the conversation's LATEST turn (409 `clarification_stale` otherwise) and
>    has no recorded answer (409 `clarification_answered`). That also makes the
>    "more than 5 open asks" cap moot: at most one ask is ever answerable.
> 3. **No expiry in the chat lane.** There is no suspended run to time out.
>    An unanswered ask is superseded by the next typed turn: the card hides and
>    an answer is 409. **D6's clock timeout (`OPENWOP_AGENT_CLARIFICATION_TIMEOUT_SEC`)
>    applies ONLY to the run lane.**
> 4. **Scope is the sink, not a flag.** The tool acts only through the turn's
>    `onClarificationAsk` sink, which only `conversationToolLoop` binds and only
>    when the tenant's chat toggle (AND the parent) is on. Without it the tool
>    returns `chat_ask_unavailable` (an error to the model, not `forbidden`).
>    It is also filtered out of what is offered: the compiled chat tools when
>    the toggle is off, the run lane's `availableTools` and voice's
>    `resolveAgentToolDecls`.
>
> Two smaller as-built points. `clarificationAnswer` is `{askId, answers}`, with
> Skip as the spec's `answers: []` (not a separate `skipped` flag on the
> request). **The host never reads the client's `turn.content` on an answer**:
> the persisted turn every participant reads and the model text are both built
> by the host from the validated answers. A Skip persists the host's English
> fallback ("I skipped your questions.") and marks the answered event
> `skipped: true`, and each viewer's client shows its own localized line
> (`clarifySkippedTurn`) as plain text. (An earlier draft displayed the
> client's localized line, capped at 200 characters server-side. It was
> replaced before review: that text would have reached every other
> participant's view.)
>
> Model input is run-independent (the ADR 1002 replay digest): no model-facing
> text of the ask or the answer carries the askId, runId or conversationId. The
> tool result is `{ok, asked}`, the ask turn is the questions, and the answer is
> question ids, question text and the values.

### D8 — One card, two lanes

No new card system. A pure `clarificationModel.ts` (parse `data` → questions,
controls, bounds; build the resume value) and one `ClarificationQuestions`
field group. `ClarificationDialog` (run page and inbox),
`FreeTextClarificationCard` (chat feed, run lane) and the D7 chat card all
delegate to it when `data.questions` is an array. The single-`question` shape
(`core.clarificationGate`, `a2ui-clarify`) renders exactly as today.
`HitlDecisionCard` labels `{answers}` and `{skipped}`.

Rendering is text only: React text nodes, no `dangerouslySetInnerHTML`, no
markdown, no autolinking. The header reads "<Agent> needs an answer", with the
D4 safety line. The card works in 4 locales and in light and dark. Radio groups
are `fieldset`/`legend`, focus moves to the first field on appear, and the
APUX-10 double-submit guard applies.

### D9 — Toggles, toggle-off honesty, the advert

There is one package with two toggles, both default OFF (decided 2026-10-28):
`toggleDefault` `agent-clarification` (P1, run lane), and
`extraToggleDefaults` `agent-clarification-chat` (P2). The catalog has a
convention for exactly this shape: a nested capability is a SUB-toggle of its
package (`features/types.ts:64-70`, ADR 0404 §P4), registered at boot like the
primary and AND-ed with it. So P2 needs no separate package. The consequence is
stated: turning on the chat ask requires turning on the run lane too, and every
chat-lane gate resolves both ids.

**Toggle off is not the old drop (M8).** With the toggle off, a final reply
that is ONLY a `clarification.request` envelope becomes a typed node failure,
`clarification_not_enabled`, never a successful output whose text is an
envelope. This is the RFC 0021 "refuse with `not-applicable`" arm. The
`limits.clarificationRounds: 5` advert stays in both states. With the toggle
off, no round is ever taken, and the refusal is honest. With it on, D1 enforces
the cap. A test reads the cap FROM the discovery document and pins round 5
accepted and round 6 `cap.breached` plus node failure.

## Implementation record — P1 (2026-10-28; rebased onto #5362 2026-10-29)

Corrections the code made to the decisions above, in the inline-correction style:

> **D1.3 corrected — the status union was NOT widened.** Adding `awaiting_input`
> to `AgentDispatchResult.status` broke `a2aServer.ts:236` at compile time, which
> is exactly the review's M9 leak: every serialising caller would have to learn
> the value. A paused turn returns `status: 'escalated'` (nothing final was
> produced) plus a `clarification` field. Only `host/agentClarificationTurn.ts`
> sets the request option, pinned by `adr1001-clarification-lane-ratchet.test.ts`.

> **D1 addition — a no-tool agent takes the loop when the run opted in.** The
> envelope is honoured in `runChatToolLoop`. An agent with no tools used the
> single-completion path, where the ask would be dropped. With the stamp on, it
> runs the loop with an empty tool list. Behind the toggle only.

> **D4 widened — tool output counts as untrusted context.** `consumedUntrusted`
> covers only the FIRST message (recall, handoff, context blocks). A question
> written after the agent read a tool result can echo that result too, so the
> loop marks a turn untrusted when any tool ran. The restriction is sticky
> across rounds: the context is still in the transcript the agent continues
> from.

> **D3.5 corrected — the fork-start derivation bug was real, not hardening.**
> The review (and this ADR) called matching on `__resumeKey` "harmless
> hardening". MEASURED with a replay fork cut right after round 1 resolved:
> `firstResolvedAfter` returned ROUND 2's resolution. The fork applied it to
> round 1's re-creation, never requested round 2, and emitted
> `replay.diverged`. `durableRoundAtCut` (`forkReplayResolutions.ts`) now takes
> the resolution of the round the prefix last REQUESTED, matched by key, and
> treats an in-prefix resolution as already recorded. Durable suspends only;
> every other gate keeps the old rule.

> **D6 as built.** `host/interruptExpiry.ts` is the one registry of profiles
> that expire into a resume value. The connection prompt is registered
> lazy-only, so its behaviour is unchanged. The agent clarification is lazy plus
> swept on the webhook worker tick. The resume goes through the one choke point
> (`resolveAndResume`, preclaimed), late-bound by the interrupts routes.

> **Wire codes.** Host failure codes reach the wire namespaced
> (`openwop-app.cap_breached`, `openwop-app.clarification_not_enabled`,
> `openwop-app.replay_diverged_at_clarification`). `cap.breached` carries
> `{kind:'clarification', limit, observed}` with `observed` = the ATTEMPTED
> round.

> **The stamp key** is `openwop-app.agentClarification` and is on
> `RESERVED_RUN_METADATA_KEYS` (`host/runDispatch.ts`). A caller who could
> supply it would turn the feature on for their own run.

> **Witnessed after the rebase onto #5362 (ADR 1002): zero live model calls on
> a BYOK replay fork** (`adr1001-byok-replay-zero-live-calls.test.ts`, through
> the real executor, the real `:fork` route and the real invocation log, with
> the Anthropic tools dispatcher mocked and `fetch` throwing). A replay from the
> start and a replay cut between the rounds both make 0 calls. Sabotage:
> removing `viaReplayLane`'s source read reds both cases. Dropping the
> `seedNodeActivity` call reds ONLY the between-rounds case, which confirms
> B1's analysis: the ordinal seed matters exactly when the fork reaches the
> continuation in one invocation.

| Piece | Where | Tests |
|---|---|---|
| Closed lift, resume schema, fenced answer, generated prompt | `host/clarificationLift.ts` | `clarification-lift.test.ts` |
| Loop: extract, accept (cap), lift, one repair, typed failures; O3 fix | `host/agentDispatch.ts` | `adr1001-p1-clarification-run`, `adr1001-schema-rounds-advert` |
| Node: checkpoint → suspend → continue; toggle-off refusal; `cap.breached` | `host/agentClarificationTurn.ts`, `host/agentRunnerNode.ts` | `adr1001-p1-clarification-run` |
| Checkpoint store on the run cascade | `host/clarificationCheckpoint.ts`, `storage/runKvKeys.ts`, both adapters | `adr1001-clarification-checkpoint`, `adr1001-checkpoint-run-cascade` |
| Durable keys, visit-partitioned ordinals | `executor/suspendSignal.ts`, `executor.ts`, `host/effectIdentity.ts`, `executor/sideEffects.ts` | `adr1001-durable-suspend-keys`, `adr1001-ordinal-seed`, `adr1001-visit-ordinal-wiring` |
| Replay/fork | `executor/executor.ts`, `executor/forkReplayResolutions.ts` | `adr1001-p1-clarification-fork` |
| Expiry, token-lane refusal | `host/interruptExpiry.ts`, `routes/interrupts.ts`, `features/agent-clarification/` | `adr1001-p1-clarification-run` |
| Card | `interrupts/clarificationModel.ts`, `ClarificationQuestions.tsx`, `ClarificationDialog.tsx`, `chat/registry/defaultCards.tsx` | `ClarificationDialog.agentAsk.test.tsx` |

## Final-head review — /architect (both tracks) and /code-review, 2026-10-29

Both were invoked on the rebased head (onto #5362). Neither found a Blocker.
Each finding is fixed and pinned, or answered:

| # | Finding | Disposition |
|---|---|---|
| A-H1 | A firewall-HELD tool was dropped when the same turn then asked (ADR 0150 "never a silent completed") | **Fixed**: the loop's clarification return carries `pendingApprovals`; `runToolLoop` escalates them first. `adr1001-review-fixes` case 1 |
| A-H2 | RFC 0021 §Run event log integration: caused events MUST carry `causationId = correlationId` | **Fixed**: `__causationId` on the suspend data, stamped on `node.suspended` / `interrupt.requested`, passed to `cap.breached`, stripped from the wire. `adr1001-p1-clarification-run` case 1, `review-fixes` case 3. D1.5's "one projector" is **corrected**: production events come from the executor's projection, `envelopeProjection.ts` stays the test seam's, and both lift through `liftClarification` |
| A-H3 | With the toggle on, a no-tool agent's turn sent `tools: []` (+ `tool_choice`), which OpenAI-compatible APIs refuse | **Fixed**: the OpenAI-compatible and Anthropic tools rounds omit an empty tool list (Gemini already did). `review-fixes` case 2. A no-tool handoff agent still loses the structured-output path while the toggle is on: answered, the XCH-DISP-1 lenient parse recovers its return and §D still judges it |
| A-H4 | A continuation's turn summary was saved as trusted memory although a person's answer shaped it | **Fixed**: `persistTurnSummary(..., consumedUntrusted \|\| !!req.resumeFrom)` |
| C-H1 | An ask from untrusted context was open to the token lane when the run had no acting person | **Fixed**: interrupt data `untrustedContext: true`; `isRestrictedAgentClarification` keys on it. `clarification-lift` restriction case |
| A-M1 | A stale card could land on the next round (Skip has no round; ids can repeat) | **Answered**: the `const` ids bind any answer whose ids differ; a Skip and same-id answers from a stale tab can land. The cards render only the current open interrupt, so this needs two tabs. A by-node `interruptId` precondition is the fix and needs the shared resolve route; left as residue R3 |
| A-M2 | The expiry value broke the interrupt's own `resumeSchema`, and `{skipped}` is not a spec `ClarificationResume` | **Fixed by design change**: a Skip and the expiry both resolve `{answers: []}`, the spec's own shape, which the generated schema admits. The agent is told "skipped, or it expired". `clarification-lift` cases |
| A-M3 / C-M6 | Fork derivation scans the parent log | **Answered**: replay forks only (`deriveRecordedResolutions` and the post-cut branch return early otherwise); bounded by the source run's size; a row lookup gates `parentResolutionForKey`'s scan. An index on (run, node, interruptId) is the follow-up, residue R4 |
| A-M4 | The recall receipt is written once, at the end: a replay can serve round 1 a later recall | **Answered**: when memory changed during the wait the replay misses its record and FAILS CLOSED (`replay_source_missing`), never a wrong answer. Per-round receipts are residue R5 |
| A-M5 | A `schemaRounds` breach neither emits `cap.breached` nor fails the node | **Answered**: pre-existing; this PR makes the advertised 3 rounds real and stops the 4th from being answered. Emitting and failing changes the shared chat loop's behaviour; residue R6 (a loop row) |
| A-M6 / C-M1 | After the too-large notice an envelope-only reply was a successful output | **Fixed**: refused as `clarification_not_enabled` |
| A-M7 | A replay fork's open clarification could be answered by a person or the expiry sweep | **Fixed**: a replay that reaches a question the source has not answered fails `replay_source_unanswered`. `adr1001-p1-clarification-fork` case 5 |
| C-M2 | The envelope's `contentTrust` ignored tool output | **Fixed**: `c.untrusted \|\| toolOutputSeen`; earlier rounds' context rides `clarification.untrustedContext` |
| C-M3 | The checkpoint stored tool output unscrubbed | **Fixed**: `stripSecretsFromPersisted` on the tail, once, and the same tail is continued from |
| C-M4 | The card rendered for ANY `questions[]` clarification | **Fixed**: requires `profile: 'openwop-agent-clarification'`. Card test |
| A-L / C-M5 | Checkpoint and durable keys are not visit-scoped | **Answered**: unreachable until loopback (`scheduler.ts` refuses cycles). Recorded as a loopback prerequisite beside the live ordinal fold (D3.3) |
| C-M7 | ADR still `Proposed` | **Answered**: kept `Proposed` until P1 lands, by the lead's instruction |
| A-L | `contextType` dropped on the wire | **Fixed**: the clarification projector carries it. `review-fixes` case 3 |
| A-L | Model-chosen `correlationId` (dedup) | **Fixed**: minted `${runId}:${nodeId}:clarify:${round}` |
| A-L | Inbox row had no question text | **Fixed**: first question. `review-fixes` case 4 |
| A-L | `isEnvelopeOnlyClarification` too loose | **Fixed**: exactly one fence, the ask. `review-fixes` case 5 |
| A-L | A person's answer after `expiresAt` was accepted on session lanes | **Fixed**: 410 on every lane; only the preclaimed expiry resolves it. Run test case 4 |
| A-L | Refusal code is not the spec's `not-applicable` | **Answered**: host failure codes are namespaced on the wire (`openwop-app.clarification_not_enabled`); the meaning matches |
| A-L | No production `clarification.requested` event (observability SHOULD) | **Answered**: `interrupt.requested{kind:'clarification'}` is the normative event; residue R7 |
| A-L | A replay miss now returns before `replayRecall.finish()` | **Answered**: the node fails on a miss either way; the receipt bookkeeping on a failed replay is moot |
| C-M8 | Doc claims (wire `contextType`, a prompt-parity test name, an `agent-prompt-tool-ids` entry) | **Fixed / corrected**: `contextType` now true; the comment cites `clarification-lift.test.ts`; the block names no tool id, so `agent-prompt-tool-ids` does not apply, and its parity pin is `clarification-lift` |
| C-L1/L2 | Whitespace answer read as a skip; UTF-16 vs code-point lengths | **Fixed**: `pattern: '\\S'` in the text schema; code-point lengths in host and card |
| C-L3 | Expiry shown as "Skipped" | **Fixed with A-M2**: the label is "Not answered" (4 locales) |
| C-L4 | `agent-hitl` is now durable: a retried node reuses its approval | **Answered**: recorded here. The approval is the run's own, for the same node; a retry re-asking for the decision already made was the bug's other face |
| C-L5 | A restricted ask still mints a token link | **Answered**: the token is projected only to `approvals:respond` holders (ADR 0755 D3) and 403s on use; delivery is unchanged |
| C-L6 | Unguarded `!` in tests | **Fixed** |

> **Corrections to the decisions above, from the same pass.** D3.5 said the
> checkpoint read "falls back to the PARENT run's rows": it does not. A fork
> re-runs round 1 from the log, with the model call served, and is served the
> recorded answer inline. Only the durable-key read uses the parent. The
> Alternatives line "checkpoint in host-ext KV — rejected" is superseded by the
> D0 correction: run-keyed host-ext KV on the run cascade is what shipped.

## Residue (added by the final-head review)

- **R3.** Stale-card binding for a Skip or same-id answers (needs a by-node `interruptId` precondition).
- **R4.** An index for the fork derivation's parent reads.
- **R5.** Per-round recall receipts.
- **R6.** A `schemaRounds` breach should emit `cap.breached` and, on the run lane, fail the node.
- **R7.** Optional `clarification.requested` observability event.
- **R8 (loopback prerequisite, open; raised by the ADR 1002 agent).** Live runs
  build NO `ExecutionOrdinals` (`executor.ts`, replay forks only), so a live run
  always passes visit 0 while a replay fork passes the folded visit. Today they
  agree because nothing re-enters a completed node. When ADR 0772 RRWF-10
  loopback lands, the live executor MUST fold ordinals too, or a source records
  every visit at base 0 while its fork keys visit k at k·2^20, and since ADR 1002
  every revisit's replay is REFUSED (`replay_source_missing`) instead of served.
  The same change must visit-scope the clarification checkpoint key and the
  durable suspend keys (`clarify:<round>:<digest>`, `agent-hitl:<roster>`), or a
  revisit resumes the previous visit's transcript and is served its answers.
  No test can witness this before loopback exists; the loopback PR owns the
  witness (a revisited node's replay is served, on BYOK and managed).

## Implementation record — P2 (2026-10-29)

Built on `origin/main` 8da0849a5 (after #5377, XCH-ENV-9).

| Piece | Where |
|---|---|
| Tool | `features/agent-clarification/askUserTool.ts` (schema `askUserInputSchema`, lift `liftClarification`) |
| Turn sink, events, answer rendering | `host/clarificationChat.ts` |
| End the turn | `host/agentDispatch.ts` (`endTurn`; later calls in the round `forbidden`) |
| Offer only on chat with the toggle on | `host/conversationToolLoop.ts`; filtered in `host/agentRunnerNode.ts` and `features/voice/realtime/toolBridge.ts` |
| Answer exchange | `host/exchange/chatAnswer.ts`, `host/conversationExchange.ts` (claim `clarify:<askId>`), `host/exchange/loadTurns.ts` (`loadClarificationState`), `host/exchange/dispatchTurn.ts` (model text per turn) |
| Card, hydration, send | `chat/MessageFeed.tsx`, `chat/hooks/useClarificationAnswer.ts`, `chat/conversationTransport.ts`, `chat/hooks/chatSession/useTurnTransport.ts` |

Witnesses: `test/adr1001-p2-chat-ask.test.ts` (16 route-level cases) and
`frontend/react/src/chat/__tests__/chatClarificationCard.test.tsx` (7). Both
are red on `origin/main` (the modules they import do not exist there).
Sabotage-witnessed, each red then restored:

| Sabotage | Red case |
|---|---|
| `endTurn` ignored in the loop | the call ends the turn |
| the answer fence dropped | the fenced answer; injection inside an option |
| the latest-turn (stale) check dropped | the superseded ask |
| the answered check dropped | the second answer (its `clarification_answered` reason) |
| the claim key dropped | two answers at once |
| the chat-toggle filter dropped | toggle off; the parent AND |
| the voice filter dropped | voice never offers it |
| the `skipped` flag dropped | the Skip |
| the client's text used as the display | the fenced answer; the Skip |
| the askId appended to the model text | run-independence |
| card: last-turn guard / answered guard / answers unwrap | the matching card case |
| summary: boolean arm / no-match arm; feed: localized Skip | the matching case |

## Post-merge record — P2 (2026-10-29)

- PR #5379, head `d4a0beaad`, merged in train 157 as `f382e70d1`; live on
  `openwop-app-backend-01084-bm8` (100%, Ready 16:14:21Z), both toggles OFF.
- Read-only post-deploy check (GETs only), 2026-10-29:
  - `/build-info.json` commit `f382e70d1`; the entry chunk
    `index-CnCGfLyN.js` matches the gated build.
  - The P2 chat code is served: `c-Bm5BXFsd.js` (carries both
    `openwop-app.conversation.clarification-*` events and
    `clarificationAnswer`), `200 text/javascript`.
  - `clarifySkippedTurn` is served in all four locales, each
    `200 text/javascript`: `i18n-p9NnQneb.js` (en), `i18n-es-DyY8S8RD.js`,
    `i18n-fr-BM90XFq0.js`, `i18n-pt-BR-CtFZFzmI.js`.
  - Readiness, the limits advert, revision logs (0 ERROR, 0 provider 4xx, 0
    `chat.ask-user` hits) and the stored toggle rows were checked by the team
    lead.

## Final-head review — P2 (/architect both tracks, /code-review), 2026-10-29

| Finding | Severity | Disposition |
|---|---|---|
| An answer's `to` was the client's when it sent one, so a raw caller could route a person's answer (and its "my answers to your questions" text) to an agent that never asked | MEDIUM | **Fixed**: the answer always goes to the asker (`conversationExchange.ts`); pinned and witnessed red with the old `!to &&` guard |
| The ask/answer event fold trusted the payload shape | LOW | **Fixed**: `loadTurns` skips an ask without `questions`/`resumeSchema` and an answer without `modelText` |
| `chatAnswer.ts` casts the validated answers to `ChatAnswers` | LOW | **Answered**: the cast follows `assertResumeMatchesSchema` on the ask's generated schema, which admits exactly that shape |
| A conversation BRANCH copy (ADR 0117) may not carry the ask events | LOW | **Answered, not measured**: a run `:fork` copies the run log, events included; a branch that seeds turns only would show the questions as text with no card (fail-safe: an answer is 404) |
| The ADR 0975 Challenge Author grant reads the client's `turn.to`; the card sends none | LOW | **Answered**: that lane refuses an answer without `to` (403, fail-closed); both toggles are OFF there. Revisit before enabling on a stamped lane |
| Wire | — | **Pass**: no new RFC 0064 status (`forbidden` already exists); the two events are host-ext `openwop-app.conversation.*`; `clarificationAnswer` is a host-internal resolve field (the `webSearch`/`permissionMode` precedent); no capability advert changes. No RFC needed |
| Replay | — | **Pass**: model input is run-independent (pinned); the events ride the run log that `:fork` copies; `loadTurns`' cache is keyed by run, so a fork folds fresh |
| Boundaries | — | **Pass**: one card (`AgentClarificationCard` via `CardHost`), one tool seam (`registerFeatureAgentTool`), one claim (`claimExchange`), one store (the run log); core never imports the feature (the enable resolver is late-bound) |

## Residue (added by P2)

- **R9.** No shipped agent pack allowlists `openwop:chat.ask-user` (a BY_DESIGN
  exception in `agent-tool-reach-ratchet`; an operator grants it per agent).
  A pack opt-in, with its version bump, is a follow-up.
- **R10.** A boolean answer displays "yes"/"no" in English on both sides (the
  host's persisted display and the optimistic bubble).
- **R11.** The card renders through the default card set, which `ChatTab`
  registers. An embedded conversation mounted where `ChatTab` never loaded
  shows the ask as the agent's text only (the questions are still readable;
  the run lane's cards have the same dependency). MEASURED 2026-10-29: no
  `EmbeddedChatPanel` consumer registers the card set (`PairPanel`,
  `AgentAuthorPanel`, `CadAssistPanel`, `ChatPocket`, the KickTodo Guide and
  Studio pages). They get it only as a side effect of `App.tsx`'s idle
  `prefetchChatTab()` (`requestIdleCallback`, 3 s timeout), which evaluates
  `ChatTab.tsx` and so its module-level `registerDefaultCards()`
  (`ReviewCard.tsx` does the same where it is imported). So the residue is
  LIVE today for P1's cards too, in a narrow window: a card that renders
  before the prefetch has run, or after a failed prefetch, has no renderer.
  The fix is NOT just another `registerDefaultCards()` call: `registerCard`
  overwrites with a warning (`CardRegistry.ts:11`), so a second call would
  clobber an adopter's override registered in between. It needs a
  register-once guard in `defaultCards.tsx`, then a call from
  `EmbeddedConversation.tsx`.

- **R12 (found by the P2 UX review, pre-existing).** The exchange claim's
  in-progress refusal (`conversationExchange.ts`, `claim.outcome ===
  'in_progress'`) is `interrupt_already_resolved`, and the chat client's
  `DEAD_RUN_CODES` (`useTurnTransport.ts`) reads that code as a dead
  conversation run and drops its binding, so a retried or double-sent turn
  with an `exchangeKey` can orphan a live conversation. P2 sends `conflict` for
  its own answers (pinned); every other key keeps the old code. Its own row.

  **DONE (R12 PR, branch `fix/r12-exchange-claim-conflict-code`).** MEASURED
  red on `origin/main` @ `f382e70d1`: two POSTs with the same `exchangeKey`, the
  first still in flight, answered `409 interrupt_already_resolved`. The claim's
  in-progress refusal is now `conflict` for every key (`openwop-app.conflict` on
  the wire). It was the only CHANGE site. Every other server emit of
  `interrupt_already_resolved` is a gate that really resolved or timed out, or a
  terminal owning run (`authorizeResolve.ts`, `routes/interrupts.ts`,
  `routes/reviews.ts`), so the client's dead-run teardown stays correct there and
  is unchanged. `exchangeKey` is a host sidecar, not a wire field, so no RFC was
  needed. Pins, each sabotage-witnessed red:
  `backend/typescript/test/adr1001-r12-exchange-claim-conflict.test.ts` (the
  in-flight duplicate is `openwop-app.conflict` and appends nothing, and the run
  then exchanges under a new key. A closed conversation still answers
  `interrupt_already_resolved`.) Plus the R12 case in
  `frontend/react/src/chat/hooks/__tests__/useChatSession.integration.test.tsx`:
  a 409 `openwop-app.conflict` on send keeps `conversationRunId` and the next
  send reuses the run, while a 409 `interrupt_already_resolved` drops it.

  Defense in depth (lead decision 2026-10-29): with no wire code,
  `useTurnTransport`'s message-regex fallback never tears down on a 409. A 409
  is a refusal against a live run. The fallback is kept for other statuses,
  because an older server may send a codeless error for a run that really is
  dead. Pinned in the same frontend file: a codeless 409 whose message says
  "resolved" keeps the binding, and a codeless 410 still drops it. Both halves
  are sabotage-witnessed.

  **Residue R12a (not in this PR):** a refused duplicate shows the generic
  error bubble, because `errorClassify` has no `conflict` case. The candidate
  fix is a `conflict` case there with a "still sending" card. How often a user
  would see it, read from the code: the SPA mints a fresh
  `crypto.randomUUID()` key on every `send()` (`useTurnTransport.ts`). The SDK
  and `sdkFetch` do not retry a POST. The one retry (`withSessionBootstrap`) is
  a 401 that the auth layer refuses before any claim is taken. So the SPA never
  reuses a client key itself. The reachable case is the server-derived
  `clarify:<askId>` key: two submits of one question card mint two client keys
  but contend for one claim. The card disables its buttons on `isLoading`
  (`defaultCards.tsx`), and its answer is hidden only after the POST returns
  (`clarifyAnsweredRef`). Whether `isLoading` covers the whole POST was NOT
  traced. So a fast double-submit is the remaining SPA path, and it is
  unmeasured. A second tab or a non-SPA client reusing a key is the other way
  to get the bubble.

R11 and R12 are their own rows, outside P2 (lead decision 2026-10-29): each
changes a shared seam that P1 already depends on (the card registry; every
`exchangeKey` path) and gets its own PR and review.

## Enablement checklist (before either toggle is ON anywhere)

Both `agent-clarification` and `agent-clarification-chat` ship OFF. The enable
decision is held to these (lead decision 2026-10-29):

- [ ] A live render of BOTH lanes' cards with the browser skill, in light and
      dark: the run lane (run page, inbox, a chat-started run's feed) and the
      chat lane (the card under the agent turn, an answer, a Skip shown in a
      non-English locale).
- [ ] R11 closed, or its window confirmed acceptable for the surfaces being
      enabled (an embedded chat renders the card set without the prefetch).
- [ ] For the chat lane, at least one agent granted `openwop:ask-user`
      (R9: no shipped pack allowlists it).

## Alternatives weighed

- **Re-run the node from the top on resume, answers appended.** Re-executes
  side-effecting tools and re-calls the model (live on the managed tier).
  Rejected — D3.
- **Serve every resolved key for every ctx.suspend node.** Fixes the
  sequential-suspend bug everywhere, but turns any node that deliberately
  re-asks on one key into an infinite loop. Rejected in favour of opt-in
  `durable: true`.
- **Put the checkpoint in interrupt `data`.** The open-interrupts read returns
  `data` to every responder; the checkpoint carries recall and twin corpus
  scoped to the acting human. Rejected.
- **Envelope in the chat lane too.** Chat-time asks are tools by rule; an
  envelope would need a suspend the chat lane does not have. Rejected.
- **Mint an interrupt for a chat ask.** ADR 0834 D6 disposition. Rejected.
- **Compile the model's answer schema.** ReDoS/unbounded compile. Rejected — D2.
- **Serve a fork the parent's answer inline from `makeSuspendFn`.** The fork's
  log would carry no suspend/resolve events, which reads as a false divergence or
  as a decision with no record. Its ordinals would also drift past the source's.
  Rejected in favour of derived rows (D3.5).
- **Checkpoint the whole transcript.** That freezes borrowed twin recall past
  revocation (ADR 0589). Rejected: `messages[0]` is rebuilt live (D3.4).
- **Checkpoint in host-ext KV.** `deleteRun` has no host-ext hook, so every run
  delete would orphan it. Rejected: a Storage table on the run cascade (D0).

## Phases

| Phase | Scope | Toggle |
|---|---|---|
| P1 | D0–D6, D8 (run-page / inbox / chat-feed run cards), D9 run toggle. Route tests: createApp → run → `interrupt.requested` with lifted questions → resolve → node completes with the answer fenced in the continuation. Plus: two rounds; cap breach (round 6); timeout → skip; injection in choices (fenced on return, text-only on the card); stale round-1 POST refused; a BYOK replay fork making zero live calls; a branch fork re-asking; a replay digest miss failing; revoke-mid-wait; toggle-off refusal. | `agent-clarification` OFF |
| P2 | D7, D8 (chat card + hydration), D9 chat toggle. Route tests: conversation → `chat.ask-user` → ask row + turn text → answer exchange → next turn sees the fenced choice. Plus: double answer (CAS 409); answer after expiry; voice/run lane `forbidden`; async-failure release; toggle-off 400. *(As built: "CAS 409" is the claim plus the answered check; "after expiry" is "after the conversation moved on" — see the D7 correction.)* | `agent-clarification-chat` OFF |

Every new test is sabotage-witnessed (red on `origin/main`, red again with the
guarding line reverted).

P1 code in `agentDispatch.ts` waits for #5358 (TOC2CD-11) and #5359 to merge.

## Open questions

Decided by the team lead, 2026-10-28:

- [x] O1. One package, two toggles. P2 is the `extraToggleDefaults` sub-toggle
      (D9: the catalog's own convention).
- [x] O2. Chat free-text answers stay unfenced, because they are the user's
      own turn. Chosen options are model-authored and fenced (D4, D7).
- [x] O3. FOLDED INTO P1. The `schema.request` loop increments
      `schemaRoundsUsed` before `acceptEnvelope`, and the acceptor breaches at
      `current >= cap` (`envelopeAcceptor.ts:486-487`). So the third advertised
      `schemaRounds` round is refused: the effective cap is 2 and the
      advertised cap is 3. This is a live advert-honesty bug. P1 passes the
      pre-increment count, plus a test that reads the cap FROM the discovery
      document (round 3 accepted, round 4 breached). It is also called out in
      the P1 PR's security section.
      > **As built:** the breached fourth ask ends the turn, with that reply as
      > the final answer (the prior visible behaviour). Refusing it and
      > continuing let a model that keeps asking spend every remaining round;
      > `envelope-live-roundtrip.test.ts` ("cannot spin forever") caught that.
- [x] O5. The token lane is refused for a restricted clarification (D4,
      ISWF-23). ISWF-23 is not fixed here.

## Residue (known, not fixed by this ADR)

- **R1 (was O4): tracked separately, fix in flight.** The managed tier
  bypasses the invocation log in a workflow run (`aiProvidersHost.ts:644-651`,
  and the tools path at `:913`), so a replay fork of a managed-tier agent node
  is not deterministic. The release manager (openwop-app-14) made this its own
  row, and the `managed-tier-replay` agent owns the fix. This ADR does not touch
  `aiProvidersHost.ts`. Until that fix lands, D3's zero-live-calls guarantee
  holds for BYOK only. If it lands before P1, the guarantee widens to the
  managed tier, and the P1 witness widens with it.
- **R2.** ISWF-23 (D4).

## Review findings (/architect, 2026-10-28) and where each landed

| Id | Sev | Finding | Landed in |
|---|---|---|---|
| B1 | Blocker | Ordinal rewind on re-entry: a replay fork's continuation misses the source's invocation log and calls the provider live | D3.3 `ordinalCursor` + `seedNodeActivity` |
| B2 | Blocker | Checkpointing `messages[0]` freezes borrowed twin recall past revocation | D3.4 rebuild `messages[0]` live |
| B3 | Blocker | "re-dispatch on the returned answer": `ctx.suspend` throws; the re-entry algorithm was missing | D1.4 written out |
| H1 | High | Inline parent serving on a fork breaks the event-sequence comparison | D3.5 derived rows |
| H2 | High | A digest miss on a replay fork re-asks a person (re-decides) | D3.5 replay fails, branch re-asks |
| H3 | High | Core would import the feature package | D0 |
| H4 | High | "deleted with the run": no host-ext hook on `deleteRun` | D0 Storage table |
| H5 | High | Question text leaks the same context to every responder | D4 approver restriction + safety copy |
| H6 | High | "CAS on the sidecar": the sidecar is a best-effort append | D7 durable ask store |
| H7 | High | Card lost on reload; tool reaches voice and the run lane | D7 hydration + `chatAsk` scope |
| M1–M10 | Medium | `endTurn` is new; empty-content 422; fence helper name; key length; user-submitted timeout + stale card; second projector; expiry layering; toggle-off success; dispatch route leak; wrong freeze seam / `observed` count | D7, D7, D4, D1, D2, D1.5, D6, D9, D1.3, D5/D1.2 |
