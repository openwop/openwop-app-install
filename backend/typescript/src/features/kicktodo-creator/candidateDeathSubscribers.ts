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
 *  (d) KTFAC-2 — the candidate's UNPUBLISHED `chal:ktc-*` draft, retired through
 *      the kicktodo-core owner (`retireDraft`, a draft-only CAS). Only a row still in `draft` is
 *      touched: a PUBLISHED version is live catalog content whose withdrawal is the
 *      kill switch's decision (`monitorService`), never a side effect of this seam.
 */

import { createLogger } from '../../observability/logger.js';
import { onCandidateDeath } from './candidateLifecycle.js';
import { deleteCanvasForTenant } from '../../host/canvasSurface.js';
import { outlineCanvasId } from './outlineDoc.js';
import { purgeLessonMediaForCandidate } from './lessonAssembly.js';
import { candidateDraftId } from './planService.js';
import { getCandidate } from './creatorService.js';
import { getLatest, retireDraft } from '../kicktodo-core/challengeService.js';

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

  // (d) KTFAC-2 — the candidate's unpublished draft. The deterministic id covers a
  // draft written before the candidate bound it (a crash between `draftFromPlan`
  // and the bind); the bound id covers anything else. One open draft per lineage
  // (`createDraftVersion` refuses a second), so the LATEST row is the only one
  // that can still be a draft.
  onCandidateDeath('kicktodo-creator.unpublished-draft', async ({ tenantId, candidateId }) => {
    const ids = new Set([candidateDraftId(tenantId, candidateId)]);
    const bound = (await getCandidate(tenantId, candidateId))?.draft?.challengeId;
    if (bound) ids.add(bound);
    for (const id of ids) {
      const latest = await getLatest(tenantId, id);
      if (latest?.status !== 'draft') continue;
      const retired = await retireDraft(tenantId, id, latest.version);
      if (retired) log.info('kicktodo_candidate_draft_retired', { candidateId, challengeId: id, version: latest.version });
    }
  });
}
