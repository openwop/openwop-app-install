# ADR 0472 — Retire the `builtinWorkflows` seam once and for all

Status: implemented (all phases 0–4 complete 2026-07-23; the `builtinWorkflows` seam is fully retired — field deleted, `host/builtinWorkflows.ts` deleted, quarantine drained to zero)

## Context

The chains-or-stacks doctrine (CLAUDE.md § "Workflows — never hard-code",
ARCHITECTURE.md) states a workflow is **never** a hard-coded, in-tree definition:
it ships as a **chain** (nodes + edges, an RFC 0013/0133 workflow-chain pack —
builder-editable, `/`-runnable, tenant-ownable) or a **stack** (todos on a kanban
board, ADR 0311). Yet the deprecated ADR 0072 seam `BackendFeature.builtinWorkflows`
(+ `host/builtinWorkflows.ts`) still exists and **20 feature files still declare it**,
pinning ~74 workflow ids as code that is **invisible to `/builder` and the `/`
picker** (both list only the ownership index / chain gallery). Such a workflow
silently forfeits the product's core selling points: UI ownership assignment,
clone/copy/edit in the visual builder, and `/`-slash ignition in AI chats.

**Why fresh sessions keep recreating this anti-pattern** (the root cause this ADR
addresses): the wrong path is the path of least resistance (a ~15-line typed object
in a file you're already editing), it is **self-templating** (74 existing examples
teach the next session), and **nothing fails** when you use it — the deprecation is
prose, the type is not even `@deprecated`, and there is no CI gate. Documentation
alone has already failed to hold. The fix must be **structural**: make the wrong
path impossible (delete the field), the right path effortless (a one-call
chain-backed registration), and any residue loud (a ratchet + reachability test).

There are **no production users yet**, so a HARD cutover is available (no
backward-compat window), with one caveat recorded under "Replay" below.

## Decision

Delete `BackendFeature.builtinWorkflows` and `host/builtinWorkflows.ts` entirely,
in a sequenced program. The builtin conflates **two** requirements the migration
splits: **(1) resolve-by-id on every instance (restart/replay-safe)** — the
`host/index.ts` catalog "source A" — and **(2) reachable/editable in `/builder` +
the `/` picker** — the ownership index + chain gallery. A builtin satisfies (1) but
not (2); that is exactly why it is unreachable. The end-state is a single source of
truth (the chain registry) with a boot registration that satisfies BOTH.

### Phases

- **Phase 0 (this change) — the ratchet + this ADR.** `test/builtin-workflow-ratchet.test.ts`:
  NO-GROWTH (no builtin id beyond the frozen `test/fixtures/builtin-workflow-baseline.json`
  snapshot ⇒ a new builtin is a RED build) + MIGRATION-REACHABILITY (a migrated id is
  gone from the field AND loadable as a chain). Transitional guard for Phases 1–2;
  Phase 3 makes it structural.
- **Phase 1 — the friction-reducer.** Generalize the app-builder
  `registerDesignChainWorkflow` precedent (`designWorkflow.ts:137`) into a first-class
  `registerChainBackedWorkflow(chainId, { hostOwned? })`: reads the chain from the
  registry, expands to a **stable, deterministic id**, registers it for resolve-by-id
  (source A), and (when `hostOwned`) records host-owned ownership so it shows in
  `/builder` + `/` and is cloneable. **Accepts ONLY a chainId — never a raw
  `WorkflowDefinition`** (the type is the guardrail against reopening the anti-pattern).
- **Phase 2 — convert the tractable groups** (each deletes its `builtinWorkflows:` line):
  20 convert-clean + `enrollment` → chain packs; 19 MCP tool-projections → chain packs
  (re-point `mcpServerRegistry.ts:50` off `listBuiltinWorkflows()`); 25 walkthroughs →
  seeded owned chains (extend ADR 0435 demo-data; re-point `walkthroughs/surface.ts:18`);
  3 kicktodo lifecycle → chain packs via the Phase-1 API. Re-point every ignition
  constant (agentTools/services) to the migrated stable/chain id.
- **Phase 3 — DELETE THE FIELD (the guarantee).** Remove
  `BackendFeature.builtinWorkflows` (`features/types.ts:87`) + the registration loop
  (`features/index.ts:209`). Anything still pinned moves to a closed, allowlisted,
  **shrink-only** `host/legacyPinnedWorkflows.ts` (a quarantine — NOT a feature-facing
  field; features can no longer declare builtins, TypeScript enforces it).
- **Phase 4 — empty the quarantine, gated on:** **F3** (host fix — `coRegisterSubChains`
  emits a sub-chain child's `parameters` → `variables[]`) unblocks `lesson-batch`; **F2**
  (wire RFC — add `truthy`/`falsy` to `workflow-definition.schema.json §EdgeCondition` +
  `WIRE_OP`) unblocks the `challenge-factory` reject-safe barrier + `campaign-orchestration`.
  When the quarantine is empty → delete `host/builtinWorkflows.ts` + `legacyPinnedWorkflows.ts`.

### Enforcement (so it can never come back)

1. **Type deletion** (Phase 3) — primary guarantee; no field = uncompilable to declare.
2. **Ratchet test** (Phase 0) — no-growth during the migration.
3. **Reachability test** — a migrated workflow must be gallery-reachable, not vanished.
4. **Shrink-only quarantine test** (Phase 3) — the legacy allowlist can only decrease.
5. **No lint tripwire needed** once the field + `registerBuiltinWorkflow` are deleted —
   there is no symbol left to call. The tests are the durable ratchet.

## Alternatives weighed

- **Full delete blocked on F2+F3** — lets the anti-pattern keep breeding while a wire
  RFC lands. Rejected (kills the field too late).
- **New boot API accepts a raw `WorkflowDefinition`** — renames the seam; a code-pinned
  unreachable def is declarable again. Rejected (defeats the purpose).
- **Convert the blocked 3 to stacks** — `challenge-factory` / `campaign-orchestration`
  are branching DAGs; a stack (ordered todos) cannot express branching. Not available;
  hence the quarantine.

## Replay / backward-compat (the one real caveat)

A run stamps `run.metadata.workflowId`; replay/`:fork` re-resolves the definition via
the `host/index.ts` catalog. Deleting `getBuiltinWorkflow` (and where an id CHANGES,
builtin `openwop-app.x` → chain-minted id) is a **breaking change to replay-by-old-id**.
Acceptable ONLY because no production runs exist — the replacement registers under a
**stable deterministic id** (never a random `uuid`), fixtures/seeds are updated for
changed ids, and a hosted deployment with real runs would require an id-alias shim.
Recorded here as the accepted breakage.

## Implementation record

| Phase | Status | PR / evidence |
|---|---|---|
| 0 — ratchet + ADR | implemented 2026-07-23 | `builtin-workflow-ratchet.test.ts` + baseline (74 ids), PR #2431 |
| 1 — `registerChainBackedWorkflow` | implemented 2026-07-23 | `host/chainBackedWorkflows.ts` (chainId-only) + `host/index.ts` source-A resolver + app-builder migrated off `registerBuiltinWorkflow`; `chain-backed-workflows.test.ts` 5/5 |
| 2 — convert groups | **implemented 2026-07-23** — all groups migrated to chain packs (chain-backed same-id): plan-generation (#2430), research (#2433), insights trio (#2434), MCP projections + notebooks + podcasts + production + slides + workflow-author + walkthroughs, then the P4 batches below | — |
| 3 — delete the field | **implemented 2026-07-23** — `BackendFeature.builtinWorkflows` field DELETED (declaring a builtin is now a TypeScript error); the not-yet-migrated defs moved to the explicit shrink-only `LEGACY_PINNED_WORKFLOWS` quarantine in the features barrel; ratchet reads the quarantine + a Phase-3 assertion pins it as the sole pin site | — |
| 4 — empty quarantine + DELETE module | **✅ COMPLETE 2026-07-23** — F2 (RFC 0134 truthy/falsy) + F3 (`coRegisterSubChains` param→variable backfill) cleared, then the final batches drained the quarantine 14→0: campaign-brief singles + kicktodo singles (#2453), cdp-sync + replan (#2454), 5 campaign channels (#2455), campaign-orchestration parallel spine (#2456), and the TERMINAL Challenge Factory + lesson-batch (this PR). The Factory's `build-0..3` reference lesson-batch via RFC 0133 `config.subChainRef`; `buildChainBackedDefinition` gained a **host-default sub-chain binding** that rewrites `subChainRef` → the shared same-id child (reproducing the old builtin's exact dispatch — the tenant `from-chain` path still mints a per-tenant child via `coRegisterSubChains`). With the quarantine empty, **`host/builtinWorkflows.ts` is DELETED** and its two consumers (`host/index.ts` source-A resolver, `mcpServerRegistry` projection) re-pointed to `getChainBackedWorkflow`/`listChainBackedWorkflows`. A code-pinned, UI-unreachable workflow is now inexpressible at every layer: **field deleted + module deleted + empty ratchet (NO-GROWTH anchored at 0 + a PHASE-4 assertion that the module file is gone)** | — |
