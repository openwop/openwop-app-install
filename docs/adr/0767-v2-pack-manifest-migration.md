# ADR 0767 — v2 pack manifest migration: ownership, palette categories, install visibility

Status: implemented — P4a/P4b/P4c, P5 and P7 are done, and the reconciled canon families were published in NP-V2 P6 (registry #83). The closeout is recorded below.

Tracker rows: `NP-V2-3`, `NP-V2-4`, `NP-V2-5`, `NP-V2-7`, `NP-V2-9` (new), the "pre-existing v1+v2 non-conformance" rows, and the install-visibility lesson of `NP-V2-1` in `docs/steward/NODE-PACK-AUDIT.md`.

## Context

MEASURED on the tree after the NP-V2 P0 re-vendor (2026-09-28): 150 node packs, 39 valid against `schemas/v2/node-pack-manifest.schema.json`. The failures split by **who owns the pack**, and each owner needs a different fix.

1. **Host-owned** (`feature.*`, `vendor.openwop-app.*`, 119 manifests) lack the now-required `kind` and an engine range admitting major 2. They also carry v1-era debt the v2 schema also rejects:
   - node `category` values outside the spec enum;
   - node-level `inputs`, `name`, `title` and `metadata`;
   - seven descriptions over 1024 characters.
2. **Registry-canon families** (`vendor.myndhyve.*` and several `core.openwop.*`, 45 packs) diverge in **both directions**. Canon (openwop-registry) carries the RFC 0177 v2 manifest wave at a higher version, and the app carries code fixes canon never received. 28 `index.mjs` files differ, including `XCH-RAG-1` (#1800), ADR 0525's `suitability`/`maxResults`, and ADR 0083's image `dimensions`.
   - A guard that hashed every canon code file against this repo's object database found **zero** canon-side code this repo has not already seen, so the app is uniformly ahead in code.
   - Three packs are the same version with different content.
3. **The palette taxonomy is finer than the spec enum.** The builder groups nodes by `flow` and `ai` (`catalogRegistry.ts:370`, each with its own accent), but the v2 enum is `chat|control|data|canvas|coordination|integration`. Canon's own fix for `core.openwop.flow` (1.1.2) mapped `flow` → `control`, which would silently collapse the palette's Flow group into Control.
4. **The peer-dependency satisfier spoke only v1** (`agentPackResolver.ts:37`), while the P0 re-vendored core agent packs declare v2 family keys (`NP-V2-7`). And the v2 discovery document advertises **none** of `agents`, `agentRuntime`, `fs` or `queueBus`, only `aiProviders` (`NP-V2-9`).
5. **An install failure was invisible.** The 16 registry chain refusals of 2026-09-20 surfaced only as a `warn` line for eight days (`NP-V2-1`).

## Decision

- **D1 (ownership decides the fix).**
  - *Host-owned* packs are edited here, mechanically (`kind`, engines `>=<lower> <3.0.0`, patch bump, `requiredPacks` pins in lockstep).
  - *Canon families* get a **three-way merge**: the app's code and manifest, plus canon's wave fields (`kind`, `engines`, `peerDependencies`, `peerDependenciesMeta`) and the higher node version. The pack version becomes `max(canon, app) + 1`, vendored here and **published upstream in P6**, so both sides converge on one version.
  - Rejected: editing canon families here only, which widens the fork, and re-vendoring canon, which regresses 28 packs' code.
- **D2 (`NP-V2-7`).** The satisfier accepts a v2 family key plus `peerDependenciesMeta.<family>.facets`, and satisfies a family only if the v2 document advertises it. A parity test pins the table to `buildV2Advertisement`. There is no runtime change: no agent pack marks a dependency optional and the eager load is non-strict.
- **D3 (`NP-V2-9`, peer keys are NOT migrated).** Migrating host packs from `agents.manifestRuntime` to `agents` plus a facet would turn a satisfied requirement into an unsatisfied one, because the v2 document does not advertise the `agents` family, although this host implements `manifestRuntime`. The v2 schema does not constrain peer keys, and these packs are never registry-installed. The migration waits until the v2 advertisement carries `agents`. That is a separate v2-readiness gap, recorded, not worked around.
- **D4 (two fields for two audiences).** `category` becomes the honest spec value. The palette group rides the RFC 0138 extension hatch as `x-paletteCategory`, which `buildNodeCatalog` serves ahead of `category`, so the palette does not move.

  | authored | spec `category` | `x-paletteCategory` | palette effect |
  |---|---|---|---|
  | `flow` (29, core.openwop.flow) | `control` | `flow` | none |
  | `ai` (12) | `integration` | `ai` | none |
  | `generation` (2) | `integration` | `ai` | Control → **AI** |
  | `read` (19), `transform` (18) | `data` | — | Control → **Data** |
  | `action` (5) | `integration` | — | Control → **Integration** |
  | *(missing)* (18) | per node (`MISSING_MAP`) | — | Flow default → its real group |

  The last four rows are deliberate improvements. Those nodes were never grouped by intent; they fell through `mapCategory`'s `control` default, or the catalog's `flow` default for missing values.
- **D5 (node extras become legal).**
  - Inline node `inputs` become real `schemas/<node>.input.json` files referenced by `inputSchemaRef`. As a side effect, the builder gains input ports for 22 nodes that had none.
  - `name`/`title` become `label`.
  - `metadata.mcpApproval` (read nowhere from a pack node, `mcpServerRegistry.ts:126`) becomes `x-mcpApproval`.
  > **Correction (P4 code review):** the migrated input schemas deliberately carry **no `required`**. The inline flags were never enforced, because the catalog never read inline `inputs`. The builder derives one input port per required field, so keeping them would split a single `in` port. An existing builder-authored edge would then re-bind to the first required port on a no-op save (for example `get-enrollment → progress` would start passing an object as `enrollmentId`). The schemas keep types and descriptions.
  > **Disposition (grade-data D-5, 2026-09-28):** grade-data asked to restore `required` and change the builder's port derivation to ignore it. That is deferred, not rejected. Changing port derivation re-binds existing saved edges for every node whose schema already declares several required fields, which is the same class of silent edge move this correction exists to prevent, so it needs its own migration plan. The residual is real: the workflow-author model sees these 17 inputs as all-optional and can author a node without, for example, `topic`, which fails at run time as a typed node error, not silently. Tracked as `NPV2-D-5`.
  > **Resolved by ADR 0782 (2026-09-29).** The "change port derivation to ignore `required`" half of the disposition was measured and rejected: 71 schemas already derive several ports and 212 a single named port, so it would re-route about 283 nodes' saved edges. Instead, ADR 0782 adds an opt-in node-entry hint `x-ports: "single"` and restores `required` on the 17 schemas behind it.
- **D6 (no authored text is discarded).** A description over 1024 characters is shortened in the manifest, and the full original text moves to the pack README under "Full description".
- **D7 (a survivable failure must be counted).** Boot-time registry installs are counted (`host/registryInstallStatus.ts`), and `/readiness` reports them as `checks.registryPacks`. The report is informational and never gates `ready`, because the vendored copy serves. `verify-deploy.sh` **fails** a revision that reports any failed install; a backend that predates the report prints NOT REPORTED rather than passing silently.

## Consequences

- **No deploy between merge and P6** (the same window as ADR 0766 P3). D7 would correctly fail every deploy until the 16 chain refusals are re-pinned, and the canon-family bumps are ahead of the registry until they are published.
- A future re-vendor from canon of a D1-merged pack is safe only after P6, when canon holds the merged version.

## Open questions

- [ ] `NP-V2-9`: advertise the `agents` family on the v2 document, then migrate the 48 host packs' v1 peer keys.
- [ ] Should `x-paletteCategory` graduate into the spec (an RFC 0013 or node-pack schema revision) once another host needs a palette hint?
- [x] **Palette group for spec `canvas` (P5 UX review).** The frontend `mapCategory` sends `canvas|chat|coordination` to Control, so canvas-writing nodes (`app-builder` `repair`, `apply-repair`) group under Control. Data may be the better home. If so, change the ONE mapping, not per-node hints.
      > **Resolved (grade-ux U-4):** `mapCategory` maps each v2 spec value explicitly: `canvas` → Data, while `chat` and `coordination` stay in Control, where they grouped before. `coordination` is MEASURED mixed (12 agent-orchestration nodes beside 20 kanban/canvas/brand/entity nodes), so one mapping cannot be right. The agent-orchestration nodes moving to AI is a per-node `x-paletteCategory` edit in the `vendor.myndhyve.agent-orchestration` canon pack, which needs a MyndHyve-key publish; that is recorded as a canon follow-up. **Done in ADR 0782 D4:** agent-orchestration 1.0.3 carries `x-paletteCategory: "ai"`.

## Implementation record

| Phase | What | Evidence |
|---|---|---|
| P4a | v2-aware peer satisfaction (D2) | `test/agent-peer-satisfaction-parity.test.ts`; sabotage (claim `agents`) goes red |
| P5 (catalog) | `x-paletteCategory` served ahead of `category` (D4) | palette snapshot in the P4c commit |
| P7 | install status + `/readiness` + `verify-deploy` (D7) | `test/registry-install-status-readiness.test.ts`; deploy-gates 135/135; sabotage (drop `fail=1`) goes red |
| P4b | canon-family three-way merge (D1): 45 packs | Guard: zero canon-ahead code; canon-family v2 validity 89/91 (the 2 are the artifact-type dialect) |
| P4c + P5 | host-owned manifests (D1, D4–D6): 119 packs, 76 pin files in lockstep, 44 new input/output schema files, 7 full descriptions moved to READMEs; runtime / `x-confidence` / capability fixes on 7 more | **All `packs/` manifests: 138/212 v2-valid, and every remaining error is a dispositioned class** (72 PMC-6 `feature.*` names, the artifact-type dialect). Palette before/after over 747 pack nodes: **685 unchanged**; 62 moved, all previously DEFAULTED: control→data 37, flow→control 8, flow→data 8, control→integration 5, control→ai 2, flow→integration 2 |
| Closeout | grade-code / grade-ux / grade-data fixes. (1) Install failures carry a `code`, and the status carries `bootAt` plus `skipped` with a reason (C-3, D-4). (2) The tombstone check runs before downgrade classification (C-2). (3) Branch test for the boot install (C-5). (4) `x-paletteCategory` precedence test (C-8). (5) Badge letters use `--cat-on`, the only text that clears 4.5:1 on every category fill in both themes, and the canvas names the category for screen readers (U-5). (6) Explicit spec-category mapping (U-4). | `registry-install-boot`, `node-catalog-palette-category`, `mapCategory` tests (the precedence sabotage went red) |
