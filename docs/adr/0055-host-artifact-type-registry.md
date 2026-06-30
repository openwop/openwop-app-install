# ADR 0055 — Host artifact-type registry (RFC 0071/0075)

**Status:** implemented (Phases 1, 2, 4 — `host/artifactTypes.ts` registry + ajv validation +
host-native `doc.*` types; `host.artifactTypes` discovery + `/schemas/artifacts/{id}.schema.json`;
`feature.documents` validated `artifactTypeId` binding + `validateArtifact` surface + typed
`artifact.created` emission from `feature.documents.nodes.generate-from-template`. Phase 3 —
the `kind:'artifact-type'` pack tier — DONE (`host/artifactTypePackLoader.ts` +
`packs/core.openwop.artifact-types`). `test/artifact-types.test.ts`,
`test/artifact-type-pack-loader.test.ts`, `test/documents-route.test.ts`. Fully implemented.)
**Date:** 2026-06-16
**Depends on / composes:** ADR 0053 (Documents & Templates — the first consumer), ADR 0057
(rendering — export facets), ADR 0001 (feature-package), ADR 0022 (pack registry pipeline).
**Implements (already Accepted on the wire — no new RFC):** RFC 0071 (Artifact-Type Packs +
`artifact.created`), RFC 0075 (host-registered artifact types + per-type capability facets).
**Surface:** `host.artifactTypes` capability + `{HostBase}/schemas/artifacts/{id}.schema.json`
+ the `artifact.created` run event.

## Why this exists

ADR 0053/0057 deliberately left `artifactTypeId` an **opaque, stored-not-validated tag**
because this host does not implement the RFC 0071/0075 artifact-type machinery — only seeded
demo strings in `launchStudioSurface.ts`. That was the honest call (advertise only what's
honored). This ADR closes that gap: a real **host artifact-type registry** so a document (and
any future typed output) binds a *validated* `artifactTypeId`, emits a typed `artifact.created`
run event, and advertises per-type store/render/export facets — the capability the wire already
defines and other hosts already consume.

## Decision

A host registry `host/artifactTypes.ts` owning the set of known artifact types, fed from two
tiers (RFC 0075):
- **Host-native types** — declared in-repo (e.g. `doc.sow`, `doc.prd`, `doc.rfp`, …), each with
  a JSON Schema served at `{HostBase}/schemas/artifacts/{artifactTypeId}.schema.json`.
- **Pack-distributed types** — `kind:"artifact-type"` packs installed through the existing
  signed registry pipeline (Ed25519 + SRI, ADR 0022), registered at boot.

Each registered type carries `{artifactTypeId, schema, render?, export?, registrationSource:
'host'|'pack'}`. Three seams:
1. **Discovery** — advertise `host.artifactTypes` at `/.well-known/openwop` with per-type
   facets (RFC 0075), only for types actually registered (capability honesty).
2. **Validation** — `validateArtifact(artifactTypeId, payload)`; an unregistered type stays
   valid with `registered:false` (the RFC 0071 escape hatch), a registered one MUST validate.
3. **Emission** — an `artifact.created` run event `{artifactTypeId, payload, registered,
   registrationSource}` recorded in the event log (so replay/fork read it verbatim — the
   payload is non-deterministic state and MUST live in the log, `replay.md`).

**Documents integration (the first consumer):** `documents:template.artifactTypeId` becomes a
*validated binding* (assemble can derive `outputSchema` from the type's schema); the
`generate-from-template` node emits a typed `artifact.created`; ADR 0057's render export
formats (pdf/slides/sheet) map to the type's **export facets**. The opaque-tag caveats in ADR
0053 §RFC-verdict and ADR 0057 are then lifted.

## Phased plan

1. **Registry + host-native types + discovery** — `host/artifactTypes.ts`, seed a small native
   set (`doc.*` for the document kinds), serve schemas, advertise `host.artifactTypes`.
2. **Validation + `artifact.created` emission seam** — `validateArtifact` + an executor/run-event
   emit path; event-log capture + replay/fork verbatim read; SR-1 redaction on payloads.
3. **Artifact-type packs** — extend the registry installer to accept `kind:"artifact-type"`,
   register their types at boot; conformance against `node-pack-manifest`/artifact-type schema.
4. **Documents upgrade** — validated `artifactTypeId` binding + typed emission + export-facet
   mapping; lift the opaque-tag caveats; capability-gated.

## Alternatives considered

1. **Keep the opaque tag (status quo).** Rejected — leaves a permanent honesty gap and blocks
   cross-host artifact portability the wire already supports.
2. **Host-native types only (no packs).** Rejected as the end state (packs are the RFC 0075
   distribution story) but acceptable as **Phase 1** — ship native types first, packs in Phase 3.
3. **Per-feature artifact validation (no shared registry).** Rejected — that's the parallel-system
   smell; artifact types are a cross-feature host capability (David's law).

## RFC gate

**No new RFC** — RFC 0071/0075 are Accepted; this is host implementation. BUT it adds a real
**wire run-event** (`artifact.created`) + a capability advertisement, so: advertise only when
wired (`OPENWOP_REQUIRE_BEHAVIOR=true` honesty), keep the event-log/replay invariants, and run
`/architect` (wire-shape + replay) and `/nfr` (capability gating + conformance) before merge.
Conformance scenarios SHOULD cover the `host.artifactTypes` capability gate + validated-vs-
unregistered emission.

## Open questions (for sign-off)

- [ ] Which host-native types to seed first — one per document kind (`doc.sow`…), or a single
  generic `doc.markdown`? (Lean: per-kind, mirroring the seed catalog.)
- [ ] Do ADR 0057's pdf/slides/sheet become **export facets** on the type (preferred) or stay
  feature-local? (Lean: export facets, so the capability is honest end-to-end.)
- [ ] Per-type capability gating granularity (store/render/export advertised independently per
  RFC 0075) — confirm we advertise all three honestly.
- [x] **Artifact-type pack tier (RFC 0075 `kind:'artifact-type'`).** DONE —
  `host/artifactTypePackLoader.ts` scans the pack roots at boot and registers each pack's
  declared types through the SAME registry (`registrationSource:'pack'`), with per-pack/per-type
  failure isolation. Example: `packs/core.openwop.artifact-types` (`doc.one-pager`, `brand.kit`).
