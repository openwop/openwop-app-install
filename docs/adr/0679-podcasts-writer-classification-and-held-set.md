# ADR 0679 — Podcast writers, and the nodes a declaration cannot reach

Status: **implemented** (verified 2026-09-17, #3811)
Date: 2026-09-14
Feature loop 2026-09, iteration 29 (Podcasts)
Gap ids: `PODWF-9` (new), `PODWF-10` (new), `PODWF-11` (new), `GEN-HELD-1` (new, corpus-wide); `PODWF-2`..`-8` all re-verified STILL TRUE

## Context

All five nodes in `packs/feature.podcasts.nodes` (v1.0.5) are `role:"action"` with **no
`capabilities` key** — the same shape ADR 0678 closed for notebooks one iteration ago. Three
write durable state:

| node | effect | reach |
|---|---|---|
| `select-content` | reads (`nb.ask`, `pod.getEpisode`) | `no-ai-reach` |
| `outline` | `ctx.callAI` **+ `pod.recordEpisodeResult`** | **`invocation-log`** |
| `transcript` | `ctx.callAI` **+ `pod.recordEpisodeResult`** | **`invocation-log`** |
| `synthesize` | billable speech synthesis → hosted audio URLs; no durable row | `no-ai-reach` |
| `mix` | `docs.createDocument` + `docs.addVersion` + `pod.mixClips` + `pod.recordEpisodeResult` | `no-ai-reach` |

**But the obvious fix — declare `side-effectful` on every writer — is a NO-OP for two of them,
and I measured that BEFORE prescribing it rather than after.**

## D1 — classify `mix` and `synthesize` (this works)

Both classify `no-ai-reach`, so `gen-side-effect-floor.mjs:117-129` puts them in the floor AND
the served set, and `isSideEffectingNode` returns true.

- `mix` writes a Document + a version + the episode result. ADR 0603 already fixed a
  *destructive* bug in this node (an unconditional empty-`clips` write that ERASED recorded
  clips while the mux gate left `audioMediaRef` pointing at previous audio). Classification is
  the replay half of the same story.
- `synthesize` makes a **billable** speech call per dialogue turn and returns hosted audio URLs.
  It is neither invocation-logged (the classifier reports `no-ai-reach` — the speech surface is
  not `ctx.callAI`) **nor served**, so a replay re-synthesises, re-bills, and **stores a fresh
  Media asset per turn**. It is also the node `pack.json:4` explicitly promises will not be
  re-called.
- `mix` additionally calls `pod.mixClips` (`index.mjs:360`), which unconditionally
  `storeMediaAsset`s a freshly muxed blob on every call (`features/podcasts/surface.ts:118-120`)
  — so each replay leaks a new media asset and repoints `audioMediaRef`, which in turn trips the
  `durationSeconds` delete at `podcastsService.ts:432`.

**`recordEpisodeResult` itself is content-idempotent** — a named-field merge, last-write-wins,
with per-field emptiness gates (`podcastsService.ts:394-441`) — so THAT leg of a duplicate is
benign. It is, however, the **smallest** write these nodes make, and it bumps
`updatedAt: now()` (`:427`), which is non-deterministic under replay. The idempotent merge does
**not** make the unclassified writers safe.

**Decision:** declare `capabilities: ["side-effectful"]` on `mix` and `synthesize`, and
`capabilities: []` on the other three, so a non-classification is a reviewed decision rather
than a missing key (the ADR 0678 precedent). Bump the changed nodes' own versions and the pack.

## D2 (`PODWF-9`) — `outline` and `transcript` CANNOT be fixed by declaring anything

Both reach `ctx.callAI`, so `classifyNodeReach` returns `invocation-log`, and the generator
**holds them out of the served set** (`gen-side-effect-floor.mjs:126`):
```js
else if (reach.kind === 'invocation-log') held['ai-invocation-log'].push(typeId); // HELD, not served
```
`isSideEffectingNode` consults **only** `MANIFEST_FAST_PATH_SERVED` (`sideEffects.ts:266`) —
`MANIFEST_SIDE_EFFECT_FLOOR` is referenced **zero times** in that file. So declaring
`side-effectful` on these two would put them in the floor, hold them back, leave
`isSideEffectingNode` returning **false**, and change nothing — while looking in the diff
exactly like the fix applied to `mix`.

**That would be the third consecutive iteration in which a prescribed classification was a
provable no-op** (ADR 0677 D2's first draft, ADR 0678's `fetch-youtube-source`). The difference
here is that it was caught in recon, by running `classifyNodeReach` and reading the generator's
arm logic, rather than by the review.

**This is an architectural gap, not a pack defect.** The holdback is *correct* for the model
call — it preserves RFC 0041 §B divergence injection, which is why ADR 0673 D1 introduced it.
The gap is that the scheme is per-NODE while the effects are per-CALL: a node that both invokes
a model and writes durable state gets ONE arm, and the arm that serves the model call withholds
serving from the write. `outline` and `transcript` therefore re-execute
`recordEpisodeResult` on every replay.

**Decision: FILE the classification gap, do not paper over it.** Declaring the capability on
these two is explicitly REJECTED here, with the reason recorded at the node, so the next author
does not "complete" the pattern and ship a no-op. The real cures are larger than this iteration:
split the AI call into its own node (the chain already has that shape), or give the executor a
per-effect discharge rather than a per-node one.

## D2b (Blocker, `PODWF-10`) — but the WORST defect in those two nodes is fixable, and it is not the classification

Verification of the prior rows turned up something D2 had missed: `outline` and `transcript`
each mint a **Document**, and that write leaks on every replay, fork **and plain retry** —
independent of the served-set holdback entirely.

`index.mjs:371-372` claims the write is *"idempotency-keyed so a fork reuses it"*. **It is false
in both halves:**

1. `index.mjs:396-402` calls `docs.createDocument({ orgId, title, kind, format, ownerSubject })`
   with **no `documentId`**. `createDocument` is idempotent ONLY on a caller-supplied
   deterministic id (`documentsService.ts:326-329`); absent one it mints `doc:${randomUUID()}`
   at `:335`. **So every attempt creates a brand-new container.**
2. The `idempotencyKey` is applied at `addVersion` only (`:403`), scoped to *that* new
   container's version list (`documentsService.ts:484`) — and the key itself embeds `ctx.runId`
   (`:192` `podcast-outline:${ctx.runId}:${episodeId}`, `:251` the transcript twin). A fork gets
   a new `runId`, so **it cannot collide across a fork by construction.**

Consequence: a re-run or fork leaks a duplicate outline Document AND a duplicate transcript
Document per attempt, and `episode.outlineDocRef` / `transcriptDocRef` are overwritten to the
newest — **orphaning the prior pair**.

**This is the THIRD instance of the identical pattern**: ADR 0676 D1 (strategy
`create-board-memo`), ADR 0678 D1b (notebooks `write-transformation`), now podcasts. In every
case a runId-bearing key was applied to a freshly-minted document, which can only ever collide
with itself. ADR 0678 recorded that the notebooks instance propagated **by citation** from the
strategy one; this is a third independent site, so the pattern is a house idiom, not a copy.

**Decision:** mint both Documents at a **content-derived deterministic id**
(`doc:podcast-outline:<sha256(orgId,episodeId,content)>` and the transcript twin), the same cure
as ADR 0678 D1b. **This is orthogonal to D2's classification gap and strictly more valuable**:
it converges the duplicate on `mode:'branch'`, on `mode:'replay'`, and on an ordinary retry —
none of which classification would have reached for these two nodes.

## D4 (`PODWF-11`) — `podcasts.generate` is bindable to the scheduler and to triggers, and dies there

Both documented dispatch sites pass `inputs: { episodeId }` (`features/podcasts/routes.ts:132-139`,
`agentTools.ts:218-221`). But the chain is reachable by raw id from two automation lanes that
neither row records:

- **Trigger:** `routes/triggerBridge.ts:102-110` accepts any string `workflowId` and gates only
  on `workflowCatalog.getWorkflow(workflowId)` resolving — which `podcasts.generate` does, via
  the chain-backed source-A resolver (`host/index.ts:500-501`).
- **Scheduler:** `routes/scheduler.ts:204,248` stores `body.workflowId` with **no catalog check
  at all**, and `:393,:403` fire it.

Neither lane can supply `episodeId` through the `inputs` seam, so a scheduler- or trigger-bound
run enters with an empty bag and dies inside `select-content` — **the same observable failure
`PODWF-1` described, through a door `PODWF-1`'s fix does not touch.** Filed; the cure is a
launch-contract check at bind time, which is a core-surface decision.

## D3 (`GEN-HELD-1`, corpus-wide) — the held set is 73, and some of them write

**MEASURED:** floor **323**, served **250**, so **73 nodes are declared side-effecting and are
NOT served** — `isSideEffectingNode` returns false for every one of them. For most this is
correct: `core.ai.chatCompletion`, the `agent.*` and `brand.*` families are model calls whose
invocation log discharges them.

Of the 73, **7** sit in a pack whose source contains a durable-write call (a pack-level proxy —
an upper bound, per the ADR 0678 lesson that this kind of count is a candidate set). **Two are
CONFIRMED by reading the node body:**

| node | durable write in its own body |
|---|---|
| `core.rag.vector-upsert` | `.upsert(` — writes vectors |
| `feature.documents.nodes.generate-from-template` | `createDocument` + `addVersion` |

The other five are either reads in a writing pack or write nothing in the held node itself —
including `feature.workflow-author.nodes.draft`, which ADR 0673 D1 deliberately held back and
which correctly writes nothing (`persist` does).

So the class has **at least four confirmed members** once podcasts' two are counted, and it is
the same shape in every case: *declared, held, unserved, writes anyway*. Filed with the
measurement and its limits; not swept here.

## RFC verdict

**Host + pack work, no RFC.** D1 declares existing manifest fields; D2b is a pack-internal
change to how a document id is derived. D2's classification gap, D3 and D4 are filed, not
implemented — a per-effect discharge and a bind-time launch-contract check are both core changes
needing their own ADRs.

## Three FALSE replay claims to correct (podcasts asserts it in more places than notebooks did)

1. **`pack.json:4`** — *"Action nodes — outputs are recorded; replay/fork read the recorded
   result rather than re-calling the model/synthesizer."* This is the pack's advertised contract,
   shown by the node catalog, and it **names the synthesizer specifically** — the one node with
   no recorded-result path at all.
2. **`index.mjs:12-14`** — the same claim, but stating the *inference* explicitly
   (`role:"action"` ⟹ outputs recorded), which is exactly the step the served-set holdout breaks.
3. **`index.mjs:371-372`** — the `writeDocument` idempotency claim falsified in D2b.

## Open questions

1. Should `gen-side-effect-floor.mjs` **refuse** a node that is held AND whose body contains a
   durable-write call — i.e. make this class a build error rather than a filed row? That is the
   detector the ADR 0678 §"Why the build does not catch it" gap calls for, one level up.
2. `recordEpisodeResult` may be idempotent service-side. If it is, `outline`/`transcript`'s
   duplicate is harmless and `PODWF-9`'s severity drops to the billable re-call only. Pending.

## Status correction (2026-09-17)

This read `Status: Proposed (revised after prior-row verification — the held-se…` — a PRE-implementation phrasing that went stale when
the work landed in **#3811** (D1/D2/D2b). `docs/steward/FEATURE-LOOP-2026-09.md` records the
row **DONE** with that PR, which is the independent evidence for this correction.

**It was invisible to the steward staleness ratchet for a structural reason worth recording.**
That gate tested `Status:` for the EXACT string `Proposed`, so the parenthetical after the
word silenced it permanently — no baseline row, no exemption, nothing in a diff that reads as
a suppression. Seven ADRs were hidden that way, and the commit that claimed the baseline was
"drained to zero" was wrong about its own headline. The test is a prefix match now.
