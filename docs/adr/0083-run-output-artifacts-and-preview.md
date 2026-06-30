# ADR 0083 - Run-output artifacts: the missing producer for preview + library

**Status:** implemented
**Date:** 2026-06-20
**Completes:** ADR 0069 (chat artifact workbench), ADR 0055 (artifact-type registry), ADR 0068
(unified review projection). Those built the CONSUMER surfaces (workbench, projection,
registry, preview modal) but explicitly DEFERRED the producer; this ADR builds it.
**Surface:** host-extension only — a host-internal run-artifact store + executor persistence
hook + lighting up the reserved `artifactProjection` `run-event` source + the existing
host-ext artifact routes. **No wire change, no new RFC.**

## Why this exists (the repeatedly-deferred root cause)

A user approving a HITL gate, or finishing an AI run, sees **no preview of what was
produced** — a dead-end "Approval required" card and no durable artifact. Investigation found
the consumer infra is complete and solid (`ArtifactWorkbench` preview/raw/revisions/diff/
provenance; `artifactProjection` with a reserved `source:'run-event'`; the `artifactTypes`
registry; `ArtifactPreviewModal`), but **no producer ever persists run outputs as artifacts** —
`artifact.created` emission / run-output persistence was deferred in ADR 0055/0069 and
`FEATURES.md`. So `source:'run-event'` is dead, the workbench never has anything to open, and
the approval gate (`bootstrap/nodes.ts`) drops the upstream content unless ≥2 string ports
exist. Every prior attempt reached for the *wire* version (a normative `artifact.created` run
event → needs an OpenWOP RFC → deferred forever). **This ADR does the host-internal version
that actually ships.**

## Decision

Add the producer + store, light up the consumer, and add a Library — reusing the workbench,
projection, registry, modal, and routes untouched.

### P1 — the approval card shows what's being approved
- `approvalGate` lowers the inline-`options` threshold (≥2 → ≥1) so a single upstream string
  still previews inline; and (the robust path) every suspend persists the upstream output as
  an artifact (P2) and injects `{artifactId, revisionId}` into `interrupt.data`.
- `ApprovalCard` (`chat/registry/defaultCards.tsx`) gains an "Open preview" affordance when
  `data.artifactId` is present → opens the existing `ArtifactWorkbench` (any content type).

### P2 — persist run outputs as durable artifacts (the producer)
- **New host-internal store** `host/runArtifactStore.ts` — a `DurableCollection<RunArtifactRecord>`
  keyed on the **deterministic** `${runId}:${nodeId}` (replay-safe; insert-only via
  compare-and-swap; first-write-wins). Row maps 1:1 onto `ArtifactProjection`.
- **Executor producer hook** (`executor/executor.ts`), two seams, both best-effort/fail-open
  and gated `forkMode !== 'replay'`:
  - **Seam A (HITL suspend):** persist the gate's upstream output (`role:'gate-preview'`,
    `status:'in-review'`) BEFORE `createInterrupt`, then merge `{artifactId, revisionId}` into
    the interrupt data → `reviewProjection.artifactBinding` surfaces it (no change needed
    there).
  - **Seam B (run.completed):** persist each terminal node's output (`role:'deliverable'`,
    `status:'final'`) BEFORE the `run.completed` append.
- **Light up the projection:** `artifactProjection.ts` gains `runArtifactToArtifact()` +
  `resolveRunArtifact()` + run-event arms in the 4 exported functions (single immutable
  revision, like media). The existing workbench routes then serve `run-event:` ids unchanged.
- **Wire the dangling last mile:** `MessageFeed` passes `artifactId`/`onOpenWorkbench` into
  `ArtifactPreviewModal` so a run-completion preview escalates into the full workbench.
- Content is secret-scrubbed before storage; title/kind/format derived from the output
  (text/markdown/json/asset); `core.email.draft` also emits the draft body so it's previewable.

### P3 — the Library (ChatGPT-style)
- `artifactProjection.listArtifacts()` — cross-source fan-out (documents + media + run-event),
  per-org authorized (batched, no N+1), newest first.
- `GET /v1/host/openwop-app/artifacts` (collection route, registered before `:artifactId`).
- A Library gallery page (All / Images / Files) consuming the list, reusing the workbench to open.

## Boundaries

No parallel store for what the projection already models (run-event was reserved for exactly
this). The workbench/projection/registry/modal/routes are reused, not recreated. New store is
host-internal; producer is an executor hook; routes are non-normative `/v1/host/openwop-app/*`.

## Replay / fork / dedup safety

Deterministic key `${runId}:${nodeId}` + insert-only compare-and-swap ⇒ retries/re-dispatch
don't duplicate or re-mint ids (outputs are deterministic per the Layer-2 invocation log).
`:fork` in `branch` mode legitimately mints new artifacts under the new runId; `replay`-mode
forks are gated off (mirrors the executor memory-write fork semantics). Persist precedes the
terminal `run.completed`/`node.suspended` appends (event-ordering); best-effort try/catch so a
store failure never aborts the run; content secret-scrubbed.

## Amendment (2026-06-20) — reference resolution for asset/media/document nodes

A full node-library audit (fan-out) found the v1 producer's naive "serialize any output to
inline content" silently broke a large class of **asset-producing nodes**: anything emitting
binary/media (`*Base64`, `renderedMediaToken`, image/audio/video/file generators across
`core.openwop.ai`, `core.files`, `core.storage`, `feature.documents.nodes.render`,
`local.openwop-app.image-emit`) previewed as a useless JSON blob, and **document**-producing
nodes (`generate-from-template`, `create-board-memo`, agent-knowledge `ingest`) created a
DUPLICATE `run-event` artifact beside the real `document:` one.

**Fix (the unifying rule): `run-event` persistence is a FALLBACK for outputs with no other
owner.** `persistRunArtifact` now resolves references BEFORE serializing, in priority order:
1. **documentId** → link the existing `document:` artifact (no dup, no blob).
2. **inline base64 bytes** → MINT a `media:` asset (`mediaStorage.put` + `createAsset`, org-quota
   asserted) → link it, so image/audio/video preview as real bytes via the existing media
   source (the workbench renders `source:'media'` images inline; a `run-event` row would not).
3. **serve token / `/assets/` URL** → a `run-event` artifact whose content is a click-to-open
   Markdown link (the assetId isn't recoverable from a bare token).
4. **inline text/markdown/json** → a `run-event` artifact, **size-capped at ~1 MB** (mirrors the
   Documents version cap; over-cap text truncates, over-quota bytes are skipped not inlined).

Replay-safety preserved: the non-deterministic media mint is guarded by a **bookkeeping row**
keyed on the deterministic `${runId}:${nodeId}` recording the minted `media:`/`document:` id,
so a re-execution returns it without re-minting. Link/bookkeeping rows are excluded from the
Library list and from `run-event` projection (the linked owner represents them). Reuses the
`media:`/`document:` projection sources untouched — the only new code is detection-at-persist.

**Mid-graph capture (follow-up, implemented 2026-06-20).** A node that declares an
`outputRole` (`primary`/`secondary` — the existing "this is a deliverable" signal) is now
captured as a durable artifact AT COMPLETION even when it sits mid-graph (has outgoing edges),
so an asset produced mid-flow (e.g. the variance `render` PDF that feeds `notify`) is no
longer dropped — Seam B only captured terminals. Scoped to mid-graph nodes (terminals are
already Seam B); reuses the existing `outputRole` field (no new value); replay-safe
(deterministic key, no event, replay-fork-gated); captured at node completion so the asset
survives even if a LATER node fails. Reference resolution (media/document/link) applies
identically. (`executor.ts` node-success branch; `run-artifacts-midgraph.test.ts`.)

Idempotency note: a node that is BOTH gate-upstream and `outputRole`-marked is written under
the same deterministic key by Seam A (`gate-preview`/`in-review`) and this branch
(`deliverable`/`final`) — whoever writes first wins; the artifactId is invariant, only the
row's role/status is write-order-dependent (benign — the asset is captured once, openable).

Multi-image capture (#3, implemented 2026-06-20): a multi-image generator now captures EVERY
image — `detectBase64All` returns all `images[]`, each minted as its own `media:` artifact (the
primary keyed `${runId}:${nodeId}`, extras at `${runId}:${nodeId}#i`); all surface in the
Library, the interrupt binding uses the primary. Idempotent per-image (get-first). (`run-artifacts.test.ts`.)

## Post-ship architecture review (2026-06-20) — hardening applied

A full-solution `/architect` review (0 blocking) surfaced hardening items, all now FIXED:
- **MED-1 (security, defense-in-depth):** the artifact routes are no longer toggle-gated, so the
  projection's per-record authz is the only gate — and `resolveEffectiveAccess` with no subject
  falls through to tenant-OWNER scopes. The routes now **fail closed on a missing principal**
  (`requireSubject` → 401) rather than leaning solely on the auth middleware.
- **MED-2 (real bug, not just a test gap):** writing the missing route-level `GET /artifacts`
  test exposed that `listArtifacts` resolved access ONCE for the workspace-root org
  (`orgId===tenantId`) and listed only root-org documents/media — so the **Library was EMPTY for
  a normal user** whose documents live in sub-orgs (where their membership is). Fixed:
  `listArtifacts` now lists tenant-wide (`listDocumentsForTenant`/`listAssetsForTenant`) and
  authorizes **per-org, batched once per distinct org** (no N+1). Also fixed a **pre-existing
  namespace collision** the tenant-wide scan exposed: `inMemorySurfaces._mediaAssets` (token-keyed
  raw bytes) and `mediaService.assets` (assetId-keyed library metadata) share the `media:asset`
  collection name → `listAssetsForTenant` now filters to real library assets (assetId+orgId).
  **PERMANENT FIX (#2, 2026-06-20):** the byte-store moved to its own collection `media:bytes`;
  `resolveMediaAsset` read-falls-back to the legacy `media:asset` location AND migrates-on-read
  (zero-downtime, self-healing — no big-bang migration that could orphan a served URL);
  `deleteMediaAsset` frees both locations. (`media-bytes-migration.test.ts`.)
- **MED-3 (correctness):** the base64 media detector now requires a value that actually looks like
  base64 (length ≥ 64 + charset) before minting, so a stray short field can't consume org quota.
  The field-name heuristics (`contentBase64`/`renderedMediaToken`/`/assets/` url) remain best-effort
  by design; documented limit.
- **LOW-1 (data hygiene):** a CAS-loss media mint now **GCs the orphaned asset** (deleteAsset),
  so a concurrent re-exec doesn't leak bytes.
- Doc fix: the stale `resolveMediaArtifact` docstring (claimed run-event "reserved/unpopulated")
  corrected — the source is live.

## RFC verdict

**Host-extension — no new RFC.** No normative `artifact.created` run event is emitted (that
WOULD be wire → an OpenWOP RFC, the deferred-forever path we deliberately avoid). We persist
into a host-internal store and serve via the existing non-normative `/v1/host/openwop-app/artifacts*`
routes. A future cross-host normative `artifact.created` event remains a separate RFC if ever wanted.

## Implementation record

| Phase | What landed | Where |
|---|---|---|
| P1–P3 | producer store + executor seams + projection run-event arm + Library + approval-card preview | `runArtifactStore.ts`, `executor.ts`, `artifactProjection.ts`, `artifactRoutes.ts`, `LibraryPage.tsx`, `defaultCards.tsx` |
| Amendment | reference resolution (document link / media mint / serve link / capped inline) | `runArtifactStore.ts`, `run-artifacts.test.ts` |
| Mid-graph | `outputRole`-marked mid-graph nodes captured at completion | `executor.ts`, `run-artifacts-midgraph.test.ts` |
| Review fixes | MED-1 (routes fail-closed), MED-2 (per-org batched list + collision filter), MED-3 (base64 detector), LOW-1 (CAS-loss GC) | `artifactRoutes.ts`, `artifactProjection.ts`, `runArtifactStore.ts` |
| #2 / #3 | byte-store rename to `media:bytes` + read-fallback/migrate-on-read; multi-image capture; fail-open await | `inMemorySurfaces.ts`, `runArtifactStore.ts`, `media-bytes-migration.test.ts` — PR #532 |

Deployed: Cloud Run `openwop-app-backend` rev `00262-rx9` (2026-06-20).
