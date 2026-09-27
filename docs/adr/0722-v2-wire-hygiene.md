# ADR 0722 — v2 wire hygiene: one projection for every egress channel, and the gate that sees inside a type

Status: Accepted (implemented; see § Implementation record)

## Context

The v2 evaluation of 2026-09-17 found the wire conformant (major-2 lane EXIT=0,
known-red ledger empty) and the *data* not: 31 event types with persisted
payloads failing their corpus `$def`, one enum regression live in production,
and a payload-audit ratchet that had stayed green across the bump that caused it.
This ADR is Phase A of the closure plan — the host-only, unblocked half.

The architect pass before implementation reshaped it. Two findings were bigger
than any planned task:

**1. Two major-2 egress channels, one unprojected.** The poll and SSE reads go
through `storage.listEvents`, which under `contract === 2` applied
`projectEnvelopeIds` and `projectV2OwnerEcho` inline. The webhook fan-out
(`routes/webhooks.ts`) projected only the event *type* via `wireEventType` and
forwarded the raw in-process payload. A major-2 webhook subscriber therefore
received the **v1 owner block** (`principal`, `principalKind`), no
`nodeId`/`runId` where the def requires them, and every write-seam violation.
MEASURED: 156 `/owner must NOT have additional properties` on `run.started` —
the single largest bucket in the audit — and seven webhook scenarios in suite
2.2.1, none validating payload shape. A green lane proved nothing here.

**2. The audit measured the wrong seam for the wrong question.** It recorded at
the write seat (`eventEraAdapter.appendEvent`), so it saw the persisted v1 owner
block and reported it as a violation — which it is not for poll/SSE (the read
projects it away, by design, ADR 0625) and *is* for webhooks. Neither seam alone
is "the wire truth": the corpus validates what a v2 **reader receives**, and
there were two readers with different answers.

## Decision

**One composed projection, `storage/v2PayloadProjection.ts`, called from every
major-2 egress channel and nothing else.** Order stated: envelope ids → key
aliases → owner echo (the echo rebuilds `owner` and must see the final object).
`listEvents` and the webhook fan-out both call it; the inline composition is
gone. RFC 0184 §A.5's apply-once rule applies by analogy: a payload already read
at contract 2 is never projected again.

**The audit records both seams and gates on the wire one.** The recorder now
emits `{payload, wire}` per sample from the same write, where `wire` is the
composed projection. `payload` is informational (a v1 block at rest is correct);
`wire` is what the ratchet judges.

**An error-SHAPE ledger beside the type ratchet.** The type-level ratchet stayed
31/31 green across the 2.2.0 bump that regressed `approval.granted` and
`approval.overridden` (both `$ref: interruptResolved`; the enum tightening landed
inside two already-admitted types). Types are the right coarse gate — stable
against sample jitter — and structurally blind to a new *kind* of violation
inside an admitted type. `scripts/event-payload-shapes-baseline.json` holds
per-shape counts over wire violations, shrink-only per shape; `--write-shapes`
regenerates it after a fix, never after a bump.

> **CORRECTED 2026-09-17 (cleanup loop it.1, the day after this shipped) — the
> ledger gated on per-shape COUNTS, and § Alternatives weighed below rejects
> exactly that ("counts move with test ordering").** MEASURED: the baseline was
> written at 188 `/F must match pattern "X"`; #3948 and #3950 then merged from
> branches that pre-date the gate and added three pattern violations (their
> three new test files, run alone with the recorder, produce exactly
> `/interruptId`, `/runId`, `/subscriptionId`), so every later full run measured
> 191 and every PR went red on a diff touching no emitter. The mechanism is
> structural, not a one-off: the recorder keeps ONE sample per (type, key-set)
> PER WORKER PROCESS, so one full run produced 1,336 samples over 93 distinct
> key-sets (one key-set 177 times across 211 forks) — the count is a function of
> vitest's worker distribution. The ledger is now the SET of
> `<type> :: <error-shape>` pairs, gated on presence (a NEW pair fails — the
> 2.2.0 enum tightening this section was written for is a new pair); counts are
> printed but informational, and an admitted pair a run does not reproduce is
> reported, never failed, because which VALUE the recorder kept is
> order-dependent. `scripts/audit-event-payloads.mjs` refuses the old
> count-keyed file so a stale ledger cannot read as green.

**Key aliases are migration debt, in one file.** `artifact.created`'s
`artifactTypeId`/`versionId` are emitted by node packs (`feature.slides.nodes`,
`feature.production.nodes`) whose keys cannot change without a version bump and
a registry publish (token not held). A read-seam rename is the only host-side
fix — and `myndhyve-1`'s `variableChanged` case is the warning: a def and a host
naming one fact differently with the mapping written nowhere cost them data at
rest. So the mapping is `storage/payloadKeyAliases.json`, consumed by the
projection *and* asserted by a test that every target is a declared def
property and every source is not. When the packs republish, the row is deleted;
the test makes a stale row red rather than permanent.

**Deleting `interrupt.resolved.outcome` is safe; `reason` stays.** `outcome` was
single-valued (`'rejected'`), redundant with RFC 0183's `decision`, and read by
nothing. `replayDivergence.key` hashes `type@nodeId` only, forks copy the prefix
verbatim, era-2 major-1 reads are untouched. `reason: 'timeout'` is a *cause*
(gate expired vs quorum rejected) with no seat yet — kept, not dropped (RFC 0185
§C: carry it or fail); the hatch carries it when it ships.

**The demo subscription id needed a migration, not a rename.**
`registerSubscription` is idempotent *by id*; a bare mint change would have
registered a second demo subscription per tenant on the next seed while the old
one kept delivering. Migration 21 re-keys existing rows to the grammar-safe id
(a hash of the tenant — tenant ids may carry `:`, and `anon:<sid>` does).

## Alternatives weighed

| option | why not |
| --- | --- |
| project the webhook payload with a second inline composition | the defect was two channels drifting; a third copy is the same defect with better odds |
| edit the node packs' keys directly | a pack is a versioned artifact; the publish is blocked, and a local edit is shadowed by the registry copy under `OPENWOP_STRICT_REGISTRY=true` |
| drop `reason` with `outcome` | a silent drop; §C now forbids it and the field carries the only provenance distinguishing a timeout from a human reject |
| gate the audit on counts instead of shapes | counts move with test ordering; a gate that moves for unrelated reasons gets re-baselined on reflex |
| widen `V2_OPAQUE_ID` to admit `:` for the demo id | the grammar is the corpus's; one demo mint is not an argument to change it |

## Implementation record

| task | change | witness |
| --- | --- | --- |
| A.6 | `v2PayloadProjection.ts`; `listEvents` + `webhooks.ts` call it | projected `run.started` validates; route-level fan-out witness |
| A.4 | recorder emits `{payload, wire}`; audit validates both, gates wire; shape ledger | `--write-shapes`; a tightening reds the shape gate |
| A.1 | `workforceHistory.ts` `approve→granted`, `reject→rejected` | Ajv on `approvalGranted` |
| A.2 | `outcome` → `decision: 'rejected'` at both emitters | existing interrupt tests |
| A.3 | `run.started` extras → `metadata`; alias table for `artifact.created` | alias tripwire; persisted vs wire split |
| A.3 | `agentRunnerNode` emits `[type, payload]` via `agentEventToEmit` | discriminator witness (2 legs) |
| A.5/A.7 | hashed demo subscription id + migration 21 | rekey witness (4 legs) |

**A witness that matched its own comment.** The discriminator test's negative
regex asserted the old spread expression was gone from the source — and the
docblock explaining the fix quoted that expression verbatim. The test failed on
its own explanation. Reworded to describe rather than quote; the lesson is the
same as the crosstalk marker rule: never write the literal you are policing.

**A fixture that blamed the projection.** The "projected `run.started`
validates" leg first failed on `/owner/subject/lane`. The projection was
correct; the fixture had invented `lane: 'legacy'`, and `legacySubject()` stamps
`lane: 'api-key'` (`host/runOwner.ts:146`). Ajv's error, not my reading of the
code, settled it.

## The transferable part

**Neither the write seam nor the read seam is "the wire truth"; the truth is
per channel, and a host has more channels than it thinks.** The audit was
honest about what it measured and still wrong about what it meant, because one
egress path had been projected and one had not — and the seven scenarios that
should have noticed did not validate payload shape. The fix was not a better
number but a single function every channel is forced through.

## Implementation record — Phase E addendum (2026-09-17, corpus 2.3.3)

- Pins `@openwop/openwop-conformance` + `@openwop/spec-artifacts` `^2.2.1 → ^2.3.3`
  (lockfile delta: those two packages only; `@azure/core-rest-pipeline` intact —
  the KMS-preflight tripwire class). `schemas/` re-vendored at `v2.3.3`
  (`schemas/CORPUS_TAG`), `eventCodemap.generated.ts` regenerated (36 renamed pairs).
- RFC 0186 seats are live in the vendored schema: `reason` on `nodeSuspended` /
  `interruptResolved` (this host already emitted it bare — no code change),
  `conversationExchanged` union `{turn?, outcome?}` (this host emits `turn`),
  `ApprovalData.onTimeout`. `clarification.requested` has no emitter here (bus
  `3eec`) — the corpus closed it as a deletion.
- `host/workforceHistory.ts` (the EP0 demo fixture) rewritten to the SEATED
  shapes: `nodeStarted.typeId`; `nodeSuspended {interruptId, kind, key, reason}`;
  `approval.requested` = `suspend-request {kind, key, data: ApprovalData}` (the
  old `{prompt}` was the wrong MODEL, not an extra key); `approval.granted` /
  `overridden {interruptId, kind, resolvedBy: Subject, decision, action}`;
  `run.completed {outputs}`; `run.failed {error, failedNodeId}`. Witness
  `adr0722-workforce-fixture-validates.test.ts`: 2461/2461 generated events
  validate on the full major-2 wire.
- The audit recorder records the FULL wire (`projectV2RunIds` after
  `projectV2Payload`) — see ADR 0725 D4; Phase A's 188 `must match pattern`
> **Phase E addendum, CORRECTED 2026-09-18 by #3954** (which landed while this
> branch was in its gate). The shape ledger this addendum describes gated on
> per-shape COUNTS, and #3954 measured why that cannot hold: the recorder keeps
> one sample per (type, key-set) PER WORKER, so a count is a function of how
> vitest spread the tests (188 → 191 on an untouched tree). This branch takes
> #3954's mechanism — the ledger is the SET of `<type> :: <error-shape>` pairs,
> gated on PRESENCE, counts informational — and keeps Phase E's own addition on
> top: the two classes that are NOT this host's projection failing (a
> fixture-minted opaque outside the grammar; an `anon:` run, bare by ADR 0704's
> decision) are reported and excluded from the gate. Regenerated from Phase E's
> measurement #3 (1,324 host samples / 50 types): **5 pairs across 2 types**,
> both fixture-driven and admitted with reasons in the type baseline.

  errors were bare ids in an unbound copy.
- Correction to §A's numbers: the 797 wire errors measured 2026-09-17 morning
  included that artefact; the honest post-binding figure is re-measured in the
  Phase E sweep and recorded in the baselines' `measured` stamps.
