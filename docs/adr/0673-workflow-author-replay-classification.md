# ADR 0673 — AI Workflow Author: replay classification, and four stale claims about it

Status: **Accepted — PARTIALLY implemented** (verified 2026-09-17, #3803)

Extends **ADR 0072** (the author), **ADR 0595** / **ADR 0596** (which closed 10 of its 11
Blockers), and **ADR 0572** (the manifest-derived side-effect floor). Feature-loop 2026-09
iteration 25. Gap id `WFAWF-24` in `docs/steward/WORKFLOWS-ASSESSMENT.md` § "AI Workflow
Author — feature loop 2026-09 it.25 re-grade, 2026-09-13" (`ea1bdc144`).

## Context

The 2026-08 pass graded this feature **C with 11 Blockers**. ADRs 0595/0596 closed **10 of
them**, verified at the mechanism this pass. What remains is one defect the prior pass
reported as **clean**, and four documentation claims about this feature that are false at
HEAD — one of them in `CLAUDE.md` itself.

### The Blocker, measured twice

All four authoring nodes declare `"role": "action"` with empty `capabilities`
(`packs/feature.workflow-author.nodes/pack.json:19,31,42,53`), and the derived floor binds
`role:"side-effect"` ∪ the `side-effectful` capability only
(`scripts/gen-side-effect-floor.mjs:139`).

**First measurement — computing the generated file's `export const` boundaries and locating
each typeId numerically**, rather than reading a grep window: all four sit in
`MANIFEST_DECLARED_TYPE_IDS` **only**, in neither `MANIFEST_SIDE_EFFECT_FLOOR` nor
`MANIFEST_FAST_PATH_SERVED`.

**Second measurement — calling the real predicate** rather than reasoning about it:

```
feature.workflow-author.nodes.draft      isSideEffectingNode=false
feature.workflow-author.nodes.validate   isSideEffectingNode=false
feature.workflow-author.nodes.get        isSideEffectingNode=false
feature.workflow-author.nodes.persist    isSideEffectingNode=false
```

`executor/executor.ts:983` gates the recorded-outcome serve on exactly that predicate, so
**false ⇒ the node executes.**

**CORRECTED after the pre-implementation review — my threat model was INVERTED across the two
fork modes, and both halves of the original paragraph were false.**

On a **`mode:'replay'`** fork, `draft`'s `ctx.callAI` is normally served from the SOURCE run's
invocation record (`aiProvidersHost.ts:729` — `if (!cached && scope.replayInvocationsFromRunId
&& !mockProgramPending)`), so the re-drafted definition is **identical**, `parseDefinition`
yields the same `workflowId` (ADR 0596 removed the `runId`-derived mint), and
`persistAuthoredWorkflow` upserts the same id. It does **not** "re-issue a billed call with
fresh non-determinism", and the transient cap is not charged.

The defect is reachable in the two ways that record does not cover:

1. **An RFC 0041 §B divergence injection** — a pending mock program deliberately skips the
   source-run fallback (`aiProvidersHost.ts:728`, `mockProgramPending`), so `draft` genuinely
   diverges and today mints a second workflow.
2. **An absent or evicted invocation record.**

**A `mode:'branch'` fork is NOT covered by this decision and must not be claimed as such.**
`routes/runs.ts:1725` sets `replayInvocationsFromRunId` **only** for `replay`, so under
`branch` `sourceOutcomes` is null, `executor.ts:983`'s guard is never consulted, and **every
classification in D1 is inert** — `persist` re-executes live past the checkpoint by design
(`runs.ts:1721-1723`: *"branch: resume from the checkpoint snapshot (the copied prefix never
re-executes)"*). Whether that is acceptable is a question for the executor, not this feature.

**The fix is still worth shipping** — for the two narrow cases above, which are exactly the
cases the invocation log cannot serve. But an ADR that claimed the broad version would have
been shipping a fix for a defect that mostly does not occur, while implying it covered a mode
it cannot reach.

**The pack header asserts the opposite** (`index.mjs:3-6`): *"Every node is `role:"action"` …
so the engine records the output and replay/fork read the recorded result rather than
re-issuing."* MEASURED: `grep -rn "role === 'action'" src/executor/` returns **zero** — the
executor never reads `role`.

**Fourth instance of a named family.** `CRMWF-1`, `WF-COS-2`, `WF-AKM-1` — the last of which
records *"five docblocks claim `role:"action"` makes it replay-served and the executor never
reads `role` at all."*

**How the prior pass missed it** is the transferable part: its Reachability row cites
*membership in `MANIFEST_SIDE_EFFECT_FLOOR` at `sideEffectFloor.generated.ts:1272`* — **the
wrong set, at a line inside a different export.** The generated file's own header warns that
membership is not a discharge anyway.

## Boundaries audit

- **No new feature package, no new toggle, no new mechanism.** D1 is a manifest declaration
  plus a generator run plus one pattern entry — the cure this repo already settled.
- **The precedent was verified, not inherited.** `WORKFLOWS-ASSESSMENT.md:5538` prescribes
  the **two-leg** cure for `WF-COS-2` and states its reasoning: *"a pack `.mjs` node cannot
  set `module.sideEffecting`, so the manifest role alone is what the derived floor reads and
  the pattern is the belt."* Confirmed at HEAD against **`sideEffects.ts:258-264`, the predicate itself** — three arms
  since ADR 0572 P3. (The `:219-222` comment still describes the pre-P3 two-arm world; its
  sub-claim that a pack `.mjs` cannot set `module.sideEffecting` is true, but citing a stale
  two-arm sentence as current state — in an ADR whose thesis is that the derived set is the
  mechanism — would hand the next reader the same trap.)
- **No parallel classification path.** `isSideEffectingNode` stays the one predicate.

## Decisions

### D1 (Blocker, `WFAWF-24`) — declare the four writers, SCOPE the belt, and predict BOTH artifacts

Flip all four nodes to `role:"side-effect"`; bump the pack **to 1.0.4 in BOTH places** —
`packs/feature.workflow-author.nodes/pack.json` and the feature pin at
`features/workflow-author/feature.ts:65` (the replay-witness precedent asserts pin ==
manifest); regenerate the floor **and** `docs/steward/SERVED-SET-BASELINE.json`; re-attest; and
correct the pack header that asserts the opposite.

**The belt is SCOPED to the three served nodes — this was a self-contradiction in the first
draft.** It said to add an explicit `SIDE_EFFECTING_TYPE_PATTERNS` entry without qualification.
`isSideEffectingNode` (`sideEffects.ts:258-264`) **ORs** three equally decisive arms, and
`gen-served-set.mjs:131` (`derived.has(t) || res.some((re) => re.test(t))`) does the same — so a
pack-wide regex would **fast-path `draft`, overriding the `ai-invocation-log` holdback this
whole decision is built on**, retiring §B divergence injection for the one node that needs it
and falsifying D1's own table. The entry is therefore
`/^feature\.workflow-author\.nodes\.(validate|get|persist)$/` and **must not match `draft`.**
The `WF-COS-2` precedent used a pack-wide entry because that pack contains **no AI node** —
that is the fact that does not transfer.

**The four do NOT land in the same place, and that asymmetry is the decision.** `draft` calls
`ctx.callAI` (`index.mjs:200`), so `classifyNodeReach` marks it `ai-invocation-log` and holds
it back from the served set.

| node | floored | served | on a `mode:'replay'` fork |
|---|---|---|---|
| `draft` | yes | **no** (held back, `ai-invocation-log`) | invocation-log served normally; re-executes under §B divergence — **by design** |
| `validate` | yes | yes | replays the recorded outcome |
| `get` | yes | yes | replays the recorded outcome |
| `persist` | yes | yes | **replays — no second workflow is written** |

*(`mode:'branch'` is unchanged throughout: the guard is not consulted there.)*

**TWO artifacts, TWO accountings — predicted up front, because in iteration 23 I predicted the
opposite for exactly this case and would have read a correct movement as a regression:**

- `sideEffectFloor.generated.ts`: floor **313→317**, `MANIFEST_FAST_PATH_SERVED` **241→244**,
  held `ai-invocation-log` **27→28**.
- `docs/steward/SERVED-SET-BASELINE.json`: floor **313→317**, served **270→274**,
  `servedByRole['side-effect']` **216→219**, and **`undischarged` UNCHANGED at 43** — the
  ratchet counts `invocation-log` as *discharged* (`gen-served-set.mjs:150`). So `draft` is
  "held back" in one file and "served" in the other. **Reading a +1 in `undischarged` here
  would be exactly the misread this paragraph exists to prevent.**

**This closes the durable half in the cases that are actually reachable**: under a §B
divergence or a missing record, `persist` now serves its original outcome, so the run reports
the workflow it authored and no second row appears.

**Alternative weighed and rejected — make `draft` deterministic so it could be served.** Trades
a real property (divergence injection, which the conformance suite exercises) for a cost
saving, and cannot be honest: a provider is free to vary.

**Alternative weighed and rejected — the pattern entry alone, without the manifest flip.** The
pattern is the belt, not the mechanism. ADR 0572's point is that a pack's declaration binds the
host "without anyone having to remember a regex".

**The witness must be BORN RED, which needs a stated divergence mechanism.**
**CORRECTED — the first draft's witness passes today.** "Fork an authoring run and assert no
second `wfreg:` row" is green with the current manifest, because a plain replay serves `draft`
from the invocation log and the definition is byte-identical. (The CRM precedent was born red
for a mechanism that does not exist here — a per-run id key, which ADR 0596 deliberately
removed from `parseDefinition`.) So: stage a mock program for the draft node
(`providers/dispatchMock.ts:85`; `aiProvidersHost.ts:728` skips the source-run fallback while
one is pending) so the fork's `draft` returns a DIFFERENT `workflowId`, then assert (a)
`persist`'s `node.completed` carries the SOURCE run's `workflowId`, and (b) `kvList('wfreg:')`
gained no row. **Sabotage leg:** flipping `persist` back to `role:"action"` must turn both red.

### D2 — correct four stale claims, one of them in `CLAUDE.md`

1. **`CLAUDE.md:140-145` says `WFAU-4` "is still open and cannot be closed in a host PR"**,
   needing an RFC 0064 change because *"tool errors never write `meta.error` and the
   tool-return event carries no result payload."* **It is closed.**
   `docs/adr/0612-wfau-4-tool-return-error-surfacing.md` is **Status: implemented** (#3580),
   and the host hops are present: `deriveToolErrorCode` (`host/toolHooks.ts:142`) reads
   `.code` **or `.error`**, and `agentDispatch.ts:1246`/`:1276` emit `status:'error'` with
   `error:{code, message}`.

   **CORRECTED after review — "closed" means the `meta.error` HALF.** `CLAUDE.md` names TWO
   gaps, and the second — *"the tool-return event carries no result payload"* — is **still
   literally true at HEAD**, and is a deliberate design choice rather than a gap:
   `agentDispatch.ts:1264` records that this host never sets `outcome` on a tool-return (the
   result reaches the model through compaction, not the wire), which RFC 0064 §F permits
   (`error` ⊥ `outcome`, both optional). **`WFAU-4` is closed because the DISCRIMINATOR is now
   honest, not because both sentences became false.** Correcting a stale citation with a
   half-true one is the same failure one rung down.

   **Corrected in place, as a note beside the original.** The paragraph sits directly under
   `CLAUDE.md`'s own warning that *"a citation here is a claim, not evidence"* — and had gone
   stale two paragraphs below it. **A file that warns about stale citations is not exempt from
   them**, and that is worth recording where the next reader will hit it.

2. **`docs/steward/NODE-PACK-AUDIT.md` carries three stale facts in one row**: it grades this
   pack **A / 0 gaps / 0 blockers** (`:47`), says *"3/3: draft/validate/persist"* when a
   fourth node shipped (`:193`), and records the pin as *"1.0.2==1.0.2"* when both are
   **1.0.3** at HEAD and **1.0.4 after P1** — the correction records the post-P1 value
   (`:264`). **The `A` was awarded without the fork-guard check** — the same
   correction the CRM row on that page already records about itself.

3. **`FEATURES.md:193`'s parity claim is INVERTED.** It says the author lane registers
   *"through the shared validator + registry (the same path `POST …/workflows` uses)"*. At
   HEAD the author lane is **strictly safer**: the REST route has no closed-world check, no
   acyclicity check, a fire-and-forget definition write, and registers **before** recording
   ownership — the last two being exactly the Blockers ADR 0595 fixed here. Fixing that route
   is out of scope; the sentence pointing a reader at the *less* guarded path as the reference
   is not.

4. **My own memory** recorded *"WFAU-4 §F witness pinned #3585"*. #3585 is a conformance
   dependency bump. Corrected there rather than in the repo.

### D3 (`WFAWF-15`) — the response schema is hand-written, unpinned, and teaches the wrong field

`index.mjs:44-80` mirrors `WorkflowDefinition` by hand. It teaches `edgeId` as the required
edge-id field while the canonical field is **`id`** (the host accepts `edgeId` only as a legacy
alias, `workflowDefinitionValidation.ts:527`), and it cannot express `condition`, `inputs`,
`variables`, `metadata` or `settings` — **so no AI-authored workflow can branch conditionally
or take a launch parameter.** The parity suite pins the catalog text but not this schema.

**CORRECTED after review — the SSoT I named does not exist.**
`host/workflowDefinitionValidation.ts` is hand-written imperative code that MIRRORS
`schemas/workflow-definition.schema.json` by hand (its own header at `:8`, and `:433`, `:511`,
`:564`); it reads no schema at runtime, so "generate it from the SSoT the validator reads" is
unimplementable as phrased.

**CORRECTED AGAIN at implementation (2026-09-13) — BOTH proposed generation sources are
wrong, and the second was the review's own correction of the first.**

- *"the SSoT the validator reads"* (my first draft) — there is none; the validator is
  imperative code that reads no schema at runtime.
- *`schemas/workflow-definition.schema.json`* (the review's correction) — MEASURED: the wire
  schema requires **`id`** plus `name`, `version`, `triggers`, `variables`, `metadata` and
  `settings`, while the host validator requires **`workflowId`**
  (`workflowDefinitionValidation.ts:401`). **A definition generated from the wire schema is
  REJECTED by the host.** Pinned as a test leg so the next reader does not re-propose it — I
  proposed it twice.

**Chosen: keep the schema hand-written, fix its concrete defect, and pin it BEHAVIOURALLY.**
The defect was that it taught `edgeId` — a legacy host ALIAS — as the required edge field,
when the canonical field is `id` (`workflowDefinitionValidation.ts:526`). The guard is a
round-trip: a definition satisfying the prompt schema must PASS
`validateWorkflowDefinition`. That is stronger than schema-against-schema because it pins the
thing that actually gates the write, and it is the shape the review asked for ("pin validator
behaviour against the schema, not just schema-against-prompt").

**Deferred with a reason:** widening the schema to express `condition`, `inputs`, `variables`
and `settings` is a real gap (no AI-authored workflow can branch), but it is a **behaviour
change** — it is the first time an authored workflow could take a launch parameter or branch —
and it is OQ-2's subject. It gets its own decision and its own witness, not a rider on a
field-name correction.

*(Superseded text, kept for the trail: "generate it from `schemas/workflow-definition.schema.json`
— the vendored WIRE schema the validator mirrors.")* State plainly what that buys and what it does not: the model's
contract comes to agree with the **wire**, while the validator remains a third party that can
still drift from both. The parity test must therefore pin **validator behaviour against the
generated schema**, not merely schema-against-prompt. Bound the output — nodes with >8KB
schemas are already excluded from the catalog menu, and OQ-2's widening (`condition`, `inputs`,
`variables`) is exactly what makes this schema large. Phased after D1 because it changes what the model can author, and
that deserves its own witness.

### D4 — the small open rows

`WFAWF-13` (`if (!offMenu) return;` — a probe that ran nothing reports green); `WFAWF-16` (the
id pattern has no length bound while the error text promises `{1,64}`); `WFAWF-17` (`get`'s
declared input schema describes `definition` while its real input is `workflowId`);
`WFAWF-23` (`get` is wired into no chain).

> **CORRECTION (pre-merge, same PR) — `WFAWF-16`'s bound is `{1,128}`, and the `{1,64}` this
> row cites was never a description of this host.** The first implementation enforced the
> advertised `{1,64}` verbatim. That turned **14 test files / 28 tests red** — every chain
> expansion suite, none of them workflow-author's. MEASURED across all 181 shipped chains
> (570 nodes): expansion mints node ids as `<chainId dots→underscores>_<12-hex instance>_<nodeId>`,
> and a **sub-chain prefixes an already-prefixed id a second time**. The un-prefixed population
> maxes at exactly **64**; real single-prefixed ids run **65–66**
> (`campaign-studio_campaign-orchestration_a001317ad3f5_kernel-approve`); double-prefixed ids
> reach **87**. So the error text was the thing that was wrong — enforcing it would have
> rejected legitimate chains at `from-chain` and at the `workflow-chain:expand` seam, and the
> repair loop has been feeding that false bound to the model all along. The bound is now
> `{1,128}`, matching the sibling `WORKFLOW_ID_PATTERN`, clearing the measured 87 with
> headroom, and still bounding the storage key; both error messages were updated to say so.
>
> **The transferable lesson is the one this repo keeps re-learning: measure the blast radius
> of a gate against the population it will actually judge, BEFORE enforcing it.** The bound
> looked correct, matched the documented contract, had passing unit tests, and was still an
> outage for every sub-chain in the repo. A regression witness (`leg 4`, real 66- and 87-char
> ids from that run) now fails before the fourteen chain suites do, and names the reason.

## Explicitly NOT filed

- **The transient-GC posture gap.** The ADR 0369 transient-def GC runs only inside
  `if (defaultRetentionDays() > 0)` (`host/retentionSweepDaemon.ts:390-398`), and on a default
  install run retention is disabled — so authored defs are born transient and are **never
  collected** there. **Fail-closed is the right posture**; the residual is that
  "transient ⇒ eventually GC'd" holds only on a retention-enabled install, which the ADR 0595
  §6 narrative reads as automatic. Recorded as a doctrine note, not a defect.
- **`WFAWF-3`'s review-gate asymmetry** — kept by an explicit ruling (ADR 0595 §4 O2, four
  options weighed). A disposition, not an omission.
- **The REST route's missing guards** (finding 6 of the re-grade) — real, and **CORE's, not
  another feature's**: `routes/workflows.ts:311` is a host-extension route with no owning
  feature package, so "another feature's to fix" named the wrong owner. Deferred because the AI
  lane does not traverse it (both chat and node lanes enter at `persistAuthoredWorkflow`) — but
  the deferral must name what it leaves open: `registerWorkflow` at `:400` runs **before**
  `recordOwnership` at `:418`, with an `await recordRevision` between, so a throw in the middle
  leaves a definition permanently REGISTERED and permanently UNOWNED — which
  `workflowAuthorService.ts:367-375` describes as **readable by every tenant and overwritable
  by none, including its author**. That is the state ADR 0595 §3 called a Blocker and inverted
  on THIS lane, and it is reached through the builder's autosave, a far higher-volume writer
  than the AI lane. Filed as **`WFREST-1`**, owned by the workflows core surface.

## RFC verdict

**Host-extension throughout; no new RFC.** D1 changes a pack manifest's node classification —
host-internal, though it moves the ADR 0572 served-set ratchet under `docs/steward/`, which is
the item to watch. D2 is documentation. D3 changes what the model is taught it may author,
which is a prompt-surface change, not a wire change; the definitions it produces still go
through the same validator and the same closed-world check.

**Notably NOT needed:** the RFC 0064 dependency `CLAUDE.md` describes for `WFAU-4` — because
that RFC already landed and ADR 0612 already honoured it (D2.1).

## Phases

| Phase | Scope | Gap ids |
|---|---|---|
| P1 | role flip ×4 + pack bump to 1.0.4 **in both manifest and feature pin** + floor regenerate + **`SERVED-SET-BASELINE.json` regenerate** + belt **scoped to validate/get/persist** + re-attest + the pack header; a **born-red fork** witness via §B divergence | `WFAWF-24` |
| P2 | the four stale claims (`CLAUDE.md`, `NODE-PACK-AUDIT.md` ×3, `FEATURES.md`) | D2 |
| P3 | generate + pin the response schema | `WFAWF-15` |
| P4 | the four small rows | `WFAWF-13`, `-16`, `-17`, `-23` |

## Open questions

- **OQ-1 — WITHDRAWN, its premise was false.** It asked whether a fork-time budget guard was
  wanted because `draft` would re-issue a billed call on every fork. It does not: under
  `mode:'replay'` the call is invocation-log served and costs nothing. The real cost question,
  if one is wanted, belongs to `mode:'branch'` — which this decision does not reach (see
  Context).
- **OQ-2.** D3 generates the response schema from the validator's SSoT. That widens what the
  model may author to include `condition` and `inputs` — which is the point, but it is the
  first time AI-authored workflows could branch. Does that want a separate review gate, or is
  the existing closed-world + validate + human-promote chain sufficient?

## What the pre-implementation review changed (recorded, not silently fixed)

**3 Blockers**, and the first two each falsified a claim the decision rested on:

1. **My threat model was INVERTED across the two fork modes.** I wrote that a fork re-issues a
   billed, non-deterministic call and persists a different workflow. Under `mode:'replay'` the
   call is served from the source run's invocation record, so the definition is identical and
   the write is idempotent; under `mode:'branch'` the guard is never consulted, so **my fix is
   inert there entirely**. The defect is real but narrow — a §B divergence injection or a
   missing record — and the ADR now says exactly that instead of implying broad coverage.
2. **The belt I specified contradicted the decision it belonged to.** An unscoped
   `SIDE_EFFECTING_TYPE_PATTERNS` entry would have fast-pathed `draft`, overriding the
   `ai-invocation-log` holdback that D1's whole asymmetry depends on — retiring divergence
   injection for the one node that needs it, and falsifying my own table. Now scoped to the
   three served nodes.
3. **My witness was born GREEN.** "Fork and assert no second row" passes today, because replay
   serves the model call. A witness that cannot fail before the fix is the vacuity class I
   have now hit in five iterations; this one needs a staged divergence to bite.

Also corrected: the `CLAUDE.md` correction **overstated** (ADR 0612 closes the `meta.error`
half; the result-payload half is still true and is a deliberate, spec-legal choice — correcting
a stale citation with a half-true one is the same failure one rung down); D3 named an **SSoT
that does not exist** (the validator mirrors the wire schema by hand and reads nothing at
runtime); the REST-route deferral **named the wrong owner** and omitted the consequence; P1
omitted the served-set baseline regenerate and the feature-pin bump; and I cited a **stale
two-arm comment** as current state in an ADR arguing that the derived set is the mechanism.

**The transferable lesson is #1.** I measured the classification correctly — twice, carefully,
by computing export boundaries and by calling the real predicate — and then reasoned wrongly
about *what a fork does with it*. **Measuring the mechanism is not the same as tracing the
lane that reaches it.**

## Status correction (2026-09-17)

This record read `Status: Proposed` while its decision was already merged in **#3803**. It was on the steward staleness baseline (`backend/typescript/test/steward/adr-status-not-stale.test.ts`) as *flagged but unverified*; the status above was established by reading the code, not the commit message.

**Evidence.** P1 pack 1.0.4 all four nodes `side-effect` + belt `executor/sideEffects.ts:86` (correctly excluding `draft`); P2 corrections in `CLAUDE.md:146`, `FEATURES.md:193`, `docs/steward/NODE-PACK-AUDIT.md:194,276`.

**P4 is 2 of 4 and P3 shipped in a different shape.** Open: `WFAWF-17` — `packs/feature.workflow-author.nodes/schemas/definition.io.schema.json` still declares `required:["definition"]` and is still `get`'s `inputSchemaRef` (`pack.json:41`) while `get`'s real input is `workflowId` (`docs/steward/WORKFLOWS-ASSESSMENT.md:8433`); `WFAWF-23` — `…nodes.get` is wired into no chain (`WORKFLOWS-ASSESSMENT.md:8457`). P3 kept a hand-written `RESPONSE_SCHEMA` (`packs/feature.workflow-author.nodes/index.mjs:58-70`) with a recorded argument that both proposed generation sources are wrong, substituting a behavioural round-trip pin — defensible and witnessed, but not what this ADR prescribes.
