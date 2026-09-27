# ADR 0702 — validate the payloads this host WRITES against the corpus `$def`

Status: Accepted (implemented; see § Implementation record)

## Context

`#3835` (ADR 0688) moved two event types onto their codemap names. The steward
confirmed the finding and flagged one thing they could not see from the corpus:

> `nodeId` is required and neither payload you quoted carries it — but you told
> me for the chunk case that `{nodeId, runId}` ride on the envelope, so I assume
> the same here rather than asserting a second defect I cannot see. **Worth your
> checking.**

**Checked, and my own answer to them was wrong.** `voice-event-payloads-shape.test.ts`
— a corpus scenario — compiles the `$def` and calls `validate({...payload fields})`.
There is no envelope merge anywhere. So `required` binds the **payload object
alone**, and the envelope carrying `nodeId`/`runId` is irrelevant to a validator
that never sees the envelope.

| def | `required` | this host wrote | missing |
| --- | --- | --- | --- |
| `outputChunk` | `nodeId, runId, chunk, isLast` | `{chunk, isLast}` | nodeId, runId |
| `interruptResolved` | `nodeId, interruptId` | `{interruptId, kind}` | nodeId |

`ctx.emit` does not enrich: `executor.ts` passes the payload through
`stripSecretsFromPersisted` and puts the ids on the envelope, nowhere else.

**How the error was produced is the useful part.** ADR 0688 says the reject path
omits `nodeId` too and calls it *"the house convention is envelope-carries-nodeId"*.
That is a description of what the code does, written as a rule that licenses it.
I had the evidence and converted it into permission. The corpus had already
corrected itself once on this exact field list — `outputChunk`'s own description
says *"the prior `{nodeId, chunk}`-only required set was the defective
restatement"* — and I read that sentence while checking the payload *matched*.

**And the lane could not have caught it.** The full major-2 conformance lane was
**EXIT=0, 490 files, 0 red** on the commit that wrote both short payloads, and it
ran twice that day: once in CI, once as the deploy-day certify. `myndhyve-1`
measured why on the corpus side: **31 of 355 scenarios apply Ajv**, and those
validate hand-written literals, which are correct by construction. The suite is
structurally strong at catching *a wrong value* and blind to *a missing required
key*. A green bundle does not mean payload-shaped.

## Decision

**Build the missing axis: record every payload this host writes, and validate it
against the `$def` its own `_typeIndex` names.**

- `storage/eventPayloadAudit.ts` — a recorder at `eventEraAdapter`'s two writers,
  the documented single seat for every event write. One comparison per append
  when off, hoisted to module load.
- `scripts/audit-event-payloads.mjs` — aggregates, validates with Ajv 2020,
  reports, and ratchets.
- The samples ride **free on the backend lane `ci.sh` already runs**. A second
  lane would have cost twenty minutes and measured slightly different code.

**Plus the one fix this ADR ships:** `storage/envelopeIdProjection.ts` supplies
`nodeId`/`runId` into the payload on a **major-2 read**, for the types whose own
`required` list asks. A read projection rather than a writer change because it
**repairs history** — every row already written gets the ids, including the
~1273 era-2 rows `persistence.md` forbids rewriting — and it cannot affect
replay or fork, since nothing persisted changes. The same argument
`projectV2OwnerEcho` already makes in that file. The type sets are derived FROM
the schema's `required` lists, never hand-listed: every def is
`additionalProperties: false`, so injecting `nodeId` into a type that does not
declare it would turn a valid payload into an invalid one — the mirror of the
defect being fixed.

## The measurement, and it is worse than the two types that prompted it

Full backend suite, 1323 distinct (type, key-set) samples:

| | |
| --- | --- |
| types the corpus `_typeIndex` names | 117 |
| types this host produced a sample for | 42 |
| **never sampled — a green run says nothing about these** | **75** |
| sampled types with no corpus def (vendor / host-only) | 14 |
| host-emitted payloads validated | 1310 over 53 types |
| **host-emitted payloads VIOLATING** | **499 over 31 types** |
| closed by this ADR's projection | **6** |
| **residual backlog** | **493 over 30 types** |

**The projection closes 6 of 499.** That number is the honest headline: the fix
I set out to make is a rounding error against what the measurement found. The
residual is dominated by `additionalProperties` violations — this host writes
keys the closed defs do not declare — which needs a closed-world key projection
of the kind `myndhyve-1` already has (`projectRunEventPayloadV2`) and this host
does not. That is its own decision, with its own information-loss question, and
it is **not** in this ADR.

Recorded as a shrink-only ratchet by TYPE in
`scripts/event-payload-violations-baseline.json` (31 admitted). Types, not
counts: the count moves with test ordering and flake, and a gate that moves for
reasons unrelated to the code is one people re-baseline on reflex until it means
nothing.

**The 75 never-sampled types are the number I would watch.** For those, a green
run is not weak evidence — it is no evidence, and the report says so rather than
folding them into a pass.

## The instrument under-measured itself FOUR times

Worth recording in full, because each fix made the audit look *worse* and every
intermediate state looked like a result:

| # | defect | reported | actually |
| --- | --- | --- | --- |
| 1 | only the payloads doc registered with Ajv | `VALIDATED 7`, 3 violations | 15 of 22 samples silently unvalidated — **including both defects that motivated the script** |
| 2 | direct `$ref`s only | `VALIDATED 17`, 6 violations | `ids.schema.json` itself refs `subject.schema.json`; 2 defs uncompilable |
| 3 | one ref SPELLING only | 2 uncompilable | refs appear as a bare name, a `./` path AND an absolute URL |
| 4 | regex over the TEXT | tried to load a file named after half an English sentence | a schema filename inside a prose `description` matched |

Each one silently narrowed the audit while the summary line looked complete.
The fix for (4) is the general lesson: **`$ref` is a key in the schema language —
walk the parse, do not match the text.** A substring match is not a parse.

A fifth, different in kind: the first origin tag was `'host' | 'test'`, and
**1319 of 1326 samples came back `'host'`** — because a test that drives an HTTP
route makes host code emit, and the conformance seed seam, whose entire job is to
plant arbitrary fixture payloads, lives in `src/` like everything else. A
two-value category cannot separate "this host's behaviour" from "a fixture's
spelling" when one module emits both. The tag is now the **emitting file**, and
the aggregator names the fixture seams explicitly rather than guessing.

So the script now refuses three ways: **zero samples is fatal** (the recorder did
not run — never "nothing to report"), **an uncompilable def is fatal** (a type
went unchecked while the summary looked complete), and an unresolvable `$ref`
exits rather than skipping.

## Implementation record

| phase | change | witness |
| --- | --- | --- |
| P1 | recorder at the write seat | `payloadAuditEnabled`, and zero-samples is fatal |
| P2 | aggregator + Ajv validation + denominator | the four self-corrections above |
| P3 | `projectEnvelopeIds` on the major-2 read | `adr0702-envelope-id-projection.test.ts`, 6 legs, 2 sabotages |
| P4 | shrink-only ratchet by type, wired into `ci.sh` | 2 sabotages (a new type; a stale admission) |

**A composition bug caught by reading my own diff.** The projection first landed
as a second `payload:` key ABOVE the existing `run.started` owner echo, which
silently won. It was harmless *only* because `runStarted.required` happens to be
`[workflowId]` today — correct by luck, and it would have broken the moment the
corpus added an id to that list, with nothing to notice. The two projections are
now composed explicitly.

## Follow-up, 2026-09-16 — the residual is NOT a drop, and the obvious fix is destructive

This ADR left "493 residual over 30 types" as work for a closed-world key
projection, *"of the kind `myndhyve-1` already has (`projectRunEventPayloadV2`)"*.
**Measured before building it, and that prescription is wrong for this host.**

### The residual, classified

| class | errors | actionable here? |
| --- | --- | --- |
| extra key (`additionalProperties: false`) | **611** over 20 types | see below — NOT by dropping |
| missing required property | 171 | per type; some need a corpus answer |
| **id-grammar pattern** | **249** | **NO — parked behind the steward's `~`-encoding PR** |
| enum / other | 29 | needs the corpus vocabulary answers |

All 249 pattern failures are `^[A-Za-z0-9._~-]{1,128}/[A-Za-z0-9._~-]{16,128}$`
(181) and the tenant pattern (68) — i.e. **a third of the residual is correctly
blocked on someone else's RFC**, not waiting on effort here. The original
"mostly additionalProperties" summary was right in shape and hid that.

### Why dropping is the wrong fix

A closed-world projection would drop **32 distinct keys**. They are not debris:

| key | what it is |
| --- | --- |
| `conversation.exchanged.turn` | **the conversation content** |
| `conversation.opened.initialTurn`, `conversation.closed.finalTurn` | same, at the ends |
| `replay.diverged.expected` / `.actual` | the divergence evidence — the entire point of the event |
| `artifact.created.documentId` / `.versionId` / `.payload` | artifact identity |
| `run.started.correlationId` / `.batchId` / `.workforceId` | correlation |
| `node.suspended.reason`, `interrupt.resolved.outcome` / `.reason` | the fields already in dispute |

And `conversation.exchanged.turn` is **read by two SPA modules** —
`chat/conversationClient.ts:154` and `chat/conversationTransport.ts:356`. A
closed-world projection at the major-2 read would **empty every chat** the moment
the SPA reads at contract 2, which is the direction the whole v2 migration is
going.

So the choice is not "drop or don't". It is:

1. **the host is over-emitting** and should stop recording this data — which
   costs real capability, including the conversation feed; or
2. **the v2 defs are under-modelled** relative to what a real host records, and
   32 keys of genuine data have no legal seat.

`myndhyve-1` can drop because their payloads apparently do not carry this. Ours
do. **Copying their fix because it worked for them is the citation-propagation
shape this repo keeps paying for**, and the measurement is what stopped it —
the same measurement the naive version would have passed, since every dropped
key makes the validator happier.

**Routed to the steward with the key list rather than decided here.** A host
cannot widen a corpus def, and it should not silently delete a user's
conversation to satisfy one.

## The transferable part

**A description of what the code does is not a rule that licenses it.** The
sentence "the house convention is envelope-carries-nodeId" was true as
description and false as permission, and writing it into an ADR is what let it
pass review — including my own.

And the reason this axis was missing at all: **every check we had validated
things that were correct by construction.** Hand-written literals in scenarios,
emit sites read as source. The only thing that finds a missing required key is
running the real payload against the real def, which is `myndhyve-1`'s sentence
one register over: *reading the writer tells you what it meant; only reading the
log tells you what it wrote.*

## Addendum 2026-09-18 — trying to partition the never-sampled set STATICALLY, and failing three times

The 75 (now 74) never-sampled types are the open item this ADR named as "the
number I would watch". The obvious next question is the right one: of those, how
many are types this host **cannot emit at all** — where a green run is not a
coverage gap but a capability this host simply does not have — and how many are
types it **can** emit that no test exercises? Only the second set is a gap.

The tempting way to answer it is a static grep of the emit sites. **It does not
work, and the way it failed three times in a row is the point.**

| pass | method | "host can emit" | what the next pass found |
| --- | --- | --- | --- |
| 1 | type string appears anywhere in `backend/typescript/src` | 82 of 117 | a mention is not an emit — comments, codemaps and type unions all match |
| 2 | `type: '<t>'` object-literal spelling | 44 | the character class was `[a-z0-9._-]`, so **every camelCase type silently failed to match** — `agent.toolCalled`, `core.dispatch.fanOut`, `envelope.nlToFormat.engaged` |
| 3 | same, uppercase allowed, plus `packs/` | 51 | a third emit shape exists: the type is passed **positionally to a helper** (`bootstrap/nodes.ts:1411` emits `'envelope.refusal'` as a bare argument), which no `type:` pattern can see |

Each pass looked like a result. Pass 2 is the one worth dwelling on: it
*lowered* the count from 82 to 44 and read as a useful tightening, when in fact
seven of the types it dropped were ones the host demonstrably emits. A number
that moves in the direction you expect is not evidence that it moved for the
reason you think.

**The conclusion is that this partition must not be derived from source
spelling at all.** There are at least three emit shapes and no reason to believe
three is the whole set — which is the same lesson as the `_typeIndex` work
above, one register over: reading the writer tells you what it meant, only
reading the log tells you what it wrote. The instrument that answers this
honestly already exists and is the one this ADR built — the runtime sampler at
the `eventEraAdapter` seam, which observes what was actually appended and
assumes nothing about how the call was written.

What the sampler alone still cannot say is *why* a type went unsampled. That
needs the emit site located by call graph, per type, and it is worth doing only
for the types the sampler reports as never seen — which is a much smaller list
than 117 and does not require guessing at spellings.

**Recorded here rather than acted on**, because the correct next step needs a
fresh sample set and the samples were being deleted: `scripts/ci.sh` now honours
`OPENWOP_PAYLOAD_AUDIT_KEEP=1`, which preserves the sample directory the audit
already produces during `npm run ci` instead of removing it. Default behaviour
is unchanged. Re-deriving those samples costs a full suite run; keeping them
costs a temp directory.
