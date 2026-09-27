# ADR 0595 — The AI Workflow Author's durable-write contract: integrity, ordering, and the second write lane

Status: implemented (2026-08-21)

Feature 25/71 (AI Workflow Author, ADR 0072) was graded by three independent
lanes on `origin/main` @ `3fe8aba16` and returned the worst result of the loop:
**20 Blocker rows resolving to 16 distinct defects** (code **B−**, UX **C−**,
workflows **C** — `docs/steward/{CODEBASE,UX,WORKFLOWS}-ASSESSMENT.md`). This ADR
covers the **data-integrity and authority** half (PR-A). The honesty/reachability
half — `WFAC-2`/`WFAWF-10` success-with-empty, the "opens on the canvas" promise,
the `builtinWorkflows` doc rot, acyclicity, `SCHEMA_READ_EXEMPT_TOOLS`, node-pack
test coverage — is PR-B and is **not** addressed here.

`CLAUDE.md` cites this feature's `draft → validate → persist` as one of two **A+
reference implementations** for the AI-exchange lanes. All three graders tested
that claim rather than inheriting it and falsified it. This ADR closes the
integrity half of the falsification; the citation should not be restored until
PR-B lands.

## The seven decisions

| Gap | Decision |
|---|---|
| `WFAWF-1` | Run `preserveDroppedFields` on the author lane, **reversing ADR 0524's exemption**; widen `PreservableField` 3 → 5. |
| `WFAWF-5` | Record ownership **before** the definition. |
| `WFAC-1` = `WFAWF-4` | **Await** the durable definition write (`registerWorkflowDurable`). |
| `WFAC-4` = `WFAWF-3` | The two write doors agree on **legality**; the review gate stays lane-specific. |
| `WFAWF-7` | The host **discards** any caller-supplied `metadata.lifecycle`. |
| `WFAWF-2` | Stamp ADR 0369 §5 `transient`/`generatedBy` — **on create only**. |
| `WFAWF-8` | Wire the `wfreg:` purge into the anon-tenant teardown daemon. |

---

## 1. `WFAWF-1` — the exemption this reverses

`persistAuthoredWorkflow` never called `preserveDroppedFields`. The grader filed
that as an oversight. **It was not.** ADR 0524 §Exemptions says, verbatim:

> **Workflow-author persist** regenerates a whole definition; merging would
> resurrect inputs the author intentionally replaced.

So this is a **reversal of a recorded decision**, and it is recorded as one
rather than slipped in as a call-site addition.

**Why the exemption no longer holds.** Its premise is that the lane only ever
*regenerates*. That was true when it was written. It stopped being true when
`XCH-WFA-1` added the `get` tool and the Architect prompt began actively
instructing get-then-revise (`workflow-architect.md:17-20`: *"When the user asks
to CHANGE or EXTEND a workflow, call this FIRST and revise the real
definition"*). The lane is now **also** a revise lane, and on a genuine
regeneration the id is fresh, so `previous` is `null` and the helper is a no-op
anyway. The exemption costs nothing on the case it was written for and destroys
data on the case that appeared later.

**Why the exemption's fear does not bite.** "Merging would resurrect inputs the
author intentionally replaced" describes an *unconditional* merge. ADR 0524 §4
had already replaced that with the **whole-set discriminator**: the merge fires
only when the incoming definition carries the field on *zero* nodes while the
head carried it on at least one. A model that replaces inputs on some nodes
leaves the count non-zero and **nothing merges**. On this lane the discriminator
is *more* reliable than on the builder lane it was designed for, because the
authoring brain's `RESPONSE_SCHEMA`
(`packs/feature.workflow-author.nodes/index.mjs:44-80`) **provably cannot
express** these fields — a capability fact, not a heuristic.

### The prescription was incomplete, measured

The brief and the grader both said "call `preserveDroppedFields`", and named six
lost fields. Reading the helper rather than the sentence: `PreservableField` was
`'inputs' | 'variables' | 'configurableSchema'` — it covered **two** of the six.
`settings`, `metadata`, node `compensation` and edge `condition` are all accepted
and persisted by `validateWorkflowDefinition` and none of them were protected.

**Decision: widen the set to five, from the one owner** —
`+ 'settings' | 'compensation'` — rather than adding a second, lane-local merge.
This is a legitimate one-owner move, not scope creep, and the evidence is that
the REST lane needed it too: the builder's own `SavedWorkflow`
(`frontend/react/src/builder/schema/workflow.ts:109-134`) models **neither**
`settings` nor node `compensation`, so a builder save has been stripping them all
along. The guard had simply never been asked about them.

`compensation` is the one with teeth. `workflowDefinitionValidation.ts` already
records what losing it costs: the executor "would then mint no obligations and an
unwind would report a clean `none` for a run that committed real effects".

**The node-field ITERATION is hoisted, not copied.** `inputs` and `compensation`
share the whole-set test, the prior-by-id map and the surviving-node re-attach.
A second field must not mean a second copy — that shape (N hand-written copies,
two of them half-right) is this repo's dominant fix-defect. One
`restoreNodeField(next, previous, field)`, called in a loop.

### Two fields deliberately excluded — on mechanism, not effort

- **`metadata`** — the author lane **writes** it (`draft` stamps
  `metadata.authoring`; §5 below stamps `metadata.lifecycle` server-side), so it
  is never a whole-set omission, and a wholesale restore would fight both
  stampers. Two new rules over one field in one PR is the reintroduce-the-family
  shape.
- **edge `condition`** — there is no stable key to restore onto. Node `inputs`
  re-attach by surviving `nodeId`; edge ids are *regenerated* per authoring pass
  (`e1`, `e2`, …), so a re-keyed restore is verbatim the stale-attachment hazard
  ADR 0523 §Q3 names. **Open residual**, stated rather than quietly dropped.

### Not silent

Per ADR 0524 §5, the merge is disclosed all the way out: `persistAuthoredWorkflow`
returns `preservedFields`, `surface.ts` puts it in the node's outputs, and the
chat tool returns it with an instruction to tell the user *which* fields were
kept and how to genuinely clear one. A merge nobody can see is a silent success
wearing the costume of a fix.

## 2. `WFAWF-5` — ownership before the definition

The old order was `registerWorkflow` → **awaited** `recordRevision` →
`recordOwnership`. A throw in the middle left a definition **permanently
registered and permanently unowned**, and that is not merely "invisible to
`/builder`" — `listAuthoredWorkflows` classifies a registered-but-unowned
definition as a host **BUILT-IN** (`const isBuiltin = !authored.has(...)`), so it
becomes readable by **every** tenant and overwritable by **none**, its own author
included (`isBuiltinWorkflowId` then 409s them). **Verified, not inherited**: the
witness constructs the stranded state and asserts a stranger sees it.

Ownership-first inverts the failure. A lost definition write leaves an ownership
row pointing at nothing — invisible (the registry listing never sees it),
harmless, and re-writable by its owner on retry, because `getOwned` now returns
true and the self-overwrite path opens.

**Correction to the grader's framing.** The ADR 0369 §5 stamp (§6 below)
*narrows* this hole incidentally — a born-transient draft is catalog-hidden from
non-owners, so a stranded fresh draft is not exposed. It does **not** close it: a
workflow the user promoted, whose ownership row later vanishes, is fully exposed.
The ordering carries the invariant; the stamp does not.

## 3. `WFAC-1` = `WFAWF-4` — await the durable write

`registerWorkflow` fires `void storage.kvSet(...).catch(log.warn)`. Everything
after it on this lane was awaited, so a lost write returned 201 over a definition
no other instance can resolve — while the tool had already told the user *"it is
open in the builder"*.

`registerWorkflowDurable` exists **precisely** for this, added by ADR 0473 D5 for
the sibling compose lane under a comment naming the identical hazard. **Match the
sibling, don't invent a second shape.** The witness makes the `wfreg:` write fail
and asserts the call rejects instead of reporting success.

## 4. `WFAC-4` = `WFAWF-3` — the authority ruling

The Workflow Architect holds **two** durable-write doors and picks between them
by inferring intent from prose (`workflow-architect.md:32-42`). Each lane has
exactly what the other lacks:

| | `…nodes.persist` | `openwop:workflows.propose` |
|---|---|---|
| closed-world typeIds | **yes** | **no** — its step 2, `capabilityGatedTypeIdRefusal`, is a documented no-op (`void nodes; return null`) |
| review gate (CAS + hash re-verify) | no | **yes** |
| transient cap | no | **yes** |
| effect if approved/used | an inert artifact a human must choose to run | **starts a run** |

Four options were weighed (`/architect`, options-evaluation mode).

- **O1 (the grader's) — route chat `persist` through `registerTransientDraft` +
  a review card. REJECTED.** It over-gates the *inert* lane (a review card for
  "save the workflow I just asked you to build"), breaks the documented
  open-in-the-builder flow and an existing test, and — decisively — **does not
  close the defect it names**: `propose` still has no closed-world check, so the
  two lanes still disagree. It inverts the disagreement rather than removing it.
- **O3 — one `composeDurableDraft(review: boolean)`. REJECTED.** The lanes differ
  in five ways at once (transient stamp, cap, id-takeover refusal,
  overwrite-your-own vs mint-fresh, hash pin). A boolean selecting five
  behaviours is a false unification.
- **O4 — delete the chat `persist` tool. REJECTED.** Authoring a workflow the
  user can open is the Architect's headline job.
- **O2 — ADOPTED.** *Legality is lane-independent; the review gate is
  lane-dependent, and that difference is legitimate because the lanes have
  different effects.* `prepareComposedDraft` now calls the **same core
  `findUnknownTypeIds`** the author lane calls — a second **call site** of one
  owner, never a third copy. Whichever door the model picks, an invented typeId
  is refused. **Reported, not thrown** — the agent repairs from the message.

The hole this actually closes: a model could propose a definition naming a typeId
that does not exist, a human could approve it, and it would `unknown_typeid` at
dispatch. The reviewer approved something that could never run.

### The resource half — one budget, not two

`propose` has been capped at 25 live transient drafts since ADR 0473 while
`persist` was **unbounded**, so the Architect could mint unlimited durable
workflows simply because the user's phrasing sent it through the other door.
`persist` now enforces the **same** bound, by importing `transientCapReached`
from the one owner rather than growing a second counter — a per-lane cap would
let an agent double the ceiling by alternating doors, which is the very
lane-shopping this section closes.

Two details the witness pins: the cap applies **on create only** (overwriting a
draft the tenant already owns adds nothing to the budget, and a cap that blocked
editing what it capped would be a gate with no exit), and **archiving frees
budget**, so the refusal names an action that actually works.

**Named residual:** a *promoted* workflow is uncounted by design — it has left
the draft budget. A distinct permanent-workflow quota is a product decision with
its own refusal path and belongs in its own ADR.

## 5. `WFAWF-7` — lifecycle is not model-writable

`validateWorkflowDefinition` passes `metadata` through wholesale, `lifecycleOf`
reads `metadata.lifecycle` out of it, so a model could persist
`lifecycle.archivedAt` and mint a **born-archived** — catalog-hidden — workflow
while the tool truthfully reported *"registered … open in the builder"*. Model
output writing its own visibility is the inverse of the lane's law and produces a
dishonest success.

`withHostLifecycle` (new, in the one lifecycle module) **discards** the
candidate's block and writes the host's. Note `withLifecycle` alone would **not**
have been enough — it merges *onto* `lifecycleOf(def)`, i.e. onto the model's,
which is the same hole one layer down. Sabotage S5 confirms it.

## 6. `WFAWF-2` — ADR 0369 §5 stamping, **on create only**

The ADR's decision (`0369:140-143`) was entirely unimplemented: authored
definitions were born permanent, structurally GC-immune
(`runRetentionSweeper.ts:192` — `if (!lc.transient || !lc.archivedAt) continue`)
and cap-exempt. `generatedBy: 'workflow-author'` existed only in a doc comment.

**Correction to ADR 0369 §5 — implementing it verbatim would have shipped a
regression.** §5 says drafts are stamped transient *"at creation"* and that
**Save = promote**. A stamp applied to *every* write would **demote** an
already-promoted workflow the moment its owner asked the AI to tweak it —
silently pulling a saved workflow out of the `/` picker as a side effect of an
edit, with re-promotion gated behind a fresh green run and green evals. So the
stamp fires **only when the tenant does not already own the id**; a revise
inherits the head's lifecycle verbatim. Witnessed directly.

**Second correction, found by the witness.** Stamping `transient` alone would
have hidden the tenant's own fresh draft from `listAuthoredWorkflows` (which
filters through `catalogVisible`), so the Architect could not `get`-list the
workflow it had just authored — breaking read-before-write on the very next turn.
`listAuthoredWorkflows` now asks for transient rows and re-applies the filter
per row, showing the caller's **own** drafts and hiding host/foreign ones. This
mirrors the decision the scoped REST list already made in so many words:
*"Transient DRAFTS stay VISIBLE here — this is the owner's own scoped list."*
A fix that reintroduces the family it closes is 3× worse than the bug.

## 7. `WFAWF-8` — teardown reachability, per lane

`purgeTenantOwnedWorkflowDefs` had exactly **one** caller,
`routes/account.ts:150`. The anon-tenant teardown daemon leg called
`purgeHostExt` / `purgeToggleOverrides` / `deleteAllTenantData` /
`purgeTenantVectors` and **not** this — and `wfreg:` rows carry no JSON
`tenantId`, so they sit outside the `hostext:` walk by construction. Every
workflow an anon tenant authored was orphaned **permanently**.

Both lanes are witnessed separately. *Reachability is proved PER LANE — a shared
helper with one caller is a helper with one lane.*

Two implementation notes, both load-bearing:

- **The hook is REQUIRED, not optional.** A caller passing a partial
  `AnonTeardownHooks` object is now a **compile error** rather than a silently
  skipped purge. Absence must be a claim someone has to make.
- **The runless run-EXISTS probe is hoisted above the purge.** It was a
  `continue` *inside* the else-branch. Purging first would have destroyed an
  active tenant's workflows and *then* declined to tear the tenant down — a fix
  strictly worse than the bug. Hoisting keeps one call site and leaves the
  probe's semantics identical.

---

## Probes run

- **P1 (the report's flagged inference — "if wrong, the feature is dead on
  arrival"): CONFIRMED.** After `loadWorkflowChainPacks`,
  `buildChainBackedDefinition('openwop-app.workflow-author')` yields
  `variables = [{ name: 'intent', type: 'string', required: true }]` and the
  `draft` node's `inputs.intent = { type: 'variable', variableName: 'intent' }` —
  **not** the frozen `''` the RFC 0013 Path-A hazard would produce, and not the
  literal `{{params.intent}}`. The deferred-materialization + un-prefix restore
  works. No `intent_required` dead-on-arrival.
- **P4 (free, same probe): CONFIRMED.** Two builds in one process are
  byte-identical — `expandChain` + the un-prefix restore + `postProcess` are
  deterministic.

## Witnesses

`backend/typescript/test/workflow-author-write-integrity.test.ts` — 21 cases.
**Every one was written before the cure and watched fail** (8 born red on the
first complete run, each on its own assertion). **11 sabotage probes**, each
reddening its own assertion and nothing else:

| # | Sabotage | Reddens |
|---|---|---|
| S1 | drop the `preserveDroppedFields` call | W1 revise |
| S2 | restore register-before-ownership | W2 fault injection |
| S3 | `registerWorkflow` (fire-and-forget) | W3 |
| S4 | remove the propose closed-world check | W4 |
| S5 | `withLifecycle` instead of `withHostLifecycle` | W5 |
| S6 | don't stamp `transient` on create | W6 |
| S7 | remove the daemon `wfreg:` purge | W7 lane 2 |
| S8 | drop `compensation` from the shared node-field loop | W1 |
| S9 | drop `settings` from the def-level companions | W1 |
| S10 | hide the tenant's own transient drafts | W6 listable |
| S11 | remove the `persist` cap check | W4b |

Sabotage proves an assertion is load-bearing; it cannot invent one nobody wrote.
So each assertion was derived from the mechanism first — e.g. W2's fault
injection had to re-init `hostExtPersistence`, not just the durable store,
because the ownership index rides a different storage ref; the first draft
injected nothing and reported green.

## RFC gate

**No RFC.** Everything here is host behaviour on the non-normative
`/v1/host/openwop-app/*` surface and on in-process agent tools. No run-event
field, capability flag, event type, endpoint contract or normative `MUST`
changes. `preservedFields` is an additive optional field on a host-extension
response, exactly as ADR 0524 already ruled for the REST lane.

## Replay / fork

- Resolution stays **unfiltered** (`workflowsRegistry.ts:97-99`) — an archived or
  transient definition remains resolvable forever, so replay/`:fork` are
  unaffected by the stamp, which lives in `metadata`.
- Restored node `inputs` **do** change run behaviour — which is the point: the
  pre-fix lane was changing it silently, in the destructive direction.
- No clock or randomness is introduced on any expansion path. P4 re-measured
  byte-stability after the change.

## Open — carried to PR-B or a follow-on

- Edge `condition` is still droppable on a revise (no stable restore key). §1.
- `persist` is uncapped as a count of *permanent* workflows. §4.
- The whole honesty/reachability half of the feature: `WFAC-2`/`WFAWF-10`
  success-with-empty on `draft`, `WFAWF-9` acyclicity, `WFAC-3`
  `SCHEMA_READ_EXEMPT_TOOLS`, `WFAWF-11` the untested node pack, `WFAWF-18` the
  `builtinWorkflows` doc rot, `WFAWF-6` the showcase-seed pin site, and the UX
  rows. **PR-B.**
- `CLAUDE.md`'s "A+ reference implementation" citation should not be restored
  until PR-B lands.

---

# Correction notes — the adversarial-review fold-in (2026-08-21)

An adversarial review of this PR found nine defects. They are recorded here as
**appended corrections**; the text above is left as written, because the point of
the record is the reasoning trail, including where it was wrong.

## §Correction 1 (§1) — widening to `compensation` shipped a gate with NO EXIT

**This is a regression the ADR introduced, and it came from my own brief.** The
brief told the implementer to widen `PreservableField`; §1 above records the
widening as a one-owner improvement. It is, for `settings`. For `compensation`
it was a **new instance of the family §4 warns about**.

ADR 0524's discriminated merge is safe *only because* "explicitly cleared" is
representable. `inputs:{}`, `variables:[]`, `configurableSchema:{}` and
`settings:{}` all validate, so `carries()` stands down and a deletion is
honoured. **`compensation` has no such form.** `validateNodeCompensation`
(`workflowDefinitionValidation.ts`) is a CLOSED RFC 0151 §B block with
`nodeTypeId` **required**, so:

| form | result | reads as |
|---|---|---|
| `compensation: {}` | **400** | not a clear — a validation error |
| `compensation: null` | normalized to `undefined` | **omission** ⇒ resurrected |
| omitted | — | omission ⇒ resurrected |
| two-step (drop, persist, drop again) | first persist restores it | the carrying count never reaches zero |

So a node's inverse action became **permanently undeletable on every shipped
lane** — verbatim the forbidden state `preserveDroppedFields`'s own docblock
names (*"an unconditional merge makes DELETION IMPOSSIBLE"*), reached through a
discriminator that in this one case can never discriminate.

**The cure, and why this one.** Two were on the table.

- **Drop `compensation` from `PreservableField`** and record it as a residual
  beside edge `condition`. **Rejected**: it re-opens a *silent* data loss with
  the worst consequence in the set — the authoring brain's `RESPONSE_SCHEMA`
  provably cannot express `compensation`, so every AI revise of a
  chain-instantiated workflow would delete its declared undo, and the failure
  surfaces only when something has already gone wrong and the unwind reports a
  clean `none` for a run that committed real effects. Trading a silent
  destructive default for a documented explicit one is the wrong direction.
- **Make the clear representable — ADOPTED.** Not with a new `null`-means-delete
  semantic (that would have to be read from the RAW body at each call site, or
  threaded as a side channel out of a validator with many callers — N copies of
  a rule, this repo's dominant fix-defect — and it is ambiguous with serializers
  that emit `null` for absent optionals). Instead the **ADR 0524 Phase E0
  declaration seam that already exists** is made reachable from this lane:
  `persistAuthoredWorkflow` takes `declaredFields`, the surface takes
  `clearFields`, and the `…nodes.persist` agent tool exposes `clearFields` in its
  input schema — parsed by `parseFieldContract`, the *same* parser the
  `x-openwop-field-contract` header uses, so the two lanes cannot drift on which
  tokens are honoured.

**Reachability, per lane** — because an exit nobody can reach is not an exit
(the finding's whole point; the header alone was unreachable from every shipped
client):

| lane | can it intend a clear? | exit |
|---|---|---|
| AI author (agent tool + surface) | yes — the user asks for a removal | **`clearFields`** (new) |
| REST / API client | yes — it can author `compensation` in the first place | `x-openwop-field-contract` |
| builder | **no** — no compensation editor exists | none needed |
| collab derive | **no** — same store, same absent editor | none needed |

Adding `compensation` to `BUILDER_FIELD_CONTRACT` would **not** have been the
fix and was not done: that ratchet exists to stop a lane declaring a contract for
data it may hold only stale.

**§Measured correction to §1's evidence.** §1 says *"the builder's own
`SavedWorkflow` models **neither** `settings` nor node `compensation`, so a
builder save has been stripping them all along."* Half of that is false.
`settings` — correct, no occurrence anywhere under `builder/schema/`.
`compensation` — **wrong**: the builder carries it VERBATIM in both directions
(`builder/schema/workflow.ts` *"Preserved VERBATIM rather than modelled —
round-tripping what you cannot edit is the whole job"*, `serialize.ts` *"emit the
inverse action back"*, `deserialize.ts`), added precisely because dropping it had
been found three times. The population an absent `compensation` is a capability
signal for is therefore a **pre-fix bundle, a localStorage-sourced
`SavedWorkflow` written by one, and the AI author** — not the current builder.
The widening is still right; the sentence justifying it was not.

**Witnesses** (`workflow-author-write-integrity.test.ts`, W8): the two look-alike
clear forms are pinned as *not* clears; the two-step decoy is pinned as
ineffective; the declaration clears on the service, on the agent tool and on the
node-facing surface; a narrow declaration does **not** stand the guard down for
the other fields; and the disclosure note is asserted to name `clearFields` —
because an instruction the caller cannot act on is a dead end, not a disclosure.

| sabotage | reddens |
|---|---|
| S12 service drops `opts.declaredFields` | all three clear cases |
| S13 agent tool drops `clearFields` | the agent-tool route only |
| S14 surface drops `clearFields` | the surface route only |
| S15 note reverts to "say so explicitly" | the disclosure case only |

## §Correction 2 (§5) — `WFAWF-7` was closed on ONE of the two model doors

§5 rules that *"the host discards any caller-supplied `metadata.lifecycle`"* and
notes, correctly, that `withLifecycle` alone would not be enough because it
merges *onto* the model's block. That ruling was applied to
`persistAuthoredWorkflow` and **not** to `registerTransientDraft`
(`workflowComposeTool.ts`) — the shared step 5 of BOTH
`openwop:workflows.propose` and `openwop:workflows.compose-and-run`, i.e. the
sibling door this same PR reached into for its closed-world check (§4).

It called `withLifecycle(def, {transient:true, generatedBy})`, which seeds from
`lifecycleOf(def)` and patches only those two keys — so **`archivedAt` survived
from the model**, one layer down, in exactly the shape §5's own paragraph
describes. Measured end-to-end through the real agent tool: a model-supplied
`archivedAt` returns `status:"pending_approval"` (a reported success) over a
draft that is catalog-hidden and satisfies the GC predicate **from birth**, with
the ownership row — written `transient:true`, no `archivedAt` — disagreeing with
the definition it denormalizes. The user-visible end of it: propose → approve &
run → **Save** calls `promote`, which is `withLifecycle(def,{transient:undefined})`
and **keeps `archivedAt`**, so the workflow disappears the moment the user saves
it.

Cure: `withHostLifecycle` at that call site. **Why no assertion caught it:** W5
covers the author lane and W4 covers the propose lane's typeIds only — nothing
asserted this door's lifecycle at all. Sabotage proves an assertion is
load-bearing; it cannot invent the assertion nobody wrote. W5b (new) is the
W5-shaped case on the propose door; sabotage S16 (revert to `withLifecycle`)
reddens it and nothing else.

## §Correction 3 (§1 "Not silent") — the disclosure died at the pack boundary

§1 says *"`surface.ts` puts it in the node's outputs"*, and `surface.ts` carried
a comment saying the node *"relays it into the run outputs so the disclosure
survives to the surface the user actually reads."* **Both were false as shipped:
the diff contained zero pack changes.** `packs/feature.workflow-author.nodes/index.mjs`
`persist()` builds its own output object without the field, and
`schemas/persist.output.schema.json` is `additionalProperties:false` — so the
field could not even have arrived by accident. The disclosure reached the chat
tool (which the model reads) and died before the RUN outputs (which the run
detail, forks, and evals read).

Closed rather than downgraded, because §1's "NOT SILENT" is load-bearing for the
whole merge ruling. The relay needed **four artifacts moved together** — the
node's emit, the output schema's declaration (`additionalProperties:false` means
an undeclared relay is a contract violation, not a fix), the pack `version` +
`requiredPacks` pin (test-enforced by `required-packs-pin-parity`), and a
regenerated `packs/.steward-manifest.json` digest. A missed digest leg does not
fail loudly: the pack silently stops being `steward` and **stops dispatching**.
`feature.workflow-author.nodes` 1.0.1 → **1.0.2**; the `…nodes.persist` node
1.0.0 → **1.0.1**.

W9 follows the field across all four seams and asserts the schema's closed shape
is preserved rather than opened. Born red on **seam 3 alone**, which is itself
the finding: seams 1, 2 and 4 were real, and only the artifact in the other
repository half was not. S17 (drop the node's emit) and S18 (drop the schema
property) each redden seam 3 and nothing else.

**Residual, disclosed rather than closed: the relay is OUTPUT-only.** `clearFields`
was not wired into the node's *input*. `definition.io.schema.json` is shared by
`validate`/`get`/`persist`, so declaring it there widens three nodes' contracts to
serve one — a worse trade than the asymmetry it removes. The consequence is real
and bounded: **via the in-run meta-workflow a user can create, but cannot CLEAR a
preserved field; only the chat lane can.** That is tolerable today because the
meta-workflow is a create lane, where preservation rarely fires at all — but it is
a statement about how the lane is used, not a structural guarantee, and it is the
same shape as §Correction 1's builder residual. If the meta-workflow ever grows an
edit path, this becomes the identical gate-with-no-exit defect §Correction 1
closed, and the fix is a `persist`-only input schema rather than a widened shared
one.

## §Correction 4 (§4) — "the two write doors agree on legality" was half-done

§4's table compares the doors on closed-world typeIds, the review gate, the
transient cap and the effect. It omits a row that was **false on both model
doors**: the ADR 0194 P3 per-tenant **disabled-pack** curation.

Enumerated by call graph rather than by grep:

| lane | writes a definition | `assertNoDisabledPacks` |
|---|---|---|
| `POST /v1/host/openwop-app/workflows` | yes | **yes** (ADR 0194 P3) |
| revision restore | yes | **yes** |
| `…/workflows/from-chain` | yes | **yes** |
| collab derive | yes | **yes** (ADR 0481) |
| `persistAuthoredWorkflow` (model) | yes | **no** ← |
| `prepareComposedDraft` (model, both compose tools) | yes | **no** ← |
| `walkthroughAuthorTool` | yes | n/a — its two typeIds are HOST constants, never model-chosen |

The gap is camouflaged, which is why it survived: the AI author's **menu** *is*
curated (`buildAuthoringCatalog` takes `disabledPacks`), so nothing goes wrong
while the model composes only from what it was shown. But `findUnknownTypeIds`
resolves against the **host-global** `buildNodeCatalog()`, so a disabled pack's
typeId — recalled from an earlier turn, read from `openwop:schema.lookup`, or
simply remembered — passes the closed-world check and is written. Net effect:
tenant curation enforced on every door a **person** writes through, and skipped
on both doors a **model** writes through.

**Pre-existing on both doors, so not a regression of this PR** — but §4's ruling
is titled "the two write doors agree on legality", and this is a legality rule.
So it is **enforced** rather than carved out, at the one existing choke helper
(never a second copy): `persistAuthoredWorkflow` throws the helper's own 403
(the agent tool relays it as a typed refusal), and `prepareComposedDraft`
**reports** it in the same shape as its 2b closed-world refusal — the agent
repairs from a message that already names the fix ("re-enable them in the
Marketplace first"). The refusal has a real exit, and it is tenant-scoped, both
witnessed.

Witness: `workflow-author-disabled-pack-gate.test.ts`. The gate maps typeId →
packName through the pack half of `buildNodeCatalog()`, and the suite's
per-worker pack dir is empty, so the file writes ONE synthetic manifest into it
and removes it afterwards. It **asserts the fixture is real first** — the
synthetic node is in the catalog AND is closed-world legal — because a witness
over a node nothing declares would pass forever. S19/S20 redden one door each;
S21 (suppress the fixture) reddens all six cases including the fixture guard,
which is how a vacuous version of this test would announce itself.

## §Correction 5 (§7) — the hoisting called "load-bearing" had NO witness

§7 records that the runless leg's run-EXISTS probe was hoisted above the new
`wfreg:` purge, "for the same reason": purging first would destroy an ACTIVE
tenant's workflows and *then* decline to tear the tenant down. The reordering is
correct — but re-applying the dangerous shape leaves **both** witness files
green. `anon-tenant-lifecycle.test.ts`'s ordering case pins the purge against the
other **purges**, never against the **probe**.

A witness now covers it. **It contradicted its own first draft, which is the
finding worth recording:** the obvious construction — insert a run, expect the
runless leg — does not reach the branch at all. A tenant with a run is
RUN-anchored, takes the other leg, and (stale under the FUTURE clock) is
legitimately torn down. The population the probe exists for is narrower than
"has a run": the run-anchored enumerator must have **missed** it, i.e. the
review-M2 past-the-500-cap case. The witness simulates exactly that
(`listTenantActivity` blind, `listRuns` truthful) rather than asserting over a
population the branch never sees — the same "derive the assertion from the
mechanism" rule that §Correction 2 needed.

S22 (move the purge back above the probe) reddens it and nothing else: 41 other
cases across the two files stay green, which is precisely why nothing caught
this before.

## §Correction 6 (§6) — the compensating list filter had no witness

§6 adds `if (!isOwn && !catalogVisible(w)) continue;` to `listAuthoredWorkflows`,
the compensating half of asking the registry for transient rows. Deleting that
line leaves the file green: W6's "not visible to another tenant" case exits at
the EARLIER `!isOwn && !isBuiltin` continue, so it passes for the wrong reason —
and would pass on `origin/main` too, where the line does not exist.

The state that actually reaches the second filter is the stranded one W2
constructs: registered, **unowned** (so it classifies as a host BUILT-IN and
clears the first continue) and **transient**. A new case covers it and asserts
the fixture really is transient before asserting the filter. S23 (delete the
line) reddens it alone.

## §Correction 7 (§4) — the cap refusal named the wrong population and the wrong remedy

Two defects in one sentence, both in a hand-written copy of a message that lived
in a different module from the counter it describes.

- **Population.** `transientCapReached` counts every ownership row with
  `transient && !archivedAt` — deliberately, because §4's whole point is that
  alternating doors must not double the ceiling. That includes agent
  `propose`/`compose-and-run` drafts **and recorded walkthrough tour drafts**
  (`walkthroughAuthorTool` writes `transient: true`). The message said
  *"unsaved AI-authored drafts"*, so a user whose budget is full of tours is
  sent looking for authored workflows that may not exist. **The count is right
  and stays one budget; the sentence was wrong** — narrowing the count instead
  would have re-opened the lane-shopping §4 closes.
- **Remedy order.** It led with *"Save (promote)"*, which requires a completed
  non-debug run plus green `requiredForPromote` evals — so for the un-run drafts
  actually consuming the budget it 409s. Archive always works, and now comes
  first.

Cure: one exported `transientCapMessage()` beside the counter, used by all three
call sites. The two pre-existing assertions that pinned the old phrase now
assert what the message must **do** (name the budget, name archive) rather than
a literal — a phrase-pin is how the wrong population survived this long. S24
(revert the message) reddens all three.

## §Correction 8 — two accuracy defects in the record

**(a) The `/` picker claim, in §6 and in the ADR 0369 §5 note, is wrong about
the mechanism.** Both say a demote would "silently pull a saved workflow out of
the `/` picker", and the PR summary went further ("AI-authored workflows now stay
out of the `/` picker until promoted"). The `/` picker does **not** filter
transient rows. It sources `GET /v1/host/openwop-app/workflows`, whose scoped
list deliberately keeps them (*"Transient DRAFTS stay VISIBLE here — this is the
owner's own scoped list"*), and `chat/lib/workflowMentions.ts` carries the
`transient` flag through and renders a **Draft badge**.

What the stamp actually changes is real but **smaller**: the `catalogVisible`
consumers (the MCP server registry, the walkthroughs surface,
`exampleDataSummary`, the marketplace) and **GC eligibility**
(`runRetentionSweeper` collects `transient && archivedAt`). A demote-on-revise
would therefore have hidden a saved workflow from those surfaces, re-badged it
Draft in the picker, and made it GC-eligible — worth preventing, and not what the
sentence said. The create-only rule stands unchanged; only its justification is
corrected.

**(b) "Two advisory e2e failures" is three.** Measured twice on one box by
building and booting the e2e backend at HEAD and again with all seven changed
backend `src` files replaced by their `origin/main` blobs: **identical three
failures both runs** — `collab.spec.ts:44 @serial` (a *document* room, not a
workflow room) and `route-snapshots.spec.ts:109` builder in **both** `@light` and
`@dark`. Identical at HEAD and at `origin/main` ⇒ **not** caused by this PR
(which has zero frontend diff), but the count in the record was wrong, and a
wrong count is how a real regression hides inside an expected one.

## §Correction 9 (§2) — what ownership-first actually costs, named

§2 says a lost definition write leaves an ownership row "pointing at nothing —
invisible …, harmless, and re-writable by its owner on retry". "Harmless" is
slightly too generous and the residual should be stated: that phantom row **holds
the id against other tenants** (`isAuthoredByOtherTenant` 409s them), **renders
in the owner's scoped REST list** as a workflow whose builder link 404s, and
**consumes 1 of the 25 transient-draft slots** until archived. All three are
recoverable — the owner re-persists the same id (`getOwned` is true, so the
self-overwrite path is open) and DELETE needs only the ownership row — which is
exactly why this direction is still the right one: the inverse strands a
globally-readable definition **no one** can overwrite.

## §Correction 10 — the fix reintroduced the family it closes, once, and it was caught

§Correction 1 and §Correction 3 each added an **enum listing the five preservable
fields** — one in the `…nodes.persist` tool's `clearFields` input schema, one in
the pack's `persist.output.schema.json`. Both were hand-copies of
`PreservableField`, which is a TYPE and therefore cannot be read at runtime. That
is a drift site in model-facing schema text, i.e. exactly the class CLAUDE.md
names ("schema text reaching a model is **generated from its SSoT or test-pinned**
to it"), reintroduced by the fix for a different instance of it.

Drift lies to the model in **both** directions: an enum naming a field the guard
does not protect invites a `clearFields` token that silently does nothing, and one
MISSING a protected field hides the only exit that field has — which is the very
defect §Correction 1 exists to close.

Closed the way the rule says: `PRESERVABLE_FIELDS` is now exported as the SSoT,
the tool's enum spreads it, and the pack schema — a separate artifact that cannot
import — is **test-pinned** against it. S25 (drift the tool enum) and S26 (drift
the pack enum) each redden the pin.
