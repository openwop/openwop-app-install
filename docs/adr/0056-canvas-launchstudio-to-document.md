# ADR 0056 — Canvas / launch-studio → Document materialization

**Status:** implemented (backend — `host/canvasSurface.ts#getCanvasForTenant` seam,
`materializeCanvasToDocument` + idempotent `documents:canvasmap`, `POST …/documents/from-canvas`;
`test/documents-route.test.ts`. Explicit trigger; one-way; project ownerSubject carried when it
resolves to the org. **FE** "From canvas" action on `DocumentsPage` (no standalone canvas page
exists — the documents UI is the home). **launch-studio** `sharedArtifactRefs.documentId`
resolution via the `setLaunchStudioDocumentResolver` seam, filled by the documents feature
(`getDocumentByIdForTenant`); `test/launch-studio-document-resolver.test.ts`. Fully implemented.)
**Date:** 2026-06-16
**Depends on / composes:** ADR 0053 (Documents — the single owner of stored business docs),
ADR 0045/0046 (Subject model — `project` ownerSubject), `host/canvasSurface.ts` +
`host/launchStudioSurface.ts` (the producers).
**Surface:** host-extension under `/v1/host/openwop-app/documents/*` + a host seam. **No RFC.**

## Why this exists

ADR 0053 declared the `documents` feature the **single owner of durable business documents**
and flagged the adjacent owners: `host.launchStudio` holds `sharedArtifactRefs` with
`artifactTypeId:'doc.prd'` and canvas steps bound to `canvas.brief`/`canvas.design`. Today
those are demo-seeded refs that point nowhere real. The declared direction was: a finished
canvas / a launch-studio artifact should **reference a `documentId`** owned by the documents
feature — never a parallel artifact store. This ADR wires that, closing the single-owner loop.

## Decision

A one-way materialization seam: **canvas/launch-studio → documents** (never the reverse).
- **`POST …/documents/from-canvas`** `{canvasId, kind?, ownerSubject?}` (authed, `workspace:write`)
  — reads the canvas's current content via `canvasSurface`, creates a `documents:doc` (kind
  derived from the canvas type, e.g. `canvas.brief → epic-brief`; markdown content from the
  canvas state) + its first version, and returns the `documentId`. If the canvas carries a
  `projectId`, the document is created with `ownerSubject: {kind:'project', id}` (ADR 0046).
- **Reference, don't copy:** launch-studio's `sharedArtifactRefs` gain an optional `documentId`;
  the studio surface resolves it through the documents feature. `core`/host surfaces never
  import the feature — the documents feature FILLS a seam (`host/canvasMaterialization.ts`,
  `setCanvasDocumentSink`) the canvas/launch-studio code reads, the same pattern `kb` uses for
  `setKnowledgeBackend` and `projects` for `setSubjectOrgResolver`.
- **Idempotency:** a deterministic `(canvasId → documentId)` mapping so re-materializing updates
  the existing document (a new version) rather than spawning duplicates.

## Decisions to confirm (the sign-off)

1. **Trigger — explicit, not automatic.** A user action ("Save as document") / an explicit
   workflow node, NOT an implicit "on canvas finalize" hook. Rationale: avoids surprise
   document spam and keeps the user in control. (Confirm: explicit only, or also an opt-in node?)
2. **Kind mapping.** `canvas.brief → epic-brief`, `canvas.design → doc`, `canvas.launch →
   doc`, default `doc`. (Confirm the map; it's easy to extend.)
3. **Direction is one-way.** Documents never write back into a canvas; a canvas is a working
   surface, the document is the durable artifact. (Confirm.)

## Phased plan

1. Seam `host/canvasMaterialization.ts` (`setCanvasDocumentSink`/resolver), filled by the
   documents feature at boot (no feature→core import).
2. `POST …/documents/from-canvas` + the deterministic canvas→document mapping (idempotent).
3. Launch-studio `sharedArtifactRefs.documentId` resolution through the seam.
4. FE: a "Save as document" action on the canvas/launch-studio surface; tests.

## Alternatives considered

1. **Launch-studio writes to the documents store directly.** Rejected — that's a core/host
   surface reaching *up* into a feature; use the fill-a-seam pattern instead.
2. **Auto-materialize on every canvas finalize.** Rejected for v1 — surprising + noisy; explicit
   action is safer. Can add an opt-in node later.
3. **Leave the refs demo-only (status quo).** Rejected — leaves the ADR 0053 single-owner
   declaration unfulfilled; the parallel-artifact smell persists.

## RFC gate

**Pure host-extension — no new RFC.** Reads existing host surfaces (canvas/launch-studio),
writes the documents feature's own store, and fills a host seam. No wire shape changes.

## Open questions

- [ ] Does this compose with ADR 0055 (artifact-type registry)? A materialized document could
  emit a typed `doc.*` artifact — sequence 0056 after 0055, or independently? (Independent; 0056
  needs only the documents store.)
- [ ] Should `from-canvas` also run a render (ADR 0057) to attach a PDF immediately, or leave
  that to the user? (Lean: leave to the user — keep materialization cheap.)
