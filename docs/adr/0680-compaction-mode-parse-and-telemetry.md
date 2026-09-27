# ADR 0680 — A failed `off` loses byte-exactness, and the enum that must exist first

Status: **implemented** (verified 2026-09-17, #3813)
Date: 2026-09-14
Feature loop 2026-09, iteration 30 (Tool-output compaction, `FEATURES.md:198`)
Gap ids: `TOCWF-9` (open, **upgraded**), `TOCWF-11`, `TOCWF-12` — closed here;
`TOCWF-14` dispositioned; `TOCWF-3` downgraded + widened; `TOCWF-5`/`-6`/`-8`/`-10` carried

## D1 (Improvement, `TOCWF-9` + `TOCWF-6` — ONE unit) — `parseMode` fails OPEN, and the enum must land with it

`features/tool-output-compaction/surface.ts:21-23` is the mid-graph surface's mode parser:
```ts
function parseMode(v: string | undefined): CompactionDecision['mode'] {
  return v === 'lossy' || v === 'off' ? v : 'lossless';
}
```
Any unrecognised string becomes `'lossless'`. **MEASURED:**

| input | result | |
|---|---|---|
| `'off'` | `off` | |
| `'Off'` | **`lossless`** | ← meant OFF, got compaction |
| `'OFF'` | **`lossless`** | ← meant OFF, got compaction |
| `' off'` | **`lossless`** | ← meant OFF, got compaction |
| `'loosy'` | `lossless` | harmless (a failed upgrade) |

**The filed row probed only the harmless direction** — a failed *upgrade*, which safely degrades.
The direction it never probed is a failed **`off`**.

> **CORRECTED — the harm is BYTE-EXACTNESS, not "compaction was applied", and the first draft's
> framing contradicted D2 three sections later.** D1 called landing on `lossless` a Blocker-grade
> harm; D2 calls it fail-SAFE because lossless "cannot leak or corrupt". Both defaults land on the
> same value, so as written one of them had to be wrong. The reconciliation was already in the file
> I am editing, at `surface.ts:33-35`: *"this lane takes a **CALLER-SUPPLIED string**, so the
> **byte-level guarantee** is the one that matters here."*
>
> `off` on this surface does not mean "skip a saving"; it means **"do not touch my bytes"** — what
> a caller hashing, signing, or diffing a payload needs. `lossless` is `minifyJsonText` plus a
> never-regress guard (`compact.ts:235-238`) and copies every non-whitespace byte in order
> (`:120-142`), so a failed `off` costs **insignificant-whitespace deletion** — nothing for tool
> output, everything for a signature. **A DOWNGRADE to lossless loses only savings; an UPGRADE
> from `off` loses the guarantee `off` exists to provide.** That is the real statement, and it is
> compatible with D2.

> **CORRECTED — my reachability premise was FALSE, and it changes the shape of the fix.** The first
> draft said *"there is no SPA editor … so its callers are hand-authored chain node configs."*
> **Measured: two more consumers exist.** `routes/nodeCatalog.ts:29` serves `buildNodeCatalog()`
> to the **SPA builder palette** (pinned by `test/tool-output-compaction-node-catalog-parity.test.ts:135`
> under an anti-vacuity leg), and `features/workflow-author/workflowAuthorService.ts:81` builds the
> **Workflow Architect's closed-world authoring catalog** from the same source. So an LLM authors
> configs for this node.
>
> **That makes the refusal unsafe ALONE.** The pack declares **no `inputSchemaRef`**
> (`packs/feature.tool-output-compaction.nodes/pack.json:10-18` — this is open row `TOCWF-6`, which
> the first draft merely *carried*), `toAuthorNode` omits `inputSchema` when undefined
> (`workflowAuthorService.ts:105-117`), and `findUnknownTypeIds` validates **typeIds only**
> (`host/nodeCatalogBuilder.ts:253-259`). So the model is handed this node with nothing naming the
> legal `mode` values, nothing validates what it writes, and D1 alone would convert *"the author
> picks `'none'` and gets silent lossless"* into *"the author picks `'none'` and the run dies, with
> no closed world that could have told it otherwise."* That is this repo's own non-negotiable read
> backwards. `WORKFLOWS-ASSESSMENT.md`'s remediation plan already sized them as ONE unit —
> *"`TOCWF-6` + `TOCWF-9` (S) — schemas on the pack, typed failure on a missing input"* — and the
> first draft split the pair and kept the half that is unsafe alone.

**Decision (D1a):** `parseMode` accepts `off` / `lossy` / `lossless` case-insensitively after
trimming, and **refuses anything else with a typed `validation_error`** rather than defaulting.

**Decision (D1b) — ships in the SAME PR, and the ordering is the point:** add an `inputSchema` to
the pack declaring `mode: {enum:["off","lossless","lossy"]}` and `required:["input"]`, so the
closed world an authoring model reads names the legal values **before** the host starts refusing
the illegal ones. *The enum must exist before the refusal does.*

**Decision (D1c) — the same defect has three instances in one method, not one.** `parseNum`
(`surface.ts:24-26`) silently maps `head:"20"`, `head:3.5`, `head:-1` to `undefined`, so
`compact.ts:240-241` substitutes `DEFAULT_HEAD`/`DEFAULT_TAIL` and the caller gets **a different
elision than it asked for, reported as success** — `parseMode`'s shape exactly. It is replaced by
the shared `surfaceOptCount` (`host/featureSurfaces.ts:140-148`), which throws `validation_error`
on a present-but-unusable count and was added under ADR 0602 / `NBWF-1` for precisely this class —
from a module `surface.ts:16` **already imports and does not use**. The third instance,
`str(args.input)` coercing a missing input to `''` (`:40`), is closed by D1b's `required:["input"]`.
Fixing one argument of a three-argument method and calling the class closed is the failure this
ADR would otherwise repeat.

**Blast radius MEASURED:** no shipped caller, fixture or pack passes a non-canonical mode
(`packs/feature.tool-output-compaction.nodes/index.mjs:26` forwards `mode` only when
`typeof === 'string'`; every test passes a canonical spelling). **The single casualty is a test
that PINS the defect** — `test/tool-output-compaction-surface.test.ts:69-71`,
*"defaults to lossless for an unknown mode"*. It is **inverted, not quietly deleted**, and it is
named here so an implementer who hits the red does not take the easy exit and weaken the parser
back to a default.

**Witness:** born-red legs for `'Off'`, `'OFF'`, `' off '`; a leg that an unknown mode is a typed
refusal; a leg that the three canonical spellings still pass; a leg that `head:"20"` refuses
rather than silently substituting a default; and a leg that the pack's `inputSchema` enumerates
exactly the three legal modes.

## D2 (`TOCWF-11`) — a bare `catch {}` hides a persistently broken agent profile

`features/tool-output-compaction/decision.ts` wraps the `getAgentProfile` read in
`} catch { /* fail-open: any profile-read error leaves the safe lossless default. */ }` with
**no log**. An agent configured for `lossy` whose profile read keeps failing silently runs
`lossless` forever, and nothing says so.

Two notes, because the comment is half wrong: the fallback is **fail-SAFE**, not "fail-open" —
`lossless` is minify-only and saves ~nothing, so degrading to it cannot leak or corrupt. What is
wrong is the **silence**, not the direction.

**Decision:** keep the fallback, add a `log.warn` naming the tenant + agent. Mirrors the
contributor-level `run_start_contributor_failed` warn already in `runStartContext.ts:86`.

## D3 (`TOCWF-12`) — the savings telemetry cannot be attributed to a tenant

`host/agentDispatch.ts:1282` builds the transform ctx as
`{ decision: opts.compaction, toolName: call.name }` — **no `tenantId`** — so every
`tool_output_compacted` telemetry row from the chat lane is unattributable. The one lane whose
savings anyone would want to measure is the one that cannot be grouped.

**Decision:** add `tenantId?: string` to `ChatToolLoopOpts` (`agentDispatch.ts:937`), pass it at
`:1282`, and supply it at the two callers that have a tenant (`conversationToolLoop.ts:529` →
`run.tenantId`; `agentDispatch.ts:1368` → `deps.tenantId`). `anonymousActor.ts:482` is the
ratchet's EXEMPT lane and supplies no decision, so the field is deliberately absent there.

> **CORRECTED — "one field" was wrong, and so was the impact.** The ctx type already accepts it
> (`host/toolResultTransform.ts:28`) and the observer already emits it (`:204`), so D3 is real and
> not a no-op — but `ChatToolLoopOpts` has no `tenantId`, so delivering it is ~4 edits, not one.
> And the first draft's *"every `tool_output_compacted` row from the chat lane is unattributable"*
> is **true and empty**: `applyToolResultTransform:200` emits only when the output SHRANK, and
> lossless saves zero on this host's already-minified tool output (`compact.ts:45-50`, 0 of 336
> sites indent). So this attributes the rows a **`lossy`-opt-in agent** produces — not a flow of
> rows that exists today.

## Dispositioned, NOT fixed

- **`TOCWF-14` — the event log persists the FULL output while the model receives the COMPACTED
  one** (`bootstrap/nodes.ts:2026` emits `output: subResult.output`; the return value is compacted
  at the boundary below it). **The conclusion is right and the row's "Nice-to-have" is right; the first draft's MECHANISM was
  wrong.** It said the two are "full vs compacted" views of one artifact, so the compacted one is a
  reproducible projection. **They differ in SHAPE, not only in compaction.** The event records
  `subResult.output` and **only when `status === 'completed'`** (`bootstrap/nodes.ts:2030`); the
  model receives `compact(formatSubRunResult(subResult))` (`:2039`), which on `pending`/`failed`
  **synthesises** a `{status, runId, message}` — including a prose resume instruction and the
  30 000 ms budget — that the event never carries (`:2145-2165`). So the log is **not a strict
  superset**, and the deterministic-projection argument does not hold on the non-completed
  branches. Truncating the log would still be wrong; the cure is a **marker on the event naming
  what the model actually received**, which is its own decision.

## Ranking, stated honestly — `TOCWF-8` is the most reachable open row here, and D1 is not

The first draft labelled D1 a **Blocker** while its own Open Question conceded the live blast
radius is nil. Both cannot be true. Measured reachability:

| row | reachable today? |
|---|---|
| D1 (`parseMode`) | only via the `compact` node — **zero chain consumers** (`TOCWF-5` re-verified; the typeId appears only in the pack's own two files and `sideEffectFloor.generated.ts`) |
| **`TOCWF-8`** | the **tool-result boundary**, for any agent with the per-agent `lossy` opt-in (`decision.ts:93-97`) — **no chain required**. `isSchemaReadExempt` shields ~23 declared tools; the other ~180 are exposed |

`TOCWF-8` inserts a synthetic `{"_elided":N}` **as an element inside** the array it shortens
(`compact.ts:185-196`), so a model receives a **fabricated array element** — the tracker's own
probe records *"a JSON-Schema `enum` gained an object member."* Feeding a model fabricated input
on a lane that needs no chain outranks guarding a lane nothing reaches. **D1 is therefore an
Improvement, and this ADR says so rather than inheriting the label.**

**`TOCWF-8` is NOT fixed here, and the reason is that the tracker's prescribed cure is wrong.**
It says *"move the marker out of the array (`{items:[…], _elided:N}`)"* — which converts a JSON
**array** into an **object**, lying to the model about shape and breaking every structural
consumer. The other half ("refuse `lossy` on the explicit node lane") covers only the lane with
zero consumers. The real cure is an out-of-band disclosure channel, which is its own decision.
Carried with that mechanism recorded, so the next pass does not implement the broken cure.

## Corrected

- **`TOCWF-3` (PARTIAL) — downgraded, and it names 1 of 2 lanes.** The row says the anon lane is
  "still bare `storage.insertRun`". True — but the consequence is **fail-safe, not a hazard**: no
  stamp ⇒ no decision key ⇒ no compaction, and a later `:fork` inherits nothing because
  `decision.ts:72` returns `{}` for any `derivedFromRun` run and the two PRODUCTION derive lanes
  pass it (`routes/runs.ts:1675`, `routes/workflowDebug.ts:435` — `:385` is a comment). So
  `TOCWF-1`'s closure genuinely holds on the product lanes.
  > **"Both derive lanes" was FALSE — there is a THIRD.** `routes/compensationSeam.ts:389-402`
  > creates a run with `parentRunId` **and** `forkMode:'replay'` and inserts it **without**
  > `derivedFromRun`, so the contributor re-resolves the live toggle on a derived run — the exact
  > acquisition defect `TOCWF-1` closed. Not a production hazard: it is gated on
  > `OPENWOP_TEST_SEAM_ENABLED` and born with empty metadata. **Recorded because the ratchet does
  > not cover the invariant's real population** — `test/run-metadata-copy-sites.test.ts` polices
  > metadata-COPY sites, and this site copies no metadata, so it is *structurally invisible* to it.
  > The population that needs `derivedFromRun` is "runs created from another run", which is
  > strictly larger than "runs that copy metadata" — [[ratchets-police-spelling-not-invariant]].
  What the row misses is that there are **two** production bare-insert sites, not one:
  `host/anonymousActor.ts:403` **and** `host/workforceEval.ts:133` (eval runs). Both behave
  identically. The real content of this row is "the feature does not apply to these lanes" — a
  coverage gap, not a correctness defect.
  > **But the cure is SECURITY-GATED, and the first draft dropped the strong reason for the weak
  > one.** `anonymousActor.ts:397-402` records why the lane was left alone: routing anon through
  > the seam **also runs the AUTHORITY contributor**, minting a recorded authority block from
  > `currentAuthority()` for an ANONYMOUS principal — *"a security-relevant change… not a
  > token-savings fix."* Arriving at "fail-safe, low priority" by a weaker argument invites a
  > future reader to conclude the cure is cheap and route anon through the seam. That is the
  > prescribed-cure-causes-a-regression shape, reached by omission. `workforceEval.ts:133` carries
  > no such constraint. (Five further bare inserts are conformance/test seams —
  > `anonSurfaceSeam.ts:171`, `effectSeamFireSeam.ts:109`, `eventLogSeedSeam.ts:202`,
  > `effectTransportRetrySeam.ts:110`, `testSeam.ts:723` — so "two PRODUCTION sites" is the load-
  > bearing word.)
- **There is NO second fail-open mode parser — my own question was premise-wrong, recorded as a
  negative.** `executor/compaction.ts:24` already refuses (`if (mode !== 'lossless' && mode !==
  'lossy' && mode !== 'off') return undefined;`), `decision.ts:36-51` parses a **boolean** `lossy`
  and no mode string, and a forged `run.metadata.compaction` is closed (`compaction` is a reserved
  key, pinned at `test/tool-output-compaction-fork-real-path.test.ts:264-268`). `parseMode` is
  genuinely the only one. One real asymmetry falls out and is worth the row:
  `readAgentCompactionConfig` can express `lossy: true` but has **no way to express `off`**, so an
  agent cannot opt out of a tenant-enabled compaction except per-tool via `exemptTools`.
- **Sibling-lane classification check: CLEAN** — recorded as a negative so the next pass does not
  re-spend it. `feature.tool-output-compaction.nodes.compact` is `role:"action"` with
  `capabilities: []` **already explicit**, and its implementation makes no `ctx.features.*`,
  connector, or persistence call at all. A pure deterministic transform is correctly unclassified.
  This is the second clean result on this check in four iterations.

## RFC verdict

**Host work, no RFC.** D1 changes a host-internal parser's refusal behaviour; D2/D3 are a log line
and a field. No wire facet, no envelope kind — consistent with the feature's standing
`A+ Wire/RFC governance`.

## Open question

`parseMode` refusing an unknown mode changes a mid-graph surface from total to partial. Every
current caller is a hand-authored chain config and **zero chains consume this node**
(`TOCWF-5`), so the live blast radius is nil — but a future caller passing an unvalidated
user string would now get a typed failure instead of silent `lossless`. That is the intended
trade and it is stated here rather than discovered later.

## Status correction (2026-09-17)

This read `Status: Proposed (revised after adversarial review — 3 Blockers; the…` — a PRE-implementation phrasing that went stale when
the work landed in **#3813** (D1a/D1b/D1c, D2, D3). `docs/steward/FEATURE-LOOP-2026-09.md` records the
row **DONE** with that PR, which is the independent evidence for this correction.

**It was invisible to the steward staleness ratchet for a structural reason worth recording.**
That gate tested `Status:` for the EXACT string `Proposed`, so the parenthetical after the
word silenced it permanently — no baseline row, no exemption, nothing in a diff that reads as
a suppression. Seven ADRs were hidden that way, and the commit that claimed the baseline was
"drained to zero" was wrong about its own headline. The test is a prefix match now.
