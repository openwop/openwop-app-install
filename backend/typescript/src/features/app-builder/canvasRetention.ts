/**
 * DATA-AB-1 (ADR 0382) — retention for abandoned App-Builder canvases.
 *
 * App-Builder canvases are the `canvas.app-builder` slice of the SHARED host `canvas`
 * store (which also holds `canvas.document` / `canvas.slides`), so this purger is
 * strictly type-scoped and lives in the app-builder feature (the typeId owner) — never in
 * the host canvas surface (the host must not hardcode a feature's typeId).
 *
 * Abandoned = not edited within the window AND not project-linked AND with no active share
 * link. Survive-conditions (err toward NOT purging — deletion is irreversible):
 *  - `projectId` set → the design is referenced by a live project (intentional). Kept.
 *  - a NON-revoked, NON-expired share link → the app is "in use externally". Kept. The
 *    check goes through sharing's owned predicate `hasActiveLinkForResource` (a read; the
 *    "is this link live" semantics stay single-owned in sharing).
 *
 * The window is its OWN env var, NOT the shared `internal` classification window: a design's
 * abandonment horizon is months, whereas the `internal` window is tuned for the
 * seconds-to-days idempotency/checkout stores it also drives — riding that window would
 * silently delete users' app designs at (e.g.) 30 days. We register under `internal` only to
 * ride the sweep tick, then compute our own cutoff. Opt-in (unset ⇒ never), matching every
 * existing purger. Deletes route through the single delete owner `deleteCanvasForTenant`
 * (cascades versions/collab/comments/lineage via the onCanvasDeleted seam).
 *
 * § CORRECTION (WF-SHARE-3, 2026-08-18) — the sentence that used to close this
 * docblock said the purged canvas's remaining links "are dead (revoked/expired) and
 * self-heal via sharing's `sweepDeadLinks`, so app-builder never writes into
 * sharing's store". The CONCLUSION was right for the wrong reason, and the reason
 * was false: `sweepDeadLinks` only ever purged rows that were REVOKED or EXPIRED,
 * and a link orphaned by THIS purger is neither — the owner never revoked it, and
 * unless they set an expiry it never lapses. Those rows were immortal, and each one
 * kept `hasActiveLinkForResource` (the survive-condition three lines below) answering
 * TRUE for a canvas that no longer exists.
 *
 * What is true now: sharing registers `onCanvasDeleted`, which `deleteCanvasForTenant`
 * fires — so the links this purger orphans are PURGED, by sharing, in sharing's own
 * store. The invariant this sentence was defending ("app-builder never writes into
 * sharing's store") still holds, and now holds because of a mechanism that exists.
 */

import { registerRetentionPurger, type PurgeOutcome, type RetentionPurger } from '../../host/retentionPurger.js';
import { listCanvasesForTenant, deleteCanvasForTenant } from '../../host/canvasSurface.js';
import { hasActiveLinkForResource } from '../sharing/sharingService.js';
import { APP_BUILDER_CANVAS_TYPE } from './componentCatalog.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('app-builder.canvasRetention');
const DAY_MS = 86_400_000;

/** The app-builder canvas retention window in days, or null = never (opt-in). Deliberately
 *  its OWN env var, decoupled from the shared `internal` classification window. */
export function appBuilderCanvasRetentionDays(): number | null {
  const days = Number(process.env.OPENWOP_APPBUILDER_CANVAS_RETENTION_DAYS);
  return Number.isFinite(days) && days > 0 ? days : null;
}

/** The ONE module-level purger object (a `const`, not a per-call literal) so
 *  `registerRetentionPurger`'s identity dedup (`purgers.includes(p)`) genuinely makes a
 *  repeat registration a no-op — a fresh object literal per call would register a duplicate
 *  (double-scan + double-count). */
const appBuilderCanvasPurger: RetentionPurger = {
  feature: 'app-builder:canvas',
  async purge(tenantId, classification): Promise<PurgeOutcome> {
    // Ride the `internal` sweep tick, but ignore its cutoff — use our own window.
    if (!tenantId || classification !== 'internal') return { deleted: 0, failed: 0 };
    const days = appBuilderCanvasRetentionDays();
    if (days == null) return { deleted: 0, failed: 0 }; // opt-in: dormant until an operator sets the window
    const cutoffIso = new Date(Date.now() - days * DAY_MS).toISOString();
    let deleted = 0;
    let failed = 0;
    for (const c of await listCanvasesForTenant(tenantId)) {
      if (c.canvasTypeId !== APP_BUILDER_CANVAS_TYPE) continue; // shared store — type scope is mandatory
      if (c.projectId) continue;                                // project-linked = intentional, keep
      if (!(c.updatedAt < cutoffIso)) continue;                 // strict `<` — recently edited, not abandoned
      try {
        if (await hasActiveLinkForResource(tenantId, 'app_builder_canvas', c.canvasId)) continue; // live share, keep
        if (await deleteCanvasForTenant(tenantId, c.canvasId)) deleted += 1;
      } catch (err) {
        failed += 1;
        log.warn('app-builder canvas retention delete failed', {
          tenantId, canvasId: c.canvasId, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (deleted > 0 || failed > 0) log.info('app-builder canvas retention swept', { tenantId, deleted, failed });
    return { deleted, failed };
  },
};

/** Register the app-builder canvas retention purger (truly idempotent — see the purger const). */
export function registerAppBuilderCanvasRetention(): void {
  registerRetentionPurger(appBuilderCanvasPurger);
}
