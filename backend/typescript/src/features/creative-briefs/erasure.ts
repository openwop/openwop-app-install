/**
 * ADR 1039 D7 (CB82WF-7) — DSAR erasure for creative briefs.
 *
 * Every row here is the org's creative record that a person happened to author
 * or last touch: a brief, its version snapshots, a render (the provenance of a
 * library asset) and a client org's grounding opt-in. So the erasure is
 * RE-ATTRIBUTE, not delete (the ADR 0464 actor-attribution rule), with the
 * tombstone as the target: `createdBy`/`updatedBy` on briefs, `capturedBy` on
 * versions, `createdBy` on renders and `updatedBy` on grounding settings.
 *
 * Matching is `subjectKeyForms` (every spelling a writer may have stored,
 * including the doubled `user:user:`), never a raw string compare. Each rewrite
 * is its own compare-and-swap and never goes through `mutateBrief`, which would
 * bump the version, snapshot and demote an approved brief; a row it cannot
 * rewrite after three lost races fails the eraser rather than being skipped.
 * Run ids and the `'workflow'` literal in `createdBy` are left alone, unless a
 * subject's raw id IS one of those strings (`subjectKeyForms` includes the bare
 * id; real ids are opaque hashes, so this is stated rather than special-cased).
 *
 * Not reached, stated rather than implied: free text a person typed INTO a brief
 * (scene, directions) is org content and stays; a brief's comment threads are
 * erased by the comments feature's own eraser.
 */
import { registerSubjectEraser, type SubjectEraseReport } from '../../host/subjectErasure.js';
import { subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import { tombstoneBriefActors } from './creativeBriefsService.js';
import { tombstoneRenderActors } from './render/renderService.js';
import { tombstoneGroundingActors } from './groundingSettings.js';

/** Same token as documents/media/environments — "erased on request", not "nobody". */
export const ERASED_SUBJECT = 'erased:subject';

export async function eraseCreativeBriefsSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey) return { rowsTouched: 0 };
  const { forms } = subjectKeyForms(subjectKey);
  const rowsTouched = (await tombstoneBriefActors(tenantId, forms, ERASED_SUBJECT))
    + (await tombstoneRenderActors(tenantId, forms, ERASED_SUBJECT))
    + (await tombstoneGroundingActors(tenantId, forms, ERASED_SUBJECT));
  return { rowsTouched };
}

/** Registered from `feature.ts` with the routes (the media/brand precedent). */
export function registerCreativeBriefsErasure(): void {
  registerSubjectEraser(eraseCreativeBriefsSubject);
}
