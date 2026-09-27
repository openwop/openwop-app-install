# ADR 0370 — Workflow-chain pack root precedence + same-pack shadowing

Status: implemented

## Context

`loadWorkflowChainPacks` discovers `kind:"workflow-chain"` packs from three
roots and registers chains first-writer-wins, treating ANY duplicate `chainId`
as a hard `workflow_chain_id_conflict` rejection ("no silent shadow"). Two
problems surfaced in prod (2026-07-14/15):

1. **Noise:** the image vendors `examples/workflow-chain-packs/` in-tree AND
   the same packs are registry-installed into `OPENWOP_PACK_DIR` via
   `OPENWOP_INSTALL_PACKS` — so every boot rejected the second copy of every
   chain: a daily wall of ~51 error-level rejections that trained operators to
   ignore the log line that exists to catch real collisions.
2. **A dead update lane:** root order was `[in-tree examples, install dir,
   operator dir]` with first-writer-wins — so a **newer registry-installed
   pack could never win against the older vendored copy**. The pack-pinning
   workflow (fetch + Ed25519/SRI-verify at boot) silently did nothing for any
   chain id that ships in-tree.

## Decision

1. **Precedence order (first root wins):** operator override dir
   (`OPENWOP_WORKFLOW_CHAIN_PACKS_DIR`) → registry-install dir
   (`OPENWOP_PACK_DIR`) → in-tree examples. An explicit operator choice beats
   a pinned install; a pinned install beats the vendored fallback.
2. **Same-pack duplicates shadow quietly:** a duplicate `chainId` from a pack
   with the SAME name as the already-registered one is that pack's copy in a
   lower-precedence root — logged at info
   (`workflow_chain_pack_duplicate_shadowed`, with kept/shadowed versions),
   never an error. A fully-shadowed pack is not reported as `installed`.
3. **Cross-pack collisions stay hard errors:** a duplicate `chainId` from a
   DIFFERENT pack name keeps the `workflow_chain_id_conflict` rejection —
   "no silent shadow" still holds between unrelated packs, and the error now
   names the winning pack.

## Alternatives weighed

- **Dedupe by name@version only (keep root order):** fixes the noise but not
  the dead update lane — a version bump would still lose to the vendored copy.
- **Last-writer-wins:** simplest, but reintroduces the silent-shadow hazard
  the original design deliberately avoided.
- **Stop vendoring examples in the image:** breaks fresh installs with no
  registry reachability; the vendored fallback is the offline story.

## Phase → artifact

| Phase | Artifact |
|---|---|
| Precedence + shadowing | `host/workflowChainPackLoader.ts` |
| Tests | `test/workflow-chain-pack-precedence.test.ts` |
