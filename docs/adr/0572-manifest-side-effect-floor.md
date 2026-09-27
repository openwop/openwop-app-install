# ADR 0572 — The manifest-derived side-effect floor (replay.md requirement 4)

Status: Accepted — Phase 1 + Phase 2 implemented 2026-08-15; Phase 3 implemented 2026-08-17

## Context

Upstream `replay.md` requirement 4 makes a pack manifest's node
`role: "side-effect"` **binding on the host**, and says a host's own classifier

> is a floor ABOVE this declaration and never a substitute: it may classify
> additional nodes as side-effecting, and it MUST NOT classify fewer.

This host does not satisfy that. `executor/sideEffects.ts` classifies on a
hand-maintained regex allowlist plus an optional `NodeModule.sideEffecting`
flag, and **never reads the manifest**. A pack `.mjs` node cannot set the module
flag (it is reachable only through programmatic registration), so a pack node
declaring `"role": "side-effect"` is invisible to the classifier.

That is not a hypothetical. It has shipped twice:

| case | what happened |
|---|---|
| ADR 0563 | `core.storage.blob-put` declared `side-effect`; nothing read it; a replay re-executed a real S3 PUT |
| ADR 0533 correction | ten `core.openwop.http.*` senders declared `side-effect`, routed through an unguarded `ctx.http.safeFetch`; a replay re-executed them with **neither** the fast path nor the ADR 0531 backstop in the way |

Both were fixed by adding regexes — i.e. by feeding the very mechanism the
requirement is telling us to stop relying on alone.

### The measurement

Counted from `packs/*/pack.json` (736 distinct typeIds, no duplicate typeId
declared with conflicting roles):

| | |
|---|---|
| declaring `role: "side-effect"` | 218 |
| ...also carrying the `side-effectful` capability | 218 (all of them) |
| carrying `side-effectful` under **another** role (`action`, `gate`, `streaming-output`) | 60 |
| **floor = the union** | **278** |
| covered by the classifier today | 21 |

The capability is the strictly **wider** signal, so the floor binds
`role: "side-effect"` ∪ `capabilities: ["side-effectful"]`. Classifying
additional nodes is the direction requirement 4 permits; the union is never a
subtraction.

## The decision that a naive union is WRONG — and this is code, not judgement

The obvious implementation — union the floor into `isSideEffectingNode` — breaks
a conformance behaviour, provably:

```ts
// executor.ts
outcome = replayServed ?? await runWithEffectContext(…, () => module.execute(ctx));
```

A typeId the classifier returns true for is **never executed** on a replay. All
fifteen `core.openwop.ai.*` nodes declare `role: "side-effect"`. Unioning them
would stop the mock provider from ever running and kill the RFC 0041 §B
divergence machinery — which `executor.ts:856`'s own docblock describes as a
deliberate design, not an oversight.

> **CORRECTION 2026-08-17 (Phase 3), and it narrows this section rather than
> overturning it.** The objection above is sound and it is **AI-SPECIFIC**. It
> is an argument for a SUBTRACTION, not a veto on the union — which is how P1
> and P2 both read it, and why the derived floor sat unwired for two phases
> while `replay.md` requirement 4 went undischarged for 214 typeIds.
>
> Subtract the nodes whose discharge is the invocation log and the remainder can
> be unioned into `isSideEffectingNode` wholesale: requirement 2 does not merely
> permit serving them the source run's recorded outcome, it **mandates** it.
> Phase 3 does exactly that — 210 derived typeIds, `undischarged 214 → 43`.
>
> Two facts had to be established in code first, and one of them contradicted
> P2's own census:
>
> - **`core.openwop.ai.*` is not one class.** Only `classify`/`extract`/
>   `transform`/`embeddings` reach `ctx.callAI`. The MEDIA nodes
>   (`image-generate`, `video-generate`, `image-edit`, `image-upscale`,
>   `audio-synthesize`, `audio-transcribe`, `rerank`) reach
>   `ctx.callImageGenerator` and siblings, and `callImageGenerator` **never
>   touches the invocation log** — it dispatches after a metered budget check.
>   Pre-P3 a replay of those re-fired a **paid** provider call. P3 SERVES them,
>   which is the fix; see the mid-phase correction below for why "AI-ish" is the
>   wrong reason to hold a node back.
> - **`callAIWithTools` is not `callAI`.** It reaches `toolsRoundDispatcher`
>   with no invocation-log read or write anywhere in it. P2's arm-2 predicate
>   was `/callAI|…/`, and `callAI` is a **prefix** of `callAIWithTools`, so
>   `core.ai.toolCalling` was counted **served** while a replay would re-fire
>   its provider call. That is a FALSE DISCHARGE — the worst cell in the table,
>   because it is a claim of protection rather than a gap in one. See
>   §"The parse has no independent confirmation" below: this is the fourth
>   parser wave that section said to expect.

So requirement 4's real obligation is **"the node must not re-fire its declared
effect on replay"**, and this host has *three* mechanisms that can discharge it:

| mechanism | replay behaviour | who it covers |
|---|---|---|
| ADR 0341 fast path | serves the recorded outcome; node never runs | 21 typeIds |
| ADR 0326 P3a/b invocation log | node runs; the provider call is served from the record — preserves §B | the AI class |
| ADR 0531 guarded seam | node runs; `assertEffectAllowed` throws | everything reaching a guarded seam |

The floor must therefore be a **disjunction over discharge mechanisms**,
asserted per typeId, with `UNDISCHARGED` a build failure — not "everything into
the fast path".

### The open question (blocks Phase 2)

The third mechanism discharges by **throwing**, not by serving: the replay
*fails* rather than reproducing. Does requirement 4 accept that as discharge, or
does it require the replay to **succeed** with the recorded outcome?

- **Throw counts** → the remaining ~257 need only *seam coverage*, derivable
  from the `assertEffectAllowed` call sites, and the gate is a coverage map.
- **Must succeed** → they need *classification*, including working out what the
  fast path serves for a `streaming-output` node.

That is a large difference in scope and it is a spec reading, not a host choice.
Raised with the spec steward; Phase 2 waits on it. The fail-closed posture (seam
guards + allowlist) holds either way, so waiting costs nothing but time.

> **ANSWERED 2026-08-15 — a throw is a BACKSTOP, not a discharge.** The steward
> ruled (upstream #999, conformance suite `1.104.0`, requirement 4 now states
> the rule) that requirements 1 and 2 are **two obligations, not one**:
>
> | | req 1 — do not perform | req 2 — resolve the outcome |
> |---|---|---|
> | guarded seam throws | ✅ | ❌ |
> | fast path serves recorded outcome | ✅ | ✅ |
> | invocation log serves recorded outcome | ✅ | ✅ **iff keyed on `sourceRunId`** |
>
> So the disjunction above is **two arms, not three**. A typeId is discharged
> only by serving the source run's recorded outcome — by any store, provided the
> lookup keys on `(sourceRunId, nodeId, attempt)`. The fast path and the
> invocation log are the same discharge at two levels; a log keyed on the
> **fork's own** `runId` misses by construction and is not one.
>
> Requirement 3's `replay_source_missing` stays the only sanctioned failure, and
> it is conditioned on there being no recorded outcome. **A generic seam error
> is not that code and does not become it by also being safe.** The spec now
> names the posture: a throw-only host is **safe and non-conformant**.
>
> Consequences for Phase 2, which is now unblocked:
>
> - The **AI class is discharged**, and the §B objection was right — the
>   invocation log *is* requirement 2's mechanism, so those nodes never belonged
>   on the fast path. Conditional on the `sourceRunId` keying, which ADR 0326
>   P3b's `replayInvocationsFromRunId` fallback appears to already satisfy;
>   Phase 2 must **verify that in code before relying on it**, not infer it from
>   this sentence.
> - **Seam-only typeIds are UNDISCHARGED, not exempt.** They are safe today and
>   they fail a replay that should succeed.
> - The gate keeps the shape proposed here — per-typeId, `UNDISCHARGED` a build
>   failure — with the seam arm **removed from the disjunction** and recorded
>   separately as the backstop it is. ADR 0563's own phrasing already had it: a
>   backstop firing is a bug report, not a steady state.
> - The `recorded-outcome` advertisement is **withdrawn** until the served set
>   makes it true by construction. Withdrawing removes a *claim*, not a
>   guarantee — nothing escapes either way.
>
> Phase 1 below is unaffected: membership is the same set under either ruling.

## Decision

**Phase 1 (this ADR, implemented).** Derive and snapshot the floor's
**membership**; enforce that every manifest node is classified. Do **not** wire
the snapshot into the classifier.

1. `scripts/gen-side-effect-floor.mjs` enumerates `packs/*/pack.json` and emits
   `backend/typescript/src/executor/sideEffectFloor.generated.ts` — derived,
   never hand-written.
2. **Three states, fail closed.** A node's role is `side-effect` / one of the
   other taxonomy values / **unclassified**. Unclassified — a missing role *or*
   an unrecognized one — is a **build failure**. A typo like `"side_effect"`
   would otherwise silently drop a node out of protection, which is the ADR 0563
   shape exactly.
3. **Snapshot committed**, `--check` in `scripts/ci.sh`, so a new node arrives as
   a reviewed diff rather than an assumption.
4. **Conflicting declarations fail.** One typeId declared by two packs with
   different roles would let load order decide whether a replay re-fires. Zero
   today; the generator refuses rather than picking.

**Scope note, stated rather than assumed.** `unclassified → build failure` is
scoped to **manifest-declared** nodes. Applying it universally would sweep in
every programmatically-registered node and change replay semantics far beyond
requirement 4, which binds manifest declarations only.

Four nodes qualified and were classified from their **implementations**, not
their names:

| node | was | now | why |
|---|---|---|---|
| `feature.app-builder.nodes.capture` | absent | `pure` | wraps a value in an envelope; no surface call, no I/O |
| `feature.app-builder.nodes.repair` | absent | `action` | reads the design + one AI call — matches sibling `audit`/`deepen` |
| `feature.app-builder.nodes.apply-repair` | absent | `action` + `side-effectful` | CAS-writes a canvas version — matches sibling `deploy-app` |
| `feature.campaign-orchestration.nodes.setup-check` | `transform` (off-taxonomy) | `read` | reads the brief and reports what is missing; "auto-resolves" means `missing: []`, **not** a write — checked in source |

`apply-repair` was flagged as a candidate defect of the blob-put class and
**cleared**: it writes through `updateCanvasForTenant`, the host's *own* store,
which shares a transaction boundary with the durability record. Recorded because
an unresolved suspicion reads as a finding.

**Phase 2 (implemented).** The floor as a per-typeId discharge assertion, shaped
as a **ratchet** rather than a hard failure.

The served set has exactly **two** arms, per the ruling: the ADR 0341 fast path
and the ADR 0326 invocation log. A guarded-seam throw is a backstop and is
recorded separately. Measured against `main`:

| | |
|---|---|
| floor | 279 |
| served — fast path | 31 |
| served — invocation log | 24 |
| **undischarged** | **214** |
| unresolved (a human must classify) | 10 |

**Why a ratchet.** 214 undischarged typeIds means a hard build failure is a gate
nobody can land through, and a gate that gets disabled in a week is worse than
none. The baseline may only shrink.

**The three conditions the steward set, and how each is met:**

**(a) Build-only, never runtime.** The baseline lives in `docs/steward/`, outside
`backend/typescript/src`, so a runtime import is structurally awkward rather than
merely discouraged — and `test/served-set-baseline-build-only.test.ts` asserts no
file under `src/` references it. An entry means *"not yet served"*, **not** *"may
execute during a replay"*; at runtime the node still reaches a seam and throws.
Wiring it into the executor would rebuild the fail-open allowlist that started
this, and would look like progress while doing it.

**(b) Bucketed, not 214 opaque ids.** This is the steward's correction of my own
proposal: I rejected a 257-row exemption list as a rubber stamp and then proposed
a 240-row baseline — *the name change was doing the work*. A reviewer cannot
check 214 ids; they can check "14 moved from `needs-fast-path-classification` to
served".

**(c) The exit condition is in the file.** The baseline reaches zero, the
`recorded-outcome` advertisement returns **true by construction rather than by
census**, and the file and its check are deleted together. A ratchet with no
terminus is a monument that happens to be machine-readable.

**Plus the instrumentation, which is the failure mode a ratchet actually has.**
An exemption list rots by *growing*; a ratchet rots by *not shrinking* — 214,
213, 212, stall, green forever. Every could-not-fail gate this program found
failed loudly once someone looked; **a stalled ratchet never looks wrong.** So
`--check` prints the bucket counts on every run, pass or fail, and the check
fails on an **unrecorded shrink** as well as on growth — otherwise progress goes
unrecorded and the next growth is measured against a stale floor.

### How the buckets are derived — and what three wrong attempts cost

By reading each node's **function body**, never its name.

1. **typeId regex** (`/generate|classify|extract/`) — the exact trap that filed
   `core.db.sql-query` as a read on the strength of the word *query*. Caught and
   discarded before use.
2. **"does this pack call AI"** — code-derived but far too coarse: 20+ packs hold
   one AI-calling node, and that does not make its siblings AI-served.
3. **typeId → exported fn → read the body** — correct, and it took three parser
   fixes to work: arrow consts, **factory indirection**
   (`export const themeAnalyze = makeAiGenerator(…)` has no body of its own), and
   inline factory-call mappings (`'core.db.nosql-find': delegate('nosql','find')`).
   Unresolved went **107 → 62 → 10**.

Every one of those waves was **this parser, not a gap in the packs**. Reporting
the first 107 as unclassifiable would have been a finding about a regex dressed
as a finding about the codebase. The surviving 10 are kept as their own list and
never folded into a bucket — a node the generator cannot read is one a human must
classify, and defaulting it is how a ratchet starts lying.

### The parse has no independent confirmation — recorded, not resolved

Stated plainly so the ratchet's provenance is not read as stronger than it is:

- the bucketing is **derived from code**, not identifiers, which rules out the
  `sql-query` class of error;
- it has **no independent confirmation**. `107 → 62 → 10` is a sequence of *my
  own* parser defects, each invisible until the next fix exposed it. That is
  evidence of three fixes and says nothing about a fourth;
- the **10 unresolved are explicit**, so the known blind spot is visible rather
  than silently bucketed.

The spec steward proposed the declared dispatch-shaped fields
(`fallbackModel`, `requiredModelCapabilities`, `requiredCredentials`, `auth`,
`requiresSecrets`) as an independent oracle. **Measured: 6 of 736 nodes populate
any of them; three of the five are populated on ZERO.** Cross-checking the 269
resolved typeIds produced *zero disagreements out of a sample of two* — which is
not validation, it is an oracle silent on 99.3% of its population. Reported that
way rather than as "0 disagreements ✓", where the denominator does all the work.

### P3 candidate — the mock-provider seam, and its one dangerous default

The better instrument, because it is **authored by the harness rather than by
this parser** and observes a real run: stage a mock-AI program for a node
(`host-sample-test-seams.md` §5 — honoured deterministically by attempt index,
callable before the run), execute, and see whether an entry was consumed.
Consumption is a positive fact about the wire, not an inference.

**The asymmetry must be designed in from the start** (the steward's catch):

```
entry CONSUMED      -> the node reaches the provider           sound
entry NOT consumed  -> it did not reach it ON THIS INPUT       NOT "never"
```

A node with a conditional AI path — cache hit, short-circuit on empty input, a
branch that only calls the model past a confidence threshold — consumes nothing
on one input and consumes on another. **Non-consumption MUST resolve to
`unresolved`, never to a bucket.** Filing it as *fast-path* would move
conditional-AI nodes onto the mechanism that kills RFC 0041 §B divergence
detection — the exact hazard P2 exists to prevent, arriving through the
instrument built to prevent it.

Presence is binding; absence is silent. That is now the same rule for three
independent instruments: `role`, the declared fields, and this seam.

Practical note: attempt-index determinism means a **two-entry** program yields
the original-run and replay observations from one fixture, and the replay
observation is the one P2 actually cares about.

**Phase 3 (implemented 2026-08-17).** Wire the derived floor into the classifier
— which is Alternative (A) below, the "additional union in Phase 2" this ADR
already wanted, executed once the steward's ruling removed the only objection to
it.

`scripts/gen-side-effect-floor.mjs` now emits a **second** set,
`MANIFEST_FAST_PATH_SERVED`, and `isSideEffectingNode` consults it **first**.
That is the change requirement 4 was actually asking for: a pack node is
protected by **its own declaration**, not by somebody remembering to add a
regex. The hand-list is retained — it still covers the in-tree conformance nodes
(`conformance.effect.emit`, `core.conformance.side-effect`), which have no pack
manifest and which the RFC 0140 scenario probes by typeId — but it is no longer
the primary mechanism.

| | before | after |
|---|---|---|
| floor | 279 | 280 |
| served — fast path | 31 | 212 |
| served — invocation log | 24 | 25 |
| **undischarged** | **214** | **43** |
| unresolved | 10 | **0** |

**The served set is the floor MINUS four subtractions, and each one leaves the
node UNDISCHARGED and counted — never exempt.**

| subtraction | n | why |
|---|---|---|
| reaches `ctx.callAI` | 25 | arm 2 IS its discharge; fast-pathing it would stop `module.execute` and kill RFC 0041 §B divergence injection |
| reaches a capability that MAY resolve through the invocation log | 23 | `agentRuntime`, `aiEnvelope`/`promptLibrary`, `guardrails`, `subWorkflow`. Held back because fast-pathing them could destroy a §B discharge this analysis cannot see — NOT because they are "AI-ish" |
| `role: gate` / `streaming-output` | 20 | semantics this ADR records as open, not guessed — see below |
| the build cannot read it | 0 | the P2 residue, CLOSED — see the parser note below |

(Counted from the ratchet, which is the register. The floor generator's own
header holds back a slightly larger set — 74 — because the retained hand-list
still classifies a handful of nodes the derivation declines; arm 1 is the union
of the two, which is exactly what `isSideEffectingNode` evaluates.)

**The P2 residue closed, and by fixing the parser rather than by ruling on the
nodes.** All ten `unresolved` entries were ONE shape the brace-matcher could not
see — the expression-bodied arrow:

```js
export const metricCounter = (ctx) => recordMetric(ctx, 'counter');   // core.obs.metric-*
const decl = (kind) => async (ctx) => ({ … });                        // core.agents.memory-*
export const personaPublish = (ctx) => applyOrPublish(ctx, 'publishPersona', …);
```

`bodyOf` required a `=> {` to brace-match, so each read as "fn not resolvable".
Returning the expression text instead lets the transitive walk follow the call,
and all ten resolve with no AI reach — spot-checked in source, not inferred:
`applyOrPublish` writes through `ctx.brand[op]` (a real host write, no model),
and `decl('memory')` returns a config object. `unresolved 10 → 0`.

This is the **fifth** parser wave, and P2's warning — "evidence of three fixes
says nothing about a fourth" — now says nothing about a sixth. What makes that
tolerable here and not before is the direction: eligibility is POSITIVE
(readable AND no AI reach), so a node this parser reads WRONG still has to clear
"no AI capability anywhere in its reachable text" before it can be served. A
sixth defect lands on `held back`, not on `silently fast-pathed`.

**Why `gate` and `streaming-output` are held back rather than swept in.** A gate
suspends; "serve the recorded outcome" for a node that reached no terminal
outcome in the source is requirement 3's question, and answering it by
fast-pathing every HITL gate changes suspend semantics across the whole
approvals surface. `streaming-output` is the case §"The open question" named
outright — "working out what the fast path serves for a `streaming-output`
node". Serving only the terminal outcome drops the frames the source emitted, so
the replay's event log is **not** byte-equivalent: that trades one §C.2
violation for another. Both are a later phase, and holding them costs only a
number in the register.

### A DELIBERATE widening past the set requirement 4 binds

Requirement 4 binds `role: "side-effect"`. **The served set is wider than that on
purpose**, and the ratchet now prints the breakdown so the judgement is visible
without diffing 212 ids:

| role | served | |
|---|---|---|
| `side-effect` | 186 | the set requirement 4 binds |
| `action` | 25 | **deliberate widening** |
| `streaming-output` | 1 | `core.openwop.a2a.send-and-stream`, pre-existing via the retained hand-list |

This is the direction requirement 4 explicitly permits — *"it may classify
additional nodes as side-effecting, and it MUST NOT classify fewer"* — and it is
recorded here because the alternative reading ("bind exactly what the spec
binds") is the more conservative-sounding one and would have been the easier
thing to write down.

**Why widening is right for these 25.** Most are outward writers whose replay
re-firing is the exact harm this ADR exists to prevent: `ads.publish.{google,
meta,tiktok}`, `ads.{image,video}.generate` (metered), `landing.page.publish`,
`feature.crm.nodes.gmail-sync`, `feature.job-search.nodes.run-campaign`,
`feature.app-builder.nodes.{deploy-app,apply-repair}`,
`feature.dealers.nodes.approve-registration`,
`feature.sales-commissions.nodes.{approve-statement,compute-statement}`,
`feature.territories.nodes.{activate-model,set-quota}`,
`feature.strategy.nodes.{check-in,record-decision,sync-metrics}`,
`feature.priority-matrix.nodes.{add-evidence,propose-scenario,update-intake}`,
`feature.computer-use.nodes.{decide,task}`. They carry `side-effectful` under
`role: action`, and serving them the recorded outcome IS the protection.

The two exceptions are `knowledge.retrieve` and `knowledge.augment-prompt`,
which are reads. Over-including a read costs **only divergence detection for
that node**, and divergence detection over a read is not information anyone
acts on — so the cost is nil and the consistency is worth more than the
exception.

What is NOT widened: `gate` and `streaming-output` as classes, for the
semantics reasons below. The widening stops where the semantics stop being
understood, not where the spec's binding text stops.

### Mid-phase correction — "AI-ish" was the wrong test, and a sabotage found it

The first cut of P3 held back **every** AI-ish capability on a refuse-to-decide
hedge. Two defects fell out of it, and both were found by a sabotage that
**failed to apply** rather than by review:

**(1) A blind spot that produced the RIGHT answer for the WRONG reason.** The
attempted sabotage was "hand-add a floor member the generator holds back"; it
asserted the target was not already served and **the assertion tripped**. Six
`core.openwop.ai.*` media nodes were in the served set while the ADR text said
they were held back. Cause:

```js
function delegateProvider(method) { const fn = ctx[method] ?? …; }
export const imageGenerate = delegateProvider('callImageGenerator');
```

The capability name is a **call-site string argument** and never appears in the
resolved body, so the reach analysis scanned them as touching no AI capability
at all. The outcome was correct — serving a metered media node is exactly
requirement 2 — but the reasoning was empty, and the identical shape would hide
a `callAI` reach and fast-path a node that must stay live. That is the failure
direction P3 claims to have designed out. Fixed by carrying the factory's
arguments into the reach text.

**(2) The hedge itself was wrong.** Holding a typeId back only helps when a
SECOND discharge exists for it to fall to. For `ctx.callAI` one does. For the
media providers and `callAIWithTools` there is **none** — neither reads or
writes the invocation log — so holding them back protected nothing and left a
replay throwing where requirement 2 says it must reproduce. The test is not "is
it AI-ish" but **"would fast-pathing this destroy a discharge I cannot see"**.
`NOT_INVOCATION_LOGGED_AI` now names the eligible ones explicitly.

**(3) And the prefix bug reappeared one layer down, in my own fix.** The opaque
filter used `text.includes(cap)`, so `'callAI'` matched `callAIWithTools` and
parked `core.ai.toolCalling` as undischarged — the exact defect this phase was
written to correct, in the code correcting it. Conservative rather than
dangerous that time, which is how a prefix bug survives a review. Matching is
now boundary-aware.

Net: `undischarged 47 → 43`, with the media class served for a stated reason
instead of by accident.

**The failure direction is the design, and it inverted at this phase.** Before
P3, a node the parser mis-read landed in `undischarged` — safe (the ADR 0531
seam throws) and visible. After a union, a mis-read node could land on the fast
path — never executed, divergence detection silently retired. So the eligibility
rule is **positive**: a typeId is served only if the analysis can read it AND
sees it touching **no** host AI capability. Anything else is held back.
`scripts/lib/packNodeReach.mjs` states this in its header, because a future
reader tempted to "improve" the predicate needs to know which way it is
deliberately conservative.

**Why the advertisement is still NOT restored, stated as four separate
blockers rather than one number.** `undischarged` reaching 47 is progress, not
the exit condition, and even at zero the advertisement would need more than
this file says:

1. **43 undischarged floor typeIds can still fire.**
   Requirement 5 is whole-run: "a host MUST NOT advertise `recorded-outcome` if
   any class of side-effecting node in its catalogue can still fire during a
   replay."
2. **The floor is manifest-only by construction** (P1's scope note), and
   requirement 5 binds the whole **catalogue**. A programmatically-registered
   side-effecting node without the module flag is outside this census entirely.
   The exit condition as P2 wrote it — "the baseline reaches zero ⇒ the advert
   returns true by construction" — is therefore **necessary but not
   sufficient**, and this is a correction to that line.
3. **Requirement 6(b)** demands a default-deny guard at **every** host effect
   seam. A served-set census cannot witness seam coverage; that is a different
   instrument and it is the H20 residue row's own reason class.
4. **The `ai-opaque-not-invocation-logged` class is the sharpest of these** —
   `core.agents.run` and the `aiEnvelope` nodes reach AI through a host
   capability this analysis cannot follow, so they are held back and a replay
   of one THROWS at the backstop rather than reproducing. That is precisely the
   posture the spec names "safe and non-conformant", and it is 23 typeIds wide.
   (The metered media nodes were named here in an earlier draft; P3's
   mid-phase correction moved them to SERVED, which is the conformant answer —
   see below. Correcting rather than deleting, because the earlier claim was
   published to the team.)

**P4 candidate, and why it is not this phase.** Decide the AI/non-AI split at
REPLAY TIME from the source run's own `provider.usage` events — they carry
`nodeId`, and the fork path already loads `srcEvents` — so the split becomes an
observation of the actual run rather than a parser inference, and per node
INSTANCE rather than per typeId. Rejected for now on the same asymmetry the
steward caught on the mock-provider seam: `emitProviderUsage` returns early when
token counts are absent, so **absence of the event is not proof of no AI call**.
Building the split on a silent-absence signal would move the hazard from a build
script into the executor. Presence is binding; absence is silent — for a third
instrument.

## Alternatives weighed

- **(A) Consult the manifest live inside `isSideEffectingNode`.** Rejected as
  the *primary* mechanism: it is an executor→host dependency, and an unwired
  provider would silently yield an empty map. Still wanted as an *additional*
  union in Phase 2 for packs installed after build — a snapshot cannot see those.
  **Phase 3 note:** the union landed against the committed SNAPSHOT, not a live
  manifest read, so this rejection stands as written and the residue is
  unchanged — a pack installed after build is still invisible to the classifier
  and still relies on the ADR 0531 backstop.
- **(B) Derive allowlist regexes at pack-load time.** Rejected: the drift moves
  from a hand-written list to a hand-written *derivation*, and the result is
  invisible in review. A committed snapshot is a diff a human reads.
- **(C) Snapshot + build gate, wiring deferred.** Chosen. It closes the
  "nobody classified it" hole immediately without guessing the discharge
  semantics.
- **Union everything into the fast path now.** Rejected on evidence — it breaks
  RFC 0041 §B, see above.

## What this explicitly does NOT claim

The generated module's FLOOR set is **not protection** — it is membership, and
citing membership as coverage is the error P1's header exists to prevent.

**Corrected at Phase 3:** this section used to say the generated module as a
whole was not protection, "the SSoT the Phase 2 gate will consume". Half of it
now IS protection: `MANIFEST_FAST_PATH_SERVED` is what `isSideEffectingNode`
reads, and a typeId in it is genuinely short-circuited and served on a replay.
The claim that does NOT hold is the wider one — **43 floor typeIds are held back
from that set and remain undischarged**, so floor membership still says nothing
about whether a given node's replay reproduces. A green on the snapshot suite
means the derivation and the wiring are honest, not that requirement 4 is
discharged.

The original warning still binds in the other direction: a generated file that
nothing consumes is indistinguishable from a gate that cannot fail, and this
program has produced seven of those. So the P3 wiring is asserted, not assumed —
`gen-served-set.mjs` refuses to run if `sideEffects.ts` stops consulting the
generated set, and the snapshot suite fails if any served typeId is unclassified.

## Implementation record

| item | where |
|---|---|
| generator + `--check` | `scripts/gen-side-effect-floor.mjs` |
| snapshot | `backend/typescript/src/executor/sideEffectFloor.generated.ts` |
| CI wiring | `scripts/ci.sh` |
| tests | `backend/typescript/test/side-effect-floor-snapshot.test.ts` |
| P2 generator + `--check` | `scripts/gen-served-set.mjs` |
| P2 baseline (build-only, outside `src/`) | `docs/steward/SERVED-SET-BASELINE.json` |
| P2 CI wiring (prints bucket counts every run) | `scripts/ci.sh` |
| P2 build-only invariant | `backend/typescript/test/served-set-baseline-build-only.test.ts` |
| manifest roles | the four rows above |
| P3 reach analysis (shared by both generators) | `scripts/lib/packNodeReach.mjs` |
| P3 served set + classifier wiring | `sideEffectFloor.generated.ts` → `executor/sideEffects.ts` |
| P3 tests | `backend/typescript/test/side-effect-floor-snapshot.test.ts` |
| P3 `servedByRole` breakdown (printed every run + recorded in the baseline) | `scripts/gen-served-set.mjs` |

**Phase 3 sabotage — every guard broken, and each verified for EFFECT:**

| sabotage | result |
|---|---|
| an invocation-log typeId (`core.openwop.ai.classify`) added to the served set | §B guard red — "fast-pathing it kills RFC 0041 §B divergence injection" |
| …and the same hand-edit run past the generator | `gen-side-effect-floor --check` red, "snapshot is stale" |
| `MANIFEST_FAST_PATH_SERVED.has(typeId)` deleted from `isSideEffectingNode` | 2 tests red **and** `gen-served-set --check` exits 1 ("the derived set is not wired into the classifier") |
| one served anchor (`core.storage.table-insert`) removed from the served set | "the union ADDS coverage" red |
| 5 served typeIds dropped (ratchet GROWS) | `--check` exits 1, `47 -> 52` |
| baseline counts forced stale (unrecorded SHRINK) | `--check` exits 1, `99 -> 47` |
| the reach analysis forced to classify everything as arm 2 (served set → empty) | generator exits 1, refuses to write |
| the P3 expression-arrow parser branch disabled | `gen-side-effect-floor --check` exits 1 (stale); regenerating past it, `gen-served-set --check` exits 1, `unresolved 0 -> 10` |
| restored | both generators `--check` rc=0, `tsc --noEmit` clean, 11 replay/effect/advert suites green (91 tests) |

**One sabotage exposed a sequencing fact worth stating, because I assumed the
wrong guard first.** Disabling the parser branch and running ONLY
`gen-served-set --check` came back **green**. Not a broken gate — the ratchet
reads arm 1 out of the committed generated file, so a reach-analysis regression
is invisible to it until the floor snapshot is regenerated. The floor `--check`
is the first line of that chain and the ratchet is the second, and **`scripts/ci.sh`
runs both** (lines 147 and 163). Neither alone is sufficient; do not "simplify"
by dropping one. Found by running the sabotage against the wrong gate and
believing the green for about a minute.

**The first attempt at the anchor sabotage did NOT sabotage, which is the
finding — again.** `core.storage.table-insert` appears in THREE sets in the
generated file, and a `perl` one-liner removed the first occurrence, which is in
`MANIFEST_SIDE_EFFECT_FLOOR`. Two tests reddened, so it *looked* verified; but
neither was the test under examination. Only a targeted edit inside the
`MANIFEST_FAST_PATH_SERVED` block exercised the intended path. This is exactly
P2's recorded lesson — "a mutation that lands but changes nothing produces a
green that reads as proof" — repeated by the person who wrote it down, with the
variant that a mutation landing on the WRONG target produces a RED that reads as
proof.

**A guard caught the author, unprompted.** The P2 build-only invariant went red
during P3 because a doc comment in the generated file mentioned the baseline's
FILENAME — the check matches it "in any spelling", comments included. That is a
non-vacuous demonstration of a guard nobody sabotaged on purpose.

**Sabotage-proven:**

| sabotage | result |
|---|---|
| a node's role removed | generator exits 1, names the node |
| role typo'd to `"side_effect"` | generator exits 1, names the node |
| a new `side-effect` node added, snapshot stale | `--check` exits 1 |
| snapshot hand-shrunk (`core.storage.blob-put` deleted) | 2 tests red |
| restored | generator + `tsc` + 41 tests green |

**Phase 2 sabotage — and the two that did NOT sabotage, which is the finding:**

| sabotage | result |
|---|---|
| a floor node loses its classification (ratchet GROWS) | exits 1, `214 -> 215` |
| a node becomes served but the baseline is not regenerated (unrecorded SHRINK) | exits 1, `214 -> 211` |
| the baseline referenced from `src/` | build-only test reds |
| restored | green |

The shrink case took **three attempts**, and the first two returning `rc=0`
looked exactly like a check that cannot fail. Neither was: the first mutation
never applied (a silent `str.replace` no-op), and the second applied but targeted
`core.openwop.files.` — the pack **directory** name, not the typeId prefix — so
zero floor nodes matched and nothing moved. Only the third, using typeIds read
out of the baseline itself, exercised the path.

**A sabotage must be verified for EFFECT, not just for application.** A mutation
that lands but changes nothing produces a green that reads as proof.

The last row matters most: the snapshot cannot be edited to shrink the floor,
because the test re-derives it from the manifests rather than trusting it.

## Wire

None. Host-internal classification and a build gate. No RFC needed.
