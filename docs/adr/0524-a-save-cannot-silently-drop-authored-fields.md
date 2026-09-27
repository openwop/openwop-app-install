# ADR 0524 — A save cannot silently drop authored fields

Status: implemented (2026-08-04)

The server-side half of **ADR 0523**, whose §Open recorded the residual as
`GEN-0523-1`: that fix was client-only, and nothing stopped a client from
stripping the head.

## The premise ADR 0523 got wrong

ADR 0523 §Open said "an un-refreshed SPA keeps stripping", which reads as
deploy-skew that self-heals when users reload. **It does not heal, for two of the
eight round-trip POST lanes.**

`runs/RunsIndexPage.tsx:237` and `chat/hooks/chatSession/useWorkflowRunMentions.ts:487`
register-then-run by serializing from **localStorage**, not from a fetched head. A
`SavedWorkflow` written by a pre-0523 bundle carries no node `inputs` — the old
deserializer never read them — and the *corrected* serializer then faithfully emits
the nothing that is there. So a user on the fixed bundle, running a workflow from
the runs index or a chat `@workflow` mention, re-strips the server head. A hard
refresh does not help, because the stale data is in browser storage, not in the JS.
**A workflow the user only ever runs is never healed at all.**

Consequence: the guard cannot be retired on a calendar. It retires on a measured
zero. This ADR corrects 0523 §Open rather than restating it.

## Decision

### 1. Fix the two lanes at the source

Both now probe `fetchRegisteredWorkflow(workflowId)` and register **only when the
backend cannot already resolve the workflow**. The register exists solely so
`POST /v1/runs` can resolve the definition; when the head already exists, writing a
localStorage copy over it is pure downside. This is the highest-leverage change in
the phase and it was not on the original plan — `/architect` surfaced it.

### 2. One shared helper, called at the two round-trip write sites

`host/preserveDroppedFields.ts`, invoked from `routes/workflows.ts` and
`host/collab/workflowCollabResource.ts`.

**Not the `registerWorkflow` choke point**, for two independent reasons. There are
21 production callers and most are *legitimate* full replacements — chain
instantiation, seeding, migrations, boot registrations — that must be free to write
a definition with no prior `inputs`; `registerWorkflow(def)` receives only the
definition, with no caller identity or intent, so it cannot tell them apart, and
adding an `intent` parameter to 21 sites is the hand-maintained-list defect
generator ADR 0523 exists to end. And `registerWorkflow` is **synchronous by
design** (write-through cache, fire-and-forget durable write); the guard needs an
async prior-head read, which would break sync-only boot callers.

The precedent is exact: `assertNoDisabledPacks` (ADR 0194/0481) is one helper
called at these same two lanes, and its comment already states the rule — *"the
registration choke applies to EVERY registration path."*

### 3. Merge, never refuse

`routes/workflows.ts` already ruled on this at the same line for the removed-node
guard (ADR 0440 P2): a refusal is *"an unsatisfiable 409 arriving 1.5s after a
keystroke, via an autosave the user never triggered."* Refusal also **inverts the
harm** — an old-bundle user loses everything typed since their last successful save
(remedy: a hard refresh the error cannot perform) instead of one field.

Merging is the established doctrine at this seam, not a novelty: three sites already
take "content from the client, these fields from the head"
(`workflowCollabResource.ts:111`, the rollback path, and `definitionMetadata.ts`).
And it restores fields the ingest contract **already accepts**, so it is not the
carry-verbatim anti-pattern 0523 rejected — nothing is promised that the server
does not honour.

### 4. The merge is discriminated, because an unconditional one is a time bomb

An unconditional merge makes **deletion impossible**. That is harmless only while
nothing can delete a preset input (the Inspector section is deliberately read-only)
and becomes a silent-resurrection bug the day editable preset inputs ship —
correct-now, defect-generator-later, silently.

So the merge fires only on **whole-set omission**: the incoming definition carries
the field on zero nodes while the head carried it on ≥1. An old bundle zeroes all of
them at once; a user clearing one leaves the others intact. That is a
*bundle-capability* signal rather than a content signal, so it stays correct after
editing ships. Def-level fields merge only when **absent entirely** — an explicit
`[]` or `{}` is an author clearing them and is honoured.

Restoration is keyed on the **surviving node id**: a node the save deleted stays
deleted, and a node it added inherits nothing.

### 5. Not silent

Every merge returns `preservedFields` in the 201 (owner-gated exactly like the
sibling `removedReferencedNodeIds`), logs, and is counted. Be honest about the
audience: an old bundle cannot render an unknown field, so the *user-visible* value
is nil — its real consumers are the operator and the route tests, which can then
assert the guard fired without mocking a logger.

### 6. The collab lane MERGES too

> **Correction (code review).** This section originally said the derive should
> SKIP, reasoning that *"the room re-derives on the next edit, so skipping costs
> one derive rather than the data."* **Both halves were wrong.** `evict()` runs a
> FORCED derive at room close — the documented canonical parity point — so a skip
> there means the entire session's graph never reaches the head, while REST save
> 409s (`workflow_room_live`) for the whole session. And it is STICKY: a pre-0523
> peer writes stripped nodes into the durable Y snapshot, so every later peer
> deserializes stripped, serializes stripped, and skips again — across sessions,
> until someone retypes the values by hand.

The lane now merges, exactly like the route. Consistency is the point: two write
paths with different loss semantics is how this whole class started.

### 7. Allowlists #7 AND #8

> **Correction (code review).** Widening `WORKFLOW_COLLAB_FIELDS` was **INERT**.
> `workflowCollabSlice` skips `undefined`, and the adapter's writer
> (`workflowCollabAdapter.ts:70`) never passed `variables`/`configurableSchema`
> in, while its reader (`:95`) never read them back — two further
> hand-maintained lists. Worse, `commit()` DELETES absent root keys, so that
> writer would have actively erased a `variables` key any other writer added.
>
> **So the fix for allowlist #7 reproduced this ADR's own root cause at #8**, and
> the ratchet I added to prevent exactly that recurrence could not see it: it
> grepped every quoted identifier in the shape file, so deleting `'variables'`
> from the list while leaving the `{ key: 'variables' }` collections entry kept
> it GREEN (sabotage-proven by the review). Both ends are now wired, and the
> ratchet parses the NAMED list plus both adapter ends, comparing against
> `SavedWorkflow` rather than echoing a hard-coded list. Re-probed with the
> review's own two sabotages.

#### The original #7

`WORKFLOW_COLLAB_FIELDS` was written for ADR 0364, when `SavedWorkflow` had no
`variables`/`configurableSchema`. ADR 0523 added them; nothing compared the lists.
So a peer's variable edits never reached another peer, and the last scalar write
erased them. **That is ADR 0523's own root cause recurring in a site it never
counted** — bringing the total to seven. `variables` is declared as a *collection*
keyed on `name`, not a scalar: as a scalar it would be whole-object
last-writer-wins, so two peers editing different variables would lose one.
`configurableSchema` stays a scalar — a plain object edited as a unit, the same
semantics `inputSchema` already has.

The two-line edit is not the fix; the **ratchet** is. `node-field-contract-parity`
now parses `WORKFLOW_COLLAB_FIELDS` against `SavedWorkflow`.

## What the grade trio then found

**The ratchet had a THIRD blind spot — third version, third hard-coded echo.**
It exempted collections from the read-back check via a literal
`new Set(['nodes','edges'])` instead of reading `WORKFLOW_COLLAB_SHAPE`. Deleting
`{ key: 'variables', idKey: 'name' }` therefore passed **10/10** — and that
deletion demotes `variables` from a per-variable CRDT collection to a
whole-object last-writer-wins scalar, i.e. the exact "two peers edit different
variables, one silently loses" harm §7 says the entry exists to prevent. It now
parses the declared collections, plus a new assertion that every array-valued
field IS one. **The pattern worth naming: each time I fixed this ratchet I moved
the hard-coded echo somewhere new rather than removing it.**

**The restorations were incoherent when partially applied.** They were gated
independently, so a client that models `variables` (sends an explicit `[]`) but
NOT node `inputs` got restored inputs carrying `{type:'variable'}` refs while the
declarations stayed cleared — refs resolving against an empty bag, which is
verbatim what `SavedWorkflow.variables`' own docblock says must never happen, and
**worse than either endpoint**. The pair now moves together: if restoring inputs
reintroduces a ref the surviving declarations do not cover, the declarations come
back with it.

**The frontend lanes failed OPEN into the destructive branch.** A probe error
(429/5xx/offline — and CLAUDE.md documents the per-IP read budget as a real 429
source on fan-out pages) fell through to the register. They now fail CLOSED: the
cost is a loud 404 from `POST /v1/runs` for a workflow that exists only locally,
where the alternative was silently overwriting authored values. A loud failure
beats a silent loss — which is this ADR's whole thesis, applied to itself.

**The §4 false positive is no longer an assertion — it is measured.** Across all
169 shipped chains the histogram of input-carrying nodes per chain is
`0:55, 1:74, 2:24, 3:11, 4:1, 5:3, 13:1`. **74 of 169 chains (43.8%) — and 74 of
the 114 that carry any inputs (64.9%) — have exactly ONE**, and the mode is 1.
The affected families are the most-instantiated ones (all `starters`, `support`,
`devops`, `lighthouse`, `inbox`, `exec-ops`, every `mcp-tool-projections`). So on
the seed distribution roughly two in three at-risk workflows would resurrect a
deliberately-cleared input the day editable preset inputs ship. That is the
acceptance figure for treating the client field-contract marker as a
**prerequisite**. Limit stated: the pack corpus proxies SHAPE, not COUNT — the
real population is tenant-owned heads, still uncounted.

**My own frontend test was mostly asserting itself.** Three of its five cases
exercised a helper declared in the test file that no production module imports —
they stayed green if both lanes were reverted wholesale. Removed; what remains is
an honest source-shape ratchet that says so in its docblock, with behavioural
coverage recorded as owed.

## Residual gaps the review named, recorded not papered over

- **The renumber sweep leaked.** Renaming ADR 0523's references was a blind global
  replace that also rewrote 28 references belonging to a PEER's ADR 0519 —
  retitling their file. Caught by `/ux-review`, reverted. This is the
  scripted-bulk-edit class again, and I skipped the verification pass my own
  earlier record prescribes: *the fix for a scripted-edit defect is not a better
  regex, it is a pass that compares the result to what it should have been.*
- **The collab derive has no wiring test.** `deriveWorkflowHead` is not exported
  and needs the full WebSocket/Yjs room harness. The helper it calls has 8
  route-level tests and 5 sabotages, but the collab CALL SITE is asserted by
  nothing. Stated rather than implied: the collab toggle is `off` in production,
  which is why this ships as a gap and not a blocker.
- **`preserveDroppedFields` restores by `nodeId` alone**, so a caller that keeps a
  nodeId, changes its `typeId`, and drops every input in one POST would inherit
  stale inputs onto a retyped node. Unreachable from the builder (ids are fresh
  UUIDs, never reused; there is no change-node-type verb) — a direct API caller
  only.
- **One real discriminator false positive**: a workflow with exactly ONE
  input-carrying node whose input is cleared IS a whole-set omission and would be
  resurrected. Unreachable today (the preset-inputs section is read-only) but one
  checkbox away, and "workflows with exactly one input-carrying node" is not a
  corner case. **The client field-contract marker is therefore a prerequisite for
  editable preset inputs, not a follow-on.**

## Correction to an in-code note that nearly mis-designed this

`routes/workflows.ts` carried a comment calling `registerWorkflow` an "unguarded
overwrite… pre-existing and separately tracked". True when written (ADR 0440 P1–P3),
and false **4.5 hours later** when P4 added `isWriteProtected` — a non-owner now
gets an indistinguishable 404 and never reaches that line. Nobody corrected the
note, and it nearly justified a defensive read this guard does not need. Corrected
in place. The real residual is narrower: the documented no-CAS race on the *first*
write of a never-registered id.

## Exemptions

- **Rollback** deliberately restores a chosen prior revision; merging the *current*
  head's inputs into *older* nodes produces a Frankenstein definition — new inputs on
  old nodes — worse than either endpoint.
- **Workflow-author persist** regenerates a whole definition; merging would resurrect
  inputs the author intentionally replaced.

Both are distinct call sites that simply do not invoke the helper — which is the
payoff of the shared-helper design over a choke point that could not have told them
apart.

> **CORRECTION 2026-08-21 (ADR 0595) — the workflow-author exemption is REVERSED;
> the rollback exemption stands.**
>
> The exemption's premise — *"regenerates a whole definition"* — was true when
> written and stopped being true when `XCH-WFA-1` added the `get` tool and the
> Workflow Architect's prompt began instructing get-then-revise
> (`workflow-architect.md:17-20`). That lane is now **also** a revise lane, and on
> a genuine regeneration the workflowId is fresh, so `previous` is `null` and the
> helper is a no-op anyway. The exemption bought nothing on the case it was
> written for and destroyed data on the case that appeared later — silently, on
> the documented happy path.
>
> The fear it encodes ("would resurrect inputs the author intentionally
> replaced") describes an **unconditional** merge, which §4 above had already
> replaced with the whole-set discriminator: a model that replaces inputs on
> *some* nodes leaves the count non-zero and nothing merges. On that lane the
> discriminator is *more* reliable than here, because the authoring brain's
> structured-output schema **provably cannot express** the fields.
>
> ADR 0595 also widened `PreservableField` from three to five (`+ 'settings'`,
> `+ node 'compensation'`). Evidence that this was owed to the REST lane too, not
> just to the new caller: `frontend/react/src/builder/schema/workflow.ts:109-134`
> `SavedWorkflow` models **neither**, so a builder save has been stripping both
> since before this ADR — the guard had simply never been asked about them.
> `metadata` and edge `condition` are excluded, with reasons, in ADR 0595 §1.

## Tests

Route-level over HTTP through `createApp`, never spying on the helper: a test that
calls it directly proves the mechanism and says nothing about whether the route
reaches it (ADR 0502, paid for twice). Every case **seeds the precondition through
the route first** — the dominant vacuity risk here is a test that POSTs a stripped
definition with no prior head and asserts "nothing lost", which passes for the wrong
reason.

Four independent sabotages, each reddening its own assertion: disable the merge;
remove the disclosure; widen the discriminator (partial drop must NOT merge);
resurrect deleted nodes. Plus one on the collab ratchet.

## RFC gate

**No RFC.** `preservedFields` is an additive optional field on the non-normative
`/v1/host/openwop-app/*` route; nothing on the wire changes.

## Open

- ~~**P0 measurement is owed.**~~ **CLOSED by Phase B** — see §"Phase B" below.
  The framing here was right about the population (tenant-owned registered heads,
  not the pack corpus) and right that a request count is meaningless. Two of its
  incidental claims have since gone stale: the two steward probes it says query
  `hostext:wfreg:%` were corrected to the flat `wfreg:%` by ADR 0525 Phase D, and
  the instrumentation it implies turned out to be unnecessary (§"Phase B" §1).
- **The retirement criterion is compromised by shipping §1 in the same change.**
  The frontend fix suppresses the two lanes that generate merges, so the counter
  can read zero while the stale localStorage population is untouched.
  > **§Correction (2026-08-05, Phase B).** The second half of this item —
  > "`.catch(() => null)` fails OPEN into the stripping register" — **is no longer
  > true.** Both call sites now fail CLOSED
  > (`runs/RunsIndexPage.tsx:251-253`, `chat/hooks/chatSession/useWorkflowRunMentions.ts:497-499`,
  > `let probeFailed = false; … if (!probe && !probeFailed)`), so the SECOND
  > condition this item demands is satisfied.
  >
  > **But closing it made the first half worse, not better.** The fail-open path
  > *was* a stripping path, and suppressing it removed its observability along
  > with it. You cannot measure a behaviour you have already suppressed — the
  > same trap this item names about shipping §1, recurring one layer along. The
  > consequence is that the merge-log signal is structurally biased **low** and
  > cannot on its own prove the stale-bundle population is gone. Durable state is
  > therefore the primary evidence for retirement, and the log strictly
  > corroborating.
- **Running from the runs index or a chat mention now executes the SERVER head.**
  If the builder's last autosave failed (offline, or a 409 `workflow_room_live`),
  the user runs an older definition than the one on screen, with no disclosure.
  Net-better for the multi-device case it fixes; the divergence between the three
  Run entry points is undisclosed either way.
- **`DD-0524-1` — rollback is now the LAST remaining strip path, and it is
  one-way.** Rollback is (correctly) exempt, so restoring a bug-window revision
  re-strips the head — and a *fixed* bundle then cannot re-arm the guard, because
  it faithfully serializes zero inputs and `beforeCount === 0`. Pre-existing;
  this delta neither causes nor worsens it, but it is the path left open.
- **`GUARD-UX-5` — the collab merge repairs the HEAD but not the ROOM.** The
  Y.Doc keeps the stale peer's stripped nodes, so a user in that room sees the
  Inspector's preset-inputs section empty for a node whose head carries values,
  while Run inside a live room executes the head. The run uses values the screen
  denies exist. Cheapest honest fix is writing the merged definition back into
  the room, not adding copy.
- **The observable is not a fixed point.** `preservedFields` and the log re-fire
  on every 1.5s autosave, so the merge counter inflates exactly the way §Open
  warns request counts do — which matters because "retire on a measured zero"
  reads that counter.
- **Retire on a measured zero, never a date.** When the merge counter reads zero over
  a full window, the branch is provably dead.
- **A client field-contract marker** would let the SPA declare which fields it
  modelled, making the merge unnecessary rather than heuristic. Becomes primary — not
  optional — the day editable preset inputs ship, because the whole-set
  discriminator's safety margin narrows then.
- **The revision store holds stripped revisions from the bug window**, and rollback
  surfaces them as legitimate restore targets. Not fixable by this guard.
- **RFC 0124 SR-1 at the snapshot boundary.** Putting `variables[]` in the Y.Doc means
  declarations ride the collab transport and land in the collab snapshot — a new
  at-rest location. SR-1 says a `sensitive` variable MUST NOT carry a persisted
  `defaultValue`, so by construction there is nothing secret to leak, but the
  invariant is enforced at the *definition* boundary only. Asserted in one place,
  relied on in two.

---

## Phase B — the owed measurement (2026-08-05)

Ships `scripts/measure-stripped-workflow-inputs.mjs`: read-only, four counts.
`/architect` ruled on the design before any of it was written, and overturned two
of my premises.

### 1. No instrumentation was needed — the "counter" problem was a QUERY problem

§Open says the observable "is not a fixed point": `preservedFields` and the log
re-fire on every 1.5s autosave, so a merge counter inflates by orders of
magnitude. I had planned to dedupe the disclosure or emit a one-shot repair
signal. Both were unnecessary: `preserveDroppedFields.ts:144` **already logs
`workflowId`**, so `COUNT(DISTINCT workflowId)` is a fixed point and `COUNT(*)`
is not. The defect was in how the number would be read, not in what is emitted.

The deeper correction is that I had collapsed two different questions:

| Question | Measures | Source |
|---|---|---|
| Is durable state repaired? | **stock** | the `wfreg:` rows |
| Has the stripping behaviour stopped? | **flow** | the merge log |

"Retire on a measured zero" is a claim about **both**, and a zero *flow* number
is satisfied by nobody opening the builder for a week — a false green of exactly
the family this program is about. Stock is what this phase measures.

### 2. Ground truth comes from revisions, not from re-expanding packs

The obvious ground truth is `metadata.expandedFrom` — re-expand the source chain
and diff. Rejected: that needs the pack corpus loaded, which means booting the
backend outside vitest, which **re-points every `~/.openwop-packs` symlink at the
running checkout** (CLAUDE.md § "the pack hazard that IS real"). A measurement
tool that mutates a shared developer environment is not a measurement tool.

`workflow:revision` rows carry the **full definition as registered**
(`workflowRevisions.ts:46-48`) *and* the `tenantId`. If an earlier revision
carried inputs and the head carries none, the head lost them — no packs, no boot,
pure SQL. It is also strictly closer to the guard's own semantics, which compares
next-vs-previous.

### 3. What is NOT measurable, stated so it is never claimed

- **A per-tenant count from `wfreg:` alone is impossible.** The key is flat and
  host-global (`workflowsRegistry.ts:27-28`) and the value carries no `tenantId`
  (`workflowOwnership.ts:175` says so explicitly). Tenant attribution comes from
  the revision rows and the `workflow:ownership` join, or not at all.
- **Per-tenant *flow* is unavailable by design.** `preserveDroppedFields` has no
  tenant — *"the lane is not knowable here; the caller tags it"* (`:146`). Not
  worth coupling the pure helper to a request to get it.
- **A workflow may be owned by several tenants**, so affected-workflows and
  affected-tenants are independent numbers, not multiples.
- **`UNKNOWABLE` is a real bucket and `stripped` is a FLOOR.** A head with no
  inputs and no revision that ever had any cannot be classified — it may
  legitimately declare none. Revision history is capped
  (`OPENWOP_WORKFLOW_REVISIONS_KEEP`, default 50), so a workflow stripped long
  enough ago that every surviving revision is also stripped lands here. Folding
  these into "intact" would produce a reassuring number that means nothing, which
  is more dangerous than no number because nobody re-checks it. The report
  therefore emits four figures and **refuses to print a headline percentage**.

### 4. A fourth count the phase would otherwise have missed

`DD-0524-1`: rollback is exempt from the guard and is one-way, so a head that is
clean today can be re-broken tomorrow by restoring a bug-window revision — and a
*fixed* bundle then cannot re-arm the guard (`beforeCount === 0`). Counting only
current heads understates the hazard, so the script also counts **poisoned
rollback targets**. Repairing them is Phase C's job; sizing them is this one's.

### 5. One of my own tests was vacuous, found by probing it

Six sabotages, each required to redden **its own** assertion:

| Sabotage | Result |
|---|---|
| fold `unknowable` into `intact` | ✅ reddens the load-bearing test |
| count workflow×tenant pairs instead of distinct tenants | ❌ **no test failed** |
| treat the `host` sentinel as a real tenant | ✅ |
| count an empty `inputs: {}` as carrying | ✅ (incl. the guard-parity test) |
| count every zero-input revision as poisoned | ✅ |
| add a headline percentage to the report | ✅ |

The distinct-tenant test used **one** workflow with two tenants, where "distinct"
and "pairs" both equal 2 — so it passed unchanged against an implementation that
counted pairs. Rewritten with two workflows sharing a tenant (distinct 2, pairs
3), it now reddens. This is the recorded "a sabotage probe can be vacuous" lesson
catching a live instance: **the probe is what proved the test, not the green run.**

### 6. Parity, because the predicate is duplicated

The script re-implements "does this node carry inputs?" because the guard's copy
is module-private. Two definitions of one predicate is how a tool ends up
measuring a population the guard does not act on, so parity is asserted
**behaviourally** against the real `preserveDroppedFields` — including that
`inputs: {}` arms neither.

### What this does NOT do

- **Run against production.** It needs a read-only DSN and someone with access.
  The numbers are not in this ADR because they have not been taken; writing a
  plausible figure here would be the "past-tense claim outliving the code" defect.
- **Repair anything.** Read-only by construction — SELECTs only, no lock.

### 7. What `/code-review` found — including the program's own defect, in my tool

Three real defects, all in the Phase B delta:

**(a) THE TOOL DECLARED AN EMPTY DATABASE CLEAN.** Run against zero rows, the
first version printed `stripped 0 … Every head was classifiable against its own
history.` So a DSN pointing at the wrong database, a drifted `KEY_PREFIX`, or an
empty schema **all produced a clean bill of health**. That is exactly the
"a broken check reads as a passing check" family ADR 0525 is about —
**reproduced inside the tool built to measure it**, which is how this class
survives: it is invisible from inside the artifact that has it. Zero heads is now
a REFUSAL with a non-zero exit (3) and two SQL probes to confirm the connection,
and the refusal is triggered by an EMPTY POPULATION rather than by "no findings",
so a genuinely clean database can still be reported clean.

**(b) THE PARITY TEST PROVED AGREEMENT, NOT PARITY.** It asserted two cases — a
populated object and `{}` — and both implementations agreed on both. They did
not agree in general: the script had added a `typeof n.inputs === 'object'` test
that reads like a tightening, and for `inputs: "abc"` the guard counts 1 (because
`Object.keys('abc')` has length 3) while the script counted 0.

The failure direction is the dangerous one. A revision the guard treats as
input-carrying scored 0 here, so its head fell out of `stripped` and into
`unknowable` — an **undercount**, which reads as good news. Fixed by making the
predicate character-identical to `preserveDroppedFields.ts:53` and driving parity
from a **ten-row value matrix** including the truthy non-objects. Sabotage:
reintroducing the `typeof` test now reddens the string row specifically.

> Deliberately NOT "improved" while fixing it. The string behaviour may well be
> wrong — but it is wrong in the *guard*, and this tool's job is to measure the
> population the guard ACTS ON, not the one a better guard would act on. Changing
> it there is a behaviour change with its own tests, not a decision a measurement
> script makes unilaterally.

**(c) `--json` hid the parse-failure warning.** Unparseable rows are excluded and
warned about on **stderr**, which is invisible to anything consuming stdout — so
a machine reader saw a smaller-than-real population with no signal at all.
`parseFailures` and `refused` now ride the JSON object.

Also fixed: `loadPg()` reported "could not load `pg` — run npm ci" for *every*
failure, misdiagnosing the case that matters (pg installed but throwing on
import). It now keeps the first error and distinguishes not-installed from
failed-to-load. It also resolves the **package** rather than `pg/lib/index.js`,
a private path a major version is free to move.

Confirmed clean: the three `LIKE` prefixes match what the code writes
(`hostext:<name>:<id>` per `hostExtPersistence.ts:236`, so
`hostext:workflow:revision:%` and `hostext:workflow:ownership:%` are right, and
`hostextidx:` cannot false-match because position 8 is `i`, not `:`); no jsonb
operator is applied to the TEXT `v` column (JSON is parsed in Node); no user
input reaches an import specifier; and the tool issues **SELECTs only** — zero
write verbs, no `BEGIN`, no lock.

### 8. What `/ux-review` found

The skill's three modes (marketing site, `frontend/react/src`, spec corpus) all
**fail to apply** — this phase changed no React surface, no CSS, no token and no
route. Recorded rather than padded with a design-system section that would have
graded nothing.

The surface that does exist is the **operator-facing CLI output**: a terminal
report a steward reads once, under time pressure, to decide whether a guard can
be retired. Four fixes:

- **The NOTE split `OPENWOP_WORKFLOW_REVISIONS_KEEP` across a line break** at 80
  columns — making the one environment variable a reader might act on
  un-greppable and un-copyable. Now word-wrapped at 78; every line fits.
- **`poisoned rollback targets (DD-0524-1)`** was insider shorthand. A bare
  tracker ID tells a reader nothing; it is now *"stripped revisions still
  restorable"* with a two-line gloss, keeping the ID as a cross-reference rather
  than as the explanation.
- **`heads attributable to no tenant`** did not say why it matters. Now *"heads
  owned by no tenant — shared fixtures and seeded definitions, no one tenant to
  notify."*
- **The no-args message listed two flags and no exit codes.** It now documents
  `--json` and states all three exit codes, so the `3 = REFUSED` contract is
  discoverable without reading the source.

Confirmed good: no ANSI colour, no emoji, no box-drawing — it pipes to a file and
reads aloud cleanly; the `UNKNOWABLE` bucket appears in both the table and the
NOTE; and no single figure is presented as the answer.

---

## Phase C — the repair, and why it is NOT a migration (2026-08-05)

Ships `scripts/repair-stripped-workflow-inputs.mjs`: restores node `inputs` to
heads that lost them, sourced from the workflow's own most recent revision that
carried any. **Dry-run by default; `--apply` writes.**

### The central decision: not an `APP_MIGRATIONS` entry

The obvious shape is version 16 — versioned, single-shot, self-running on deploy.
Rejected, because of a gate set one phase earlier: **Phase C is gated on Phase
B's numbers, and B has not been run against production.** An `APP_MIGRATIONS`
entry is an automatic, unreviewable, host-wide rewrite of tenant-owned durable
state with an unmeasured blast radius.

Shipping one anyway would be exactly the mistake ADR 0504 records me *not*
making once before: there I built a correct gate, measured that it would block
114 of 169 chains, and did not ship it. Writing the gate and then ignoring it one
phase later would make the gate decorative. Promoting this to a migration is a
few lines once the numbers exist.

### Why the repair is safe today — and why that is time-limited

Restoring inputs onto a head where the user **deliberately cleared** them is data
loss in the other direction. That is not expressible today: the Inspector's
preset-inputs section is read-only, the same fact ADR 0524 §4 relies on for the
guard's discriminator.

**It stops being true the day Phase E ships.** So this must run BEFORE E — the
mirror of E's own dependency on E0. Recorded here rather than left implicit,
because the ordering constraint is invisible from either phase alone.

### Replay/fork: safe for two independent reasons

Node ids are untouched — this is a surgical field restore, never a re-expansion
(the ADR 0508/0498 lesson: re-expansion changes every id because
`deterministicExpansionId` hashes `chainId@version:params`). So a run resolving
HEAD still matches its checkpoints by nodeId. And a run that stamped
`run.metadata.definitionRevision` keeps resolving its own revision row, which is
content-addressed and additive.

### Idempotent by construction, not by a marker

After a repair the head carries inputs, so the `now === 0` precondition fails and
a second pass plans nothing. No sentinel row to get out of sync, no clock, no
random id. Asserted directly: the test re-plans the repaired output and requires
null.

### What it refuses to do — the assertions that protect user data

The dangerous failure is not "failed to repair", it is "repaired something it
should have left alone". Four refusals, each sabotage-probed:

| Refusal | Why |
|---|---|
| a head already carrying inputs on any node | the whole-set precondition; a partial repair would overwrite visible values |
| a node whose `typeId` changed | inputs are shaped for a node schema — restoring across a type change produces values that match the wrong one |
| a node the head deleted | stays deleted; matches the guard's surviving-node-id rule |
| a node the head added | inherits nothing |

Plus: `variables` restore only when the head declares none (so restored
`{type:'variable'}` refs resolve), and revisions are scoped per workflow — a
cross-workflow leak would write one workflow's authored values into another.

### Anti-vacuity, carried over from Phase B

Zero heads is a **refusal**, not "nothing to repair". A wrong DSN must never read
as a healthy database — the same rule the measurement tool learned the hard way
when its own first version declared an empty database clean.

### What Phase C does NOT close

- **`DD-0524-1` (rollback) remains open.** Rollback is deliberately exempt from
  the guard — merging the current head's inputs into an older revision produces a
  Frankenstein definition, worse than either endpoint — so the honest fix is
  *disclosure at rollback time* ("the revision you are restoring carries no
  inputs while the current head does"), not a merge. That is a route + UI change
  and is sequenced with Phase E, whose surface it shares. Phase B counts the
  poisoned targets so the hazard is sized rather than merely named.
- **Running the repair.** It has not been run anywhere; no production numbers
  exist. Stated so no later reader infers from this record that the population
  was repaired.

### §Correction (2026-08-05, post-merge) — the repair keyed on a field that does not exist

`planRepair` shipped keyed on `n.id`. **The node identity field is `nodeId`**
(`executor/types.ts:403`) — the same one `preserveDroppedFields` keys its own
restoration on, thirty lines from the code I was mirroring.

**The failure was not a harmless no-op.**
`new Map(nodes.map(n => [undefined, n]))` collapses to a SINGLE entry, so
`get(undefined)` returned the **last** source node for **every** node, and the
repair would have written one node's inputs onto all of them. On a mail node that
is another node's recipient address — silent cross-node contamination, in a tool
whose entire purpose is restoring authored values correctly.

**Why 20 tests missed it:** every fixture used `id` too. The tests exercised a
node shape the product never produces, so they encoded my belief about the shape
rather than the shape. This is the recorded "my tests pin INTENT, not behaviour"
failure, and it is the second time in this program that a test agreed with the
code because both were wrong in the same way (the parity test was the first).

**Why no gate caught it:** `RepairNode` declared `id: string`, so the wrong code
typechecked. A declaration that names a field the runtime lacks does not fail to
compile — **it makes the wrong code compile**. Third instance of the
declaration-lies class in this program.

Two independent layers now:

1. **A structural guard** — if a definition has nodes but none yields an
   identity, `planRepair` THROWS rather than "restoring" against an empty map.
   A rename fails loudly instead of silently mis-restoring.
2. **A value-level regression test** — two nodes with distinct inputs, asserting
   each keeps *its own*. Every prior test used one input-carrying node or
   asserted only a count, so none of them could distinguish a correct key from a
   broken one. Sabotage-verified in both directions.

**Blast radius: zero.** The tool is dry-run by default and has never been run
anywhere — which is the only reason this is a correction and not an incident.
The measurement tool is unaffected: it reads `n.inputs` and never keys on node
identity.

---

## Phase E0 — the client field-contract marker (2026-08-05)

The prerequisite ADR 0524 §Open names for editable preset inputs: *"a client
field-contract marker would let the SPA declare which fields it modelled, making
the merge unnecessary rather than heuristic."*

### The shape: a request header, not a body field

`POST /v1/host/openwop-app/workflows` validates `req.body` **as** the definition
(`routes/workflows.ts:306`) — there is no envelope. So a marker had three
possible homes, and only one is right:

| Option | Verdict |
|---|---|
| a field on the definition | **No** — it would be persisted and replayed. This is request metadata about the *sender*, not content. |
| wrap the body in an envelope | **No** — a breaking change to every existing client, to carry one hint. |
| **an HTTP header** | **Yes.** `x-openwop-field-contract`, joining the existing `x-openwop-client-*` family. No body-shape change, and structurally incapable of reaching durable state. |

### The rule that is easy to get wrong

**The contract describes the SOURCE OF TRUTH, not the serializer.**

Every save lane in this bundle shares one corrected `serializeWorkflow`, so
sending the header from all of them looks obviously right. It is not, and the
failure is severe: the runs index and the chat `@workflow` mention serialize from
**localStorage**, where a `SavedWorkflow` written by a pre-0523 bundle carries no
node `inputs`. A correct serializer faithfully emits the nothing that is there —
so a declaration from those lanes would tell the server that stale data is an
intentional deletion, and **the server would delete the head's inputs**. That is
verbatim the harm this ADR exists to prevent, re-introduced through the mechanism
built to make it unnecessary.

Only the **builder store** declares. This is enforced by a call-site **ratchet**
rather than a unit test, because the mistake is a call site — a reviewer adding
the header to a third lane "for consistency" is the entire risk. Sabotage-proven
in both directions.

### Behaviour

Per-field, not all-or-nothing: declaring `variables` leaves the `inputs` guard
armed. An absent header means "the client said nothing" and keeps the heuristic —
which is the safe default, because the clients that *cannot* send this header are
the entire population the guard exists for. The **collab lane keeps the
heuristic permanently**: a Y.Doc derive has no request to carry a header.

**Trust:** a client that lies affects only a workflow it already owns and is
already sending the full content of. It cannot widen access — only decline a
repair of its own row.

### A sabotage probe found an over-claim in my own docblock

I documented the parser's closed-world rule as protection against a client
disabling a guard it was not granted. **A sabotage that opened the parser to
arbitrary tokens turned nothing red**, because `models(f)` tests an exact field
name — a junk token is inert whether stored or dropped. The route assertion I had
written for it was **vacuous**, and the claim was wrong.

What the rule actually buys is **forward compatibility**: the day a fourth field
joins `PreservableField`, an old client that had been sending that name
speculatively would suddenly be declaring a contract it never implemented. That
property is only visible at the parser, so it is now asserted there directly
(`field-contract-parse.test.ts`) — and the route test carries a note saying
exactly what it does *not* prove.

### What E0 does NOT do

- **It does not retire the guard.** Stale bundles and cached SPAs — the entire
  affected population — will never send the header. E0 makes the merge
  *unnecessary for clients that declare*, not unnecessary.
- **It does not unblock E on its own.** Phase C must still be RUN before editable
  inputs ship, and it has not been run anywhere.
- **No RFC.** A header on a non-normative `/v1/host/openwop-app/*` route; nothing
  on the wire changes.

### E0 review pass — what the gates and reviews found

**My own steward-probe gate had a false positive, and it was red on `main`.**
`check-steward-probes` rejected `hostext:dashboard%` in a peer's #2972 — a
deliberate wildcard over the `dashboardlayout` + `dashboardnote` family, in a
`GROUP BY` discovery query whose own text says so. That is the failure this
gate's docblock warns about in its own words: *"a gate that cries wolf gets
ignored, which is how the unrunnable one survived."*

The corrected rule accepts a non-segment-boundary literal **only** when it ends
in a wildcard *and* is a prefix of a real collection. Both halves are
load-bearing, because with a trailing `%` a truncated literal can only
over-match, never under-match — and under-matching (a silent zero read as health)
is the entire defect class this gate exists for. Probed all three ways:
`dashboardzz%` still fails, the no-wildcard truncation still fails, the peer's
probe passes.

**Call-site audit.** The guard has exactly two callers. `routes/workflows.ts`
passes the parsed header; `collab/workflowCollabResource.ts:132` passes nothing
and therefore keeps the heuristic — correct and permanent, since a Y.Doc derive
has no request to carry a header. Recorded so nobody later "fixes" the collab
lane by inventing a contract for it.

---

## Phase E prerequisite — recording WHETHER THE AUTHOR MEANT THE ZERO (2026-08-06)

Phase C's record said editable preset inputs must wait until the repair had been
run, because *"restoring inputs onto a head the user deliberately cleared would
be data loss in the other direction."* That framing made E wait on an operational
event nobody has performed. **It is fixable in code, and this fixes it.**

### The actual problem

Two heads carrying zero inputs are byte-identical in durable state:

| | how it got empty | correct treatment |
|---|---|---|
| an old bundle stripped it | never authored | **repair** |
| a user cleared it | authored | **leave alone** |

Nothing in `wfreg:` or the revision content distinguishes them. Phase C avoided
the ambiguity by requiring the repair to run *before* clearing became possible —
a sequencing constraint standing in for a missing fact.

### The fact, recorded

Phase E0 already made clients declare which fields they model. That declaration
was consumed and discarded. It is now **stamped on the revision** as
`declaredFields`, and `planRepair` refuses any head whose **latest** revision
declared `inputs`.

- **The revision record is the right home.** It is a host-owned envelope *around*
  the definition, already carrying non-definition facts (`tenantId`, `createdBy`,
  `seq`). A marker inside the definition would be persisted and replayed — the
  same objection that made E0 a header rather than a body field.
- **Content addressing is untouched.** `revisionHashOf` hashes the DEFINITION
  (`definitionHash.ts:29`), so the stamp changes no key, breaks no dedup, and is
  invisible to replay and `:fork`.
- **Only the SAVE lane stamps.** Rollback restores a historical definition and
  must not inherit the restorer's contract as if the original author had declared
  it.
- **Latest wins, by `seq`.** A user who declares a clear and then hits the
  runs-index lane on a stale bundle is back to a real strip — asserted directly.

### My own test caught a real gap

`recordRevision` short-circuits when the content already exists. My first cut
stamped only inside the *reorder* branch, so **re-saving an already-empty
workflow from the builder — precisely how a user CONFIRMS the zero is
deliberate — left the row unstamped** and the repair free to resurrect it. The
upsert path now records a newly-arrived declaration, without moving `seq` (a
stamp is not a reordering, and every autosave echo would otherwise churn history).

Three sabotages, each reddening its own assertion: stamping unconditionally (the
no-header control catches it — without that control the whole feature would pass
against an implementation that marks every old-bundle strip as deliberate);
ignoring the stamp in the repair; and reading the oldest revision instead of the
latest.

Wiring is asserted at the **route**, reading durable state after a real POST,
because the stamp is deliberately not exposed on the history route — it is repair
metadata, not user-facing history. ADR 0502, paid for twice: mechanism and wiring
fail independently.

### What this does and does not unblock

**Unblocked:** E no longer depends on the repair having been run. The hazard that
required the ordering is now decided per-workflow by recorded fact.

**Still true:** the repair has never been run anywhere, so the *stripped
population itself* is still unrepaired. That is a separate, non-blocking fact —
it means some users still see empty preset inputs, not that editing is unsafe.

**Phase E itself — the editable Inspector section — remains unbuilt.**

---

## Phase E — editable preset inputs (2026-08-06)

The surface every earlier phase was clearing the way for. One gesture had to
become safe: **a user removing a preset input, and it staying removed.**

### The risk was retired empirically as well as structurally

`PHBC-3` ran the Phase B measurement against production: **199 registered heads,
0 stripped, 0 restorable stripped revisions, 0 tenants affected.** So the
repair-collision hazard that gated E has an *empty population* — and the
`declaredFields` stamp makes it impossible regardless. Both halves, not one.

(The same run recorded **186 UNKNOWABLE** heads. That is not a Phase E concern —
those carry no inputs at all, so editing them is authoring, not overwriting.)

### Only losslessly-round-trippable values are text-editable

Preset values are not all strings:

| shape | treatment |
|---|---|
| `'a string'` | editable |
| `{type:'static',value}` | editable, **envelope preserved** |
| `{type:'variable',variableName}` | **read-only, with a reason shown** |
| anything else (JSON fallback) | **read-only, with a reason shown** |

An RFC 0124 variable ref renders as `{{topic}}` — that is a *rendering of a
structure*, not the value. A text box over it invites the user to turn a live
reference into a literal, silently. So the two editable shapes are exactly the
two that survive a text round-trip unchanged, and a non-editable value **says
why** rather than presenting a control that quietly does nothing.

Editing a `{type:'static'}` value writes the envelope back, never a flattened
string — a format change the executor reads structurally would be silent.

### What is deliberately NOT built

**Adding a NEW port.** The section renders only when a node already carries
inputs, and adding a port needs the node's input-port catalog — a different
surface with its own schema questions. Every hazard this ADR documents is about
a value being *removed or resurrected*, never about one being added, so this is
a scope boundary rather than a gap in the fix.

### Review findings

- **A design-system gate caught a raw `<button>`** (`check-unwrapped-buttons`,
  238 → 239). Switched to the shared `ui/Button`. The gate was right; raising
  the baseline would have been the wrong fix.
- **An accessible-name defect I nearly shipped:** the visible label is the
  sibling `<dt>`, which gives the input *no accessible name at all*. The field
  now carries a visually-hidden label naming its port.
- **An existing ADR 0523 test had to move**, and is annotated rather than
  quietly edited: those values are now in inputs, so the assertions went from
  `getByText` to `getByDisplayValue`. Deliberately not weakened to a substring
  match — that would have hidden the behaviour change instead of recording it.
- **My first test seeded state the product cannot produce** (a hand-written
  node literal with an unknown `typeId`), so the Inspector short-circuited and
  the section never rendered. The **fixture guard caught it**. Re-seeded through
  the store's own `addNode`/`updateNode`.

Three sabotages, each reddening its own assertion: clear the whole `inputs`
object instead of emptying it; make a variable ref text-editable; flatten the
static envelope on edit.

### The copy was a lie until now

`presetInputsNote` said *"These can't be edited in the builder yet."* Corrected in
all four locales — a past-tense claim outliving the code is the recorded defect
this repo has hit repeatedly.

> **CORRECTION TO THE CORRECTION, 2026-08-21 (ADR 0595 §Correction 1) — measured.**
>
> The note above says `SavedWorkflow` models **neither** `settings` nor node
> `compensation`. Half of that is false, and it matters because it was the
> evidence for widening the guard.
>
> - `settings` — correct. No occurrence anywhere under
>   `frontend/react/src/builder/schema/`.
> - `compensation` — **wrong.** The builder carries it VERBATIM in both
>   directions: `workflow.ts` (*"Preserved VERBATIM rather than modelled —
>   round-tripping what you cannot edit is the whole job"*), `serialize.ts`
>   (*"emit the inverse action back … omitting it here made every builder save
>   delete the compensator on a chain-instantiated workflow"*), `deserialize.ts`.
>   It was added precisely because dropping it had been found three times.
>
> So on a CURRENT builder bundle an absent `compensation` is **not** a
> bundle-capability signal. The population it is a signal for is a pre-fix
> bundle, a localStorage-sourced `SavedWorkflow` written by one, and the AI
> author — which is still a real population, so the widening stands. Only the
> sentence justifying it was wrong.
>
> The widening ALSO needed an exit that the first cut did not have: unlike the
> other four fields, `compensation` has no representable "explicitly cleared"
> form (RFC 0151 §B is closed with `nodeTypeId` required, so `{}` is a 400 and
> `null` normalizes to omission), which made it permanently undeletable. See
> ADR 0595 §Correction 1 for the mechanism and the cure — a lane that can intend
> a deletion must be able to DECLARE it, via this ADR's own Phase E0 seam.
