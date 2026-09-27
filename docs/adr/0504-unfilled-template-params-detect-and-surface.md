# ADR 0504 — Unfilled template params: detect and surface, do NOT refuse

Status: Accepted

Closes ADR 0502 §Open-1. Corrects the reach of **ADR 0498**.

> **The title changed during implementation.** This began as "refuse at run
> start". The refusal was built, tested, and then **measured** — and the
> measurement killed it. The original reasoning is kept below rather than
> rewritten, because the measurement is the decision.

## Context

Instantiating a chain without its required params mints a **persisted, owned,
gallery-visible workflow that can never run**. Reproduced live against production
(rev `00581-2nl`) on 2026-07-29: `POST …/workflows/from-chain` for the Challenge
Factory with no `params` returned `201`, and every run of the result failed with

```
core.web.search requires a non-empty `query` input
```

An error naming an internal node, for a cause that is a missing *parameter*.

### Why nothing caught it

`resolveTokenString` returns `bag[NAME]` for a whole-value token, so an absent
param freezes to `undefined` and `JSON.stringify` then **drops the key entirely**.
What reaches storage has no `query` at all — indistinguishable from a key the
author never wrote.

That is what defeats ADR 0498's missing-required-config check: it inspects the
**minted** node, reads only `node.config` against a pack's `configSchema.required`,
and `core.web.search` is an in-tree builtin whose `query` rides `inputs`. It
logged **nothing** for this instantiation — confirmed by querying production for
`chain_node_missing_required_config`.

## What was built, and why it was not shipped

The plan was: record the failed freeze at expansion (the only point holding both
the authored token and the params), keep minting permissive so "Use template =
just copy" survives, and **refuse at run start**, re-reading the live node so a
value filled in the builder clears the block.

That was implemented and passing. Then the blast radius was measured.

**`host/seedWorkflows.ts:88` expands every chain with `expandChain(chain, {})`.**
So the seeded gallery every tenant gets is minted with no params at all:

```
TOTAL 169 chains | AFFECTED 114
```

**114 of 169 — 67%.** A run-start refusal would have blocked two thirds of the
product's workflow gallery. The cure is categorically worse than the disease.

> **§Correction (ADR 0507, 2026-08-01) — THIS POPULATION IS MISLABELLED.**
> `seedWorkflows` seeds only ZERO-CONFIG chains, so the seeded set is **52**, not
> 169, and only **9** of them are affected. The 114 counts chains that would be
> broken if instantiated *without params via `from-chain`* — a real and larger
> population, but NOT the seeded one. The conclusion below (do not refuse at run
> start) is unchanged and if anything stronger, since the refusal would have hit
> the instantiation lane users drive by hand. Only the word "seeded" was wrong.
> This is the third recurrence of "measured the wrong artifact" (ADR 0498 → 0504 →
> here); the durable fix is to name the population explicitly before counting it.

This also reframes the original defect. The Challenge Factory instantiation was
not an anomaly; it is the *normal* state of a seeded workflow. 114 chains reach a
node with a required value simply absent and fail mid-run naming an internal node.

## Decision

**Detect and surface. Do not refuse.**

1. `expandChain` records every whole-value `{{params.NAME}}` token whose param has
   no value, as `metadata.unresolvedParams: Array<{nodeId, key, param}>`. Recursive
   through objects and arrays, so it has no blind spot of its own. Deferred mode is
   exempt — it materializes params as run-overridable variables, so an absent value
   there is expected, not a failed freeze.
2. `findUnfilledExpansionParams(def)` re-checks the record against the **live**
   node. The record says *which* values never froze; the definition says whether
   they are *still* empty. A value filled in the builder clears it with no
   write-back; a deleted node drops out.
3. The `from-chain` response carries `unfilledParams`. The sibling `incompleteNodes`
   field cannot see these — it inspects a minted node whose key is gone. Verified
   live: the broken instantiation returned `incompleteNodes` empty.
4. A **ratchet** (`seeded-chain-unfilled-params.test.ts`) pins the count at 114 and
   fails if it rises.
5. **No run-start refusal.** The enforcement point does not exist yet, because the
   population that would be enforced against is the product itself.

### The principle

> Measure the blast radius before choosing the enforcement point. A gate that is
> correct in principle and fires on two thirds of production is not a gate, it is
> an outage.

## Alternatives considered

| Option | Why not |
|---|---|
| Refuse at instantiation | ADR 0498 tried this and reverted it — breaks "Use template = just copy" |
| Refuse at run start | Built and measured: blocks 114 of 169 seeded chains |
| Infer missing values from the graph at run start | Unported edges are flattened into `input`, so absence is unprovable — blind to the motivating case |
| Extend ADR 0498's check to read `inputs` | Necessary but insufficient: the key is *gone* from the minted node |
| Block on the stale metadata record alone | Would block a workflow the user already fixed in the builder |

## Correction note — ADR 0498

ADR 0498's check is narrower than its framing suggests: **report-only**, **`config`
only**, required keys from **pack `configSchema`** (so every in-tree builtin
declares nothing), and it inspects the **minted** definition (so a vanished key is
invisible). It is a useful signal for pack-authored config; it does not cover
missing template params, and should not be cited as if it does.

## Implementation record

| Phase | Change | Test |
|---|---|---|
| 1 | `expandChain` records `metadata.unresolvedParams` | `unfilled-expansion-params.test.ts` |
| 2 | `findUnfilledExpansionParams()` re-checks the live node | same — blocks/clears/empty-string/deleted-node/inert |
| 3 | `from-chain` returns `unfilledParams` | same |
| 4 | Seeded-chain ratchet at 114 | `seeded-chain-unfilled-params.test.ts` |

Sabotage-probed: disabling the recording failed 4 of 8 assertions; trusting the
stale record instead of re-reading the node failed exactly the "clears once
filled" assertion, confirming that guard is real rather than incidental. The
ratchet carries a registry-loaded precondition so a zero count cannot pass
vacuously.

Two of my own claims were corrected by their own tests:
- the minted key does **not** vanish in memory — it is present holding `undefined`,
  and only `JSON.stringify` removes it. Both read as missing; the test asserts both.
- the run-start refusal was believed safe until measured. It was not.

## Open questions

1. **Seed in deferred mode.** `chainBackedWorkflows.ts:78` already uses
   `expandChain(entry.chain, { deferred: true })`; `seedWorkflows.ts:88` uses
   `{}`. That inconsistency is the root cause — deferred mode turns these params
   into run-overridable variables instead of freezing them to `undefined`.
   Changing it alters `expansionId` and therefore every node id, which the
   ADR 0498 note in `seedWorkflows.ts` records as having already broken replay for
   77 chains once. Needs its own ADR and a migration story; deliberately not
   attempted here.
2. **Embedded tokens** (`"a {{params.x}} b"`) resolve to `''`, not `undefined`, so
   a partially-interpolated string is not recorded.
3. **The record is not re-derived on a builder save.** It is history, not state;
   the re-check makes staleness harmless, but a workflow edited to introduce a new
   blank gains no record.
4. The Challenge Factory still hard-defaults to `provider: "anthropic"`, failing
   `byok_required` for anyone on the managed free provider (ADR 0502 §Open-2).
