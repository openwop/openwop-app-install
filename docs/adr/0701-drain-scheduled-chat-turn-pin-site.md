# ADR 0701 — Drain the scheduled-chat pin site, and make the gate enforce its own claim

Status: **implemented** (status corrected 2026-09-17 — see § Status correction)

Feature loop 2026-09, iteration 39 — Scheduled agent chats (`FEATURES.md` ordinal 207,
ADR 0125). Graded at `origin/main` `9c2e031b2`. Ids continue the 2026-08-27 pass
(`SCWF-`/`SCC-`).

## Context — the routed finding's central claim is STALE

`SCWF-1` was routed to "the orchestrator/architect, NOT a unilateral per-feature
Blocker" on this reasoning:

> **The ratchet cannot see any of them.** `builtin-workflow-ratchet.test.ts` asserts
> only `LEGACY_PINNED_WORKFLOWS` membership … it does NOT scan for
> `registerWorkflow(inTreeLiteral)` boot calls.

That is true **of that ratchet** and false **of the system**. A second ratchet exists:
`test/workflow-pin-site-ratchet.test.ts` `PIN_SITE_QUARANTINE`, which listed exactly
the three turn-workflows plus `routes/artifactTypeSeam.ts`, under a ceiling, with a
documented drain history **7 → 5 → 4**.

So the class is **tracked and gated**, not invisible — and the question is not a
doctrine debate but an un-executed drain. **Re-routing it a second time would have
carried a stale claim forward.**

## D1 — drain the entry the quarantine is designed to drain

The drain is **proven precedent, twice**:

- `features/assistant/{loops,actionExecution}.ts` (WF-COS-1, 7→5) moved their in-tree
  literals into `core.openwop.workflows.assistant` and registered **under the same
  workflowIds**, so dispatch, approval back-links, per-tenant scheduler rows and run
  stamps kept resolving.
- `host/workflowAuthorSeed.ts` (WFAWF-6, 5→4) drained the *other* sanctioned way — by
  pairing `registerWorkflow` with `recordOwnership`.

### Feasibility was verified, not assumed

The assistant precedent alone does **not** cover this case: its chains declare
`parameters: {}`, so they never exercise parameter binding. Checks actually run:

| Question | Answer |
|---|---|
| Can a chain bind params into an **agent-runner's `inputs`**? | Yes — `kicktodo-replan` does exactly this (`"task": "{{params.participantIntent}}"` on `local.openwop-app.agent-runner`). |
| Do per-fire values survive expansion? | Yes — `registerChainBackedWorkflow` expands with `deferred: true` (RFC 0124), materializing `parameters` as run-overridable `variables[]`. |
| Do the **bare** launch-contract names survive? | Yes — verified on the built definition: `variables` = `[agentId, task, credentialRef, conversationId]` and each input is `{type:'variable', variableName:'<bare>'}`, matching the in-tree DEF exactly. |
| Is it resolvable by id at dispatch? | Yes — `host/index.ts:500` `getChainBackedWorkflow(workflowId)` is in the catalog source-A resolver. |
| Is the boot order right? | Yes — `loadWorkflowChainPacks` (`index.ts:529`) precedes `registerAllRoutes` (`:780`), which is what calls the seed. |

### Decision

- **D1a** — ship the graph as `core.openwop.workflows.scheduled-chat-turn`
  (`examples/workflow-chain-packs/scheduled-chat-turn`), `chainId` = the original
  `openwop-app.scheduled-chat.turn`, and register it chain-backed under that id.
- **D1b** — remove the quarantine entry **and** lower `PIN_SITE_CEILING` 4 → 3 in the
  **same commit** (the map is exact-match in both directions — a stale entry is red).
- **D1c** — the existing Phase-2b/2c wiring test keeps **every assertion**; only its
  READ moves (`getRegisteredWorkflow` → `getChainBackedWorkflow`), because chain-backed
  defs live in that module's own registry. The test pins the *wiring invariant*, which
  is unchanged; rewriting its assertions would have been the wrong repair.
- **D1d** — a new leg pins the **silent** failure mode: `registerChainBackedWorkflow`
  swallows a missing chain into a logged error, so a boot reorder would leave this
  feature registered-with-nothing and no test would care.

## D2 — the gate did not enforce the contract it states

Found while draining, by sabotage. The docblock says:

> The ratchet is exact-match in BOTH directions … **which is why the ceiling and the
> map move in the same commit.**

That is true of the MAP. The **ceiling** was asserted `toBeLessThanOrEqual`, i.e. an
upper bound. **MEASURED: setting the ceiling back to 4 with only 3 entries left the
suite GREEN** — the single number the gate exists to hold could be raised without
adding a site, and only review would notice.

- **D2a** — assert `toBe(PIN_SITE_CEILING)`. Draining without lowering is now red, and
  raising without draining is now red. Re-verified by the same sabotage, which now
  fails as it should.

This is the [[ratchets-police-spelling-not-invariant]] family in a new shape: not a
regex matching the wrong token, but a **bound standing in for an equality**.

## Re-verified and dispositioned

- **`SCC-2`** (re-validate conversation visibility at fire time — a schedule outlives
  the grant that created it) — real, still open, **deliberately not bundled**. It is an
  authz-over-time question deserving its own measurement, and this ADR is a
  registration migration; one witness should not answer two questions.
- **`SCC-3`** is `SCWF-1` cross-filed — closed by D1.
- The two remaining quarantine entries (`channels/channelTurnWorkflow.ts`,
  `kicktodo-core/conveneTurnWorkflow.ts`) are the **same shape** and now have a third
  precedent. Not migrated here — each is another feature's iteration.

## RFC verdict

**No RFC.** Host-ext throughout: a workflow moves from an in-tree literal to a chain
pack under the **same** id. No wire shape, no capability advertisement, no conformance
claim; the RFC 0124 deferred mode it relies on is already implemented and used.

## Open questions

1. Whether the other two turn-workflows should be drained as a batch or per-iteration.
2. `SCC-2`'s fire-time visibility re-validation.

## Status correction (2026-09-17)

This record read `Status: Proposed` while its decision was **already implemented and
merged**. Evidence: `07b18ed6c` — *drain the pin site — chain-backed turn workflow*. Verified in the tree: `LEGACY_PINNED_WORKFLOWS` in `features/index.ts` is an EMPTY array.

Corrected as part of an ADR-status sweep that found **five** such records (0700, 0701,
0703, 0707, 0708). The failure mode is not cosmetic: `Status:` is the field a planner
reads to pick work, so a stale `Proposed` either sends someone to redo finished work
or tells them a closed defect is still open. `docs/adr/adr-status-not-stale.test.ts`
now fails when an ADR with a merged implementing commit still reads `Proposed`.

Verified per-ADR against the code (`features/index.ts`), not by counting commits — an early pass
of this sweep matched commit BODIES and produced contaminated counts, and ADR 0700's
own citation belongs to a decision that was renumbered away from it.

