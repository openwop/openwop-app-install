# ADR 0382 — Retention for abandoned App-Builder canvases

Status: Accepted — implemented (one PR)

Date: 2026-07-17

Lane: cross-cutting data-lifecycle seam (feature-owned purger) — no new feature package, no toggle

RFC verdict: **host work only.** A retention age-out of a feature's own durable rows touches
nothing on the OpenWOP wire.

## Context

App-Builder canvases have no retention story (DATA-ASSESSMENT **DATA-AB-1**) — abandoned
designs accrue forever until a user manually deletes them. Two facts shape the fix:

1. **App-Builder canvases are NOT their own store.** They are the
   `canvasTypeId === 'canvas.app-builder'` slice of the SHARED host `canvas`
   `DurableCollection` (`host/canvasSurface.ts`), which also holds `canvas.document` and
   `canvas.slides`. Any purge MUST be type-scoped or it would delete documents/slides.
2. The `canvas` store is **tenant-indexed** → ineligible for the ADR 0380 `kvAgeOut`
   size-hygiene lane (index-free only); retention must use `registerRetentionPurger`.

There is **no `status`/`draft`/`published` flag** on a canvas ("publish" = a one-shot GitHub
export, no persisted record), so "abandoned" must be defined from the fields that exist plus
external-use signals.

## Decision

A **feature-owned, type-scoped, opt-in** retention purger.

- **Ownership / boundary:** the purger lives in the **app-builder feature**
  (`features/app-builder/canvasRetention.ts`) — the owner of the `canvas.app-builder` typeId
  — calling host helpers `listCanvasesForTenant` (its projection already carries
  `canvasTypeId`/`updatedAt`/`projectId`) + `deleteCanvasForTenant`. It is NOT in the host
  canvas surface (the host must not hardcode a feature's typeId). Documents/slides are
  out of scope — a different owner registers its own purger if it wants one.

- **"Abandoned" = `updatedAt < cutoff` AND no `projectId` AND no active share link.**
  Survive-conditions err toward NOT purging (deletion is irreversible):
  - **`projectId` set** → referenced by a live project (intentional). Kept.
  - **an active (non-revoked, non-expired) share link** → "in use externally". Kept. The
    check goes through **sharing's owned predicate `hasActiveLinkForResource`** (a read) —
    the "is this link live" semantics stay single-owned in the sharing feature, not
    re-implemented here (the analytics identity-link cross-feature-read precedent). This is a
    read-only edge; app-builder never writes into sharing's store.

- **Its OWN window, decoupled from the shared `internal` classification window.** The purger
  registers under `internal` only to ride the sweep-daemon tick, then computes its cutoff
  from a dedicated `OPENWOP_APPBUILDER_CANVAS_RETENTION_DAYS` (default null = never),
  **ignoring** the daemon's `cutoffIso`. Rationale: the `internal` window is tuned for the
  seconds-to-days idempotency/checkout stores it also drives (30 days is normal there); an
  app *design's* abandonment horizon is months. Riding the shared window would let an
  operator who set `internalDays=30` to prune idempotency tokens **silently delete users' app
  designs at 30 days**. (This footgun is the reason for the dedicated window.)

- **Cascade:** delete routes through the single delete owner `deleteCanvasForTenant`
  (cascades versions/collab-snapshots/comments/export-lineage via the existing
  `onCanvasDeleted` seam). A purged canvas's only remaining share links are DEAD
  (revoked/expired — an active link is a survive-condition), and those self-heal via sharing's
  own `sweepDeadLinks` within its grace, so a retention-purge leaves exactly what a manual
  editor-delete leaves — no new orphan class.

- **Opt-in** (null default), matching every existing purger — no silent data loss.

## Alternatives weighed

- **Register in `host/canvasSurface` with a hardcoded app-builder type filter** — rejected:
  the host would know a feature's typeId (a boundary smell).
- **Generalize to all canvas types with per-type windows** — rejected (YAGNI): documents and
  slides are user content, not abandoned designs; forcing a retention model on them is wrong.
  Each canvas-type owner can register its own purger.
- **Scan `sharing:link` directly from app-builder** — rejected: forks the "is this link live"
  logic into a second owner. Sharing exposes the predicate instead.
- **Ride the shared `internal` window** — rejected: the design-deletion footgun above.
- **Move the share-link cascade onto the `onCanvasDeleted` seam** (so demo-clear cascades links
  too) — a legitimately cleaner refactor of existing working code, but scoped OUT of DATA-AB-1
  (the survive-condition already prevents active-link orphans; dead links self-heal). Noted as
  a follow-up.

## Consequences

- Abandoned, standalone, unshared app designs age out once an operator opts in; project-linked
  and live-shared designs are always kept.
- The sharing feature gains a reusable retention survive-condition predicate
  (`hasActiveLinkForResource`) any future shareable-resource purger can consult.

## As-built

| Piece | Where |
|---|---|
| Retention purger + own-window resolver | `features/app-builder/canvasRetention.ts`; registered in `features/app-builder/feature.ts` |
| Share-link survive-condition predicate | `features/sharing/sharingService.ts` `hasActiveLinkForResource` |
| Test-seed `updatedAt` override | `host/canvasSurface.ts` `__putCanvasForTest` |
| Tests | `test/appbuilder-canvas-retention.test.ts` (abandoned-purged / fresh-kept / project-kept / live-link-kept / dead-link-purged / other-types-untouched / opt-in) — sabotage-verified |

Cross-references DATA-AB-1, ADR 0380 (the retention-lane boundary), ADR 0359 (the shared canvas store).
