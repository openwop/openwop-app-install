# ADR 0766 — Exact node pins in workflow-chain packs (RFC 0177 §E.1)

Status: implemented — P1, P2, P3 and P6 are done (registry #82/#83/#84; production re-pinned, 57/57 installed at boot on `b78a3c55e`). The grade-code / grade-ux / grade-data closeout is recorded below.

Tracker rows: `NP-V2-1`, `NP-V2-2`, `NP-V2-8` in `docs/steward/NODE-PACK-AUDIT.md` (§ "2026-09-28 — against v2").

## Context

`spec/v2/core/workflow-chain-packs.md` §"Exact pins" (RFC 0177 §E.1, **Accepted**):

> Every reference a chain makes to a node type MUST pin an exact version per
> referenced `typeId` (`core.ai.callPrompt@1.0.0`). A host MUST refuse to register
> a chain whose reference carries a range or no version.

MEASURED on `origin/main` (2026-09-28):

1. **The rule guarded one lane.** Only the registry install gate
   (`host/packManifestV2Gate.ts`, `registryInstaller.ts:282`) applied it. The
   vendored/operator chain loader registered **63 chains with 624 of 624
   references unpinned**, which is a live violation of the MUST. The gate applied to
   production is also why all 16 registry chain packs have been refused at every
   boot since 2026-09-20 (`NP-V2-1`).
2. **The gate skipped a reference site.** `compensation.nodeTypeId` "MUST resolve at
   expansion exactly as `typeId` does" (manifest schema), so it is a node-type
   reference too, and the gate never read it.
3. **Nothing in the host could resolve a pinned reference.** The node registry is
   keyed by bare typeId (`executor/nodeRegistry.ts:20`); the only `@` parser in
   `src/` was the gate's. Pinning the chains first would have failed every one at
   dispatch.
4. **The v1 chain schema refuses a pin.** Its `FragmentNode.typeId` pattern is
   `^[a-z][a-zA-Z0-9._-]*$`, and unsigned in-tree packs were routed to v1, so a
   correctly pinned in-tree chain was refused for being correct.
5. **The builder exported unpinned manifests** (`builder/schema/chainPackManifest.ts`)
   with `engines: '^1.0.0'`, a range outside the v2 grammar, into a file the app
   invites users to PR to the registry. `test/chain-pack-export-loads.test.ts`
   proved it: once the loader enforced the rule, it refused the app's own export.
6. `expandChain`'s `isTypeIdKnown` check is passed by **no** production caller, and
   `from-chain` is permissive **by product contract**: an uninstalled node type
   is a `warnings` entry, never a refusal (R6, "Use template = just copy").

## Decision

**Option A: normalize at registration.**

- **D1 (one rule owner, bare ids downstream).** `host/chainPinRule.ts` owns the
  grammar and reads all three reference sites: node `typeId`,
  `compensation.nodeTypeId`, and an external sub-chain's `ref.version`. The install
  gate, the loader and expansion all call it. At registration the loader reduces
  every reference to its **bare** id and lifts the pins into a host-populated
  `WorkflowChain.nodePins` side record, so expansion, the requirements pre-flight,
  the listing, the executor and the builder keep keying on bare ids unchanged.
  `expandChain` normalizes defensively (idempotent) for chains that reach it by
  another road (conformance seams, sub-chain children).
- **D2 (register-time refusal plus a shrinking ratchet).** The loader refuses an
  unpinned chain with `workflow_chain_unpinned`, and a ranged or double-pinned one
  with `workflow_chain_pin_invalid`. The refusal applies to every root, not just the
  registry. `host/unpinnedChainPackAllowlist.ts` waives "no version", and nothing
  else, for the 63 packs that were unpinned when this landed.
  `test/chain-pin-ratchet.test.ts` enforces three things:
  - the list may only shrink (≤ 63);
  - no unpinned in-tree pack is off the list;
  - no entry is stale.
- **D3 (an unhonourable pin is an install gap, not a refusal).** A pinned type that
  is installed at a different version is reported as `typeId@pinned` in
  `requirements.missingNodeTypeIds` (the gallery pre-flight) and in `from-chain`
  `warnings`. This is the same field an absent type already uses, so no new UI
  state is needed and the R6 "just copy" contract is kept.
  - *Correction to the pre-implementation architect note*, which proposed refusing
    at expansion by wiring `isTypeIdKnown`: that would have contradicted R6 for
    pins while leaving absent types permissive. Consistency with the existing
    contract won.
- **D4 (definitions stay bare, pins are recorded).** The persisted
  `WorkflowDefinition` carries bare typeIds. A definition must keep running across
  a node patch, and every tenant-owned workflow already in storage is bare. The
  pins are recorded in `metadata.expandedFrom.nodePins`, which survives `:fork`
  verbatim because the definition does.
- **D5 (a pin routes to the v2 schema).** A manifest carrying any `@` in a node
  reference claims the v2 tree, exactly as a v2 `signing` block does. The v2
  `ids.schema.json` typeId grammar admits an exact pin and itself refuses a
  node-level range. The range the schema cannot catch, an external sub-chain
  `ref.version`, is refused by the rule. Consequence: after P3 the v1 chain route
  serves only waived legacy packs, and it becomes dead code when the ratchet empties.

  > **Correction (P1 code review):** D5 has consequences the first draft did not state.
  > 1. A pinned manifest is judged by the WHOLE v2 schema, not just its typeId
  >    grammar. A v1-only shape is therefore refused as a manifest error: a v1
  >    `signing` block, an extra `engines` key, or a chainId over v2's 128-character
  >    cap. MEASURED: all 63 in-tree packs, with every reference pinned, pass v2 63/63.
  >    The exporter was not safe. Its slug cap of 200 allowed a 216-character chainId,
  >    so a long workflow title exported a file the loader refused. The cap is now 112
  >    (16 + 112 = 128), with witnesses on both sides.
  > 2. A node pin follows the schema's `@[0-9]+.[0-9]+.[0-9]+` exactly: a prerelease
  >    node pin is not an exact pin (`NODE_PIN_RE`). The external sub-chain `version`
  >    keeps full SemVer.
  > 3. **OBSERVED in P3:** a v1 `signing` block (`publicKeyRef` / `signatureRef`) and a
  >    node pin cannot coexist, because v1 refuses the pin and v2 refuses the block. So
  >    a v1-signed pack is necessarily an unpinned legacy pack and registers only when
  >    waived. `chainpack-signature.test.ts` keeps its v1 fixture v1-shaped for that
  >    reason. Every real v2 registry pack uses the v2 `{ keyId, scheme }` block.
- **D6 (the export is publishable).** The builder pins every exported reference
  to the version the host catalog reports (`NodeCatalogEntry.version`, newly
  carried through from the server row). It declares `engines: '>=1.0.0 <3.0.0'`.
  When a node's version is unknown it **refuses to emit** and names the types,
  rather than hand the user a file the registry and this loader would both refuse.

## Alternatives rejected

- **B: keep `typeId@x.y.z` in persisted definitions and teach the registry to resolve
  pins.** This touches about 12 bare-id consumers (builder, palette, config-schema
  lookup, toggle binding, analytics, seeding). It would also brick existing
  tenant workflows on the next node patch, because stored definitions would pin a
  version the host no longer runs. It is not reversible, since stored data changes
  shape.
- **C: strip at expansion only.** The smallest change, but it violates the
  register-time MUST: the loader would keep accepting ranges.
- **Refuse at expansion on a version mismatch.** Rejected in D3.

## Consequences

- **Exact equality is brittle by the spec's design.** A node patch makes every chain
  that pins the old version report an install gap. "Ranges are a v2.x additive
  follow-up" (conformance `v2-chain-pin-exact`). P2's pin-parity test plus the
  `--write` tool turn a node bump inside this repo into a CI failure with a
  one-command fix.
- The registry gate now also refuses an unpinned `compensation.nodeTypeId`, a
  tightening on that lane. All 16 production registry chains are already refused,
  so this changes nothing live.

## Open questions

- [x] **Per-run node version binding.** Nothing stamped node or pack versions on
      a run, and `nodePins` recorded intent, not what executed.
      > **Resolved (grade-data D-3): RECORD, do not refuse.** A run whose definition
      > pins a node version that the loaded module does not honour is stamped
      > `metadata.nodePinMismatches` and logged `run_node_pin_mismatch`
      > (`host/runInsert.ts`). It is stamped once, like `definitionRevision`, so a
      > `:fork` keeps its parent's record. Refusing was rejected: "Use template =
      > just copy" and the D3 install-gap report both treat a mismatch as
      > reportable, not fatal, and a refusal at run start would strand every
      > in-flight definition on the next node-pack bump. Residual: only modules
      > already loaded are compared, because a pack node resolves lazily.
- [x] Delete the v1 chain route and `unpinnedChainPackAllowlist.ts` when P3 empties
      the ratchet (D5).
      > **Resolved (grade-code C-13): KEEP the waiver seam, empty.** The ratchet is
      > empty and `test/chain-pin-ratchet.test.ts` keeps it empty for in-tree packs.
      > The seam stays because the refusal also reaches OPERATOR-supplied packs
      > (`OPENWOP_WORKFLOW_CHAIN_PACKS_DIR`, registry installs), and a named,
      > code-reviewed waiver is the only non-silent escape for those. Deleting it
      > would leave "fork the loader" as the only workaround. The CHANGELOG's
      > Upgrading note points operators at `npm run chains:pin` instead.
- [ ] **"Installed version" is order-dependent when several copies of a pack are
      installed side by side.** The catalog de-dup keeps the first `readdir` hit.
      This is latent: node versions agree across today's copies. Found in the P1 review.
- [ ] `from-chain` warnings read only the PARENT's nodes and pins. A sub-chain
      child's missing or unmet types are not reported. This is pre-existing for
      absent types, and pins inherit it.

## Implementation record

| Phase | What | Evidence |
|---|---|---|
| P1 | `chainPinRule.ts` (D1), loader refusal + ratchet (D2), install-gap reporting (D3), `expandedFrom.nodePins` (D4), v2 routing (D5), pinned export (D6) | `test/chain-pin-rule.test.ts`, `test/chain-pin-ratchet.test.ts`, `test/chain-pin-route.test.ts`, `test/chain-pack-export-loads.test.ts`, `builder/schema/__tests__/chainPackManifest.test.ts`. Four sabotages each turned their witness red (loader unpinned refusal; loader hard refusal; the route's installed-version wiring; the export slug cap). The code review (4ac6067c3) fixed 2 HIGH + 2 MEDIUM + 2 LOW |
| P2 | `backend/typescript/scripts/pin-chain-typeids.ts` (`npm run chains:pin`). It reads versions from a booted catalog against a private pack dir, then re-parses what it wrote and checks it. `test/chain-pin-parity.test.ts` uses the gallery's own predicate plus an absent-type leg. The five versionless nodes (NP-V2-5) are versioned: `feature.app-builder.nodes` 1.9.1, `feature.kicktodo.nodes` 1.30.1 | Sabotage: one pin bumped to `@9.9.9` turns parity red |
| P3 | All 624 references in the 63 in-tree chain packs pinned (0 blocked), plus the 4 e2e fixture copies. Every chain pack is patch-bumped (`check-pack-version-bump`), and unbounded `engines` become `>=1.0.0 <3.0.0` (49 packs, NP-V2-3 chain half). The per-chain `version` is also patch-bumped: all 185 chains (see the correction below).

  > **Correction (P3 gate):** the P3 architect review decided *not* to bump per-chain `version`, so that expansion IDs would stay stable. It missed an invariant the repo enforces. `scripts/check-pack-version-bump.mjs` refuses a chain whose content changed while its own `version` stayed, because `deterministicExpansionId` hashes `chainId@chain.version`: an unchanged version means two different contents share one expansion identity. The gate is right. Persisted definitions and seed rows are unaffected (they are stored, not re-expanded); newly minted expansions get new node-id prefixes, exactly as on any chain edit. The ratchet is **empty**. Seven tests that read raw manifests now read them as the host does (`test/helpers/readPackManifest.ts`) | Diff pass: every changed line is a pin, the pack version or `engines.openwop`, and each manifest is semantically identical with the pins stripped. The seven tests' vacuity guards were what surfaced them |
| P6 | Republished the 16 registry chains pinned and bounded, and re-pinned `OPENWOP_INSTALL_PACKS` | registry #82/#83; deploy `b78a3c55e`, `verify-deploy` registry 57/57 |
| Closeout | grade-code / grade-ux / grade-data fixes. (1) Chain-pack load outcome on `/readiness` `checks.chainPacks` plus a verify-deploy leg (C-1). (2) `expandChain` refuses a ranged pin (C-10). (3) A sub-chain ref with no version is `unpinned` (C-11). (4) Structured `pinMismatches` on the pre-flight and from-chain (U-1/U-2). (5) Chain-backed revisions recorded, so a run paused across a chain bump resolves its own definition (D-1). (6) 18 chain packs that collided with published versions bumped and published (D-2, registry #84). (7) Run-start mismatch stamp (D-3). (8) Direct-definition pins normalized (D-6). (9) Unique child names after a bump (D-7). | `chain-backed-revision-across-bump`, `chain-pin-route`, `run-node-pin-mismatch`, `definition-pinned-typeid`, `subchain-child-name-after-bump`, `TemplatePreflightModal.pinMismatch`; each new witness was sabotaged red. `check-registry-parity.sh` collision shape: 18 → 0 |
