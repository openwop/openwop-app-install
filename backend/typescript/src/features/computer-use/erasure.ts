/**
 * Computer-use subject erasure (ADR 0894 D9; ADR 0464 store ledger — this was
 * `computer-use:session` RECORDED_DEBT, "needs the computer-use owner").
 *
 * The decision: a session row is the audit of what an agent did on a third-party
 * site, under whose authority (ADR 0541 D5 — "what did it submit, under what
 * authority" must stay answerable). So the ROW is kept, and the PERSON leaves it:
 * `createdBy` and `applyContext.subjectId` are tombstoned, and every free-text
 * field is dropped — the task (which names what the person wanted done), the
 * provider's summaries and descriptions (which echo the page the person was on),
 * and the error text. What stays is the shape of the record: action kinds, the
 * URLs' ORIGINS, tiers, `decidedBy`, approval interrupt ids and timestamps.
 *
 * A tombstoned opener matches no actor, so an erased person's live session can no
 * longer be decided and fails its next authority recheck.
 */
import { registerSubjectEraser, type SubjectEraseReport } from '../../host/subjectErasure.js';
import { subjectKeyForms, ERASED_USER_REF } from '../../host/subjectErasureRedaction.js';
import { createLogger } from '../../observability/logger.js';
import type { CuAction } from './adapter.js';
import { listSessions, putSession, type CuSession } from './sessionStore.js';

const log = createLogger('computer-use.erasure');

const originOnly = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try { return new URL(url).origin; } catch { return undefined; }
};
const scrubAction = (a: CuAction): CuAction => {
  const url = originOnly(a.url);
  return { actionId: a.actionId, kind: a.kind, description: '', ...(url ? { url } : {}) };
};

export async function eraseComputerUseSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey || subjectKey === ERASED_USER_REF) return { rowsTouched: 0 }; // never an unscoped sweep
  const forms = subjectKeyForms(subjectKey).forms;
  let rowsTouched = 0;
  for (const s of await listSessions(tenantId)) {
    const opener = forms.has(s.createdBy);
    const subject = s.applyContext ? forms.has(s.applyContext.subjectId) : false;
    if (!opener && !subject) continue;
    const { resultSummary: _r, error: _e, pendingAction, ...rest } = s;
    const scrubbed: CuSession = {
      ...rest,
      task: '',
      startUrl: originOnly(s.startUrl) ?? '',
      createdBy: opener ? ERASED_USER_REF : s.createdBy,
      ...(s.applyContext ? { applyContext: { ...s.applyContext, subjectId: subject ? ERASED_USER_REF : s.applyContext.subjectId } } : {}),
      ...(pendingAction ? { pendingAction: scrubAction(pendingAction) } : {}),
      steps: s.steps.map((st) => ({ ...st, action: scrubAction(st.action) })),
    };
    await putSession(scrubbed);
    rowsTouched += 1;
  }
  if (rowsTouched > 0) log.info('computer_use_subject_erased', { tenantId, rowsTouched });
  return { rowsTouched };
}

export function registerComputerUseErasure(): void {
  registerSubjectEraser(eraseComputerUseSubject);
}
