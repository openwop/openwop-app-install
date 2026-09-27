/**
 * Priority Matrix — GDPR subject erasure (R2 PM2-M5).
 *
 * This feature stored subject-keyed data in SIX collections and registered nothing with
 * the host erasure seam, so `eraseSubject` reached none of it:
 *
 *   - `IdeaVote.voterId`          — and the vote still weights every multi-voter aggregate
 *   - `IdeaScore.updatedBy`
 *   - `IdeaScoreChange.actor` / `.voterId`
 *   - `IdeaSchedule.setBy`
 *   - `PriorityList.createdBy` and `voterWeights` (KEYED by user id)
 *   - `IdeaIntake.requester`      — a free-text field labelled "Requester" that operators
 *                                    fill with names and email addresses
 *   - `IdeaEvidence.addedBy`      — (review: my first version fetched this store and never
 *                                    used it, while the docstring claimed six of eight)
 *   - `PlanningSession.createdBy`
 *
 * None of these is visible to either ratchet: the host gate scans `src/host`, and the
 * feature gate binds on a field literally named `userId`.
 *
 * ADR 0464's taxonomy applies per row. A VOTE is that person's own act and carries no
 * business meaning once they are erased — and leaving it would keep weighting a ranking
 * with a deleted person's opinion — so votes are DELETED, and the list's `voterWeights`
 * entry with them. An idea's SCORE and SCHEDULE are business records (the ranking depends
 * on them), so the row survives and only the person-link is severed. The requester field
 * is free text about a person, so it is cleared rather than sentinelled.
 */

import { registerSubjectEraser, type SubjectEraseReport } from '../../host/subjectErasure.js';
import { subjectKeyForms, ERASED_USER_REF } from '../../host/subjectErasureRedaction.js';
import { createLogger } from '../../observability/logger.js';
import { __pmStoresForErasure } from './priorityMatrixService.js';
import { __intakeStoresForErasure } from './intake.js';
import { __scoreChangesForErasure } from './scoreHistory.js';
import { __federationStoreForErasure } from './federationService.js';

const log = createLogger('priority-matrix.erasure');

/** PMX-4 (ADR 0590) — returns `{rowsTouched}` (the documents/forms shape):
 *  the DSAR seam's `foundNothing` wrong-tenant tell counts only erasers that
 *  REPORT, so the former `void` return opted PM out of the one telemetry
 *  channel that can distinguish "nothing to erase" from "erased in the wrong
 *  tenant". The counts were already computed and logged; now they are returned. */
export async function eraseSubjectPriorityMatrix(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey) return { rowsTouched: 0 };
  const forms = subjectKeyForms(subjectKey).forms;
  const { lists, scores, votes, schedules, sessions } = __pmStoresForErasure();
  let votesRemoved = 0;
  let rowsRedacted = 0;

  // CRITICAL — `IdeaVote`, `IdeaScore`, `IdeaSchedule` and `IdeaIntake` carry NO
  // `tenantId`: they are keyed `listId::cardId[::voterId]`. My first version of this
  // eraser iterated them and matched on the subject alone, so a DSAR in one tenant would
  // have deleted and redacted matching rows in EVERY tenant — a cross-tenant write, from
  // the routine that exists to respect a boundary. The list is the only row that knows
  // its tenant, so the tenant's list ids are resolved first and every child row is scoped
  // through them.
  const tenantListIds = new Set((await lists.list()).filter((l) => l.tenantId === tenantId).map((l) => l.id));
  const mine = (listId: string): boolean => tenantListIds.has(listId);

  // Votes: the subject's own act. Removed, so a departed person stops weighting the rank.
  for (const v of await votes.list()) {
    if (!mine(v.listId) || !forms.has(v.voterId)) continue;
    await votes.delete(`${v.listId}::${v.cardId}::${v.voterId}`);
    votesRemoved += 1;
  }

  for (const l of await lists.list()) {
    if (l.tenantId !== tenantId) continue;
    const next = { ...l };
    let touched = false;
    if (forms.has(l.createdBy)) { next.createdBy = ERASED_USER_REF; touched = true; }
    if (l.voterWeights) {
      const kept = Object.fromEntries(Object.entries(l.voterWeights).filter(([k]) => !forms.has(k)));
      if (Object.keys(kept).length !== Object.keys(l.voterWeights).length) { next.voterWeights = kept; touched = true; }
    }
    if (touched) { await lists.put(next); rowsRedacted += 1; }
  }

  for (const sc of await scores.list()) {
    if (!mine(sc.listId) || sc.updatedBy === undefined || !forms.has(sc.updatedBy)) continue;
    await scores.put({ ...sc, updatedBy: ERASED_USER_REF });
    rowsRedacted += 1;
  }

  for (const sch of await schedules.list()) {
    if (!mine(sch.listId) || sch.setBy === undefined || !forms.has(sch.setBy)) continue;
    await schedules.put({ ...sch, setBy: ERASED_USER_REF });
    rowsRedacted += 1;
  }

  for (const ch of await __scoreChangesForErasure().list()) {
    if (!mine(ch.listId)) continue;
    const next = { ...ch };
    let touched = false;
    if (forms.has(ch.actor)) { next.actor = ERASED_USER_REF; touched = true; }
    if (ch.voterId !== undefined && forms.has(ch.voterId)) { next.voterId = ERASED_USER_REF; touched = true; }
    if (touched) { await __scoreChangesForErasure().put(next); rowsRedacted += 1; }
  }

  // `requester` is free text ABOUT a person, so a sentinel id would be the wrong shape:
  // it is cleared. Matching is by the subject's forms because that is all an erasure
  // knows — an operator who typed a display name instead is named as a deferral.
  const { intakes, evidence } = __intakeStoresForErasure();
  for (const it of await intakes.list()) {
    if (!mine(it.listId)) continue;
    const next = { ...it };
    let touched = false;
    if (it.requester !== undefined && forms.has(it.requester)) { delete next.requester; touched = true; }
    if (forms.has(it.updatedBy)) { next.updatedBy = ERASED_USER_REF; touched = true; }
    if (touched) { await intakes.put(next); rowsRedacted += 1; }
  }

  // R2 review — TWO subject-keyed stores this eraser missed while its own docstring said
  // "six": `IdeaEvidence.addedBy` (the `evidence` accessor was fetched and then never
  // destructured — the tell) and `PlanningSession.createdBy`. Eight, not six.
  for (const ev of await evidence.list()) {
    if (!mine(ev.listId) || ev.addedBy === undefined || !forms.has(ev.addedBy)) continue;
    await evidence.put({ ...ev, addedBy: ERASED_USER_REF });
    rowsRedacted += 1;
  }
  for (const se of await sessions.list()) {
    if (se.tenantId !== tenantId || !forms.has(se.createdBy)) continue;
    await sessions.put({ ...se, createdBy: ERASED_USER_REF });
    rowsRedacted += 1;
  }

  // PMX-3 (ADR 0590) — the NINTH subject-keyed store, missed while the
  // docstring above narrated "Eight, not six": `FederatedPeer.createdBy`
  // (a user id, written at addPeer). Peer rows CARRY a tenantId, so the scope
  // is direct (no listId resolution needed). Same redaction shape as sessions:
  // the row is business config that must survive; only the person-link is
  // severed. Per-user peer credential refs are covered by the BYOK cascade.
  const peers = __federationStoreForErasure();
  for (const p of await peers.list()) {
    if (p.tenantId !== tenantId || !forms.has(p.createdBy)) continue;
    await peers.put({ ...p, createdBy: ERASED_USER_REF });
    rowsRedacted += 1;
  }

  if (votesRemoved || rowsRedacted) {
    log.info('priority-matrix subject erasure applied', { tenantId, votesRemoved, rowsRedacted });
  }
  return { rowsTouched: votesRemoved + rowsRedacted };
}

export function registerPriorityMatrixErasure(): void {
  registerSubjectEraser(eraseSubjectPriorityMatrix);
}
