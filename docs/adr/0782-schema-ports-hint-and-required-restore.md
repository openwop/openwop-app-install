# ADR 0782 — Builder port hint (`x-ports`), restoring `required`, and the agent-orchestration palette group

Status: implemented

Closes the three items deferred by the NP-V2 closeout: `NPV2-D-5` and `NPV2-U-9` (see `docs/steward/DATA-ASSESSMENT-np-v2.md` and `UX-ASSESSMENT-np-v2.md`) and `NPV2-U-10`. It amends ADR 0767 D5 (see the disposition there).

## Context

ADR 0767 P4c moved 17 `feature.kicktodo.nodes` inline input maps into `schemas/*.input.json`. The P4 code review then **dropped their `required`**, because the builder derives **one input port per `required` field** (`portsFromSchema`, `builder/palette/catalogRegistry.ts`). Restoring `required` would have changed the single `in` port those nodes had: 4 of the 17 declare several required fields, so their port would SPLIT into several; the other 13 declare one, so their port would be RENAMED to that field. Either way, saved edges re-route.

That port derivation is **data routing, not layout**. A non-`in` target port is persisted as the edge's `targetInput` (`serialize.ts`), which routes the upstream output into that input field. On load, an edge with no `targetInput` falls back to the node's first input port (`deserialize.ts`). So on a node whose ports split, a saved edge silently re-binds to the first required field on the next save.

The cost of dropping `required`: the node catalog serves these schemas to the workflow-author model, which saw every input as optional. It could therefore author, say, `create-candidate` without a `topic`, which fails at run time.

MEASURED on `origin/main` 80c7b5514, across every pack input schema (reproduce: for each `packs/*/pack.json` node with an `inputSchemaRef`, count the length of the referenced schema's `required`):
- 71 declare two or more `required` fields, so they derive several ports today.
- 212 declare exactly one, so they derive a single port named after that field.
- 148 declare none, so they get the fallback `in` port.

## Decision

- **D1. An opt-in hint on the pack-manifest NODE ENTRY:** `"x-ports": "single"`, using the RFC 0138 `x-` hatch. The node catalog serves it as `CatalogNode.ports: 'single'`, and only that recognised value; anything else is dropped. `portsFromSchema(schema, fallback, portsHint)` returns the single fallback port whenever the hint is present, whatever `required` says. Every node without the hint keeps today's derivation exactly.
- **D2. Restore the authored contract.** The 17 schemas get back the `required` lists recovered from their pre-P4c inline maps (`970e77a76^`), not re-invented. Each of those nodes carries `x-ports: "single"`. `feature.kicktodo.nodes` goes 1.30.2 → 1.30.3. Node versions are unchanged, so no chain pin moves. The feature `requiredPacks` pins move in lockstep.
- **D3. The hint goes on the node entry, not in the schema file** (architect review).
  - No pack schema file contains an `x-` keyword today. The app's Ajv instances are `strict: false`, but the registry and third-party SDK consumers compile these files too, and Ajv's default strict mode rejects unknown keywords.
  - The node entry is where `x-paletteCategory` (ADR 0767 D4) already passes through the v2 manifest schema, the registry and the catalog.
  - Both hints express the same thing: the pack author's presentation intent for one node.
- **D4. Agent orchestration groups under AI.** The 12 `vendor.myndhyve.agent-orchestration` nodes (spec `coordination`, which the palette maps to Control per ADR 0767's open-question resolution) carry `x-paletteCategory: "ai"`, and the pack goes to 1.0.3. The pack is not pinned in production `OPENWOP_INSTALL_PACKS`, and no chain pins its nodes. It is published to the v2 registry under `myndhyve-internal-1`.

## Alternatives rejected

- **Make `portsFromSchema` ignore `required` globally** (ADR 0767's first disposition). It would rename the ports of about 283 nodes and re-route their saved edges: the same silent edge move, 283 times over.
- **Put the hint in the schema file.** Rejected for the strict-validator risk in D3.
- **Carry `required` in a private `x-required`.** It would hide the contract from every standard JSON Schema consumer; the workflow-author model reads `required`.

## Consequences

- The workflow-author model now sees the real required inputs for the 17 nodes. Nothing enforces node input schemas at run time (the only reader of `inputSchemaRef` is `host/nodeCatalogBuilder.ts`), so no run behaviour changes.
- **Authoring behaviour changes:** the workflow-author `validate` and `persist` now REJECT an edge that sets `targetInput` on a node marked single-port, and both authoring prompts (the draft node's menu and the chat persona) say so. This is the ADR 0596 rule applied: a MUST the prompt states is a MUST the host checks.
- Saved edges into the 17 nodes keep routing to `in`. The frontend `portsHint.test.ts` proves this, and its contrast case shows an unhinted multi-required node does re-bind.
- `x-ports` can grow later: another enum value can name a different strategy without changing the default.

## Implementation record

| Step | What | Evidence |
|---|---|---|
| D1 | Catalog serves `ports`; `portsFromSchema` honours it; the workflow-author model is told (menu + persona), and `validate`/`persist` REJECT a `targetInput` edge into a single-port node (`findSinglePortEdgeViolations`) | `test/workflow-author-single-port.test.ts` (sabotage: dropping `ports` from `toAuthorNode` turns 2 tests red; dropping the validate check turns 1 red); `test/node-catalog-ports-hint.test.ts`; `builder/palette/__tests__/portsHint.test.ts` (sabotage: deleting the hint branch turns 2 tests red) |
| D2 | 17 `required` lists restored; `feature.kicktodo.nodes` 1.30.3; pins moved | The same backend test asserts all 17 hinted nodes carry a non-empty `required` |
| D4 | agent-orchestration 1.0.3 with `x-paletteCategory: "ai"` | Published to the v2 registry; collision check 0 |
| Track C | `build-meta/deployer.json` names the deploying checkout and session. It is written on the deploy path only, holds a slug, and ships in the upload and the image. It is FORENSIC ONLY: `verify-deploy.sh` does not read it. | `scripts/test-deploy-gates.sh` (write, delete-when-not-deploying, deploy.sh opts in) |
