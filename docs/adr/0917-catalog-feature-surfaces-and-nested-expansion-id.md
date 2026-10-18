# ADR 0917 — Feature-surface requirements in the node catalog; nested params fold into the chain expansion id

Status: Accepted (implemented in this PR)

## Context

This ADR implements Book AI upstream proposals P12 and P14
(`bookai/docs/upstream-proposals.md`).

- **P12:** every Book AI node reads `ctx.features['bookai-author-suite']`. The
  catalog's `requiresHostSurfaces` comes from a fixed typeId-prefix table of
  `host.*` surfaces (`bootstrap/hostSurfaceMap.ts`), which cannot name a feature
  surface.
  - So `buildNodeCatalog()` and `runnableNodeTypeIds()` report the nodes as
    runnable while the feature's toggle is off.
  - A workflow naming them passes closed-world validation.
  - It fails only at run time, when the seam refuses with
    `host_capability_disabled` (`host/featureSurfaces.ts`).
- **P14:** `deterministicExpansionId` canonicalized params as
  `JSON.stringify(params, Object.keys(params).sort())`.
  - An array replacer is a key allowlist at every depth, so a nested object
    kept only keys that were also top-level param names.
  - `{target: {chapter: 3}}` and `{target: {chapter: 9}}` therefore shared an
    expansion id, node-id prefix and default workflow id. RFC 0013 requires the
    canonical params to be folded into the id.

## Decision

- **D1 (P12) — `x-requiresFeatureSurfaces` on a pack node.** It is a list of
  feature-surface ids, carried through the RFC 0138 `x-` hatch, so the manifest
  stays v2-valid and needs no spec change.
  - The catalog adds each surface to `requiresHostSurfaces` as
    `host.sample.<id>`, the name the seam's refusal uses. It also adds it to
    `missingHostSurfaces` when this host does not compose that feature at all.
  - The node also gets `requiresFeatureSurfaces`.
- **D2 (P12) — the per-tenant view.** `nodeCatalogForTenant(tenantId, catalog)`
  adds `host.sample.<id>` to `missingHostSurfaces` for each declared surface the
  tenant has off. It uses `disabledFeatureSurfacesFor`, the resolver the seam's
  toggle gate uses at run time; an always-on feature with no toggle is never off.
  `GET …/node-catalog`, already tenant-scoped for pack enablement, now serves
  this view, so the palette stops offering what the run would refuse.
- **D3 (P14) — a recursively key-sorted canonical form for the expansion id.**
  - For flat params (primitives and arrays of primitives) the string is
    byte-identical to the old one, so no existing id whose params do not nest
    moves. A test pins that against the old formula.
  - Expansions whose params nest now get distinct ids, as RFC 0013 requires.
  - Seeded and chain-backed registrations expand with `{}` or flat params
    (`seedWorkflows.ts`, `chainBackedWorkflows.ts`, the kb, gmail,
    knowledge-sync and strategy-cadence callers), so their ids are unchanged.
  - Conformance checks host output via the host's returned `expansionId`, not a
    pinned hash.

## Not changed

- `runnableNodeTypeIds()` (sync, host-wide) gains only the "not composed" case
  from D1. A tenant-aware closed-world check for the authoring lanes (pair,
  from-chain) can adopt `nodeCatalogForTenant` next. The authoring palette is
  covered now.

## Implementation

| Part | Where |
| --- | --- |
| D1 | `backend/typescript/src/host/nodeCatalogBuilder.ts` (`x-requiresFeatureSurfaces`, `requiresFeatureSurfaces`) |
| D2 | `host/featureSurfaces.ts` (`disabledFeatureSurfacesFor`); `host/nodeCatalogBuilder.ts` (`nodeCatalogForTenant`); `routes/nodeCatalog.ts` |
| D3 | `host/workflowChainPackLoader.ts` (`deterministicExpansionId`, `sortKeysDeep`) |
| Tests | `backend/typescript/test/adr0917-catalog-feature-surfaces-and-expansion-id.test.ts` |

## Checklist

- [x] D1–D3 with tests
- [ ] Tell Book AI the PR number, so it can declare the field on its 17 nodes
- [ ] Follow-up: the tenant-aware closed-world check in pair and from-chain
