# ADR 0599 — Insights & Drafting: honest first, then runnable

Status: implemented

> **Scope.** PR-A of the feature-27 (`insights-suite`) remediation. It closes the
> fabrication class, builds the execution witness the feature never had, repairs the
> wiring, and replaces a disarm posture that was backwards in both directions — **in
> that order, which is itself a finding** (§2). PR-B takes the remaining UX and
> observability rows; every one of them is named in §9.

## 1. Context

`insights-suite` has been **non-functional since the ADR 0082 rebuild** (2026-06-20).
Three independent assessments (`docs/steward/{CODEBASE,WORKFLOWS,UX}-ASSESSMENT.md`,
feature 27/71) graded it **D/D/D** and converged on the same headline from three
different directions: all three meta-workflows fail `invalid_config` at their **first**
node on every fire, and the two pure-compute nodes downstream would, once that was
repaired, **report a confident verdict computed from zero data under
`status:'success'`**.

Because the feature ships toggle-OFF and has no frontend, nobody had hit it. 790 lines
of tests across 8 files were green over a feature that could not execute.

The doctrine posture was and remains **exemplary** — real RFC 0013 chain pack, real
loader, `chainId`-only registrar, per-chain versioning honoured, zero `builtinWorkflows`
pin sites. The shape was right and the content did not run.

## 2. Decision — the ORDER is load-bearing

**Guards first, then the witness, then the wiring.**

Repairing the wiring first would have converted two silent no-ops into two confident
fabrications. Today `variance-compute` and `talent-score` are never *reached* — the run
dies upstream — so their fabricated outputs are unreachable. The moment the source nodes
get their config, both execute, and both would emit a defensible-looking answer from an
empty input set: one of them **confidential-PII about a named human being, broadcast
tenant-wide, and reachable a second way through the chat agent tool**.

The witness sits between them for a second reason: `ISC-1` was proved on
**negative-search evidence, not execution**. Building the witness before the fix is what
made the finding falsifiable. It did not falsify — see §4.

## 3. Step 1 — the fabrication guards

Both defects were **reproduced before being fixed**, by calling each node with exactly
what its chain delivers:

```
variance (bigquery outputs as ctx.inputs): {"status":"success","outputs":{…,"verdict":"on_plan"}}
talent   (workday outputs + subjectId):    {"status":"success","outputs":{…,"box":1,
                                            "label":"Underperformer","readiness":"not_ready"}}
```

`clamp13(undefined)` went `NaN → null → 0 → Math.max(1,…) → 1`, so **absence and the
worst possible rating were the same value**. `verdict: flagged.length === 0` conflated
"checked and clean" with "checked nothing", and the tie broke toward the reading that
suppresses action.

**The rule the file already knew and applied to one node and not the other** is written
30 lines above the bug: `// metric not provided — skip, don't fabricate`. A missing input
is a typed failure or an explicit skip, never a substituted default indistinguishable
from a real answer. Out-of-range **clamping of a value the caller actually supplied**
stays legitimate and is now asserted separately, because the old test pinned that
coercion as the contract and `clamp13` applied the same coercion to absence — which is
precisely why nobody ever asked what an absent rating does.

Both nodes additionally accept the tabular `rows` shape their source nodes really emit,
so a chain can wire source → compute without a transform node that does not exist. An
unrecognized shape yields an empty bag and therefore the typed failure, never a verdict.

Pack `1.0.0 → 1.1.0`, with `requiredPacks`, the per-node versions and the steward
manifest moved in lockstep.

| Witness | Sabotage | Result |
|---|---|---|
| `variance-compute` zero-metric guard | `if (Object.keys(variances).length === 0)` → `if (false)` | **exactly 1 red** |
| `talent-score` absence guard | `clamp13` restored to `?? 0` | **exactly 1 red** |

### §Correction 1 — the guards fired on `undefined` and on nothing else (pack 1.2.0)

**Everything above is true and it closed one absence shape out of five.** The
reader underneath both guards was `Number()`, and

```
Number(null) === Number('') === Number('   ') === Number(false) === 0
```

so `clamp13` "returning `null` when `num()` returns null" was **theatre for every
absence a warehouse actually emits**, and the aggregate variance guard could not
fire because *a bag of coerced zeros is not an empty bag*. Reproduced by executing
the shipped 1.1.0 pack:

```
talent  rows [{performanceRating:'', potentialRating:''}] → success, box 1, 'Underperformer', not_ready
talent  rows [{performanceRating:' ', potentialRating:false}] → the same
variance rows with NULL cells                              → success, verdict 'on_plan'
variance every plan 0                                      → success, verdict 'on_plan'
```

`mapBigQueryRows` (`bootstrap/nodes.ts`) writes the REST cell value straight
through, so a SQL NULL arrives as literal `null`. **A warehouse of NULLs said
"we're fine" and carried a human red-team approval signature** — and §5's
`pull.rows → score.rows` edge, added by this PR, is what made it reachable.

**Why the §4 witness missed it: `PROBE-IS-2` stubs the broker with
`{data:[], rows:[]}` — an EMPTY ROW SET, which is the one absence shape 1.1.0
could see. Production produces ROWS WITH ABSENT VALUES.** The distinction is the
whole finding, so the new probe is separate (`PROBE-IS-3`), not folded in.

The cure is an absence-strict reader (`measure()`) used on the whole data path —
**not** a blanket retightening: it is applied where absence must not become a
value, it rejects `null`/blank/whitespace/boolean **before** any coercion, and it
still parses numeric **strings**, because the BigQuery `jobs.query` REST wire
returns every cell as one. Cells that fail it drop out of `metricBag` /
`readRating`, so the existing 1.1.0 guards fire as their comments always claimed.

**And the explicit decision the review asked for: `pct === null` for every
evaluated metric is NOT `on_plan`.** A zero plan yields no percentage, so such a
metric can never be flagged and contributes nothing but false reassurance —
`flagged.length === 0` was "checked and clean" again, one layer in. A `SUM(plan)`
over a table with no plan rows returns **0, not NULL**, so this is the shape an
unloaded plan really takes. A whole read of zero-plans is now `insufficient_data`;
a mixed read keeps its verdict and names `metricsUncomparable`, on the same
"the verdict is only ever as wide as the metrics behind it" rule as
`metricsMissing`. *(Residual: a verdict of `on_plan` over one comparable metric
and three uncomparable ones is still narrow — it is surfaced, not refused.)*

| Witness (all through a REAL chain run, `PROBE-IS-3`) | Sabotage | Result |
|---|---|---|
| `measure()` — NULL/blank actual cells against real plans, both nodes | `measure()` restored to `Number()` + `isFinite` | **exactly 2 reds** (one per node) |
| zero-plan guard | `if (uncomparable.length === …)` → `if (false)` | **exactly 1 red** |
| `ambiguous_data` (§Correction 4) | `if (seen.length > 1)` → `if (false)` | **exactly 1 red** |
| `unknown_scale` (§Correction 4) | `if (n < RATING_MIN \|\| n > RATING_MAX)` → `if (false)` | **exactly 1 red** |

**A FOURTH vacuous assertion of mine, caught by that first sabotage.** The probe
was first written with all-NULL rows — the literal reproduction — and it stayed
**green** under the `measure()` sabotage, because coerced zeros then made every
plan 0 and the *zero-plan* guard caught it instead. The assertion existed and
measured a different mechanism than the one it named. The `measure()` witness is
now the shape only `measure()` can catch (**NULL actuals against real plans**,
where `Number()` fabricates a −100% collapse reported as a successful `off_plan`
verdict); the all-NULL reproduction is kept as a second case, labelled with which
guard actually holds it. *That is three vacuous assertions found by sabotage in
this PR and one found by review — assume a fifth.*

A fifth sabotage (row ratings clamped instead of `Math.round`ed) came back
**green**, correctly: the `unknown_scale` guard makes the two identical over the
surviving domain. Recorded rather than dropped, because a green sabotage that
proves *unreachability* reads exactly like a vacuous witness and is not one.

Pack `1.1.0 → 1.2.0`, with `requiredPacks`, per-node versions and the steward
manifest moved in lockstep.

### §Correction 4 — `ratingFromRows` placed a named person from an arbitrary row

Two more defects in the same node, both of which survived §3 because §3 was
reasoning about *absence* and these are about *provenance*:

- **The first matching row won.** A `performanceReviews` pull returns **one row
  per review cycle**, in collection order, with no recency field this node is
  entitled to trust — so "the first row carrying a rating" presented an arbitrary
  cycle as the person's current rating. It now collects every distinct value for
  the subject and returns a typed `ambiguous_data` when they disagree. Identical
  values repeated across cycles are not a conflict.
- **`clamp13` guessed a scale.** §3 justifies clamping *"a value the caller
  actually supplied"* — the caller asserted this node's 1–3 contract and
  overshot it. **That does not transfer to a scraped column whose scale the node
  cannot know**: on a 1–5 scale, clamping maps 4 and 5 onto the top band. So a
  *supplied* rating is still clamped, and a *row-derived* rating outside 1–3 is
  `unknown_scale` — a refusal, not a coercion. The outputs now also carry
  `performanceRaw` / `potentialRaw` / `ratingSource` so a reader can see what the
  source said beside what the node scored.

**Not fixed, and named as a residual (§9): a 1–5 source value of 1, 2 or 3 is
still indistinguishable from a 1–3 one** — a mid `3` reads as the top band. That
needs a *declared* source scale. A `config.ratingScale` knob was considered and
**rejected**: nothing in either chain would supply it, and a documented mechanism
with no reader is the exact defect this ADR retired `instanceUrlTemplate` for.

**One further hole closed in passing:** an explicit rating that is not a
measurement (an unfilled `{{params.x}}` frozen to `''` — the ADR 0507 class) no
longer **shadows** the rows. It falls through, so a decorative parameter cannot
starve a chain whose data is fine.

## 4. Step 2 — the execution witness

`backend/typescript/test/insights-chain-execution.test.ts`.

`PROBE-DOC-4` had already been written for this exact class ("connectedness is not
runnability"), then scoped to `feature.documents.nodes.*` — the one instance already
removed — and **its own comment conceded it was "vacuously green."** It stayed vacuous
while five live instances sat in the same three chains.

### The Step-2 red, as it stood before any wiring change

```
× weekly-variance    query:      failure invalid_config — core.bigquery.query requires config.sql (or inputs.sql).
× talent-prep        pull:       failure invalid_config — core.workday.query requires config.baseUrl (…).
× anniversary-draft  milestones: failure invalid_config — core.workday.query requires config.baseUrl (…).
× PROBE-IS-2         wv.compute is UNDEFINED — the chain never reaches the node whose guard Step 1 built
✓ PROBE-IS-0         the pack IS dispatchable through the trust gate
```

**`ISC-1` was NOT falsified.** It is now witnessed by execution rather than by a grep.

Two rules keep the witness from becoming another mechanism test:

1. **The variable bag may contain only values a real launcher could pass.**
   `maximalLaunch()` fills every property the chain declares and nothing else; both
   `parameters` blocks are `additionalProperties:false`, so that is provably the most
   any caller can supply.
2. **Node implementations resolve through the trust-gated registry**, not a direct
   `import()` of `packs/…/index.mjs`. No prior insights test could tell a dispatchable
   pack from a revoked one (`ISWF-11` / `GEN-IS-3`); `PROBE-IS-0` can.

### The decision on widening, and the blast radius

`PROBE-DOC-4` is **un-narrowed, not preserved** — driven by a required-binding table with
an anti-vacuity floor so it cannot silently re-vacuum.

The rule is applied **corpus-wide** (`test/chain-required-config-census.test.ts`), and
the blast radius was **measured before it was enforced**:

> **6 of 179 chains across 58 packs** carry a starved required-config node.

Three are this feature's. The other three — `postmortem.draft-blameless`,
`seo.keyword-brief`, `support.email-triage`, all the same `core.email.draft` shape — belong
to features this PR does not own and are **quarantined by name, shrink-only, not silently
repaired**. A cross-feature edit smuggled into a scoped PR is how a "measurement" becomes
an unreviewed corpus change.

### §Correction 5 — that figure reproduces `PROBE-DOC-4`'s narrowing ONE LEVEL UP

**The "6 of 179 chains across 58 packs" line reads as a corpus figure and is not
one.** The algorithm reproduces exactly (58 / 179 confirmed), but the denominator
it should be quoted against is the one it never named: the corpus is **584
chain-node instances across 175 distinct typeIds**, and the hand-written table
matched **9** of them — **1.5%** — **five of the nine being this feature's own
nodes.** A number that small is a FLOOR over a named table. Quoting it as
coverage is `PROBE-DOC-4`'s own defect ("scoped to the instance, then read as the
class") committed one level up, in the very file written to close it.

**And the anti-vacuity floor could not have caught that**: `matched > 5` was
satisfied at 9, five of which were mine — the table could have covered nothing
but itself and still passed. The floor now counts matches on chains this feature
does **not** own, and the corpus denominators are carried in its failure message
so the next reader sees 15-of-584 rather than an unqualified "6".

**The table is widened by one row and the quarantine grows with it, in this same
commit** — a shrink-only gate whose table grows without its quarantine goes red
for every peer. `core.web.search: ['query']` finds **three** more dead chains,
one more than the review named:

| Chain | Node | Why it dies |
|---|---|---|
| `digest.topic-watch` | `search` | declares a `topic` PARAMETER and never binds it to `search.query`; its only upstream emits `{cron,timezone,isCatchUp}` |
| `outreach.researched-firsttouch` | `search` | upstream `core.trigger.event` → `{eventName,payload}` |
| `seo.keyword-brief` | `search` | same shape — this chain is now starved **twice over** |

`findFirstStringValue` does not rescue them: its nested pass reads only
`prompt|text|message|content|completion`, and a portless edge delivers the
upstream object under `input`. Verified by reading the fallback, not assumed.

**The review's third example is NOT a member, and the widening it implies would
have filed three false reports.** `campaign-journeys`' three `email-send` nodes
bind no `to` **because they receive one over a port-qualified edge**
(`recheck.email → welcome.to`), deliberately re-resolved after the approval gate —
the gate's own prompt says so. Two independent reasons they stay out: the census
now **models edges**, and `core.openwop.integration.email-send` fails the table's
own membership rule anyway (it has no early `invalid_config` return at all — it
forwards `undefined` to the adapter, which is a different defect class).

Edge modelling changes **zero** verdicts on today's corpus. That is stated rather
than sold: it is a false-positive guard installed before it is needed, so
`census()`'s *use* of it is deliberately **not** sabotage-witnessed, and the
helper it composes is witnessed directly on the campaign-journeys case instead.

| Witness | Sabotage | Result |
|---|---|---|
| the foreign-match floor | drop the `core.web.search` row | **2 reds** (floor + quarantine honesty) |
| the floor is not self-satisfiable | narrow the table toward this feature's nodes | **1 red** |
| quarantine is shrink-only | delete a quarantine entry | **1 red** |
| port-qualified vs portless edges | count a portless `to` as binding a key | **1 red** |
| `census()`'s edge term | delete it | **green — stated, not hidden** |

### A sabotage that found a hole in my own witness

Reverting `generate.content → emailDraft.body` to portless **passed, 5/5**. `draftId` is
still returned and the URL is still a draft URL over a *blank* draft, so both of my
assertions were theatre. The probe now reads the body the broker actually received; the
same sabotage yields exactly one red. *One sabotage proves one assertion — and it proved
the assertion I had was the wrong one.*

## 5. Step 3 — the wiring (and Step 5, scoped)

Every value the source nodes hard-require is now a chain **parameter bound as a
WHOLE-VALUE `{{params.X}}` on a top-level node `inputs` entry**.

**That position is not a style choice — it is the only lane that defers.**
`workflowChainPackLoader` materializes a whole-value `{{params.x}}` *input* into a
run-resolvable `{type:'variable'}` PortValue and **freezes everything else at expansion
time**, including all `config` and every embedded/mixed token. The boot expansion passes
no params, so:

- `config.to: "{{params.recipient}}"` would have frozen to the **empty string** → the node
  fails `invalid_config`, i.e. no better than today;
- `inputs.query: "exemplars for {{params.milestone}}"` would have frozen to
  `"exemplars for "` → the node **succeeds on truncated input**, which is the fabrication
  class this PR just closed, re-created one layer up.

The obvious authoring shape was the dangerous one.

Schema `default`s **do** reach `variables[].defaultValue` (measured on the expanded def),
and `seedRunVariables` falls back to `defaultValue` when a run supplies no inputs — which
is what makes `sql` / `exemplarQuery` / `draftSubject` deliverable on a scheduler-started
run with no inputs at all.

### `instanceUrlTemplate` — DECISION: retired, not implemented

ADR 0082 §Build-1 named the connection pack's `instanceUrlTemplate` as the mechanism
supplying `config.baseUrl`. It is declared in `examples/connection-packs/workday/pack.json`
and typed in `features/connections/connectionPackLoader.ts`, and **read by no code path**:
nothing substitutes `{instance}`/`{tenant}` from a stored connection, and nothing hands the
result to `core.workday.query`. Both Workday chains therefore failed at node 1 on every
fire from ADR 0082's own rebuild onward.

Implementing it means designing per-connection instance storage, a template resolver and a
node-side lookup — **a new host seam that deserves its own ADR**, not a line in this one.
The tenant REST base is now an explicit, required chain parameter (`workdayBaseUrl`): the
lane every other tenant-specific value in the chain format already uses — builder-visible,
per-tenant, replay-safe. ADR 0082 carries an **inline correction note** (not a rewrite), and
the node's docblock and `invalid_config` message no longer point readers at the absent
mechanism.

### Step 5 — the portless class, with the cure REJECTED where it is a no-op

Four of the seven defect-relevant portless `to`-sides are port-qualified **on both sides**:
`query.rows→compute.rows`, `pull.rows→score.rows`, `milestones.rows→retrieve.milestoneRows`,
`generate.content→emailDraft.body`.

**Both sides matter, and a bare `to`-side qualification would have made it worse.** The
value an edge forwards is the whole upstream outputs object, so `to:"compute.rows"` without
`from:"query.rows"` sets `rows` to the BigQuery *envelope*.

**The three `notify` to-sides are deliberately NOT qualified.** A resumed `core.approvalGate`
completes with `{output: <resumeValue>}` — an object — and `notifications/surface.ts`'s
`asText()` returns `''` for anything that is not a string. So `to:"notify.message"` sets
`message` to an object and the body stays empty: **a measured no-op**. Shipping it would have
been motion, and it would have made the row look closed.

> **§Correction 8 — "byte-identically the empty body" was OVERSTATED, and the mechanism
> is not the one this paragraph names.** A portless edge does not hand the downstream node
> an opaque blob: `buildNodeInputs` puts the upstream outputs on the `input` port, and
> `buildNodeCtxInputs` **unwraps and spreads** a port map that is exactly `{input: X}`, so
> the upstream outputs' KEYS land at the top level of `ctx.inputs`. **If an upstream ever
> carried a top-level `message` string, portless would deliver it and a bare to-side
> qualification would BREAK it.** That is why the rejection is *strictly stronger* than the
> alternative, and the ADR 0599 §8 #2 "both sides, or neither" amendment is confirmed
> correct — but the reason is the spread, not byte-identity.
>
> The body is empty today because of what sits on each **from**-side, which is not uniform:
>
> | Chain | from-side | Why `message` is absent |
> |---|---|---|
> | `weekly-variance` | `redteam` (`core.approvalGate`) | native return-and-resume completes `{output:…}`; no top-level `message` |
> | `anniversary-draft` | `approve` (`core.approvalGate`) | same |
> | `talent-prep` | `score` (`talent-score`) | **not a gate at all** — its outputs DO spread onto `ctx.inputs`, and simply contain no `message` key |
>
> So the paragraph's own reasoning covers two of the three. And its closing claim — *"the
> honest cure needs either a string output to bind or a produced-variable bag"* — is
> **false for `talent-prep`**, which has string outputs available right now
> (`score.label`, `score.readiness`). **Binding one is DECLINED on purpose, not deferred
> for want of a mechanism:** the chain emits at `audience:'tenant'` and the payload is
> declared confidential-pii, so `from:"score.label" → to:"notify.message"` would broadcast
> *"A. Person — High Performer"* workspace-wide. That is strictly worse than an empty
> body and it is `ISU-6`'s exact harm. The binding waits on `ISU-6`'s audience narrowing
> in PR-B — a scoping decision, not a missing primitive.

The honest cure for the two gate-fed notifications needs either a string output to bind or a
produced-variable bag, which is an additive RFC 0013 extension — recorded as a residual,
coupled to `ISU-6`/`ISU-7` in PR-B.

**A trap declined and worth recording:** adding a `compute → notify` sibling edge *would*
give the notification a real body, and it is exactly the ADR 0582 "43 approval gates that do
not gate" shape — an unconditional sibling edge into the effect node. Not done.

Also here: `rejectionPolicy:"block"` dropped (not a recognized value in either vocabulary,
silently coerced, inert on both gates); params marked `required` **so the demo seeder stops
minting copies into OFF tenants' builders** (see the correction immediately below); and
`VARIABLE_DEFAULTS` deleted — its justifying claim that the
loader does not propagate schema defaults is **false**, disproved by dumping the expanded
def (`workdayResource` already carries `defaultValue:'serviceDates'`).

### §Correction 3 — "a launch refuses instead of starving at node 1" was FALSE

That clause is struck. **No required-variable refusal exists anywhere in this host**, and
the repo already documents its own absence in three places:

- `host/variablesRuntime.ts:134` — *"else: absent … The runtime doesn't gate on `required`."*
- `routes/runs.ts:251-257` — ADR 0504 built a run-start refusal, **measured it, and
  deliberately did not ship it**: `seedWorkflows.ts` expands every chain with `{}`, so 114
  of 169 seeded chains carry unfilled required params and refusing would have broken two
  thirds of every tenant's gallery.
- `routes/workflows.ts:827-833` — a §Correction stating that exactly this enforcement
  **was reverted**, and that its error code `chain_missing_required_param` "exists nowhere
  in the codebase."

**Proved by execution** (empty bag, and again with the chain's declared defaults applied —
the most any bag-seeding cure could deliver):

```
anniversary-draft node1 core.workday.query  → invalid_config (requires config.baseUrl)
talent-prep       node1 core.workday.query  → invalid_config (requires config.baseUrl)
weekly-variance   node1 core.bigquery.query → invalid_config (requires config.projectId)
```

**The refusal is NOT implemented in response.** ADR 0504 already measured that
cross-feature change and rejected it, and re-litigating it inside a feature-27 PR is
precisely the "measurement turns into an unreviewed corpus edit" this ADR refuses
elsewhere. What `required` does do is real, verified and unchanged: it excludes the three
chains from `seedZeroConfigWorkflows` (`host/seedWorkflows.ts:58-61`), which is the whole
`ISWF-9`-half claim in §6. The meta test's comment carried the same false clause and is
corrected with it.

*This is the third instance in this ADR of the same class — a documented mechanism with no
reader (`instanceUrlTemplate`, `rejectionPolicy:"block"`, and now `required`). The tell is
identical every time: the claim is about what a field CAUSES, and nothing greps to a
consumer.*

Chain pack `1.1.0 → 1.2.0`; per-chain `weekly-variance 1.1.0→1.2.0`,
`anniversary-draft 1.0.0→1.1.0`, `talent-prep 1.0.0→1.1.0`.

## 6. Step 4 — the reconciliation lane

**The prescribed cure was verified before adoption, and it is correct only together with a
deletion the prescription states as an afterthought.** Adding `featureId` + a fire-time
resolve closes `ISC-10` and leaves `ISC-5` **entirely open**, because the destructive global
scan *is* `ISC-5`. So `teardownAllSchedules` and its listener are **gone, not supplemented**.

The posture was backwards in both directions at once:

- **Too wide.** `configs` is built with no `tenantOf`, so `configs.list()` was a repo-GLOBAL
  scan. `{status:'off', tenantOverrides:{'t-vip':{status:'on'}}}` — an operator deliberately
  keeping one tenant live — **deleted t-vip's job** while `resolveConfig` still reported
  t-vip enabled and `GET /config` still returned its cron. Recovery was manual by design and
  announced nowhere.
- **Too narrow.** The seam fires only on a change to the **global** `status` field, so
  `on → beta`, a narrowed `betaCohort`, and `tenantOverrides[t]={status:'off'}` — the only
  per-tenant disable that exists — fired nothing. Those tenants' crons kept firing and their
  webhooks kept starting BYOK-billed LLM runs, while their config route 404'd so they could
  not disarm it themselves.
- It could not report failure: every `deleteJob` was `.catch(() => undefined)` and it
  returned `all.length`, so total failure and total success produced an identical return
  value, log line and test assertion.

The replacement is `ScheduledJob.featureId` / `TriggerSubscription.featureId`, resolved
against the toggle for **that row's tenant** at fire/ingest time. *A gate on the CREATION
lane is not a gate on the USE lane.* Per-tenant, correct under every narrowing,
non-destructive (the row survives, so re-enabling resumes with no config re-save),
fail-closed on an unreadable toggle, and **additive** — absent `featureId` is every
pre-existing job and subscription, ungated.

Also closed in this lane:

| Row | Fix |
|---|---|
| `ISC-6` | `scheduleTimezone` validated at the boundary. The cron was guarded; the very next field feeding the very same parser was not, and its failure was worse — `applyConfig` persists FIRST, so a **valid** cron with a typo'd zone threw a `RangeError` out of `Intl.DateTimeFormat` **after** the write: a 500 the caller reads as a server fault, plus a phantom schedule. Validate every field before any write. |
| `ISC-6` sibling | The route now REFUSES to arm a cron with no `planSource.projectId`. The chain declares `projectId` required with no possible default and the scheduled lane's only source is that field, so accepting the cron writes a job whose every fire dies at node 1 forever. |
| `ISC-7` | `registerJob`'s by-value `{ok:false}` is honored. It was a bare `await`, so the route 200'd and the single ops line this feature emits asserted `scheduleArmed:true` for a job never written — worse than emitting nothing, because it defeats the investigation. |
| `ISWF-5` | The fire carries `inputs` from `planSource.projectId` + `businessUnits[0]`. `registerJob` has supported `inputs` since the KickTodo daily loop lost `enrollmentId` to this exact omission; `planSource` was read by **nothing** repo-wide before now. |
| `ISC-11` | The dead exported `putConfig` deleted — zero callers, one letter from `applyConfig`, and picking it re-creates the bug ADR 0081 P6 fixed. |
| `ISWF-9` (half) | All three chains now declare `required` params, so `seedZeroConfigWorkflows` no longer mints `wf.seed.*` copies into OFF tenants' builders. Asserted as a property, not a spelling. |

| Witness | Sabotage | Result |
|---|---|---|
| scheduler fire-time gate | `if (!enabled)` → `if (false)` | 2 reds (both toggle-narrowing cases) |
| trigger ingest gate | same | exactly 1 red |
| timezone boundary guard | `if (body.scheduleTimezone !== undefined)` → `if (false)` | exactly 1 red |
| zero-config property | `required: []` on `talent-prep` | exactly 1 red |
| acting-subject guard (§7) | `if (!actingUserOf(req))` → `if (false)` | exactly 1 red |

### §Correction 6 — `ISC-7`'s branch was unmeasurable, and it re-created `ISC-6`

The `ISC-7` fix honours `registerJob`'s by-value failure, and it threw **after**
`configs.put` — i.e. exactly the "a refusal that persists is worse than the bug it
replaced" defect that `ISC-6`, four lines of intent away in the same lane, exists
to fix. And **`if (!res.ok)` → `if (false)` produced 33 passed, 0 reds**: the
branch was unmeasurable in either direction.

**The claim that it is unreachable is HALF FALSE, and the false half is the one
that matters.** `schedule_horizon_exceeded` needs `firstFireAtMs`, which
`applyConfig` never passes — genuinely unreachable. `jobid_conflict` was believed
impossible "because `weeklyScheduleJobId` embeds the tenantId", and **that
reasoning is wrong**: `routes/scheduler.ts` accepts `body.jobId` **verbatim** and
registers it under the **caller's** tenant, so any authenticated tenant can squat
`insights-weekly:<victim>:<principal>`. The victim's every config save then 400s
— with their row already written, so `GET /config` advertises a cron that is not
armed and cannot be armed. Verified by building the squat and driving the real
route.

**Cure taken, and the two the review offered that were not.** *Register before
persisting* was rejected — it reorders reconciliation for the anniversary path and
merely mirrors the phantom (an armed job with no config row). *Roll back on
refusal* was rejected — it introduces a second failure mode (a rollback that
itself fails) to protect a write that never needed to happen. The cure is the one
`ISC-6` already established: **validate before any write.** The conflict
precondition is checkable up front, so it is checked up front, and the `!res.ok`
branch is retained and **relabelled a race backstop** — a squat landing between
the pre-flight and the register is a real if narrow window, and a by-value failure
must never be dropped again.

**The refusal has an exit**, which is what stops this cure from being the worse
one: clearing the cron takes the `else` branch, which removes the squatted row,
after which the save succeeds. That exit is in the error message.

| Witness | Sabotage | Result |
|---|---|---|
| squat pre-flight (`insights-suite-cron.test.ts`) | `if (prior && prior.tenantId !== …)` → `if (false)` | **exactly 1 red** |
| the pre-flight is BEFORE the write | `configs.put` moved back ahead of the pre-flight | **exactly 1 red** |
| the race backstop | `if (!res.ok)` → `if (false)` | **still green — stated, not hidden** |

That last row is the honest one: with the pre-flight in place, no deterministic
test can reach the backstop. It is a residual, not a witness, and labelling it as
such is the whole point — an unmeasurable branch presented as covered is how
`ISC-7` shipped in the first place.

*The squat itself is a wider exposure than this feature — `POST /scheduler/jobs`
accepting a caller-chosen `jobId` lets any tenant squat any feature's
deterministic job id. ADR 0379's guard blocks the CLOBBER, not the SQUAT. Recorded
as a residual for `/architect`; not fixed here, because it is not feature-27's.*

**Two of my own new tests were VACUOUS, and the ON case is what caught them.**
`getEffectiveConfig` returns `null` when an id has no **registered default**, and the gate
reads `null` as not-enabled — correctly, fail-closed. In a suite that never registers the
feature's `toggleDefault`, every OFF assertion therefore passed while measuring nothing.
Registering the real default made the ON case reachable, which then failed for a *second*
reason (a shared durable job store leaking a prior case's job into the daemon's count).
Both fixed, plus an explicit toggle-resolves anti-vacuity assertion.
`insights-suite-trigger.test.ts` carried the same latent hole and was repaired the same way.

### §Correction 7 — a THIRD vacuous test, on the scenario this section headlines

`insights-suite-toggle-and-resource.test.ts`'s *"a GLOBAL off does not fire, and
does not touch a tenant kept enabled by an override"* — the blast-radius case §6
leads with, the operator staging a rollback who deliberately keeps one tenant live
— **never asserted that the exempt tenant fires.** Every assertion in it was
negative (`t-global-off` fired 0) or structural (`t-vip`'s job row and
subscription still exist). Sabotaging the fire-time gate to block unconditionally
(`if (!enabled)` → `if (true)`) left it **green** while a sibling correctly
reddened.

*A surviving row is not a firing schedule* — which is precisely the distinction
this whole section is about, asserted everywhere except in the case that names it.
The positive half is now there: `firedRuns(weeklyScheduleJobId(vip)) === 1`. Same
sabotage now yields **2 reds**.

**That is three vacuous assertions of mine found in this ADR's own §6, plus a
fourth found in §Correction 1, plus this one found by review.** The pattern is
stable enough to be a rule: *an assertion set that is entirely negative or
entirely structural has no witness for the thing it is named after.*

## 7. Step 7 — smaller rows closed in passing

- **`ISC-8`** — the config gates now refuse **before** `resolveEffectiveAccess`.
  That function returns the tenant-OWNER principal with the full owner scope set when
  neither `subject` nor `memberId` is supplied (its own header: *"the fail direction is
  open"*), so both gates would have passed unconditionally for a request with no
  `req.userId` and no `req.principal`. Stated as precisely as the audit did: **latent, not
  a live bypass** — `authMiddleware` always populates `req.principal`. The point is that the
  safety no longer rests on an invariant held in a different file with nothing asserting it
  here, which is a class of claim this feature has already been wrong about twice.
- **`ISC-13`** — `rejectionPolicy:"block"` removed (see §5).
- **`ISC-14`** — the dashboard-era claims that outlived their code: `routes.ts`'s
  "READ-ONLY in P1 (the dashboard's read model)" header (contradicted by the `PUT` handler
  60 lines below it), the `read model PII classification` describe block, and
  `seedCoverage.ts`'s `'derived insights — self-populates'` exemption, which was granted on
  a false premise — nothing populated and nothing *could*. The exemption still stands; its
  reason is now the true one.
- **`ISWF-15`** — `FEATURES.md` no longer calls these "built-in meta-workflows". That
  phrasing is what made the chains-or-stacks prime question necessary in the first place,
  and the answer is the opposite of the one it hunts: they are genuine chains.
- **`ISC-15` (partial)** — the never-send guarantee's test was orthographic (a
  `/send|sendmail/i` regex over typeIds). `PROBE-IS-1` now additionally asserts the **URL the
  broker actually received** matches a create-draft literal. The typeId regex is still the
  only *structural* guard; re-expressing it against `sideEffectFloor.generated.ts` is a
  residual.

## 8. Prescriptions falsified or amended

| # | Prescription | Verdict |
|---|---|---|
| 1 | *"Port-qualify all 10 edges, including `… → notify.message`"* (`ISWF-2` step 4) | **TOOK FINDING, REJECTED CURE.** Qualifying the three notify to-sides sets `message` to an object and `asText()` returns `''` for a non-string — a **measured no-op**. Four of seven qualified; three rejected with the mechanism. **Amended by §Correction 8:** the original wording ("byte-identically the empty body") overstated it — a portless edge SPREADS the upstream outputs onto `ctx.inputs`, so a top-level `message` string *would* reach `notify` today, which makes rejection strictly stronger than the alternative rather than equal to it. |
| 2 | The same prescription, applied to the `to`-side only | **AMENDED.** An edge forwards the whole upstream outputs object, so `to:"compute.rows"` without `from:"query.rows"` sets `rows` to the *envelope* — strictly worse than portless. Both sides, or neither. |
| 3 | *"ONE fix (`featureId` + fire-time resolve) closes ISC-5 and ISC-10"* | **VERIFIED, THEN AMENDED.** True only if `teardownAllSchedules` is **deleted**. Adding the gate while keeping the teardown leaves ISC-5 fully open — the global destructive scan *is* ISC-5. |
| 4 | *"`sql`/`baseUrl` belong in `InsightsSuiteConfig`"* (`ISC-1` path step 2) | **PARTLY REJECTED.** `projectId` does (it is per-tenant and the scheduler must seed it), but `sql`/`baseUrl` as config rows would be invisible to the builder and to a `/`-picker launch. They are chain **parameters**, which is the surface a tenant actually edits. `projectId` rides both: a parameter, seeded from config on the scheduled lane. |
| 5 | *"Add a `no_data` verdict"* (`ISC-2`) | **AMENDED to a typed failure.** A `no_data` success still suspends at the red-team gate — a human is asked to sign off on an empty report — and still fires the tenant notification. The harm is the approval signature on nothing, which only a failure prevents. |
| 6 | *"Implement `instanceUrlTemplate` resolution OR strike the claim"* | **CHOSE: strike.** Recorded above with the reasoning, an inline ADR 0082 correction note, and the two host comments corrected. |
| 7 | My OWN witness assertion for the email body | **FALSIFIED BY SABOTAGE.** `draftId` + a draft URL both pass over a blank draft. Fixed to read the wire body. |
| 8 | *"`ISC-14.3`: `insights-suite-governance.test.ts:49` asserts a tautology"* | **CONFIRMED but NOT the line cited.** That assertion is on `insights.varianceReport`, an entity nothing declares, so `classificationOf` returns `'internal'` for any unregistered name. Left in place and named as a residual rather than deleted mid-PR: deleting it would remove the only remaining written trace that the entity was never declared. |

## 9. Residuals — every one of them, and where it goes

**PR-B (UX / observability), all still open:** `ISU-6` (confidential-PII broadcast at
`audience:'tenant'` — narrow to `role:`/`self`), `ISU-7` (title-only notifications across
inbox, bell drawer, dashboard tile, OS toast and web push), `ISU-8` (no `actionUrl`, so the
bell drawer dead-ends), `ISU-9`, `ISU-10` (the inbox `ApprovalCard` renders no evidence —
the surface the notification actually routes to), `ISU-12`, `ISU-18`, `ISU-19`, `ISU-23`
(`outputRole` curation with no consumer; `WorkflowCompletionCard` resolves terminals from
`localStorage`), `ISU-24` ("No events yet" on a **failed** read), `ISU-25`, `ISU-26`,
`ISU-27`, `ISU-15` (every user-visible string is English-only; needs a pack-string
localization mechanism that does not exist), `ISU-16`/`ISU-20`/`ISU-21` (manual-test suite,
orphaned CSS), `ISWF-17` (no frontend for the config route — a required-field route with no
client).

**Named for `/architect`, cross-feature or seam-level:**

- `ISWF-6` — trigger ingest sets `run.inputs = null` by design, so the webhook's
  `subjectId`/`milestone` reach `metadata.triggerData` and **never** the variable bag the
  chain's `{{params.*}}` resolve from. This is a shared RFC 0099 seam
  (`triggerInputMapping`, or a chain-level `triggerData`-reading entry node), not an
  insights-local choice.

  > **§Correction 2 — this bullet used to end: *"a trigger-started anniversary run
  > reaches the LLM with no subject and no milestone — it no longer fabricates, but it
  > is not yet useful."* That is FALSE, and it understates the damage by an entire
  > lane.** `ingestExternalEvent` (`host/triggerIngestionService.ts:583`) builds the run
  > with `inputs: null` and **never calls `seedRunVariables` at all**, so no bag is
  > created: `snapshotRunVariables` returns `null` (measured) and **every**
  > `{type:'variable'}` PortValue resolves `undefined` — not just the per-event ones.
  > Proved by execution: `ANNIVERSARY node1 core.workday.query → invalid_config
  > (requires config.baseUrl)`. **The lane is DEAD, not merely unpersonalised.** A
  > tenant that turns the toggle on and sets `anniversaryTriggerEnabled` gets a webhook
  > subscription whose every event dies at node 1, indefinitely, with no alert.
  >
  > So the STATIC per-tenant values are **not** deliverable on this lane either — the
  > sentence claiming they were is struck. The bug is one level below `ISWF-6`'s
  > per-event scope: `ISWF-6` asks for a mapping, and there is no bag to map INTO.
  >
  > **Two cures were considered and neither is taken here.** (a) *Seed the bag from the
  > chain's declared defaults at ingest.* **Falsified by measurement** — re-run with a
  > defaults-only bag and node 1 gives the identical `invalid_config`, because
  > `workdayBaseUrl` is `required` with no default and could not have one (it is
  > per-tenant). (b) *Refuse to arm the subscription*, mirroring the `ISC-6` sibling
  > that refuses a cron with no `planSource.projectId`. **Rejected**: a chain
  > instantiates into a tenant-owned, builder-EDITABLE workflow, so a tenant may
  > legitimately hard-code `baseUrl` on the node and repair the lane themselves — a
  > refusal at arm time would block that, and a refusal that persists is worse than the
  > bug it replaces (the `ISC-6` lesson, §6). A subscription-level `inputs` bag seeded
  > at fire time (mirroring `ScheduledJob.inputs`) remains the candidate, and it belongs
  > to the same `/architect` seam decision as the per-event half.
- `ISWF-9` (other half) — `POST /v1/runs` has no toggle gate at all. Any authenticated
  tenant that knows a workflow id can start it with the owning feature OFF. Affects every
  feature, not this one.
- `ISU-4` root cause — `core.email.draft` is code-registered with **no pack manifest**, so it
  has no `configSchemaRef` and the chain loader's required-config gate is structurally
  unable to see it. Four chains walked through that gate; three remain quarantined in
  `chain-required-config-census.test.ts`. Giving the node a manifest closes all of them at
  once and lets the census become schema-driven instead of hand-listed.
- `ISWF-14` — `gen-steward-manifest.mjs` hard-scopes to `packs/` and never walks
  `examples/workflow-chain-packs/`, so **all 58 chain packs are unattested by construction**.
  `check-pack-pin-drift.mjs` was already patched for exactly this blindness
  (`VENDOR_ROOTS`); the steward generator never got the same treatment.
- `ISC-9` — the anniversary subscription registers `verificationMode:'none'` at a fully
  deterministic id, and the ingest route enforces tenant ownership with **no RBAC scope**.
  The §6 feature gate narrows the window (a disabled tenant is now immune) but does **not**
  close it: an enabled tenant's low-privilege member can still guess
  `insights-anniversary:<tenant>:<principal>` and start BYOK-billed LLM runs. Needs
  `verificationMode:'required'` + a signing secret on the BYOK rail + a scope on the route.

**Smaller, this feature's, still open:** `ISC-12` (agent prompts instruct the model to cite
SQL provenance the pipeline still does not hand it — a model-facing surface, so it belongs
in `docs/steward/LLM-EXCHANGE-AUDIT.md` with a tripwire); `ISC-14.3` (the tautological
`insights.varianceReport` classification assertion — see §8 #8); `ISC-15` (re-express the
never-send guard against `sideEffectFloor.generated.ts` rather than a typeId regex);
`ISWF-12` (`PROBE-IS-8` — nothing asserts `withOutputRoles` produced exactly one primary);
`ISWF-18` (`withOutputRoles` has no suffix-collision guard, unlike the parameter path it
sits beside — vacuously safe today); `ISWF-19` (the live registry still serves the pack at
`1.0.1` against repo `1.2.0` — needs a registry republish, tracked corpus-wide as
`WF-EM-5`/`WF-EM-18`); `PROBE-IS-9` (replay determinism is inferred from a clean grep, not
build-probed).

**Opened by the review fold-in (§Corrections 1-8), all still open:**

- **`GEN-SCHED-1` (`/architect`, cross-feature).** `POST /v1/host/openwop-app/scheduler/jobs`
  accepts a caller-chosen `jobId` verbatim and registers it under the caller's tenant, so
  **any authenticated tenant can squat any feature's deterministic job id**. ADR 0379's
  guard blocks the CLOBBER, not the SQUAT. §Correction 6 makes insights refuse cleanly and
  gives the victim an exit; it does not close the squat, and every other deterministic-id
  feature still has it.
- **`ISC-7` residual.** The `!res.ok` race backstop is retained and is **not witnessed** —
  with the pre-flight in place no deterministic test can reach it. Stated, not hidden.
- **`ISC-2` residual (scale).** `talent-score` refuses a row rating outside 1-3
  (`unknown_scale`), but a 1-5 source value of 1, 2 or 3 is still indistinguishable from a
  1-3 one — a mid `3` reads as the top band. The real cure is a **declared** source scale.
  A `config.ratingScale` knob was **rejected**: nothing would supply it, and a documented
  mechanism with no reader is the defect this ADR retired `instanceUrlTemplate` for.
- **`ISC-2` residual (narrow verdict).** `variance-compute` earns an `on_plan` verdict from
  as little as one comparable metric, with the rest in `metricsMissing` /
  `metricsUncomparable`. Surfaced, not refused — the same "as wide as the metrics behind
  it" convention §3 set. A minimum-coverage threshold is a product decision, not a fix.
- **`GEN-IS-1` residual (coverage).** The required-config census is a FLOOR over a
  hand-written table: **15 matches of 584 chain-node instances across 175 typeIds**. Six
  starved nodes outside this feature are quarantined (three `core.email.draft`, three
  `core.web.search`). `ISU-4`'s manifest cure closes the first three; the second three need
  their owners. `census()`'s edge term is a false-positive guard that changes no verdict
  today and is therefore **not** sabotage-witnessed (the helper it composes is).
- **`ISU-4` sibling.** `core.openwop.integration.email-send` has **no early
  `invalid_config`** at all — it forwards an absent `to` to the email adapter. Deliberately
  out of the census table (it fails the table's own membership rule) and out of this PR.
- **`ISWF-6` (upgraded).** No longer "the per-event values don't arrive" — **the trigger
  lane has no variable bag at all**, so the anniversary webhook is dead at node 1 for every
  tenant that arms it, with no alert. See §Correction 2 for the two cures measured and
  declined.
- **`ISU-6` coupling (new).** `talent-prep`'s notification body is bindable **today**
  (`score.label`), and is deliberately left unbound until `ISU-6` narrows the audience —
  broadcasting a named person's 9-box band workspace-wide is worse than an empty body.
- **`instanceUrlTemplate` declarations (completeness).** Retired in prose and still declared
  in `schemas/connection-pack-manifest.schema.json`, `examples/connection-packs/workday/
  pack.json` and `features/connections/connectionPackLoader.ts`. `docs/adr/0149` cited it as
  live and now carries an inline correction. An optional property cannot be removed from a
  vendored schema inside a feature PR; recorded rather than silently deleted.
- **Harness fidelity (new).** `insights-chain-execution.test.ts` models a resumed
  `core.approvalGate` as completing `{approved:true, decision:'approve'}`; the executor
  completes it `{output:<resumeValue>}`. Immaterial to every current assertion (`notify`
  takes its `title` from a declared input), but it is a second implementation of the
  executor and it will drift — the `nodeCtxInputs.ts` lesson, one layer out.

**Two consequences of this PR that are themselves residuals:**

1. **Changing the chain parameters changes `deterministicExpansionId`, and therefore every
   expanded node id.** A pre-existing run recorded against the old ids would not resolve
   against the new definition. Accepted here because the feature has produced **zero**
   successful runs by construction (`ISC-1`), and because ADR 0472 P2 already moved these
   ids once. Any future parameter edit does not get this exemption.
2. **Tenants seeded before this PR keep stranded `wf.seed.openwop-app-insights-*` rows**
   pointing at the old, broken definitions. `seedZeroConfigWorkflows` **skips**, it does not
   retract — the same retro-strand `seedWorkflows.ts` already documents for chains marked
   `internal`. No migration is shipped here; the rows are inert copies in a builder, not a
   live lane.

## 10. Implementation record

| Step | Commit | Verification |
|---|---|---|
| Reservation | `231aba9b2` | `check-adr-refs --reserve` |
| §3 guards | `3cba1be5f` | `insights-suite.test.ts` 12/12; 2 sabotages, 1 red each; `check-pack-version-bump` 0; `gen-steward-manifest --check` 0 |
| §4 witness (born red) | `c6105fa2d` | the red shown above, verbatim on that commit |
| §5 wiring + Step 5 | `38f9a8221` | witness 5/5 green; `tsc --noEmit` 0; 36 targeted vitest files |
| §6 reconciliation | `9ae5bb941` | 27 targeted vitest files; 3 sabotages |
| §7 + docs | `81ef75c07` | `check-adr-refs` 0; 13 targeted vitest files |
| §Correction 1/4 (C1, M4) | `2b6091857` | 35/35; 5 sabotages (2+1+1+1 reds, 1 green-and-stated); `gen-steward-manifest --check` 0; `check-pack-version-bump` 0 |
| §Correction 2/3 (H1, H2) | `e98672be9` | reproduced by execution; `check-adr-refs` 0; meta 10/10 |
| §Correction 6/7 (M2, M3) | `1fc7ef3c3` | witness born RED; 4 sabotages; `tsc` 0; 74/74 across 7 suites |
| §Correction 5 (M1) | `6eeda5ffe` | 5 sabotages (4 reds, 1 green-and-stated); `tsc` 0 |
| §Correction 8 (L1, L2) | this commit | mechanism read at `scheduler.ts`/`nodeCtxInputs.ts`; ADR 0149 correction note |

**Gates run:** backend `tsc --noEmit`, `scripts/check-pack-version-bump.mjs`,
`scripts/gen-steward-manifest.mjs --check`, `scripts/check-adr-refs.mjs`, and targeted
vitest across the insights, chain, pack, seed, trust, scheduler, trigger, toggle and
assistant-loop suites.

**Gates NOT run (and not claimed):** `npm run ci` (the parent session owns that fleet; a
second one corrupts both), the frontend build and lint lane, Playwright e2e, and the live
testcontainer adapters. Nothing in this PR touches `frontend/react/`.
