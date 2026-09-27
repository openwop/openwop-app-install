# ADR 0676 — Strategy: classify the board-memo writer, and stop manufacturing expansion conformance

Status: **implemented** (verified 2026-09-17, #3805)
Date: 2026-09-14
Feature loop 2026-09, iteration 26 (Strategic Planning, `FEATURES.md:194`)
Gap ids: `SPWF-13` (new), `SPWF-5` (re-dispositioned), `SPWF-8` (re-caused), `SPWF-11` (+1 new instance), `SPWF-10`

## Context

The `/grade-workflows` re-pass on Strategic Planning at `0aa6bd6be` re-verified the
2026-08-22 closeout (ADR 0597 PR-A). **The doctrine claim holds and the four rows
recorded CLOSED are still closed** — verified mechanism-by-mechanism, not carried:

- Zero pin sites. The single registrar (`features/strategy/cadence.ts:262`) is an
  `expandChain` product paired with `recordOwnership` **in the same function**, and
  `test/workflow-pin-site-ratchet.test.ts:555` classifies it SANCTIONED with a
  non-vacuity assertion at `:636`. `LEGACY_PINNED_WORKFLOWS` is still `[]`
  (`features/index.ts:225`), frozen by `builtin-workflow-ratchet.test.ts:161-164`.
- `SPWF-1` closed: all three body-binding terminal edges are port-qualified.
- `SPWF-2` closed: the cadence PUT refuses at save time in phase 1 (`cadence.ts:224-232`).
- `SPWF-3` closed: all three chains moved `1.0.0 → 1.1.0`; pack at `1.0.4`.
- `SPWF-12` closed: `check-pack-version-bump.mjs` now compares each chain's OWN version,
  independently of the manifest check.

`SPWF-7`'s strategy half is **stale-now-fixed** (the expanded-shape and build-twice
byte-identical assertions both exist at `test/workflow-chain-strategy.test.ts:85-110`);
its two repo-wide blindnesses remain.

What this pass found is below. Every count in it was measured at this commit.

## D1 (Blocker, `SPWF-13`) — `create-board-memo` is a durable writer invisible to the replay guard

`packs/feature.strategy.nodes/index.mjs` `createBoardMemo` performs **two durable
writes** — `docs.createDocument({kind:'board-update'})` then `docs.addVersion(...)` —
and it is run-reachable as the `persist` node of the `strategy.board-pack` chain
(`examples/workflow-chain-packs/strategy/pack.json:69`), which is one of the three
cadence-scheduled entries.

**MEASURED — all three arms of `isSideEffectingNode` return false for it:**

| arm | result |
|---|---|
| `MANIFEST_FAST_PATH_SERVED.has(typeId)` | **false** — present only in `MANIFEST_DECLARED_TYPE_IDS` (`sideEffectFloor.generated.ts:1312`) |
| `module?.sideEffecting === true` | **unreachable** — a pack `.mjs` cannot self-declare; `sideEffects.ts:97` says so explicitly |
| `SIDE_EFFECTING_TYPE_PATTERNS` | **no match** — no strategy entry exists |

So a `:fork` or replay **re-executes it and creates a second board-update Document**.

**Its three sibling writers in the same manifest are all classified** —
`check-in`, `record-decision` and `sync-metrics` each carry
`capabilities: ["side-effectful"]` and each appears in BOTH the floor
(`:332-334`) and the served set (`:601-603`). `create-board-memo` carries
`capabilities: []`. **`record-decision` is the exact precedent**: it persists a
Document through `ctx.features.documents` the same way, and it is classified.

This is the twin-lane shape for the eighth consecutive iteration: a rule applied to
three nodes and not to the fourth, in one file.

**There is no `ctx.callAI` holdback reason here** (the ADR 0673 D1 exception for
`workflow-author`'s `draft`): the AI call is a *separate upstream node*
(`memo -> core.ai.chatCompletion`), so nothing about RFC 0041 §B divergence injection
argues for holding this node back.

**`record-decision` — the classified sibling — appears in NO chain.** Grepping
`examples/` for the 10 strategy typeIds returns exactly one hit: `create-board-memo` at
`strategy/pack.json:69`. So the node that IS protected is unreachable from any scheduled
run, and the one the cadence fires three times a week is the unprotected one. That is the
twin-lane shape in its sharpest form.

**Second defect — a CLASS OF TWO in this file, with the correct implementation already
present in a third.** The idempotency key cannot dedupe:
```js
idempotencyKey: `strategy-board-memo:${str(i.strategyId)}:${document.documentId}`,
```
`document.documentId` is minted by the `createDocument` call **two lines above**, so the
key is unique on every execution by construction. `record-decision` carries the
byte-identical defect at `index.mjs:167`
(`strategy-decision:${strategyId}:${document.documentId}`, same two-step at `:163-167`).

> **CORRECTED by the pre-implementation review — the first cure filed here was a NO-OP.**
> This section originally prescribed "re-key on inputs that exist before the write
> (`strategyId` + a content digest)". **No key, however derived, can ever match.**
> `addVersion`'s idempotency lookup is scoped to the document —
> `documentsService.ts:481-485` does `listVersions(tenantId, orgId, documentId)` and then
> searches it — and on any re-execution the document is brand new
> (`documentsService.ts:335` mints `doc:${randomUUID()}` because the pack passes no id),
> so `existing` is **empty**. The duplicate is the **Document**, not the version; the
> dedupe must happen at the document MINT (`documentsService.ts:326-329`).
>
> The correct mechanism is already in this feature package, twice over:
> `agentTools.ts:266-272` derives `documentId = doc:strategy-board-memo:<sha256(runId,
> orgId, title, markdown)>` and passes it in — and the ADR 0166 owner
> **`ctx.features.documents.createDraftDocument`** (`features/documents/surface.ts:69-92`)
> exists for exactly this two-step, with `feature.campaign-channels.nodes/index.mjs:610` as
> the reference consumer. **Both strategy writers hand-roll it instead** — a duplicated
> seam, which is the scope finding as well as the bug.

**Decision:** add `capabilities: ["side-effectful"]` to the `create-board-memo` manifest
entry, bump `feature.strategy.nodes` 1.2.0 → 1.3.0 with the feature pin moved in lockstep,
regenerate **both** `sideEffectFloor.generated.ts` **and** `packs/.steward-manifest.json`
(`host/packTrust.ts:110-134` refuses a drifted digest), and route **both** document writers
through `ctx.features.documents.createDraftDocument` with an **explicit** `idemBase` derived
from `(orgId, title, markdown)` — note its default base is `runId`
(`surface.ts:79`), which a fork changes, so passing it explicitly is load-bearing.

**Also taken: `SPC-20`.** `index.mjs:88-91` catches the persist failure and returns
`status:'success'` carrying the error. D1's witness is **not sound without this** — a fork
test asserting "document count stays 1" passes for the wrong reason when the persist throws
and the node reports success. It is also the success-with-empty family this ADR's own
Context section polices.

**What this version bump unblocks.** `CODEBASE-ASSESSMENT.md:8502-8524` records `SPC-7`,
`SPC-18`, `SPC-20`, `SPC-22`, `SPC-27` as deliberately batched behind "a node-pack version
bump + a `requiredPacks` re-pin + steward re-attestation". D1 performs exactly that bump.
Ruling per row: **take `SPC-20`** (D1's witness depends on it). **Decline `SPC-7`/`-18`/`-27`**
this iteration — they are independent of replay classification and taking them would make
this PR a batch with an unmeasured surface. **Decline `SPC-22`** (schema refs on all 10
nodes) with a reason: it is the same corpus-wide declaration gap as `NBWF-2` (112 chain-used
typeIds across 31 packs) and wants one change, not a per-feature drip.

**Ship-step asymmetry, stated because a reader will assume the opposite:**
`MANIFEST_FAST_PATH_SERVED` is generated from the repo's `packs/` at build time and compiles
into the image, so **the replay-classification half ships with the deploy**. The `.mjs`
change rides the pack and can be shadowed by a registry-installed copy
(`bootstrap/installRegistryPacks.ts:48-51`), so it needs the registry publish
(`check-pack-pin-drift.mjs:6-20`).

**Witness:** a born-red fork test asserting the board-update Document count stays 1
across a `:fork`; a manifest-parity leg asserting every strategy node that writes durably
carries the capability; and a leg pinning that the persist failure is a typed failure, not
`status:'success'`.

## D2 (HIGH, wire honesty, `SPWF-5` re-dispositioned) — the expand seam manufactures its own conformance

`schemas/workflow-chain-pack-manifest.schema.json:159` carries a normative MUST:

> "Capability traits to propagate to every expanded node. Hosts MUST copy this array into
> each expanded `WorkflowNode.capabilities` so existing capability gates apply uniformly."

`expandChain` does **not** do this. The only `capabilities` write on the expansion path is
`workflowChainPackLoader.ts:1552`, and it lands on `definition.metadata`, not on nodes.

**The prior row filed this as "the host skips a MUST". That understates it.** The
conformance witness seam **synthesizes the field at serialization time**
(`routes/workflowChainExpandSeam.ts:61-67`):
```ts
const chainCaps = chain.capabilities;
const nodes = def.nodes.map((n) => ({ id: …, typeId: …, ...(chainCaps ? { capabilities: chainCaps } : {}), … }));
```
its own comment conceding *"this host records them at `metadata.capabilities`"*. So a
scenario probing node-level propagation is answered by a response **the seam built**, not
by what the host produces. Every real consumer — the editor, `from-chain`
(`routes/workflows.ts:778`), the executor — sees nodes without the field. The witness and
the product disagree, and the witness is the one being graded.

**Blast radius MEASURED before proposing the fix** (the ADR 0673 D4 lesson — a gate that
matched its documented contract and still broke 14 files):

- **69 of 181 chains** declare chain-level `capabilities`; **325 nodes** would gain the field.
- The only declared value corpus-wide is **`side-effectful`** (69 occurrences, nothing else).
- **No runtime consumer exists.** The executor's capability gate reads
  `module.requires` (`executor.ts:518`), a *different field* on the NodeModule, checked
  against `runtimeCapabilities`. A repo-wide grep finds no reader of a workflow node's
  `capabilities` in backend or frontend. So propagation **cannot refuse a node** and cannot
  change execution.

**This also settles a question D1 must not get wrong: D2 does NOT fix D1.**
`isSideEffectingNode(typeId, module)` never reads `node.capabilities`, so honouring the
MUST would leave `create-board-memo` exactly as replay-unsafe as it is now. The two
findings are independent, and D1 must be fixed on its own terms.

> **CORRECTED by the pre-implementation review — the filed decision was a NO-OP and its
> framing was an over-claim. Both are replaced.**
>
> **(a) The prescribed fix could not work.** `expandChain` does not return `definition`; it
> returns `validateWorkflowDefinition(definition)` (`workflowChainPackLoader.ts:1572`), and
> that validator **rebuilds every node from a 7-key allowlist**
> (`workflowDefinitionValidation.ts:500-508`: `nodeId`, `typeId`, `config`, `inputs`,
> `outputRole`, `compensation`, `irreversibleEffect`) which does not include
> `capabilities`. Writing the field inside the expander produces zero observable change —
> a green PR that fixes nothing. This is the same class the validator's own tooling
> records (`check-vendored-schemas.mjs:64-72`: a field added upstream is silently
> DISCARDED — #3274, #3292), and the same shape as ADR 0673 D4 which this ADR cites two
> sections earlier.
>
> **(b) The vendored corpus CONTRADICTS ITSELF, so this is not host conformance work.**
> `workflow-chain-pack-manifest.schema.json:159` says hosts MUST copy into
> `WorkflowNode.capabilities`; `schemas/workflow-definition.schema.json` `$defs/WorkflowNode`
> is `"additionalProperties": false` with no `capabilities` property (same in `schemas/v2/`),
> so a node carrying it is **invalid**. Both files are vendored and pinned by
> `check-vendored-schemas.mjs:72`. A host cannot satisfy both. **This is an `../openwop`
> RFC 0013 revision — the same item as `SPWF-14`, not a separate one.**
>
> **(c) My blast-radius measurement was INCOMPLETE in the direction that mattered.** I
> measured 69 chains / 325 nodes — the chains with a NON-EMPTY `capabilities`. The real
> population is **96 chains / 410 nodes**, because **27 chains declare `capabilities: []`
> (85 nodes)**, and the reference expander guards on `length > 0`
> (`@openwop/openwop-conformance/src/lib/workflow-chain-expansion.ts:261-262`) with a
> scenario asserting an expanded node **MUST NOT** carry an empty array
> (`scenarios/workflow-chain-expansion.test.ts:500-508`). An unconditional copy — the shape
> my decision described — would have **violated a MUST on 85 nodes.** This is the "name the
> population in words before counting it" lesson, missed again: I counted the population my
> fix would help and not the population it would touch.
>
> **(d) It would reintroduce the family it closes.** `preserveDroppedFields.ts:369`'s
> `PRESERVABLE_FIELDS` has no `capabilities`, the builder's serializer rebuilds nodes from
> its own allowlist (`frontend/react/src/builder/schema/serialize.ts:311-323`), and
> `test/workflow-node-field-tripwire.test.ts:28-40`'s `DROPPED_BY_VALIDATOR` does not list
> it — so the first builder save of any chain-instantiated workflow would silently delete
> the propagated field, and **all three guards are blind to it.**
>
> **(e) The "manufacturing conformance" framing was an over-claim.** The seam is a
> documented internal→wire mapping that already renames `nodeId → id` and rebuilds edges as
> `from`/`to` strings; given (a) there is no internal field to read, so re-deriving from
> `chain.capabilities` is the only thing it CAN do. The accurate, narrower defect: **the
> witness cannot detect a propagation regression**, because it never reads what the expander
> produced. It is also scoped to the vendored `vendor.openwop.workflow-chain-sample` fixture
> and 404s in production, so no product chain is witnessed either way.

**Decision: FILE, DO NOT FIX HERE — folded into `SPWF-14`.** Honouring the MUST needs four
coordinated edits (the node member in `executor/types.ts`; the validator allowlist, which
`workflow-node-field-tripwire.test.ts:15-22` requires its own ADR to change; both vendored
`WorkflowNode` schemas, which are pinned; and the `definitionHashOf` churn below) **plus**
an RFC resolving the contradiction in (b). Recording the mechanism is this iteration's
deliverable; the change is not.

**A consequence the original text missed entirely:** `definitionHashOf` canonicalizes the
whole definition including `nodes[]` (`host/definitionHash.ts:16-17`), so any surviving
node-shape change shifts `runStarter.ts:76`'s `expectedDefinitionHash`,
`workflowComposeTool.ts:438` (the ADR 0473 approve-what-you-see pin) and
`reviewProjection.ts:367-378`'s `editedSinceProposed`. The migration risk is **phantom
revisions and hash mismatches on in-flight approvals** — not the replay concern Open
Question 1 raised.

**Deliberately NOT decided here:** whether the schema's stated *rationale* ("so existing
capability gates apply uniformly") should exist at all — on this host no gate consumes the
field, so the sentence describes a mechanism that is not implemented anywhere. Making the
shape true is host work; changing what the MUST *promises* is an `../openwop` RFC change
and is filed, not smuggled in. Recorded as `SPWF-14`.

## D3 (`SPWF-8` — re-caused; the filed cause is now FALSE) — strategy's jobs opt out of a gate that exists

The row says cadence jobs keep firing after the `strategy` toggle is off, because no
fire-time re-check exists. **The defect survives; its stated cause does not.**

The fire-time gate **was built** (`host/scheduleDaemon.ts:109-127`): a job carrying
`featureId` is resolved per-tenant at fire time and skipped with
`recordJobSkipped(job.jobId, 'feature-disabled', now)`. It is opt-in by design —
`:99-100` records "Absent `featureId` ⇒ ungated … purely additive."

**Strategy never passes it.** `cadence.ts:267-275` calls `registerJob` with
`{ jobId, tenantId, cronExpr, workflowId, ownerUserId, enabled: true, timezone }` and no
`featureId`, while two sibling features do pass it
(`insights-suite/insightsSuiteService.ts:149`, `knowledge-sync/knowledgeSyncService.ts:391`).

Recording the cause correctly matters more than the one-line fix: "no gate exists" invites
building a second gate beside the working one.

> **CORRECTED by the pre-implementation review — the filed decision named a symbol that is
> not in scope, and the symbol an implementer would reach for instead is DEFAULT-OFF.**
> `TOGGLE_ID` is module-local and unexported at `features/strategy/routes.ts:62`;
> `cadence.ts` does not import it. The **only exported toggle constant in
> `features/strategy/` is `STRATEGY_GATE_TOGGLE_ID = 'strategy-approval-gate'`**
> (`activationApproval.ts:37`), whose default is `status:'off'` (`routes.ts:259-267`).
> Passing that one **stops every strategy cadence job for every tenant**, silently, with a
> single `log.info` at `scheduleDaemon.ts:120`. That is the it.21 outage shape — enforcing a
> dormant rule and converting a latent mismatch into a hard failure — **one identifier away.**

**Decision:** export `STRATEGY_TOGGLE_ID = 'strategy'` from `features/strategy/feature.ts`
and pass it as `featureId` at `cadence.ts:267-275`. Safe, verified end to end: the toggle
default is `status:'on'` with no variants (`feature.ts:47-56`), and `getEffectiveConfig`
returns the **code-registered default** when no override row exists
(`host/featureToggles/service.ts:417-422`), so absence of a row is never `off`. Entitlement
gating lives in `featureRoute.ts:51-53`, not `resolveOne`, so `strategy`'s membership in the
sellable `leadership` bundle is inert here.

**Witness — three legs, because two of them would pass with the WRONG constant:**
(a) the job is skipped when the tenant override is `off`; (b) **the job FIRES for a tenant
with no toggle row at all** — the non-vacuity leg; (c) the stamped `featureId` resolves to a
registered toggle default. **Sabotage:** substitute `STRATEGY_GATE_TOGGLE_ID`; leg (b) must
go red.

**Stated, not discovered later:** `scheduleDaemon.ts:110-118` leaves `enabled = false` when
`resolveOne` THROWS, and the slot has already advanced at `:97` — so a transient KV read
failure drops that slot for every gated job. Deliberate and correct, but it is a new failure
mode strategy's cadence does not have today.

## D4 (`SPWF-11`, +1 new) — four stale claims, one of which is why D1 shipped

All three filed claims verified still present. **A fourth is new and is the load-bearing one** —
`packs/feature.strategy.nodes/index.mjs` header:

> "Every node is role:"action" so the engine records the output and replay/fork read the
> recorded result rather than re-issuing."

**False — but NOT for the reason first filed here, and the first filing was itself wrong.**

> **CORRECTED pre-implementation.** This section originally read *"`role` does not drive
> replay classification; `capabilities` does."* **That is false.** `role` IS binding:
> `scripts/gen-side-effect-floor.mjs:139` filters
> `v.role === 'side-effect' || v.caps.includes(SIDE_EFFECT_CAPABILITY)` — a disjunction —
> and `sideEffects.ts:16-25` calls the manifest role "binding on the host". Shipping that
> sentence would have replaced a stale false claim with a **fresh** false claim, in the
> section of an ADR whose whole subject is claims that outlive their code.

What confers nothing is **`role: "action"` specifically** — no comparison against that
string exists anywhere under `src/executor/` (the ADR 0587 finding). The docblock's error is
therefore the **inference**, not the field: `role:"side-effect"` would have earned the
guarantee it claims; `role:"action"` earns nothing, and `create-board-memo` declares neither
that nor the capability.

Also: `examples/workflow-chain-packs/strategy/pack.json:5` says *"**Both** are scheduled
via the strategy cadence config"* while the pack ships **three** chains.

**Decision:** correct all five in place, each with what falsifies it.

## D5 (`SPWF-10`) — the chain pack is outside attestation

`scripts/gen-steward-manifest.mjs:52` sets `PACKS_DIR = join(ROOT, 'packs')` and never
walks `examples/workflow-chain-packs/`, so `vendor.openwop-app.workflows.strategy` (now
1.0.4) has no digest entry while both `feature.strategy.{nodes,agents}` do
(`packs/.steward-manifest.json:884-892`).

This is **corpus-wide, not strategy-specific** — all 60 chain packs live under `examples/`
and none is attested. Widening the generator changes the manifest for 60 packs at once.

**Decision: FILE, DO NOT FIX HERE.** Scoping a 60-pack attestation change inside a
single-feature iteration is how a measured change becomes an unmeasured one. Carried as
`SPWF-10` with the cause now named at `file:line`.

## Explicitly NOT filed

- **`check-pack-version-bump.mjs` runs only under `npm run ci`, not GitHub Actions.** A
  scout flagged this as a material gap. It is not: `CLAUDE.md` records that hosted Actions
  is **deliberately disabled** and `npm run ci` green **is** the merge gate. The gate runs
  where it must. (`DESIGN.md:1021` calling `ci.yml` a "mirror" of `npm run ci` is stale for
  this script, but the mirror is moot while the workflow is disabled.)
- **N1 correction:** the steward entries are at `packs/.steward-manifest.json:789`
  (`feature.strategy.agents`) and `:794` (`feature.strategy.nodes`), not `:884-892`. The D5
  mechanism (`gen-steward-manifest.mjs:52`) is unchanged and correct. **D5's gap is also not
  exploitable the way it may read:** `packTrust.ts` gates the `packs/` loader lane, and no
  chain pack is loaded through it — so an unattested chain pack is a coverage hole in a
  corpus-wide generator, not an open door.
- **`SPWF-4`** (declared chain `outputs` never match the auto-primary terminal node —
  verified still true on all three chains). `chain.outputs` is copied to
  `definition.metadata` only (`workflowChainPackLoader.ts:1553`) and binds to nothing
  executable, so this is a documentation-vs-shape mismatch, not a runtime defect. It wants
  either an `outputs` consumer or the field's retirement — both larger than this iteration
  and both arguably wire questions. Deferred with the mechanism recorded.
- **`SPWF-9` — SPLIT by the review, because the deferral was too broad.** `cadence.ts:260-267`
  skips `registerWorkflow`/`recordRevision`/`recordOwnership` inside the `workflowRoomLive`
  branch and then calls `registerJob` **unconditionally**.
  **`SPWF-9a` — TAKE:** do not arm a job whose workflow was not registered (and raise the
  `log.warn` to `log.error`). Cheap, and it is the half that prevents a job bound to an
  unresolvable id.
  **`SPWF-9b` — DEFER:** the ordering decision (skip-the-job vs register-durably-first) is a
  genuine design call, not a one-liner.

## RFC verdict

**Host work; no new RFC for D1/D3/D4/D5.**

> **CORRECTED pre-implementation.** This section originally read *"D2 makes the host honour
> an existing vendored-schema MUST — that is conformance, not a wire change."* **That is
> false.** The two vendored schemas contradict each other (D2(b)), so no host can honour
> both, and resolving it is an **`../openwop` RFC 0013 revision**. D2 is therefore deferred
> into `SPWF-14` rather than implemented, and `SPWF-14` is the RFC item — not a separate
> host task.

## Open questions

1. **CLOSED by the review.** `deterministicExpansionId` hashes only `chainId@version` +
   canonical params (`workflowChainPackLoader.ts:778-784`), so `expansionId` and
   `workflowId` are stable and replay resolves. The real migration question was never the
   expansion id — it is the `definitionHashOf` churn recorded in D2.
2. **SETTLED NO, with the mechanism** (not "leaning"): a `^feature\.strategy\.nodes\.`
   prefix would capture the six read verbs, and `sideEffects.ts:82-88` records that a
   pack-wide pattern entry **OVERRIDES** the generator's deliberate holdbacks. Per-node
   declaration is the only correct instrument.
3. Still open: `SPWF-9a` (below) — is declining to arm a job cheaper than the ordering fix,
   or does an un-armed job hide the failure?

## Status correction (2026-09-17)

This read `Status: Proposed (revised after adversarial pre-implementation revie…` — a PRE-implementation phrasing that went stale when
the work landed in **#3805** (D1/D3/D4 shipped; D2 withdrawn in review). `docs/steward/FEATURE-LOOP-2026-09.md` records the
row **DONE** with that PR, which is the independent evidence for this correction.

**It was invisible to the steward staleness ratchet for a structural reason worth recording.**
That gate tested `Status:` for the EXACT string `Proposed`, so the parenthetical after the
word silenced it permanently — no baseline row, no exemption, nothing in a diff that reads as
a suppression. Seven ADRs were hidden that way, and the commit that claimed the baseline was
"drained to zero" was wrong about its own headline. The test is a prefix match now.
