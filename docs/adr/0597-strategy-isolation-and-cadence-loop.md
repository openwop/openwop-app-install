# ADR 0597 — Strategy: cross-org isolation, a state-set activation gate, and a cadence loop that actually delivers

Status: implemented

Feature 26/71 ("Strategic Planning") of the grading loop. This ADR covers **PR-A**,
the backend security + cadence-loop half. The UX findings (`SPU-*`, plus `SPC-11`
`SPC-12` `SPC-13` `SPC-14` `SPC-15`) are PR-B and are **not** addressed here.

Sources: `docs/steward/CODEBASE-ASSESSMENT.md` (`SPC-*`, `/grade-code`) and
`docs/steward/WORKFLOWS-ASSESSMENT.md` (`SPWF-*`, `/grade-workflows`), both
graded at `aba4aa096`/`df95a871`; branched from `origin/main` @ `c48239388`.

---

## Context

Two independent graders reached the same verdict from opposite ends. The code
grade found **six Blockers**, five of which are *the same mistake at five
different seams*: a guard was written on the door that got audited and not on
its siblings. The workflows grade found the ADR 0231 measurement loop — the
feature's centrepiece — **wired but non-functional**, and could not be seen by
the suite because the one execution test stubbed the terminal node.

Both reports agreed on the meta-finding, and it is the one that shaped this
work: **every finding was invisible to a green suite**, because the instruments
modelled neither the real executor nor the real wiring.

---

## Decision

Work in this fixed order, because the ordering is itself the finding:

1. **Fix the instruments first** (`SPWF-6`, `SPWF-7`). Otherwise the fixes land
   against a suite that proves nothing.
2. `SPC-2` — the live cross-org read leak.
3. `SPC-5` — the activation gate, expressed over the **state set**.
4. `SPC-3` + `SPC-4` — the other two isolation Blockers.
5. `SPC-1` / `SPC-16` = `SPWF-1` / `SPWF-2` — the cadence loop.
6. `SPWF-3` + `SPWF-12` — chain identity, and the gate that could not see it.

---

## §1 — The instruments (`SPWF-6`, `SPWF-7`)

`test/strategy-chain-execution.test.ts` carried three defects, each of which
individually made a Blocker unobservable:

| Defect | Consequence | Fix |
|---|---|---|
| `feature.notifications.nodes.notify` stubbed via a **catch-all**; the only assertion was `notifications.length > 0` | The chains' deliverable is the digest BODY, which was never bound. The test **pinned the defect as the guarantee**. | notify runs for real; the assertion reads the persisted notification row's `message`. |
| Node inputs built from **edges only**, ignoring `node.inputs` | Exactly the blind spot `91e398f52`'s commit message claimed to have fixed. | `buildCtxInputs` mirrors `executor.ts:726-736` — edge ports → single-`input` unwrap → `node.inputs` merged on top (fixture wins). |
| A hand-rolled `resolveConfig` re-substituted `{{params.*}}` | A freeze failure was papered over by the harness. | Deleted. A node now sees the config `expandChain` actually froze. |
| `runChain('strategy.board-pack', { orgId }, …)` | Hand-supplied the one param the only production caller never supplies. **Mechanism tested, wiring not.** | The cadence lane is driven through `PUT /strategy/cadence`, and the definition that was *actually registered* is what runs. |
| Every strategy pack test `import()`ed `packs/…/index.mjs` directly | Bypasses `packTrust.classifyPackDir`; "the pack has tests" ≠ "the pack is reachable". | One reachability assertion resolves the nodes through the registry lane the runtime uses, after `ensureLocalPacksMounted()` into the per-worker `OPENWOP_PACK_DIR`. |

`test/workflow-chain-strategy.test.ts` asserted node COUNT and `chainId` only —
it called `expandChain(board-pack, {})`, reproducing `SPWF-2` in-test, and never
looked. It now asserts the expanded port bindings, exactly-one-primary,
expansion determinism (expand-twice-and-diff, plus a different param set not
colliding on the same `expansionId`), and the reported `unresolvedParams`.

**MEASURED RED at commit `32dabdc5d`** (5 failed / 4 passed) before any production
code changed: three empty notification bodies, and `PUT /strategy/cadence
{boardPack}` returning 200 for a chain nothing could satisfy.

### Rejected

- **Converting `test/strategy-nodes.test.ts` to the registry lane.** It is a
  mock-surface unit test of the node functions; routing it through the registry
  would give the same functions and duplicate the one reachability assertion.
  The direct `import()` stays; the reachability claim is asserted in exactly one
  place. *(Residual: the same reasoning has not been applied to other features'
  pack tests.)*

---

## §2 — `SPC-2`: `/timeline` out-read `/context`

`timeline.ts:87-88` gated a `priority-list` / `priority-idea` link on
**existence** (`getList(...); if (!list) continue`) while the canonical resolver
`strategyService.ts:676` required `readable(list.orgId)`.
`priorityMatrixService.getScheduleStatus` authorizes nothing of its own, so
`GET /strategy/:id/timeline` and the portfolio `/strategy/timeline` returned
idea **titles, target dates and schedule states** from orgs the caller cannot
read, while `GET /:id/context` over the *same links* correctly withheld them.

`timeline.ts:5-7` asserted *"the same per-link gates the context resolve uses"*.
That sentence is **part of the defect** — a comment asserting a security
property is what stops a reviewer checking. It is corrected in place, not
deleted.

**Decision: one shared predicate, not a second hand-written copy.**
`strategyService.resolvePriorityLinkTarget(listId, loadList, canReadOrg)` is the
single rule; both projections call it. `resolveStrategyTimeline` takes
`canReadOrg` as a **required** parameter, so a caller cannot omit it and a
future projection has to hand-roll `getList` to bypass it.

### Lanes enumerated by CALL GRAPH (not from the finding's list of two)

Every reader of `strategy.links` that reaches priority-matrix data:

| # | Lane | Verdict |
|---|---|---|
| 1 | `strategyService.resolveStrategyContext` | was gated, still gated, now shares the rule |
| 2 | `timeline.resolveStrategyTimeline` | **the leak — fixed** |
| 3 | `routes.ts:552` `from-idea` | read-gated but WRITES → `SPC-3`, §4 |
| 4 | `routes.ts:142` `requireLinkTargetReadable` | link CREATION; read is the correct bar |
| 5 | `surface.ts:87` / `:96` (the RUN lane) | ~~passes `async () => true` **deliberately**; a run has no acting human to scope to~~ — **THE LEAK. FALSIFIED AND FIXED — see §Correction 1.** |
| 6 | `agentTools.ts:186-188` (the CHAT-TOOL lane) | already gated, via `orgReadPredicate(scope.tenantId, scope.actingUserId)` — correct before and after. |

**CORRECTION 2026-08-22.** The row above originally read *"Every reader of
`strategy.links` that reaches priority-matrix data"* over **five** lanes. It was
short by one: `agentTools.ts` is a sixth reader, now lane 6. No defect there — it
was the lane that had the rule RIGHT — but "every reader" was an overbroad claim
about a table that had not enumerated every reader, and the missing row is
exactly the evidence that would have falsified lane 5 on the spot: one feature,
two lanes over the same data, disagreeing about whether a run has a subject.

The project lane already used the identical `resolveProjectAccess` rule in both
projections, so it needed no change.

**Witness / sabotage.** `strategy-cross-org.test.ts` → "withholds a priority
link whose org the caller cannot read". Sabotage `if (!list || !readable)` →
`if (!list)` reddens **exactly that one test**: *"org-B idea
title/targetDate/state leaked across orgs"*. Matched positive controls: the
org-A link must still project, and the owner (who reads both orgs) must still
see both — so the assertion cannot pass by the projection returning nothing.

---

## §3 — `SPC-5`: the activation gate, expressed over the STATE SET

The ADR 0230 gate fired on two hand-picked **transitions**: `body.status ===
'active' && s.status === 'draft'`, and a protected-field edit while `s.status
=== 'active'`. `StrategyStatus` has five members. **`paused` matched neither**,
so:

1. `PATCH {status:'paused'}` — plain write, no branch matches;
2. `PATCH {objectives, period, planningHorizon, accountableExecutive}` — the
   revert branch requires `s.status === 'active'`; no revert, no approval, no
   `autoRevertedToDraft` marker, no audit flag;
3. `PATCH {status:'active'}` — the queue branch requires `s.status === 'draft'`;
   the flip applies directly.

`paused` appeared in **zero** strategy tests. An earlier R2 review had already
fixed **one instance of this same class** in this same `if` (`body.status ===
undefined` "was the wrong test") and still scoped its cure to `s.status ===
'active'`. Adding `paused` to a third `||` would have been the same mistake a
third time.

**Decision: the rule is a total function of the status union.**

```ts
STATUS_GATE_POSTURE: Record<StrategyStatus, { approved: boolean; terminal: boolean }>
```

`Record<>` over the union makes adding a status a **compile error** until
someone decides its posture. Two functions read it:

| Status | `approved` | `terminal` | Protected edit ⇒ revert? | `→ active` gated? |
|---|---|---|---|---|
| `draft` | no | no | no (unapproved; edits are free) | yes |
| `active` | yes | no | **yes** | n/a (already active) |
| `paused` | yes | no | **yes** | **yes** |
| `completed` | yes | **yes** | no (see below) | **yes** |
| `archived` | yes | **yes** | no (see below) | **yes** |

- **Activation keys on the DESTINATION** — `→ active` from anything not already
  active. This is the half that closes the bypass.
- **Protected-field re-approval keys on the origin being APPROVED and
  NON-TERMINAL.**

### The terminal carve-out, and why it is not laziness

Auto-reverting `archived → draft` on a protected edit would let a plain
`workspace:write` holder **un-archive** a strategy — a capability
`requireConfigAuthority` deliberately reserves (`patchIsConfigSensitive` flags
`status === 'archived'`). That is the fix for one escalation manufacturing
another: *my fix reintroduces the family it closes*. Terminal states are covered
by the destination rule instead: they cannot go live without an approval.

> **CORRECTED 2026-08-22 (§Correction 4).** This paragraph used to end *"and the
> approver sees the edited content."* **False**, and it was false for more
> origins than the terminal ones — see §Correction 4. The destination rule
> covers *"cannot go live unapproved"*; it says nothing about **which content**
> the approval was for. The carve-out itself is upheld — auto-reverting a
> terminal state is still refused — but its cover story was wrong, and the real
> cover is now the submission-withdrawal rule on the PATCH route.

### Prescription falsified: the cure as written would have REOPENED the blocker

The finding prescribed *"intercept any `body.status === 'active'` where
`s.status !== 'active'`"*. Shipping only that **breaks the lane it opens**:
`activationApproval.ts:115` enforced "approve what you see" as `s.status !==
'draft'`, so every paused/completed/archived activation would have 409'd at
approve time with *"This strategy is no longer a draft"*. The approval now
records `strategyFromStatus` and the decide side compares against **that**;
absent ⇒ `'draft'`, which is what every pre-existing row was queued from. The
`activationPending` projections on `GET /:id` and PATCH move from `status ===
'draft'` to `status !== 'active'` for the same reason.

**Witnesses / sabotage** (each reddens exactly one test):

| Sabotage | Red test | Message |
|---|---|---|
| destination rule → `current === 'draft'` | "activation is gated from EVERY non-active origin" | `paused → active applied with no approval: expected 'active' not to be 'active'` |
| origin rule → `current === 'active'` | "pause → edit protected fields → activate cannot bypass the gate" | `a protected edit on a paused (approved) strategy must revert: expected 'paused' to be 'draft'` |
| `queuedFrom` pinned back to `'draft'` | "activation is gated from EVERY non-active origin" | `claim from paused: expected 409 to be 200` — i.e. the exact regression the naive cure would have shipped |

---

## §4 — `SPC-3` and `SPC-4`: the other two isolation Blockers

### `SPC-3` — `from-idea` writes, so it must gate on write

`POST /:id/initiatives/from-idea` gated the target board with
`requireLinkTargetReadable` (`workspace:read`) and then performed **two writes**
against it: `markPromoted` (the intake overlay stamp) and `moveIdeaStatus` (the
completion-lane move). Neither service function authorizes anything of its own.

**Proof by sibling:** Priority Matrix's own routes for exactly those two
operations — `PATCH /lists/:listId/ideas/:cardId/status` (`priority-matrix/
routes.ts:322`) and `POST /lists/:listId/ideas/:cardId/promote-to-project`
(`:566`) — both use `loadListScoped(req, 'workspace:write')`.

**Cure:** `requireLinkTargetReadable` becomes `requireLinkTargetScope(req, link,
scope)`; the read form is a one-line alias. ONE function, so LINKING (a
reference ⇒ read) and PROMOTING (a mutation ⇒ write) cannot drift into two
different rules again.

### `SPC-4` — relocation is gated on the DESTINATION, like creation

`PATCH /strategy/:id {orgId}` routed to `requireConfigAuthority`, which checks
the strategy's **old** org and short-circuits entirely on creator-status.
`updateStrategy` then accepted any string. `POST /strategy` *does* require
`workspace:write` in the destination org: **creation was gated on the
destination, relocation was not.** The relocated strategy then landed in the
target org's managed Strategy KB as `contentTrust: 'trusted'`, retrievable by
that org's agents and advisory boards.

**Decision 1 — "check both", not "refuse relocation".** Relocation is a
legitimate operation with an existing config-authority gate; the defect is
*which org it reads*. `requireOrgRelocationTarget` additionally requires the
destination to **exist in this tenant** — `reqId` accepted any string, which
would have minted a KB collection under a fabricated org id.

**Decision 2 — the stale KB copy MUST be purged.** `updateStrategy` calls
`removeStrategy(tenantId, existing.orgId, id)` whenever the org changes.
~~**Removal runs first and unconditionally**: `indexStrategy` is best-effort and
swallows its own errors, so remove-then-index fails **closed** (worst case the
doc is absent and `reindex-kb` restores it) while index-then-remove fails
**open**, leaving the stale trusted copy exactly where the defect had it.~~
**THAT REASONING IS FALSE — see §Correction 6.** The purge itself is right and
is kept; the argument defending it was wrong on all three legs, and the argument
is what a future editor reorders against. This
also closes the privatizing variant (`PATCH {orgId, scope:'user'}`), which
removed from the NEW org where nothing was ever written and left the now-private
strategy fully readable in the old org's shared KB — the inverse of the ADR 0100
§CRITICAL carve-out.

**Witnesses / sabotage** (each reddens exactly one test):

| Sabotage | Red test | Message |
|---|---|---|
| `from-idea` scope → `'workspace:read'` | "refuses to promote an idea off a board the caller may only read" | `expected 201 to be 403` |
| `requireOrgRelocationTarget` call removed | "refuses a move into an org the caller has no write in" | `expected 200 to be 403` |
| old-org `removeStrategy` removed | "evicts the strategy from the OLD org Strategy KB when it moves" | `a trusted copy was stranded in the old org KB: expected {…} to be falsy` |

Every case carries a matched positive control (the writable board still
promotes; the owner's move still succeeds; the KB doc **is** present in org A
before the move, so the eviction assertion cannot pass vacuously).

---

## §5 — `SPC-1` / `SPC-16` = `SPWF-2` / `SPWF-1`: the cadence loop

### The empty notification (`SPC-16` / `SPWF-1`)

All three terminal edges were **portless** (`{"from":"digest","to":"deliver"}`).
`scheduler.ts:373` maps a portless edge to target port `input`; the AI node
returns `content` and no `output` port, so the whole outputs map landed under
`inputs.input` and `notify`'s `inputs.message` was never bound.
`asText(undefined)` → `''`, and `emit` requires only `title` + `audience` (both
supplied statically), so the node returned `emitted: true` and the run went
**green**. `weekly-checkin`'s entire deliverable is that digest: it billed an
LLM call every week and delivered a title.

Fixed to `digest.content → deliver.message`, `summary.content →
deliver.message`, and for board-pack a second edge `memo.content →
deliver.message` alongside the retained `persist → deliver` ordering edge. The
pack already showed the correct form one line away (`memo.content →
persist.markdown`).

### BLAST RADIUS — measured, deliberately NOT fixed here

**The population, stated precisely (§Correction 7).** An edge is **portless**
here when its **`to`** side carries no `.port` qualifier — `{"from":"digest",
"to":"deliver"}`. This sentence originally read *"`from` and/or `to` has no
`.port` qualifier"*, which is a **different and larger** population: recomputed
four ways against `origin/main`, `to`-only gives **257** and the `to`-side notify
count **45** (the numbers below), while the literal "and/or" gives **302** and
`from`-only gives 299. Every headline number in this section is right; the
DEFINITION was not, and anyone re-deriving the sweep from that sentence would
have got the wrong set. It is the `to` side that matters because it is the target
port that decides which input a value lands on.

**The inherited premise, stated rather than assumed:** a portless edge does NOT
implicitly bind `message`. `executor/scheduler.ts:373-374` computes `const
targetPort = e.targetInput ?? 'input'` and assigns `out[targetPort]`, so an
unqualified `to` writes to `input` and **never** to `message`. If that were
false, all 47 rows below would be a non-finding.

Across the **58 in-tree chain packs** (179 chains, 434 edges), re-measured
independently at `origin/main` (`c48239388`) and matching to the row:

- **257** of 434 edges are portless (`to`-side);
- **57** edges target a `feature.notifications.nodes.notify` node, **45** of
  those portless;
- **47 notify nodes, in 45 chains, across 20 of the 58 packs** have `message`
  bound by **neither an edge nor a declared input** — i.e. they ship title-only
  today.

Strategy is 3 of the 47. The other 44 belong to other features' packs and their
own grade passes; the enumeration is recorded here so the sweep is **filable
rather than rediscovered**:

`approvals` (2) · `campaign-sync` (1) · `commerce` (2) · `content` (2) ·
`customer-onboarding` (1) · `data-ops` (5) · `devops` (4) · `feedback-triage`
(1) · `finance` (3) · `inbox` (2) · `insights-suite` (3) · `it-support` (1) ·
`marketing` (3) · `meeting-ops` (1) · `people-hr` (2) · `research` (1) ·
`starters` (5) · `strategy` (3) · `support` (4) · `weekly-digest` (1).

> **Correction to the code grade.** Its scout cited `research` and `commerce` as
> *correct-form* references; the report already flagged that as suspect. Both
> are in the affected list above. The corrected references (`exec-ops`,
> `lighthouse`, `knowledge`) do use port-qualified terminal edges.

The structural cure `SPWF-1` proposes — *a conformance rule that an edge into a
node whose input schema declares a non-`title` content field must be
port-qualified* — is **not shipped**, and cannot be until the notify node's
input schema is a thing the checker can read for every target. Recorded as a
residual.

### The unschedulable board pack (`SPC-1` / `SPWF-2`)

`cadence.ts:113` called `expandChain(found.chain, {})` while
`strategy.board-pack` declares `orgId` **required** with no default, and
`CadenceEntry` had no field to carry one. `PUT /strategy/cadence {boardPack}`
answered **200**, `recordOwnership` published the workflow into the builder
gallery, a durable job was registered — and every fire errored
`validation_error` at `create-board-memo`, forever, with the run row as the only
trace.

**Cure:** `CadenceEntry.params` (validated scalars) feeds `expandChain`, and
`applyCadenceConfig` **refuses with a 400** naming the missing parameters when
`findUnfilledExpansionParams(cadenceDef)` is non-empty. A cadence PUT is a human
act with a caller to fail loudly at — precisely the boundary ADR 0504 said
seeding could not use.

### Prescription falsified: `deferred: true` is a NO-OP here

`SPWF-2` prescribed `expandChain(chain, { deferred: true })` "matching the
seeder". It does not fix this, twice over:

1. `deferredConfig` (`workflowChainPackLoader.ts:1228`) still calls
   `substituteTokensDeep` for a non-liftable key, so a whole-value
   `{{params.orgId}}` **in CONFIG** — which is where board-pack's `orgId` lives —
   freezes to `undefined` exactly as expansion-time mode does. Deferral defers
   `inputs`, not config.
2. `collectUnresolved` is **skipped entirely** in deferred mode, so
   `metadata.unresolvedParams` comes back empty — adopting the prescription
   would have silently made the new save-time guard **vacuous**.

Pinned as a test ("deferred expansion does NOT rescue an unsupplied required
param"), not left as prose, because the tempting "simplification" later is
exactly to replace the refusal with the deferral.

**Witnesses / sabotage:**

| Sabotage | Red | Message |
|---|---|---|
| weekly-checkin's terminal edge → portless | **2** tests — the same assertion on that one chain through its two lanes (direct run + the cadence-registered definition) | `expected '' to be 'Synthesized memo…'` |
| metric-sync's terminal edge → portless | 1 test (expanded-shape) | `strategy.metric-sync: nothing binds deliver.message — the notification ships title-only: expected +0 to be 1` |
| save-time unfilled-param refusal disabled | 1 test | `refuses to schedule board-pack with no orgId: expected 200 to be 400` |

---

## §6 — `SPWF-3` + `SPWF-12`: chain identity, and the gate that could not see it

`deterministicExpansionId` hashes `chainId@chain.version:params`. All three
chains sat at `"1.0.0"` through pack bumps `1.0.0 → 1.0.1 → 1.0.2 → 1.0.3`, one
of which (`91e398f52`) swapped **every `deliver` node's `typeId`**. Same
`(chainId, version, params)` ⇒ byte-identical `expansionId` ⇒ the same
`workflowId` and the same node ids resolving to a **different graph**, with no
version signal anywhere. A `:fork` of an older run, or a re-instantiate, crosses
that boundary silently.

`scripts/check-pack-version-bump.mjs` exists for exactly this class and compared
only the **pack manifest** `version` — the field the id never reads. It passed
on all three bumps. *Ratchet polices a spelling.*

**Both halves shipped.** The three chains go to `1.1.0` (pack `1.0.4`), and the
gate now also compares **each chain's own `version`** against the merge-base,
requiring a forward bump when that chain's serialized content changed. It runs
**independently** of the pack-level check, because a correctly bumped manifest
carrying a frozen chain version is precisely what shipped three times.

`label` is treated as content (it is what the builder gallery and the `/` picker
show); only `version` and `description` are excluded, matching the pack-level
rule.

**Sabotage — and the first probe was VACUOUS.** A synthetic commit that changed
a chain's DAG *and bumped only the pack manifest* passed with exit 0. Cause: the
check diffs against the **merge-base**, and my branch had already moved that
chain `1.0.0 → 1.1.0`, so the chain version *had* bumped relative to the base.
Re-probed with the chain version pinned back to the base's `1.0.0`, content
changed, pack manifest bumped forward:

```
✗ check-pack-version-bump: a pack changed content without a correct version bump.
    examples/workflow-chain-packs/strategy/pack.json — chain "strategy.weekly-checkin"
      changed content but its version stayed "1.0.0"
      (this is the field deterministicExpansionId hashes)
EXIT=1
```

Temp commit removed (`reset --soft` + restore from a `cp` backup); `git status
-s` clean afterwards.

**Rejected:** folding a content digest into `deterministicExpansionId` itself.
That is a wire-visible id change and needs the RFC 0013 gate, not a host ADR —
and it would re-key every existing tenant's expanded workflows. The gate is the
host-side half; the id change, if ever wanted, is an RFC.

---

## Corrections — the round-2 adversarial review of PR-A

An adversarial review of this branch found **three of this ADR's own load-bearing
CLAIMS false**, and one of them was holding a live cross-org read leak open. The
lesson is the one §2 already wrote down and then broke three times: *a sentence
asserting a security or safety property is what stops a reviewer checking it.*
So each correction below fixes the CLAIM as well as the code, in place, with the
original text struck rather than quietly deleted.

### §Correction 1 — `surface.ts` lane 5 was a LIVE cross-org read leak; §2's reason for leaving it was false

§2's lane table dismissed `surface.ts:87`/`:96` as *"passes `async () => true`
**deliberately** … a run has no acting human to scope to."* **The premise is
false.** `executor.ts:648-659` reads `run.metadata.actingUserId` and stamps it
onto the `BundleScope`; `inMemorySurfaces.ts:250` documents it as present for
human runs and **absent for system runs, which is the correct fail-closed
signal**; `POST /runs` (`routes/runs.ts:445`) stamps it from the authenticated
principal on every human-started run, and `:fork` re-stamps it. So the acting
human exists for exactly the runs a human starts, and `surface.ts` discarded it
unconditionally.

**The consequence was live.** A member holding `workspace:read` in org A only,
running any workflow that calls `ctx.features.strategy.getStrategyContext`,
received org-B idea **titles, `computedPriority` and `rank`**; `getHealth`
returned org-B **link counts** the same way. The asymmetry sat *inside one
function*: the same `resolveStrategyContext` call already fail-CLOSED on projects
via `resolveProjectAccess` with a `callerSubject` of `undefined`. And the same
feature's `agentTools.ts:191` did it correctly over the same data. Two lanes of
one feature disagreeing is the identical shape SPC-2 closed one file away — this
ADR enumerated the lane, wrote a reason, and shipped the leak.

**Cure — the reviewer's suggestion taken, but not as prescribed.** The prescription
`scope.actingUserId ? orgReadPredicate(...) : async () => true` was explicitly
flagged not-drop-in, and there was no third copy of `orgReadPredicate` to reach
for: it was a private `const` in `agentTools.ts`, one of **three** hand-written
copies of the same one-liner (`routes.canReadOrgPredicate` being the second and
`surface.ts`'s `async () => true` being the third — the copy that got the rule
wrong). Writing a fourth is the defect. The rule now lives **once**, in
`strategyService.orgReadPredicate(tenantId, subject)`, and all three lanes import
it.

**The fallback stays, and is witnessed.** `cadence.ts` passes no `metadata` to
`registerJob`, and `scheduleDaemon.ts:131` only forwards `actingUserId` if the
job row carries one — so every scheduled weekly-checkin / metric-sync /
board-pack fire is genuinely subjectless and must still project the tenant's
shared data (the `listPortfolio` precedent). A narrowing whose fallback nobody
checked is how a digest silently goes empty, so the fallback has its own test
rather than a sentence.

**Deliberately NOT widened:** which STRATEGY ROWS a run may see is still the
tenant-trusted `isShared` filter, and `callerSubject` is still passed as
`undefined` (so projects stay fail-closed for runs). Both are pre-existing ADR
0079 posture; changing them inside a fix for something else is how the last
escalation got manufactured. Recorded as a residual below, honestly, instead of
being implied by a fixed leak.

**Witnesses** (`test/strategy-cross-org.test.ts`, all against the real two-org
route fixture):

| Assertion | Sabotage | Result |
|---|---|---|
| `getStrategyContext` withholds the unreadable org · `getHealth` does the same | *(the pre-fix code itself)* | **MEASURED RED at the unfixed commit: exactly 2 failed / 6 passed** — `org-B idea title/computedPriority/rank leaked to a run owned by an org-A-only member`, and `linkedPriorityCount: expected 2 to be 1` |
| a SYSTEM run still sees the whole tenant | fallback → `async () => false` | **1 red**: `a subjectless run lost the near org: expected [] to include 'plist-…'` |
| the two-org OWNER driving a run still sees both | *(matched positive control)* | passes pre- and post-fix — the narrowing is a gate, not a blanket |

### §Correction 2 — the refused cadence PUT persisted the schedule it refused

§5 set out to close the family *"a save that returns OK and then fails forever"*
and **moved it instead**. `cadence.ts` did `await configs.put(config)` **before**
the per-entry loop that throws, and reconciled entries one at a time inside it.
So after §5 shipped, `PUT /strategy/cadence {weeklyCheckin, boardPack}` with no
`boardPack.params` answered **400** and left behind:

- a persisted config claiming `boardPack {enabled:true, cron:'0 8 * * 1'}` with
  **no job and no workflow**. Pre-§5 the failure was "200 + a job that errors
  every fire, leaving a run row"; post-§5 it is "400 + a config claiming
  *enabled* + **no run row at all**" — **strictly less observable after the
  fact** than the bug it replaced; and
- for `weeklyCheckin`, which `CHAINS` iterates **first**: a registered workflow,
  a `recordOwnership` row (so it appears in the builder gallery) and a live cron
  job — every one of them from a request the caller was told had failed.

**All four strandings were reproduced independently** against the unfixed
branch, each by removing the preceding assertion so the next one could be
observed rather than shadowed.

**Cure — the reviewer's "validate every entry first" taken; the "cheaper
variant" rejected.** Moving only the `put` after the loop leaves the
partial-reconcile half untouched, which is three of the four strandings.
`applyCadenceConfig` is now two explicit phases: **phase 1** parses, resolves the
chain, expands, checks `findUnfilledExpansionParams` and checks the deterministic
jobId is ours, writing nothing and owning **every** `throw` in the function;
**phase 2** writes what phase 1 proved. Same rule as §Correction 3 one file away
— *decide, validate, then write* — because they are one family.

**The `registerJob` path the reviewer flagged is closed, not hand-waved.** Its
two refusals are `schedule_horizon_exceeded` (needs a `firstFireAtMs` this lane
never sends — unreachable) and `jobid_conflict`. The latter needs a 40-bit
`sha256(tenantId)` slug collision, and shrugging at it would have been wrong for
a reason the rarity hides: `deleteJob` is **jobId-keyed**, so on a collision a
cadence *disable* would have reached into the colliding tenant's job. The
conflict check is hoisted into phase 1 and has its own witness. The `!res.ok`
branch in phase 2 is kept and now logs + 409s, because "unreachable" is a claim
about today's `registerJob` and a silent `ok:false` would be a schedule that does
not exist wearing a 200.

**NOT claimed: atomicity.** There is no transaction across `configs`,
`workflowOwnership`, `workflowRevisions` and `schedulingService`. The guarantee
is that *every VALIDATION failure — the whole reachable refusal surface — happens
before any write*, not that a store outage mid-phase-2 rolls back. Recorded as a
residual rather than written into a comment nobody would re-check.

| Assertion | Sabotage | Result |
|---|---|---|
| a refused PUT leaves no config, no workflow, no ownership row and no job | *(the pre-fix code itself, one assertion at a time)* | **4 separate MEASURED REDs**: `a refused PUT persisted the schedule it refused`; `a 400 still registered a workflow for the entry processed first`; `a 400 still published the workflow into the builder gallery`; `a 400 still registered a live cron job` |
| — | `configs.put` moved back above phase 1 | **2 reds** — the *same* assertion ("the config did not persist") through the two refusal lanes that both assert it (unfilled-param, jobId-conflict); no other test moves |
| a jobId owned by another tenant is refused before any write, and that tenant's job is untouched | the phase-1 `getJob` pre-check removed | **1 red**: `a refused PUT persisted the config anyway` |
| the same two entries, both satisfiable, DO all get built | *(matched positive control)* | passes throughout — the refusal is a gate, not a general failure to reconcile |

### §Correction 3 — the activation approval was created before the PATCH was validated

`routes.ts` queued the `strategy-activation` approval and **then** called
`updateStrategy`, which is the validator. `PATCH {status:'active',
planningHorizon:'not-a-horizon'}` therefore returned **400**, changed nothing,
and left a **live pending approval** — an approver holding a request to activate
a strategy whose owner had been told the change was rejected. Pre-existing, but
**§3 widened the reachable origins** from `draft` alone to `{draft, paused,
completed, archived}`, so every one of them inherited it. Same write-then-validate
family as §Correction 2.

**Cure:** the gate's DECISION stays where it was (it must, because it decides
what the patch contains — `status` is stripped from it); only the SIDE EFFECT
moves below `updateStrategy`.

**One deliberate behaviour change, called out rather than smuggled:** the
approval is now built from `updated` rather than the pre-patch `s`. A PATCH may
change the title in the same call, and an approval card must name the strategy as
it now stands; with a relocation in the same call it is also queued in the
**destination** org, whose approvers are the ones with authority over where the
strategy now lives. `status` is stripped from the patch, so `updated.status` is
still the origin status `strategyFromStatus` must record.

| Assertion | Sabotage | Result |
|---|---|---|
| a 400-ing activation PATCH queues no approval (asserted at `draft` and at the `paused` origin §3 opened) | re-queue before `updateStrategy` | **2 reds** — the same assertion at the two origins, deliberately paired so a fix that only covers `draft` cannot pass |
| the same activation, valid, still queues and still projects `activationPending` | *(matched positive control)* | passes throughout — the fix is an ordering change, not a disabled gate |

### §Correction 4 — "approve what you see" held for ONE origin, not every origin

Two claims said the opposite of what the code did: `activationApproval.ts`
commented that the `strategyFromStatus` compare makes the guarantee *"hold for
every origin state"*, and §3 said the terminal carve-out was covered by the
destination rule *"and the approver sees the edited content."*

**Both false.** The compare catches only an edit that **moves the status**, and
whether a protected-field edit moves it is decided by
`protectedEditRequiresReapproval` — `false` for `draft` (unapproved) and `false`
for the terminal states. So: queue an activation, then `PATCH {objectives:
<swapped>, accountableExecutive:'Attacker'}`; neither gate branch matches, the
status never moves, the approver's `s.status === queuedFrom` check passes, and
**swapped content goes live**.

**The review's own scoping of this was too narrow, and enumerating the class
found it.** The finding named `archived` and offered `paused` as a passing
matched control, implying the guarantee held for `draft`/`paused`. Walking the
posture table instead of the example shows it held for **`paused` alone**, and
only incidentally (its auto-revert happens to move the status the compare reads).
`draft` — the ordinary, default origin, the one every pre-existing row was queued
from — was wide open. Measured, not reasoned: three origins reproduced red.

**Cure — the reviewer's content-hash suggestion REJECTED, the finding taken.** A
hash stamped beside `strategyFromStatus` invalidates on any content change, so it
changes the 409 rate for benign edits — and the reviewer said to measure that
before shipping. There is a narrower rule that needs no measurement: the trigger
is already known exactly (`PROTECTED_FIELDS`, the same set the auto-revert uses),
so a protected edit **withdraws the submission** rather than leaving a card whose
content moved. One rule, every origin, at the one composition owner (the PATCH
route), reusing the `rejectPendingApprovalForPage` precedent. It never fires on a
benign edit — there is a matched control for exactly that — and it does not touch
the un-archive reservation, so the escalation the carve-out refuses stays
refused. It runs BEFORE the queue, so `PATCH {status:'active',
objectives:<swapped>}` against an already-pending review replaces that review
rather than inheriting it.

**Not silent:** the response carries `activationReviewClosed: true` and the audit
gets `activation-withdrawn`. The owner's own edit withdrew their submission; a
`204`-shaped silence there is the STR2-M5 lesson repeated.

**A SECOND LANE, found by call graph rather than by the example.** Walking
`updateStrategy`'s callers instead of re-reading the finding turned up
`POST /:id/versions/:n/restore`: it writes **all four** protected fields and does
not pass through the gate block at all, so restoring an old revision under a
pending review swaps the approver's content one verb away from the lane the
review named. **Reproduced red before it was fixed** — filing it as a residual
would have been the §2-lane-5 mistake a second time. It is the same rule through
the same function (`withdrawActivationReview`), not a second hand-written copy;
a second copy is what SPC-2 *was*.

**The trigger is PRESENCE, not a value diff** — a protected key being written,
exactly like the `autoRevertedFields` rule beside it. So a no-op restore, or a
`PATCH {objectives: <identical>}`, withdraws the review. That is deliberate: it
matches the existing auto-revert semantics, and a value-diff rule is a different
and unmeasured semantics that would make the two rules drift. This is also
precisely why the reviewer's content-hash was declined here.

| Assertion | Sabotage | Result |
|---|---|---|
| a protected edit closes the pending review, at origin `draft` | withdrawal scoped to `s.status !== 'draft'` | **1 red** (draft only) |
| …at origins `archived` and `completed` | withdrawal scoped to non-terminal origins | **2 reds** (archived, completed) |
| the swapped content does not go live off the withdrawn review | withdrawal disabled entirely | **red with the escalation named**: `swapped content went LIVE off a withdrawn review: expected 'active' not to be 'active'` |
| the RESTORE verb withdraws the review too | that call site unhooked | **1 red**: `a restore swapped the content under a live review and left it approvable` |
| an UNPROTECTED edit (a rename) leaves the review standing | `touchesProtected` guard dropped | **1 red** on the over-fire control — the fix cannot pass by withdrawing everything |
| `paused` keeps its auto-revert | *(matched control)* | passes — the closure is additive to the revert, not a replacement |

### §Correction 6 — the KB purge is right; the reasoning defending it was not

§4 Decision 2 and the comment beside the call argued removal-first *"fails
CLOSED"* while index-first would *"fail OPEN"*, and that the worst case was
*"the doc is absent and `reindex-kb` restores it"*. **The shipped code is not
wrong. The reasoning is**, on all three legs, and it is what the next editor
would trust while reordering two adjacent lines:

1. **Neither can throw.** `removeStrategy` and `indexStrategy` both wrap
   everything in `try/catch { log.warn }`. Neither can abort the other, so
   neither ordering can "fail closed" *relative to* the other.
2. **The collections are disjoint.** `collectionIdFor(existing.orgId)` vs
   `collectionIdFor(next.orgId)`. On a move they never touch the same document.
   **Swapping the order changes nothing** — the asymmetry does not exist.
3. **The claimed recovery is unreachable in the direction that matters.** If the
   REMOVAL fails, `reindex-kb` on the old org runs `backfillStrategyKb(tenantId,
   oldOrgId)` → `listStrategies(tenantId, {orgId: oldOrgId})`, which filters
   `s.orgId === orgId`. The relocated strategy now carries the NEW org, so that
   sweep never visits it, and nothing anywhere enumerates KB docs looking for one
   with no backing strategy. **A failed eviction is permanent.**

**Cure — the reviewer's observability half taken, the sweep half filed.**
`removeStrategy` now RETURNS its outcome instead of only swallowing it, and the
relocation call site raises a distinct `log.error('strategy_kb_relocation_
eviction_failed')` with both org ids. That is the honest safety story: it does
not come from the ORDER, it comes from the eviction being observed — because
unlike an archive, a failed eviction on a move leaves a `contentTrust:'trusted'`
copy readable by an org the strategy has left, and nothing will clean it up. The
false rationale is struck in the ADR and rewritten in the code comment.

**The orphan sweep is NOT shipped** (see residuals). Reconciling
`mgd-strategy-<org>` against its backing strategies would be the structural cure,
but it deletes KB documents on the premise that nothing else ever writes to that
managed collection — a premise not established here, and deleting user data on an
unverified premise is precisely the "my fix is worse than the bug" trap.

| Assertion | Sabotage | Result |
|---|---|---|
| neither `removeStrategy` nor `indexStrategy` can throw (leg 1, the premise the old rationale needed) | make `removeStrategy` rethrow | **3 reds** — it is a load-bearing premise of the whole file, which is the point: `promise rejected "kb store down" instead of resolving` |
| a FAILED eviction is reported (`false`), a successful one is not | return `true` from the catch (i.e. swallow again) | **2 reds**, incl. `a FAILED eviction reported success — the caller cannot alert on it` |
| `backfillStrategyKb` on the OLD org processes ZERO strategies and cannot restore the invariant (leg 3) | drop the `orgId` filter from the sweep | **1 red**: `the old-org sweep saw the relocated strategy after all: expected 1 to be +0` |
| the destination copy exists and the stale copy is present before the sweep | *(matched positive controls)* | the eviction assertions cannot pass against a KB that was never written |

### §Correction 5 — the SPC-2 fix bought an uncached member-table scan per link

Closing SPC-2 turned a branch that made **zero** access calls into one that calls
`canReadOrg` per (strategy × priority link). Each call is `subjectHasOrgScope →
resolveEffectiveAccess → members.list()` (`accessControlService.ts:1240`) — a
**full member-table scan with no cache anywhere on the path**. `GET
/strategy/timeline` fans that across the whole readable portfolio over an org id
set that repeats almost entirely (30 strategies × 5 links = 150 scans), on a
route `CLAUDE.md` already flags for read-budget fan-out. `resolveStrategyContext`
had memoized the same boolean per resolve since ADR 0080; the timeline lane
memoized nothing.

**Cure:** the shared `orgReadPredicate` from §Correction 1 is **memoized by
construction** — one predicate per request, O(distinct orgs) scans. It caches the
PROMISE (so the portfolio's `Promise.all` fan-out shares one in-flight scan
instead of racing N) and evicts on rejection (so a transient store error cannot
poison the rest of the request). Authority cannot change mid-request, so nothing
depends on re-evaluation.

**The second half is the wiring, and it is the half that would have been missed:**
`GET /strategy/timeline` built the predicate *inside* the `.map`, so a
per-construction memo would have handed every strategy a fresh empty cache — a
perfectly working memo, buying nothing exactly where the fan-out is. It is
hoisted, and the hoist has its own witness.

| Assertion | Sabotage | Result |
|---|---|---|
| the predicate returns the SAME in-flight read per org id (and distinct reads per distinct org, still answering `true`/`false` correctly) | drop the cache lookup | **1 red**: `a repeat org read started a second member-table scan` |
| `GET /strategy/timeline` builds ONE predicate for the whole fan-out | move the construction back inside the `.map` | **1 red**: `the predicate was rebuilt per strategy …: expected 3 to be 1` |

### §Correction 7 — the blast-radius ARITHMETIC was right; the DEFINITION was not

Independently recomputed against `origin/main` (`c48239388`), walking
`pack.json → chains[].dag.edges`: **58 packs / 179 chains / 434 edges**; **257**
portless edges; **57** edges into a `notify` node with **45** portless; **47**
notify nodes in **45** chains across **20** packs with `message` unbound; the
20-row per-pack table sums to 47 and matches pack-for-pack; post-fix **44 / 42 /
19**. **Every headline number reproduced exactly.**

The DEFINITION did not. §5 said portless means *"`from` and/or `to` has no
`.port` qualifier"*; computed four ways that yields `to`-only **257**,
`from`-only **299**, either **302**, both **254**. Only `to`-only reproduces the
numbers. One word, but anyone re-deriving the sweep from that sentence gets a
population 18% larger than the one that was measured — corrected in place, with
the reason (`to` is the side that decides which input a value lands on).

The inherited premise is now stated rather than assumed: `scheduler.ts:373-374`
computes `const targetPort = e.targetInput ?? 'input'` and assigns
`out[targetPort]`, so a portless edge writes to `input` and **never** to
`message`. If that were false the whole 47 would be a non-finding, and it was
nowhere written down.

### §Correction 8 — double evaluation, and a residual that understated itself

`parseEntry` was evaluated twice per key and `parseParams` twice per entry — six
`parseEntry` calls plus four `parseParams` calls for three entries. Harmless
while both are pure. Both are now evaluated once (the `parseEntry` half rode
§Correction 2's phase split).

**No witness, and deliberately none claimed:** a pure function called twice is
unobservable by construction, so there is no assertion that could fail. Writing
one would mean making the validator impure, i.e. creating the very defect the fix
is against. This is recorded as a latent-trap fix, not a tested guarantee.

`SPC-15`'s residual said `CadenceEntry.params` *"has no SPA writer"*. **It
understates itself:** `grep -rn 'strategy/cadence' frontend/react/src` returns
**zero** hits and `strategyClient.ts` contains no `cadence` at all — there is no
GET, no PUT, no screen. The cadence config in its entirety, not the `params`
field, is API-only. Corrected in the residual table.

### §Correction 9 — the harness mirrored half the executor, and nothing pinned the mirror

§1 fixed `buildCtxInputs` once (it had been edge-only, ignoring `node.inputs`).
The repaired mirror still copied only the LAST half of the executor's rule — the
single-`input` unwrap and the fixture-wins merge — and none of the RESOLUTION
half: `{{inputs.X}}` whole-token bag lookups, `{type:'variable'}` references, and
`{type:'static'|'literal'}` `PortValue` descriptors. Faithful only
**accidentally**: non-deferred `expandChain` freezes tokens, and no strategy node
declares a descriptor. The first chain node using a produced-variable input or a
deferred expansion gets a raw descriptor object in the harness and a resolved
value in production — **a green test over a broken chain**, the exact class §1
exists to prevent.

**Cure — the reviewer's FIRST option, not the cheaper second.** Pinning the two
implementations against each other with a fixture freezes today's agreement on
the cases someone thought to write down and leaves the drift surface intact
everywhere else. The rule is extracted instead into `executor/nodeCtxInputs.ts`
(`resolveDeclaredInputs` + `buildNodeCtxInputs`); the executor calls it and the
harness imports the same functions. A test double that models the executor IS a
second implementation of the executor.

| Assertion | Sabotage | Result |
|---|---|---|
| a `{type:'static'}` descriptor resolves to its value · a `{type:'variable'}` resolves against the bag · a whole `{{inputs.X}}` token resolves RAW (and mixed text still interpolates) | the pre-§Correction-9 hand-written mirror restored verbatim | **exactly 3 reds**, one per drift shape, e.g. `expected { type: 'static', value: 'the body' } to be 'the body'` |
| the single-`input` unwrap + fixture-wins merge (the half the mirror DID have) | same sabotage | **stays green** — the three reds are the drift, not a blanket |
| the executor is behaviourally unchanged by the extraction | *(regression)* | `dag-execution`, `scheduler`, `executor-durability-adr0326`, `executor-terminal-failure`, `executor-default-safefetch`, `chain-backed-flagships`, `migration-retarget-notify`, `scheduled-agent-chats`, `node-inputs-expansion`, `run-input-interpolation`, `repair-stripped-workflow-inputs`, `reseed-rows-deferred`, `cms-chain-execution`, `workflow-chain-content-execution` — all green |

### §Correction 10 — two guarantees this ADR CLAIMED that no test covered

Sabotage proves an assertion is load-bearing; it cannot invent the assertion
nobody wrote. Two of this ADR's claims rested on a code reading alone:

**1. The privatizing relocation variant (§4 Decision 2).** The ADR names
`PATCH {orgId, scope:'user'}` specifically — it used to remove from the NEW org
(where nothing was ever written, since `shouldIndex` is false for a user-scoped
row) and leave the now-PRIVATE strategy fully readable in the OLD org's shared
KB, "the inverse of the ADR 0100 §CRITICAL carve-out". `SPC-4B` exercised only a
plain move; grepping the suite for the combination found **zero** tests. Now
witnessed, with the org-A doc asserted PRESENT first so the two absence
assertions cannot pass against a KB that was never written. Sabotage (eviction
disabled) → **2 reds**, one being `a now-PRIVATE strategy stayed readable in the
old org shared KB`.

**2. The premise §Correction 1's fallback rests on.** The tenant-wide fallback
for a subjectless run is only correct because a cadence fire genuinely has no
acting human — `cadence.ts` passes no `metadata` to `registerJob`, and
`scheduleDaemon.ts:131` forwards `actingUserId` only from `job.metadata`. That
was asserted in a comment. If anyone ever attributes cadence jobs to their
configuring owner, **every scheduled digest silently narrows** to that person's
org reads and no test would notice. Now pinned, including the distinction that
matters: `ownerUserId` (the authority the run carries) must stay set, while
`metadata.actingUserId` must stay absent. Sabotage (add
`metadata:{actingUserId}`) → **1 red**, naming the consequence.

---

## Residuals — open, and open ON PURPOSE

Each of these was reached and deliberately not closed in PR-A.

| Id | Residual | Why not now |
|---|---|---|
| `SPWF-1` (corpus) | **44 notify nodes in 19 other packs** ship title-only. Enumerated in §5. | Other features' packs; fixing them here would hide the count inside a strategy PR. Needs its own sweep + 19 pack version bumps. |
| `SPWF-1` (structural) | No conformance rule forbids a portless edge into a node with a named body port. | Needs the notify node's input schema readable by the checker for every target typeId. |
| `SPC-15` / UX | ~~`CadenceEntry.params` has no SPA writer~~ — **CORRECTED (§Correction 8): the cadence config has NO SPA SURFACE AT ALL.** `grep -rn 'strategy/cadence' frontend/react/src` → zero hits; `strategyClient.ts` has no cadence call of any kind. Not a missing field on a screen — a missing screen. All three schedules are API-only. | PR-B (UX). The backend refusal is honest either way: without params the save 400s instead of silently failing nightly. |
| `SPC-9` | `PUT /cadence` still silently deletes the schedules an absent key omits. | Not in PR-A's scope; full-replace is a defensible PUT semantic, the gap is disclosure. |
| `SPC-8`, `SPWF-9` | `cadence.ts:121` still uses fire-and-forget `registerWorkflow` rather than `registerWorkflowDurable`; the live-collab skip still registers the job unconditionally. | Both are reliability, not isolation. One-line each, but each needs its own witness. |
| `SPWF-8` | Cadence jobs keep firing after the `strategy` toggle is turned off. | Needs a per-tenant re-check at fire time in `scheduleDaemon`, i.e. a host change. |
| `SPWF-4` / `SPC-24` | Declared chain `outputs` still name ports no node produces; the stamped primary is `deliver`. | Touching `outputs` is another chain-version bump and a separate contract decision. |
| `SPWF-5` | Chain-level `capabilities` is still not propagated onto expanded nodes, contradicting the vendored schema's normative MUST. | Repo-wide expander change + a wire-honesty question; belongs with the RFC 0013 lane, not here. |
| `SPWF-10` | The strategy **chain** pack is outside the attestation model (`gen-steward-manifest` walks `packs/` only). | Not a live break — no digest is wrong — but it is why `SPWF-1`/`SPWF-3` could ship unnoticed. Host-wide decision. |
| `SPC-7` | `mode: 'sync'` is a caller-supplied node input; three module docs call the proposal-only posture "STRUCTURAL". | Model-facing honesty (Wave 3). Fixing it edits `packs/feature.strategy.nodes` content ⇒ pack version bump + `requiredPacks` + steward re-attestation. Deliberately batched, not smuggled into PR-A. |
| `SPC-20`, `SPC-21`, `SPC-6`, `SPC-10` | success-carrying-an-error catch blocks; `get-context` succeeds-with-empty where both siblings refuse; the check-in decide 404-after-effect; the silently discarded `approvalId`. | Wave 3. `SPC-6` in particular is authority-safe (`checkInApproval.ts:58-65` re-derives and re-checks) — it is a response-correctness defect. |
| `SPC-22` | No strategy node declares a port schema, which is what makes `findMissingRequiredConfig` structurally blind to `create-board-memo.orgId`. | The save-time refusal in §5 closes the *reachable* consequence; the schemas are the structural cure and are a pack-content change (see `SPC-7` above). |
| `SPC-27` / `SPWF-11.1` | `packs/feature.strategy.nodes/index.mjs:67` still claims "static node `inputs` are stripped by the executor". **False** — `executor.ts:681-710` resolves them (ADR 0237). | Same pack-content/re-attestation batch. The harness that shared the wrong model of the executor **is** fixed (§1). |
| `SPC-17`, `SPC-23`, `SPWF-11.3` | ADRs 0079/0080 still assert a READ-ONLY surface that ADR 0231 falsified; ADR 0079's header is stale; ADR 0231 names pack v1.1 (disk is 1.2.0). | Doc lane (Wave 4). Highest-value doc fix in the set and explicitly still open. |
| `SPC-26` | `agent-prompt-tool-ids.test.ts` cannot see the analyst prompt's **unprefixed** tool names. | Repo-wide lint change. |
| §1 rejected | Other features' pack tests still `import()` their pack modules directly. | The reachability pattern is now in the repo once; applying it broadly is a sweep. |
| ~~§2 lane 5~~ | ~~`surface.ts` passes `async () => true` for the run/agent lane. Deliberate ("tenant-trusted") and documented~~ | **WITHDRAWN — this residual was a live leak, not a deliberate posture. Closed in §Correction 1.** |
| §Correction 1 (row lane) | The surface's **strategy-row** lane is still tenant-trusted: a human-owned run sees every `org`/`workspace`-scoped strategy in the tenant, including `org`-scoped ones in an org the run owner cannot read. `isShared` is the only filter. | Deliberately **not** widened inside a fix for the link lane. It is the documented ADR 0079 surface posture, it is identical for the system runs that must keep it, and narrowing it would change what every scheduled digest covers. Needs its own decision + its own witness — the SAME reasoning that made lane 5 wrong, so it is filed as a claim to test, not a posture to trust. |
| §Correction 4 (SPA) | `activationReviewClosed` is a new response field with **no SPA reader** — the screen still cannot say "your edit withdrew the submission". | PR-B (UX), alongside `SPC-15`. The backend is honest either way: the card is gone from the inbox and the audit records `activation-withdrawn`. |
| §Correction 4 (revert lane) | `POST /:id/versions/:n/restore` now WITHDRAWS a pending review, but it still does not fire the **auto-revert** branch: restoring old objectives onto an `active` or `paused` strategy rewrites protected content without reverting it to `draft`, which `PATCH` would do. | A pre-existing §3-class hole in a lane §3 never enumerated. It is a behaviour change to a verb outside this correction's reproduction, so it is filed with the reproduction recipe rather than fixed on the way past — the opposite failure to §2 lane 5, which shipped a *reason* instead of a test. |
| §Correction 6 (orphan sweep) | Nothing reconciles `mgd-strategy-<org>` against its backing strategies, so a KB doc whose eviction FAILED is permanent. The new `log.error` makes it visible; nothing repairs it. | The sweep would delete KB documents on the premise that nothing but this indexer writes to the managed collection. That premise is plausible (the collection is created here, `managed:'strategy'`, docs keyed by strategy id) but **not established**, and deleting user data on an unverified premise is the failure mode this whole round is about. Needs the managed-collection write surface enumerated first. |
| §Correction 2 (atomicity) | `applyCadenceConfig` phase 2 is **not** transactional: a STORE failure between `configs.put` and the last `registerJob` still leaves a partial reconcile. | No transaction spans these four stores, and inventing a compensating unwind is how a fix manufactures a new failure mode. The reachable refusal surface (bad cron, bad params, missing chain, unfilled required params, foreign jobId) is entirely in phase 1 — that is the guarantee that is claimed, tested, and true. |
| §Correction 3 (org move) | An activation queued in the same PATCH as a relocation now lands in the **destination** org. | Deliberate and argued above, but it is a behaviour change with no separate witness of its own beyond the reordering tests. |
| §Correction 1 (projects) | The run lane still passes `callerSubject: undefined`, so member-scoped `private` projects stay omitted from a human-owned run's context even when that human can read them. | Fail-CLOSED, so not a leak — an under-read. Widening it is a behaviour change to what runs return, not a security fix. |

---

## Implementation record

| § | Change | Commit |
|---|---|---|
| — | ADR reservation | `aacfd4d34` |
| §1 | instruments red-first (MEASURED RED: 5 failed / 4 passed) | `32dabdc5d` |
| §2 | `SPC-2` shared link gate | `ac5fc359b` |
| §3 | `SPC-5` state-set gate + `strategyFromStatus` | `52ec495be` |
| §4 | `SPC-3` write gate, `SPC-4` destination gate + KB eviction | `69c8adfbf` |
| §5/§6 | bound bodies, save-time refusal, chain versions, per-chain gate | `911c26798` |
| §1/§6 | expanded-shape + determinism assertions, ADR | `1ab67e019` |

**Gates run for the original six sections** (targeted only — the full
`npm run ci` is owned by the caller, and a second fleet corrupts both results):
`tsc --noEmit` clean; `scripts/check-pack-version-bump.mjs` ✓ (and proved
capable of failing); `scripts/gen-steward-manifest.mjs --check` ✓ (208 packs,
unpiped, exit 0); all strategy / planning / priority-matrix suites plus
`chain-config-conformance`, `seeded-chain-unfilled-params`,
`seed-deferred-and-embedded`, `workflow-pin-site-ratchet` and
`pack-manifest-impl-parity` green.

### Round-2 corrections (the adversarial review of PR-A)

| §Correction | Change | Commit |
|---|---|---|
| 1 + 5 | the run-surface cross-org leak §2 called deliberate; ONE shared memoized `orgReadPredicate`; portfolio hoist | `77a803db4` |
| 2 + 3 | validate-then-write: the cadence phase split + jobId pre-check, and the activation approval moved below the validator | `7e8720066` |
| 4 | "approve what you see" — submission withdrawal on a protected edit, PATCH **and** restore | `19198622d` |
| 6 | the KB purge's false rationale replaced; `removeStrategy` reports its outcome; relocation eviction logged | `2a7a704cc` |
| 7 + 8 + 9 | portless DEFINITION corrected + premise stated; double-eval removed; `SPC-15` residual corrected; executor input-building extracted to `executor/nodeCtxInputs.ts` | `657ade54d` |
| 10 | two claimed-but-untested guarantees witnessed (privatizing relocation; the subjectless-cadence premise) | `2706afc3d` |

**Gates run for the corrections — and ONLY these. Nothing else is claimed.**

- `node node_modules/typescript/bin/tsc --noEmit` — **clean**, re-run after every
  correction and after every sabotage restore.
- 20 targeted vitest suites, **163 tests, all green**: the full `strategy-*` set
  (`cross-org`, `governance`, `chain-execution`, `kb-relocation-eviction`,
  `route`, `surface`, `agent-tools`, `timeline`, `health`, `honesty`,
  `knowledge`, `checkins`, `context-memo`, `nodes`, `floors`,
  `pii-and-archival`, `board-showcase`, `commerce-revenue`) plus
  `workflow-chain-strategy` and `planning-kb-backfill`.
- Executor-extraction regression (§Correction 9), **14 suites green**:
  `dag-execution`, `scheduler`, `executor-durability-adr0326`,
  `executor-terminal-failure`, `executor-default-safefetch`,
  `chain-backed-flagships`, `migration-retarget-notify`,
  `scheduled-agent-chats`, `node-inputs-expansion`, `run-input-interpolation`,
  `repair-stripped-workflow-inputs`, `reseed-rows-deferred`,
  `cms-chain-execution`, `workflow-chain-content-execution`.
- Approval-service neighbours (§Correction 4 touches core):
  `cms-approval-hardening`, `dealers-honesty` green.
- **NOT re-run, and not claimed:** `npm run ci`,
  `scripts/check-pack-version-bump.mjs`, `scripts/gen-steward-manifest.mjs
  --check`. **No pack, schema or `pack.json` content changed in this round**
  (`git diff --name-only 1ab67e019..HEAD` is backend `src/`, backend `test/` and
  this ADR only), so no re-attestation is due — but the attestation gate itself
  was not executed, and this line is a scope statement, not a green.

**Every sabotage was restored and verified against the committed file**, not
merely reverted in the working tree: `git status --porcelain` is empty, and each
sabotaged line was re-read out of `git show HEAD:<path>`.
