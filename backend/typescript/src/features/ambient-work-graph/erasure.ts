/**
 * ADR 0930 D5/A1 — the per-subject (DSAR) eraser for the work graph.
 *
 * A suggestion row is one person's behavioural profile: what they repeat, with their
 * goal text and run ids as evidence. It is that person's record, not org content, so
 * erasure DELETES it (the proposals eraser, by contrast, redacts and keeps an org row).
 *
 * Deleting is not enough on its own. Run records are exempt from erasure (ADR 0464 §4),
 * so the runs that formed the profile keep their owner stamp and the next sweep would
 * mine them again. The eraser therefore writes a durable `erased` suppression row FIRST
 * (`pauseStore.ts`), which every sweep and every read route honours, and only then
 * deletes. Ordering matches the pause route (A2).
 *
 * Matching: a row's `ownerPrincipal` is `opaquePrincipal(callerSubject)`, so every form
 * the subject key may arrive in (`subjectKeyForms`: raw id, `user:` scope) is hashed and
 * matched, in personal and shared workspaces alike (there is no tenant-wide bucket, C1).
 * Legacy tenant-wide rows (no owner, ADR 0930 D6) can hold anyone's goal text, so the
 * eraser deletes those too rather than waiting for the next Scan (grade-code AWG2CD-4).
 *
 * Residue `AWG2-R1`: a row stamped under another auth lane's spelling of the same person
 * (an unbound bearer's `oidc:<sub>`) is not reached by a DSAR keyed on the userId.
 */
import { registerSubjectEraser, type SubjectEraseReport } from '../../host/subjectErasure.js';
import { subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { opaquePrincipal } from '../../host/runOwner.js';
import { forgetOwner, purgeLegacySuggestions } from './suggestionStore.js';
import { setSuppression } from './pauseStore.js';

// `sampleGoal` is run-metadata user text. The field name is already in the global log-mask
// union (intent-ledger's declaration); this names the entity for entity-aware callers.
declarePiiFields('ambient-work-graph.suggestion', ['sampleGoal'], { maskGloballyByFieldName: false });

export async function eraseAmbientWorkGraphSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey) return { rowsTouched: 0 };
  let touched = 0;
  const principals = new Set([...subjectKeyForms(subjectKey).forms].map((f) => opaquePrincipal(f)));
  for (const principal of principals) {
    await setSuppression(tenantId, principal, 'erased');
    touched += await forgetOwner(tenantId, principal, { keepDismissals: false });
  }
  touched += await purgeLegacySuggestions(tenantId);
  return { rowsTouched: touched };
}

registerSubjectEraser(eraseAmbientWorkGraphSubject);
