# ADR 0069 - Chat artifact workbench and revision lifecycle

**Status:** implemented  
**Date:** 2026-06-18  
**PRD:** `docs/ai-chat-a-plus-prd.md`  
**Depends on / composes:** ADR 0053 (Documents & Templates), ADR 0055 (Host artifact-type registry), ADR 0057 (Document rendering), ADR 0045 (Subject model), ADR 0046 (Project subject), ADR 0013 (Sharing), ADR 0007 (Media), `routes/runs.ts` artifact reads, `frontend/react/src/chat/ArtifactPreviewModal.tsx`.  
**Surface:** host-extension artifact workbench routes plus existing `artifact.created` run events and `host.artifactTypes` capability.  
**RFC gate:** no new RFC for a host workbench over accepted artifact-type behavior. New normative artifact events, required fields, or cross-host workbench endpoints require an OpenWOP RFC.

## Why this exists

The current chat can preview terminal node output heuristically, but A+ workflow orchestration needs artifacts that survive reload, can be revised, compared, approved, published, exported, and audited. The app already has the building blocks: Documents, Media, artifact types, run events, Sharing, and the Subject model. The decision is how to make chat artifacts durable without creating a second document store.

## Feature-refinement audit

| Concept | Existing owner | Decision |
|---|---|---|
| Business documents and versions | Documents feature, ADR 0053 | Compose for `doc.*` artifacts. Do not duplicate document storage. |
| Binary/rendered bytes | Media, ADR 0007 | Store bytes as Media tokens. |
| Artifact schemas/capability | `host/artifactTypes.ts`, ADR 0055 | Use as the type registry and validation owner. |
| Run-produced artifact event | `artifact.created`, ADR 0055 | Use as provenance/event source. |
| Project/user/agent ownership | Subject model, ADR 0045/0046 | Use `ownerSubject`, not soft tags. |
| Chat preview modal | `ArtifactPreviewModal.tsx` | Replace heuristics with links to durable artifact records when available. |

## Decision

Introduce a chat artifact workbench that projects run-produced artifacts into durable owner-specific stores:

- `doc.*` artifacts become Documents and DocumentVersions.
- file/blob artifacts reference Media assets.
- unknown or non-document artifact types may be represented by a thin host `ArtifactProjection` record that points back to the run event and validated payload.

The workbench is a UI and projection layer, not a universal new artifact database for every kind. Ownership is delegated to the existing product owner whenever one exists.

## Data model

```ts
interface ArtifactProjection {
  artifactId: string;
  tenantId: string;
  ownerSubject?: Subject;
  artifactTypeId: string;
  source: 'document' | 'media' | 'run-event';
  sourceId: string;
  latestRevisionId?: string;
  createdBy: { kind: 'user' | 'agent' | 'run'; id: string };
  createdAt: string;
  provenance: {
    runId?: string;
    nodeId?: string;
    eventId?: string;
    model?: string;
    provider?: string;
    citations?: Array<{ label: string; ref: string }>;
  };
}

interface ArtifactRevisionProjection {
  revisionId: string;
  artifactId: string;
  sourceRevisionId?: string;
  parentRevisionId?: string;
  summary?: string;
  createdBy: { kind: 'user' | 'agent' | 'run'; id: string };
  createdAt: string;
}
```

For Documents, the authoritative revision is `DocumentVersion`. The projection row only gives chat a stable, type-neutral handle.

## Route plan

```text
GET  /v1/host/openwop-app/artifacts
GET  /v1/host/openwop-app/artifacts/:artifactId
GET  /v1/host/openwop-app/artifacts/:artifactId/revisions
GET  /v1/host/openwop-app/artifacts/:artifactId/revisions/:revisionId
GET  /v1/host/openwop-app/artifacts/:artifactId/diff?from=&to=
POST /v1/host/openwop-app/artifacts/:artifactId/promote
POST /v1/host/openwop-app/artifacts/:artifactId/revisions/:revisionId/publish
POST /v1/host/openwop-app/artifacts/:artifactId/revisions/:revisionId/export
```

Create routes only where no existing feature route already owns the operation. For example, document version creation should call or share Documents service code rather than writing a second version collection.

## Review binding

Review requests that approve generated work must bind to `(artifactId, revisionId)`, never a mutable "latest" pointer. If the artifact changes while a review is pending, the pending review remains attached to its original revision and the UI offers a new review for the new revision.

## Authorization

- Subject-owned artifacts derive org scope through the Subject model.
- Document-backed artifacts use Documents authorization.
- Media-backed artifacts use Media token and owner checks.
- Run-event projections require the caller to have read access to the source run and the derived owner subject.
- Publish/export follows the target feature policy, including "approved revision only" where configured.

## Phased plan

1. **Projection read model.** Map `artifact.created` events and Documents rows into a stable `ArtifactProjection`.
2. **Workbench UI.** Add preview, raw payload, provenance, and revision timeline tabs.
3. **Promotion.** Allow terminal run output to be promoted into Documents or Media-backed projections.
4. **Diffs.** Add markdown/text/JSON diffs first; typed diffs remain per-artifact follow-ons.
5. **Review binding.** Integrate with ADR 0068 so review cards pin a revision.
6. **Publish/export.** Delegate to Documents/Sharing/Media/export facets and audit the exact revision.

## Acceptance criteria

- Chat completion cards link to a durable artifact when an artifact exists.
- Document artifacts are stored as Documents/DocumentVersions, not duplicated.
- Every approval points at an immutable revision.
- Workbench state survives reload and can be opened from chat history.
- Diff and provenance views are available for supported artifact types.
- Publish/export records the exact revision and provenance.
- Tests cover tenant isolation, subject access, stale revision approvals, and redaction.

## Alternatives considered

- **Make a universal artifact table own all content.** Rejected because it duplicates Documents and Media.
- **Keep heuristic previews only.** Rejected because previews are not durable, approvable, or auditable.
- **Force every artifact into Documents.** Rejected because not every artifact is a business document; use the owning surface for the artifact kind.

## Open questions

- Which artifact types get v1 promotion: `doc.*` only, or also generic JSON/text?
- Should diff computation be stored or computed on demand?
- What retention policy applies to run-event-only projections after run pruning?

## Implementation record

Phases 1–5 landed for the **document-backed** artifact (the dominant case); media- and run-event-sourced artifacts + promotion/publish/export (Phases 3/6) are deferred.

| Phase | Change |
|---|---|
| 1 Projection read model | `host/artifactProjection.ts` — `ArtifactProjection`/`ArtifactRevisionProjection` DTOs (NOT a store) mapping a `DocumentRecord`(+immutable `DocumentVersion`s) → a type-neutral artifact. `artifactId = document:<documentId>` (explicit source prefix; namespace open for `media:`/`run-event:`). `artifactTypeId` claimed only when `doc.<kind>` is a registered host type. |
| 2 Workbench UI | `chat/artifacts/{ArtifactWorkbench,ArtifactDiffView,RevisionTimeline,ProvenancePanel}` + `artifactClient` — preview/raw/revisions/diff/provenance tabs over `/artifacts/*`. `ArtifactPreviewModal` gains an "Open workbench" link when a node output is artifact-backed. |
| 4 Diffs | `host/textDiff.ts` — dependency-free LCS line diff (text/markdown) + recursive JSON diff. Computed SERVER-side over two IMMUTABLE `versionId`s; `latest`/missing → 422 (an audited diff always pins two fixed revisions). |
| 5 Review binding | `host/reviewProjection.ts` mappers now surface `data.artifactId`/`data.revisionId` into the `ReviewRequest` (+ an `artifact` provenance ref). Because `DocumentVersion` is immutable, pinning the `revisionId` is sufficient — an approved revision can never drift to a mutated "latest". |

**Corrections / decisions vs the plan:**
- *Ownership (open question "compose Documents vs thinner projection"):* resolved to **compose Documents** — the workbench is a read-only DTO projection + a diff; it creates no rows. Routes live INSIDE the documents feature (`documentsFeature.registerRoutes`), gated by the SAME `documents` toggle (core never imports a feature).
- *IDOR:* the flat `/artifacts/:artifactId` resolves org FROM the `DocumentRecord` and authorizes via `resolveEffectiveAccess(workspace:read)`; non-visible → 404 (never 403). Tenant-only checks would have leaked across orgs.
- *Diff (open question "stored vs on-demand"):* computed on demand (no stored diff); the inputs are immutable so a recompute is deterministic.
- *Scope:* v1 covers `document`-source artifacts only (the dominant case); `media:`/`run-event:` slot in behind the same `source` discriminant later. List-across-orgs, promotion, and publish/export remain on the owning Documents/Sharing/Media surfaces.

**Correction — media source landed (follow-up item 2):** the `media:<assetId>` source is now implemented — `host/artifactProjection.ts` resolves a Media asset via a new tenant-scoped `getAssetByIdForTenant` (org resolved FROM the asset + `resolveEffectiveAccess`), projects it as a single immutable revision (`content` = the serve URL), and the workbench preview renders the bytes (inline `<img>` for images, a download link otherwise). A media artifact is not diffable → `diff` returns 422 (not 404). The **`run-event:` source remains deferred** — no host emits `artifact.created` yet, so there is nothing to project; wiring that emit path is its own feature.

Deferred: the `run-event:` artifact source (needs an `artifact.created` emit path), a cross-org artifact list, promotion of terminal run output into Documents, publish/export from the workbench, and typed (non-text/JSON) diffs.

Tests: `backend/test/text-diff.test.ts` (line + JSON diff), `backend/test/artifacts-route.test.ts` (projection, immutable-revision diff + 422, cross-tenant 404, toggle-off 404); `frontend ArtifactDiffView.test.tsx` (text/JSON render + empty state).

