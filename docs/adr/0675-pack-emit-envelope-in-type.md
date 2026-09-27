# ADR 0675 — 376 production rows carry an envelope where a type belongs

Status: Accepted (implemented; see § Implementation record)

## Context

`ctx.emit` is positional: `emit(type, payload)`. Several packs in this repo call
it with a **single object** instead, in two spellings:

```js
ctx.emit('artifact.created', { … })                    // positional — correct
ctx.emit({ type: 'node.progress', data: { … } })       // core.openwop.http
ctx.emit({ kind: 'node.progress', payload: { … } })    // core.openwop.a2a, .agents
```

Nothing rejected the object forms, so the **whole object** was passed as `type`
and written into the `events.type` TEXT column, serialised on the way.

MEASURED in production 2026-09-14 by `scripts/era2-vendor-type-census.mjs`:

> **376 rows** whose `type` is a serialised envelope, e.g.
> `{"type":"node.progress","data":{"phase":"retry","attempt":1,"error":"This operation was aborted"}}`
>
> **Nine of the ten** grammar-invalid `(tenant, type)` pairs in the entire event
> log are this one bug.

## Why nobody had seen it

**It is invisible from the source.** A scan of `appendEvent({ type: '…' })` call
sites returns ten literals, every one a well-formed codemap-named type — which
reads as *"this host has only ever written clean types."* I had that conclusion
half-written before catching it.

The corrupting write does not go through a literal. `executor/executor.ts`'s
`ctx.emit` passes a **variable** into `eventLog.append`, and `executor/eventLog.ts`
passes `type: input.type` onward. A census of literals cannot see a variable, so
the defect sat in the log for as long as it has existed while every static check
reported clean.

It surfaced only because `openwop-1` asked for a *count of rows*, which forced a
query against the data instead of a reading of the code. **Only the data answers
a question about the data.**

## Decision

**Normalise at the bridge, and refuse what cannot be normalised.**

`executor/normaliseEmitArgs.ts` accepts the positional form unchanged, accepts
`{ type | kind, payload | data }`, and throws a typed `validation_error` for
anything else — including an empty string.

Three choices worth stating:

1. **The invariant lives in the HOST, not in the packs.** Fixing
   `core.openwop.http` alone would leave the next pack free to do the same, and
   packs are third-party by design. A type that is not a string is not a type,
   and the one place that can enforce that for every pack is this bridge.
2. **Refusal, not coercion.** `String(type)` would have "worked" and produced
   exactly the corrupt rows we already have. A silent accept is what made this
   invisible for months; an error a node surfaces is worth more than an event
   the log cannot name.
3. **The object form wins over a stray positional payload** rather than merging
   them. A caller passing both is confused, and merging would invent a payload
   neither side wrote.

Sabotage-proved: restoring the original pass-through reddens **five** of the six
assertions; replacing the refusal with `String(type)` reddens the refusal test
alone.

## What this does NOT do

It does not repair the 376 existing rows. They are durable history, they are
unreadable under `persistence.md` §The reader rule, and rewriting an event log
in place is a worse cure than the disease. They are now *counted*, which is what
an RFC 0176 amendment would need if anyone argues for relaxing that rule.

It also does not fix the packs' call style. The host now accepts both, so the
packs are no longer wrong — but `core.openwop.http` sending `{ type, data }` to
a positional signature is still a readability trap for the next author, and a
follow-up should make them positional and bump their versions.

## Implementation record

| phase | what | where |
| --- | --- | --- |
| 1 | normaliser + typed refusal | `src/executor/normaliseEmitArgs.ts` |
| 2 | bridge routes through it | `src/executor/executor.ts` (`ctx.emit`) |
| 3 | 6 assertions, 2 sabotages | `test/adr0675-emit-envelope-in-type.test.ts` |
| 4 | the measurement that found it | `scripts/era2-vendor-type-census.mjs` (#3801) |
