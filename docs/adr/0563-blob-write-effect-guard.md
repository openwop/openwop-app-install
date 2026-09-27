# ADR 0563 — The blob-write effect guard

Status: Accepted — implemented 2026-08-14

Date: 2026-08-14

Composes: ADR 0531 (replay effect suppression, `host/runEffectContext.ts`),
ADR 0341 (side-effecting node classification, `executor/sideEffects.ts`),
ADR 0533 (effect counting), ADR 0554 P0 (the effect-sender inventory).
No RFC gate — host-internal replay safety, no wire surface.

## Context

ADR 0554 P0 enumerated every effect sender and surfaced one unresolved item,
recorded as a deliberate marker rather than tolerated:

> `blob-write` is declared in `EffectKind` but **has no sender**. Either it is
> dead and should be removed, or a blob writer is bypassing the guard — worth
> resolving before P1 treats the union as authoritative.

**It is the second disjunct.** `core.storage.blob-put` — a shipped pack node
whose own manifest declares `"role": "side-effect"` — reaches
`ctx.storage.blob.put` from node execution and, on the `s3` backend, performs a
real presigned `PUT`:

```
packs/core.openwop.storage/index.mjs:42   'core.storage.blob-put': delegate('blob','put')
  → executor.ts:669                        ctx.storage = surfaces.storage
  → inMemorySurfaces.ts:1640               blob: resolveSurface('blob', …)
  → blob/s3Blob.ts:118                     fetchFn(url, { method: 'PUT', … })
```

`examples/workflow-chain-packs/starters` ships a chain ("Fetch URL → Blob
Storage") that sits on this node, and that root is a default loader root — so the
path was reachable, not theoretical.

**Both protective mechanisms were blind:**

| mechanism | status before |
|---|---|
| ADR 0341 fast path (`sideEffects.ts`) | no `blob` entry at all — node classified pure, recorded outcome never served |
| ADR 0531 backstop (`assertEffectAllowed`) | no call anywhere in the blob path |
| incidental `network-egress` guard | not reached — `s3Blob` uses bare global `fetch`, not the guarded dispatcher |

Consequence: **a replay or fork re-executed a live external write, silently.**
No fast-path serve, no backstop throw, no ADR 0533 effect count.

The pack manifest's `"role": "side-effect"` did not help, and that is worth
naming: `isSideEffectingNode` consults `module.sideEffecting` or the typeId list,
and a pack `.mjs` node cannot set the module flag. The manifest field is not read
by the classifier — it declares an intent nothing enforces.

## Decision

**Guard blob writes at the surface RESOLUTION seam, not in each adapter.**

```ts
blob: guardBlobWrites(resolveSurface('blob', (s) => createBlob(_blobState, s), scope)),
```

A future adapter (GCS, R2) inherits the guard by construction. Guarding
`s3Blob.put` alone would make effect coverage depend on which backend an operator
selected — exactly the conditional coverage ADR 0531 exists to eliminate.

**The memory backend is guarded too**, which is a real trade rather than an
oversight. Its writes are process-local, so counting them slightly inflates the
ADR 0533 tally. The alternative makes the invariant backend-conditional and
re-opens the hole for the next adapter. A uniform guard is the property worth
having; a marginally over-counted tally is the price.

**Reads are not guarded.** `get`/`presign` do not mutate external state and are
safe to re-run. (`presign` hands out a URL that may already have been used — a
compensation concern for ADR 0554, not a write.)

**The fix is coupled and must not be split.** The classification entry
(`/^core\.storage\.blob-put$/` in `sideEffects.ts`) ships with the guard:

- guard without classification ⇒ replaying the shipped `starters` chain hits the
  **backstop and throws**, and a backstop firing is a bug report, not a steady
  state;
- classification without guard ⇒ a future blob writer outside that typeId walks
  straight through again.

A test leg fails if a later edit separates them.

## A second finding: the inventory's "8 senders" was really 7

Fixing the scanner surfaced an unrelated inaccuracy.
`test/effect-sender-inventory.test.ts` scanned raw file text for
`assertEffectAllowed('kind'`, so **prose counted as a sender**.
`bootstrap/conformanceSideEffectNode.ts` was listed on the strength of a doc
comment at line 26.

**The comment is correct and there is no coverage gap** — it accurately states
that the notification seam the node delegates to
(`notifications/emitter.ts`, itself a real sender) calls the guard. Only the
*attribution* was wrong. The scanner now strips comments before matching, so it
measures calls rather than text; the row is kept in the inventory, struck through
and annotated, rather than deleted, so the correction is legible.

This is the same class as the false positive ADR 0556's P0 survey recorded (a
grep for `meter|createCounter` matching `Parameters`): **a substring is not a
symbol.** My own doc comment tripped the same scanner while writing this change,
which is how it was found.

## Alternatives weighed

- **Remove `blob-write` from `EffectKind`** (the "it is dead" branch): rejected
  on evidence — the write is reachable from a run and a shipped chain uses it.
- **Guard inside each adapter**: rejected; coverage becomes backend-conditional
  and the next adapter re-opens the gap by not knowing about it.
- **Read `"role": "side-effect"` from pack manifests**: attractive, and it would
  have prevented this class generally rather than one instance — but the manifest
  schema is RFC 0117/0119 territory (`sideEffects.ts` says so explicitly), so it
  is a spec change, not a host fix. Recorded as the extension path.

## Implementation record

- `host/inMemorySurfaces.ts` — `guardBlobWrites()` wraps the resolved surface;
  `assertEffectAllowed('blob-write', 'storage.blob.put')` is the first statement
  of `put`, the shape `smtpEgress`/`webhookEgressGuard` use. No-op outside a run,
  so the retention sweeper and the test-seam route are unaffected.
- `executor/sideEffects.ts` — `/^core\.storage\.blob-put$/`.
- `test/effect-sender-inventory.test.ts` — scanner strips comments; the
  has-no-sender test is **inverted rather than deleted** (an inverted test is the
  record that the question was answered, and it fails if the guard is removed);
  new legs pin the seam placement and the classification.
- `docs/steward/EFFECT-COMPENSATION-INVENTORY.md` — blob row added, conformance
  row corrected.

**Sabotage-proven:**

| sabotage | result |
|---|---|
| guard call removed | 3 red |
| classification entry removed | 1 red (the coupling leg) |
| restored | 6 green, `tsc` rc=0 |

## Consequence for ADR 0554 P1

P0's precondition is discharged: the `EffectKind` union is now authoritative, and
the compensation model has 6 real kinds to reason about rather than 5-plus-a-
question-mark. Blob's compensability is **Yes — a delete or overwrite is a real
inverse**, unlike email; but a *presigned* write is not covered by deleting the
object, because the URL may already have been used.
