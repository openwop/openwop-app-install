/**
 * ADR 0458 grade-pass I2 — kicktodo-creator's own subscribers to the
 * candidate-death seam (`candidateLifecycle.ts`). Registered at feature boot;
 * each is keyed (idempotent under a repeat boot), bounded, and best-effort (the
 * seam swallows throws so a subscriber can never block or reverse the kill).
 *
 * When a candidate reaches its terminal `withdrawn` state the factory's sidecar
 * rows must go with it:
 *  (a) the candidate's `challenge-outline` canvas — deleted through the sanctioned
 *      `deleteCanvasForTenant`, which CASCADES its version snapshots (the
 *      `canvas:version` prefix rows) + the seed-idempotency row and fires the
 *      host canvas-deleted lifecycle. So version snapshots do NOT need a separate
 *      delete — the sanctioned canvas delete already covers them.
 *  (b) the `kicktodo-lesson-media` pointer rows for the candidate, AND
 *  (c) each referenced Media asset — both handled by `purgeLessonMediaForCandidate`
 *      through Media's sanctioned service-side `deleteAsset`.
 */

import { createLogger } from '../../observability/logger.js';
import { onCandidateDeath } from './candidateLifecycle.js';
import { deleteCanvasForTenant } from '../../host/canvasSurface.js';
import { outlineCanvasId } from './outlineDoc.js';
import { purgeLessonMediaForCandidate } from './lessonAssembly.js';

const log = createLogger('features.kicktodo-creator.candidateDeath');

/** Idempotent (keyed) registration of every candidate-death cleanup this package
 *  owns. Called once at feature boot; safe to call again (overwrites the keys). */
export function registerCandidateDeathSubscribers(): void {
  // (a) The candidate's outline canvas (+ its version snapshots, via the cascade).
  onCandidateDeath('kicktodo-creator.outline-canvas', async ({ tenantId, candidateId }) => {
    const canvasId = outlineCanvasId(tenantId, candidateId);
    const deleted = await deleteCanvasForTenant(tenantId, canvasId);
    if (deleted) log.info('kicktodo_candidate_outline_canvas_purged', { candidateId, canvasId });
  });

  // (b)+(c) The candidate's lesson-media pointers + their Media assets.
  onCandidateDeath('kicktodo-creator.lesson-media', async ({ tenantId, candidateId }) => {
    const removed = await purgeLessonMediaForCandidate(tenantId, candidateId);
    if (removed) log.info('kicktodo_candidate_lesson_media_purged', { candidateId, pointers: removed });
  });
}
