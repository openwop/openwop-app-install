# ADR 0703 — Drain instance #3, and re-anchor the gate its own success broke

Status: **implemented** (status corrected 2026-09-17 — see § Status correction)

Feature loop 2026-09, iteration 40 — Channels (`FEATURES.md` ordinal 208,
ADR 0126/0154/0202/0195). Graded at `origin/main` `eef31c2cd`. Ids continue the
2026-08-27 pass (`CHWF-`).

## Context

Channels graded **B+ / A− / A−**, with the workflows pass a "doctrine QUALIFIED PASS"
for one reason: it is **"the SYSTEMIC `SCWF-1` instance #3"** — an in-tree
`WorkflowDefinition` handed to the raw `registerWorkflow()` at boot.

ADR 0701 established (against a stale "the ratchet cannot see them" claim) that the
class is tracked by `PIN_SITE_QUARANTINE` under an exact ceiling, and executed the
drain for scheduled-agent-chats. This is the same drain for instance #3.

## D1 — the drain

`channelTurnWorkflow.ts`'s DEF is **the same shape** as the one drained in ADR 0701:
one `agent-runner` node, four variables (`agentId`, `task`, `credentialRef`,
`conversationId`), no edges. And `channelAgentDispatch.ts:114` supplies **exactly those
four keys** through the run's `configurable` — verified, because "same shape" was the
assumption that needed checking, not the conclusion.

- **D1a** — ship as `core.openwop.workflows.channel-turn`, `chainId` = the original
  `openwop-app.channel.turn`, registered chain-backed under that id, so
  `startWorkflowRun` and every run stamp keep resolving.
- **D1b** — `PIN_SITE_QUARANTINE` entry removed and `PIN_SITE_CEILING` **3 → 2** in the
  same commit. The one remaining *product* entry is
  `kicktodo-core/conveneTurnWorkflow.ts`; `routes/artifactTypeSeam.ts` is a test seam.
- **D1c** — `seeded-chain-unfilled-params` **117 → 118**, on the justification ADR 0701
  established and **pinned**: scheduler/dispatch-supplied params, never from the
  gallery, and a param-less gallery copy fails closed via the typed
  `agentRunnerNode.ts:110` refusal. This +1 **inherits a witnessed guarantee** rather
  than repeating an assertion.

## D2 — the anti-vacuity anchor pointed at the file this ADR drained

`workflow-pin-site-ratchet.test.ts`'s non-vacuity leg ("a broken walker would pass
everything") anchors on one site *of each origin*, and its exemplar of "a module-const
literal pin site" was **`features/channels/channelTurnWorkflow.ts`** — the file drained
here. Draining it turned the anchor into a reference to something that no longer exists,
and the leg went red.

That is the gate behaving correctly: it anchored on a real example, and the example got
fixed. Re-anchored on `kicktodo-core/conveneTurnWorkflow.ts`, the one still live.

**With a note for whoever drains that one**, because the next drain cannot re-point it:
when the class is empty the leg must assert against a **fixture the walker must detect**,
so the non-vacuity property survives the success of the migration it polices. An
anti-vacuity anchor built from the defect population has a lifetime bounded by that
population — which is worth knowing *before* the last drain, not during it.

## D3 — the old registration test proved too little

The existing test asserted only `getRegisteredWorkflow(CHANNEL_TURN_WORKFLOW_ID)` is
truthy. Moving the read to `getChainBackedWorkflow` would have kept it green **even if
the migration had produced a definition the dispatch could not drive** — it proved
"something registered", not "the right thing registered".

The read moves *and* the wiring is now asserted: one `agent-runner` node, and each of
the four ports bound to `{type:'variable', variableName:<bare>}` matching what
`channelAgentDispatch.ts` puts in `configurable`. Sabotage: hiding the pack reds it.

## D4 (Blocker) — the drain REMOVED write protection, on this id and on ADR 0701's

Caught by `workflow-overwrite-tenant-guard.test.ts` — **201 where 404 is required.**

`routes/workflows.ts` `isWriteProtected` decided "is this a host-system definition?" with
`Boolean(await getRegisteredWorkflowAsync(workflowId))` — the **raw** registry only.
Chain-backed definitions live in `chainBackedWorkflows`' own registry
(`host/index.ts` catalog source A). So moving a workflow from `registerWorkflow` to
`registerChainBackedWorkflow` silently **removed its write protection**, and any tenant
could `POST` a definition under the host id and overwrite it.

**This was already live on `main`.** ADR 0701 drained `openwop-app.scheduled-chat.turn`
one iteration earlier, so that id carried the same hole from the moment it merged, and
nothing tested it. The channel drain is simply where a test happened to look.

- **D4a** — `isWriteProtected` consults **both** registries. This is faithful to the
  guard's stated contract ("keys on REGISTRATION, not ownership") rather than a
  widening: a chain-backed registration *is* a host registration.
- **D4b** — the guard test now pins **both** drained ids, so the remaining drain
  (`kicktodo-core/conveneTurnWorkflow.ts`) inherits the coverage instead of
  re-discovering the hole. Sabotage: removing the check reds both legs.

**The transferable lesson, and it is bigger than this feature: a migration that changes
WHICH REGISTRY holds a definition changes every predicate keyed on "is it registered" —
and in this codebase those predicates are the authz layer.** ADR 0701 verified
resolution (`host/index.ts:500`), dispatch, boot order and the built shape. It did not
ask *what else keys on registry membership*, and the answer was a write guard.

## D5 (Blocker) — the sweep found a SECOND predicate, on the door a MODEL uses

D4's lesson said to grep every reader of the raw registry and classify each as *lookup*
or *decision*. Doing that found the second one:

`host/workflowOwnership.ts` `isBuiltinWorkflowId` — whose own docblock calls it **"the
authz layer's read of the registry it sits over"** — also consulted
`getRegisteredWorkflowAsync` alone. Its consumer is
`features/workflow-author/workflowAuthorService.ts:257`, which 409s
`builtin_workflow` on an overwrite. So after the drains, **the AI workflow author could
overwrite `openwop-app.scheduled-chat.turn` and `openwop-app.channel.turn`.**

The lane's own comment, twelve lines above that guard, names the asymmetry this
reproduced: *"curation was enforced on the doors a HUMAN uses and skipped on the doors a
MODEL uses."* D4 fixed the human door; this is the model door.

- **D5a** — `isBuiltinWorkflowId` consults both registries.
- **D5b** — a witness pins both drained ids as built-ins, and pins that an unregistered
  id still is not (so the predicate still discriminates rather than answering `true`).

### The import cycle, discharged rather than hand-waved

`workflowOwnership` now imports `chainBackedWorkflows`, which imports `recordOwnership`
back. Both directions are used only *inside functions*, so the live bindings are
populated by call time — but "probably fine" on an authz predicate is the reasoning this
ADR exists to correct. **Leg 1 calls the imported binding directly**, because the
failure mode of a bad cycle is `undefined` at call time, not a wrong answer. It passes;
the cycle is benign *here*, measured.

## RFC verdict

**No RFC.** Host-ext throughout: a workflow moves from an in-tree literal to a chain
pack under the **same** id. No wire shape, no capability advertisement, no conformance
claim.

## Open questions

1. `kicktodo-core/conveneTurnWorkflow.ts` — the last product pin site, same shape, now
   with a **fourth** precedent. Its drain must also replace the anti-vacuity anchor.
2. Whether `routes/artifactTypeSeam.ts` (a test seam that registers an in-tree literal
   per artifact type on a request path) should be drained or formally excused.

## Status correction (2026-09-17)

This record read `Status: Proposed` while its decision was **already implemented and
merged**. Evidence: `ee22b6611` — *drain pin site #3, and restore the write protection the drain removed*, plus `9e8889c8a` (D5, the AUTHOR guard). `LEGACY_PINNED_WORKFLOWS` is empty.

Corrected as part of an ADR-status sweep that found **five** such records (0700, 0701,
0703, 0707, 0708). The failure mode is not cosmetic: `Status:` is the field a planner
reads to pick work, so a stale `Proposed` either sends someone to redo finished work
or tells them a closed defect is still open. `docs/adr/adr-status-not-stale.test.ts`
now fails when an ADR with a merged implementing commit still reads `Proposed`.

Verified per-ADR against the code (`features/index.ts`), not by counting commits — an early pass
of this sweep matched commit BODIES and produced contaminated counts, and ADR 0700's
own citation belongs to a decision that was renumbered away from it.

