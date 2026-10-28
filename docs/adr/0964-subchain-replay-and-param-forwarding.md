# ADR 0964 — Sub-chain replay and param forwarding

Status: Accepted (P1 and partial P2 qualified; P2 completion/P3/P4 open)

**Date:** 2026-10-20
**Program:** Campaign Studio, unblocks ADR 0948 P2 (funnel blueprints as nested chains).
**Touches:** `executor/subWorkflowDispatcher.ts`, `bootstrap/nodes.ts` (core.subWorkflow),
`executor/executor.ts` + `forkReplayResolutions.ts` + `replayDivergence.ts` (replay),
`host/workflowChainPackLoader.ts` (Path A), and after #5013 `host/dispatchWaitAll.ts` +
`routes/interrupts.ts` (the host-resolved wait).
**RFC verdict:** host behaviour that the spec already requires. No wire change. See § RFC.

> **Recovery record (2026-10-25):** both original branches are retained in
> history. P1 is composed after the current durable initial-bag reconstruction,
> preserving deferred configurable values. The recovered P2 code records child
> output-mapping writes and reapplies served sequential sub-workflow outcomes.
> Its original source does not complete D1b, mid-wait forks or divergence
> normalization; those remain open. Qualification must also check mapped secret
> handling and refusal after the source child has been erased. No new replay
> safety claim is made before those checks pass.

## Context

CLAUDE.md calls nesting first-class: "a chain can hold a sub-chain — workflows can hold
workflows". ADR 0948 P2 is the first chain that depends on a child doing real work and
handing a value back. The /architect review of P2 (2026-10-20) found that the three seams
it needs have never been exercised by a shipped chain. Two of them are broken. Each claim
below was re-read on `origin/main` before this ADR was written.

1. **A replay fork re-runs every sub-chain child live.**
   - `core.subWorkflow` (`bootstrap/nodes.ts:761`) is in no side-effect set: not in the generated floor, not in a regex, and with no module flag. So `isSideEffectingNode` is false and a replay fork re-executes it.
   - The dispatcher always mints a new child: `childRunId = randomUUID()` (`subWorkflowDispatcher.ts`, the child-run block). It then calls `executeRun(…)` with no `sourceOutcomes`.
   - So the child is not a replay. Every side-effect node inside it fires again with ids derived from the new child run id. A nested `feature.cms.nodes.create-draft-page` drafts a second page.
   - This is live today for `kicktodo.lesson-batch`.
   - `replay.md`'s rule that a replay "never fires a new side effect" is broken one level down.
2. **A child's return value does not survive a served replay.**
   - `outputMapping` writes the parent's variable bag from inside the dispatcher (`setRunVariable(opts.parentRunId, …)`). That write is not a node output.
   - Serving the node's recorded outputs therefore leaves the parent bag without the child's values.
   - A fork re-seeds the bag from run inputs only.
3. **A from-chain (Path A) parent cannot forward its params to a child.**
   - `inputMapping` reads the parent bag by name (`snapshotRunVariables(parentRunId)[parentKey]`).
   - Path A freezes params into config and declares NO variables for them (`expandChain`: "Path A emits neither"). `seedRunVariables` seeds declared names only.
   - So `inputMapping: {orgId: "orgId"}` delivers `undefined`.
   - The child side is already handled: RFC 0133 §1.3 declares each child parameter as a dispatch-seeded variable.

## Decision

> **Revised 2026-10-20 after /architect** (scope addition from team-lead: the resume
> cascade). Changed from the first draft:
> - the parent's wait keeps the CHILD's interrupt kind;
> - old recorded runs never re-dispatch;
> - `core.dispatch`'s child arm is named in scope;
> - the mirror-interrupt defect below is stated.

4. **A gated child strands its parent, and its mirror interrupt can fabricate the child's completion.**
   - When the child suspends, `core.subWorkflow` returns `{status:'suspended', interrupt:{kind: <child's kind>, data:{childRunId, …}}}` (`bootstrap/nodes.ts:819-830`). The executor then opens an ordinary interrupt of that kind on the parent (`executor.ts:2636`), so the parent shows `waiting-approval` or `waiting-input`.
   - Nothing resumes it: no `onAnyRunTerminal` subscriber reads `parentRunId`.
   - Worse, any approver can resolve the parent's mirror interrupt (`resolveAndResume` has no guard). It takes the native path (`executor.ts:2121-2133`): the node completes with `{output: resumeValue}`, with no `childRunId`/`childStatus` and no `outputMapping`. The parent runs on while the child is still waiting. That is two approval cards, one of which forges the other's outcome.
   - It also breaks `interrupt-profiles.md:63` ("cancelling a child surfaces a deterministic parent outcome").

### D1 — `core.subWorkflow` is replay-served (and so is `core.dispatch`'s child arm)

- **Flag.** `core.subWorkflow` declares `sideEffecting: true`, the module arm `isSideEffectingNode` already reads.
- **One shared fold.** `foldChildTerminal` applies `outputMapping`, skipping UNDEFINED child values (`node-packs.md:106`). Today `subWorkflowDispatcher.ts:395` writes `undefined`, which is a spec bug this fixes. The fold records exactly the applied writes as `outputs.parentVariableWrites`, beside `childRunId` and `childStatus`; `outputs.*` additions are allowed (`node-packs.md:122`). The synchronous path and the D3 resume path both use this fold.
- **Serving.** A replay fork serves the recorded outcome for each ADR 0772 D2 ordinal. A node that suspended and was later re-invoked is ONE execution (`sideEffects.ts:290-322`), so its served outcome is the final one. A `NodeModule` hook (`applyServed(outputs, ctx)`) re-applies the writes, rather than a typeId special case in the executor.
- **Old recorded runs** (no `parentVariableWrites`), in order:
  1. no `outputMapping`, or a child that did not complete → nothing to apply;
  2. otherwise rebuild the writes from the SOURCE child's durable terminal bag (`hydrateRunVariables(outputs.childRunId)`) through the fork definition's `outputMapping`, skipping undefined values;
  3. bag gone → `replay_source_missing`.
  It **never re-dispatches**: re-dispatching is the side effect this ADR exists to stop. The child-run shape of recorded runs is unchanged.
- **Forks taken mid-wait.** If the parent node is `suspended` with a reinvoke-style wait:
  - replay fork: the node is re-queued `ready` with the source's recorded resolution, so serving answers at the same ordinal with the real outputs and writes. If the source never resolved, `replay_source_missing`; never a re-created wait.
  - branch fork: `ready` with no resolution, which is a new dispatch.
  - `forkReplayResolutions.ts` currently ignores `__resumeStyle`; the same gap applies to #5013's dispatch wait.
- **Divergence.** `compareObservableSequences` (`replayDivergence.ts`) drops the source's suspend, interrupt and re-entry events inside an execution the fork served. Without that, every such fork reports a false `replay.diverged`.
- **`core.dispatch`'s child-run arm** has the same hole: it is in no side-effect set, so a Campaign Studio replay fork fires every channel child live.
  - Option D1b: serve it and re-apply the fold in `mergeOrder` (`node-packs.md:172`).
  - Otherwise it is recorded as an open item with a ratchet.
  - Decided in P2, after measuring which chains reach it.

### D2 — a chain parent forwards the params a sub-chain maps

> **Corrected 2026-10-20 (code-review + grade-workflows of the first cut).** The first cut declared each mapped param as a `WorkflowVariable` with the frozen value as its default. That made it a **per-run input**: the SPA builds run forms from `definition.variables`, so a Path A Factory would have prompted for 9 params. A caller's override would then have reached the children while the parent's nodes kept the frozen value, splitting the parent from its children. The first cut also left deferred-mode tenant instances broken, because variables are prefixed while the mapping names stay bare.

As built:
- **Expansion records, it does not declare.** For each param that a `core.subWorkflow` or `core.dispatch` `inputMapping` (or `perWorkerInputMappings`) names as a source:
  - Path A writes `metadata.forwardedParams = {param: frozen value}`;
  - deferred mode writes `metadata.forwardedParamAliases = {param: materialized variable name}`.

  Unmapped params are untouched. A sensitive mapped param fails Path A expansion closed, because it would put the secret at rest in the bag. Deferred mode only aliases it, since the bag already holds the per-run value.
- **The executor writes them into the bag** at the start of every run body (`applyForwardedParams`, right after `hydrateRunVariables`), under the bare name, and never overwrites a value the bag already holds. It runs with the definition being executed, so a fork, a resume and a child run all get the same values. One site covers every launch lane, unlike the ten `seedRunVariables` callers.
- **No variable is declared**, so run forms, `configurableSchema` and run-create overrides are unchanged. The values show in `RunSnapshot.variables` only once forwarded, and they are the same non-sensitive values Path A already froze into config.
- **Chain-backed registrations** (deferred, with names renamed back to bare by `chainBackedWorkflows.ts`) already work; the bare value is present and wins.
- **Recorded:**
  - Tenant workflows instantiated before this change carry no forwarding metadata and stay broken until re-instantiated (there is no backfill).
  - `../openwop` `workflow-chain-packs.md` says expansion-time substitution "mints no WorkflowVariable" (§227). D2 mints none, but a chain that relies on forwarding gets `undefined` on another RFC 0013 host. Filed with P4 as the parent-side counterpart of RFC 0133 §1.3.
  - Campaign orchestration keeps its per-child `briefId` workaround (`nextWorkerInputs`). Per-item inputs win over the mapping, so it stays correct either way.

### D3 — child → parent resume cascade

- **The wait.** When the child returns non-terminal, the node suspends **reinvoke-style**, with an interrupt of **the child's kind**. Conformance scenario HVMAP-2 (`subworkflow-input-mapping.test.ts:150-154`) asserts the parent is `waiting-approval` while the child waits at an approval, so an `external-event` parent wait would be a wire change. The data records `{childRunId, hostResolved: 'subworkflow-child'}`.
- **Resolution.** An `onAnyRunTerminal` subscriber, in the module generalised from the dispatch wait-all decision's `host/dispatchWaitAll.ts` (#5013, unmerged), resolves the wait through `resolveAndResume` under a host-only flag. The resolve value is `{childRunId, status}` observed from storage, recorded on `interrupt.resolved`. Every other resolve route gets 403, which closes the forged-completion defect.
- **Fold.** On re-invoke the node runs `foldChildTerminal`. Under `fail-parent`, a failed or cancelled child fails the node, which discharges `interrupt-profiles.md:63`.
- **Sequencing.** D3 reuses #5013's subscriber, host-only resolve flag and re-invoke-then-fold, and **lands after #5013 merges**, rebased on main and NOT stacked on its branch. D1 and D2 do not touch #5013's files and land first.
- **Resilience.** `onAnyRunTerminal` is process-local: a crash between the child's terminal and the parent's resolution strands the parent. This shares #5013's open reconciling-sweep item.
- **Size.** `parentVariableWrites` duplicates the mapped child values into the parent's `node.completed`. There is no event-size cap today; recorded as a note.

### Not decided here

- The org check on campaign-brief reads. It was fixed separately: branch `fix/campaign-brief-org-scoped-reads`.
- A general bag-replay mechanism for pack nodes that call `ctx.variables.set`. Inside a run, served values travel on edges.

## Alternatives weighed

- **Flat blueprints (no nesting).** These replay correctly today, through edges and served side-effect nodes. Rejected as the end state: a tripwire becomes 15+ duplicated nodes, there is no reusable step unit for ADR 0959 rollout, and the live kicktodo defect stays. Kept as ADR 0948's fallback if this ADR slips.
- **Replay the child as a replay of the source child** (start a child run with the source child's outcomes). It is more faithful, but it adds a child run per fork and needs the source child id threaded through dispatch. Serving the parent node gives the same observable result, and a replay needs nothing more.
- **Declare every Path A param as a variable.** That widens the at-rest surface for params no child reads. Rejected in favour of exactly the mapped ones.

## RFC

No wire change. `replay.md` already says a replay never fires a new side effect, and
`node-packs.md` already prescribes re-applying `outputMapping` for parallel dispatch. A
clarification that sequential `core.subWorkflow` follows the same rule will be filed in
`../openwop` as a non-blocking errata. The host behaviour is required by the existing text
either way.

## Phased plan

| Phase | Scope | Exit / witness |
|---|---|---|
| P1 | D2 | A real run: the parent's frozen param reaches the child run (and returns through `outputMapping`); deferred aliases fill the bare name; no variable is declared; a sensitive mapped param fails Path A expansion; the bag is never overwritten. Factory chain-backed parity holds by construction (deferred path, renamed to bare) |
| P2 | D1 (+ fold, old-run rule, mid-wait forks, divergence); D1b decided | **Witness A:** a replay fork from seq 0 of a parent whose child has a `{sideEffecting:true}` counting node and a pure counting node: both counters 0; `effectCountForRun(fork) == 0`; `listRunsByParent(fork) == []`; the bag equals the source's; `openwop.replay.node.served{recorded-success}` rises; no `replay.diverged`. The same against an old-shape source (field stripped) → bag rebuilt. A branch fork → exactly one new child. The `kicktodo.lesson-batch` Factory replay witness. Sabotage: drop the flag, the re-apply, or the fallback |
| P3 | D3, after #5013 | **Witness B:** a parent whose child has an approval gate: the parent is `waiting-approval`; resolving its mirror directly → 403; approving the child's gate → the parent completes with the mapped bag. A replay fork of that parent → zero counters and children, no divergence. A mid-wait replay fork → the recorded resolution is applied; a still-waiting source → `replay_source_missing`. A cancelled child → the parent fails deterministically. HVMAP-2 re-run green. Sabotage: no subscriber, no guard, no reinvoke tag |
| P4 | `../openwop` errata: sequential `core.subWorkflow` replay; the mirror-wait host-only resolve; parent-side param forwarding (counterpart of RFC 0133 §1.3) | Filed |

## Open questions

1. Should the served `core.subWorkflow` outcome also carry the source `childRunId` for display (debug bundle links)? Proposed: yes. It is already in the outputs.
2. Does any existing chain rely on a replay fork re-running its child (for example to refresh data)? It would have to be a non-side-effect child; serving changes that. Proposed: measure across `examples/` and `packs/` in P2 before shipping.

## Implementation record

| Phase | PR | Commit | Tests |
|---|---|---|---|
| P1 D2 forwarded params (metadata, executor apply) | (this PR) | `214b1912b` | `test/adr0964-p1-param-forwarding.test.ts` (6, incl. a real run where the child receives the frozen param); sabotage-witnessed: no executor apply, no expansion metadata |
| Interim: the parent-mirror resolve guard (the live half of D3's defect) | #5127 | (filled at merge) | `test/subworkflow-mirror-interrupt-guard.test.ts` (5) |


### Recovery qualification checkpoint — 2026-10-25

The recovered P1 and partial P2 sources now include current main `231c73a4c`.
The historical fallback originally called `hydrateRunVariables`, whose deliberate
live-cache preference let a warm bag survive durable child erasure. Three cases
were reproduced RED: erased evidence, a stale warm value, and corrupt/unreadable
evidence. The fallback now reads the authoritative persisted bag through the
existing variable owner, without changing live hydration or dispatching a child.
The three-case repair, real live/replay/branch witness, parameter forwarding and
live hydration are GREEN; the wider focused run passed 86 cases in 15 suites,
including mirror-wait guards, deferred parameters, secret lifecycle and replay
ordinal/divergence checks. Native types passed. Both dependency installs use
Node 22.13.1 and the installed corpus matches 2.46.24.

This is focused qualification only: canonical CI, merge and production rollout
remain pending. It does not complete the original P2 mid-wait/divergence matrix,
D1b policy, D3 resume cascade or P4 protocol errata. Their earlier planning text
is retained; no new wire capability is advertised by this checkpoint.


Recovery BYOK correction — 2026-10-25: source review stopped this task's first
canonical attempt before merge to exercise a child-only credential lifetime.
The real child completed and its durable bag was correctly scrubbed, but its
warm cache retained the synthetic key after `clearRunSecrets`. The new mapped
`parentVariableWrites` then recorded that value in the parent event. This was
reproduced RED before the repair; it is not a claim of production exposure.

The existing variable owner now applies its known-secret scrub to the completed
bag before the executor releases the child's key registry. It does not scrub an
active bag, add a key store, broaden credential authority or run the child again.
The witness now checks source/parent durable records and parent events, plus a
replay that produces no child and receives only the redaction marker. Native
types and all 87 cases in the 15 focused suites are GREEN. Canonical retry 2 is
still required; the interrupted attempt is not a green gate or a waiver.


Recovery flagship correction — 2026-10-25: canonical retry 2 passed 2,815
backend files but exposed an overclaim in the new Factory replay fixture. A
from-zero fork has no inherited suspended checkpoint; the existing host raises
its chat gates. The test now explicitly decides those gates through the same
real interrupt/resume path as the source, and still requires completion, zero
new child runs and equality of every mapped lesson-batch variable. Production
human-gate behaviour is unchanged. This witness establishes sub-workflow
suppression and mapped-state restoration; it does not establish complete gate
replay or the still-open mid-wait/divergence matrix. Native types and 90 cases
in 16 focused suites passed; canonical retry 3 remains required.


Qualified recovery record — 2026-10-25: PR #5219 merged as `e774c8561`,
whose tree exactly matches the complete green gate at `d76259d7c`. Backend
2,816 files / 23,463 cases and frontend 1,105 files / 7,656 cases passed;
both Tracegate lanes reported zero misses. Major-2 conformance, 116 regular
browser checks, three serial checks and the +365-day sweep passed. The resource
guard recorded peak 6.04 GiB and no swap growth. The documented remaining
phases stay open; production deployment awaits operator reauthentication.
