/**
 * Territories — GDPR subject erasure (R2 TER2-B4).
 *
 * Territories stored three subject-keyed fields and registered NOTHING with the
 * host erasure seam, so `eraseSubject` left every one of them intact:
 *
 *   - `Territory.managerSubjectId`  — and `Territory.memberSubjectIds[]`
 *   - `Quota.repSplits[].subjectId`
 *
 * Those are not inert labels. `visibility.ts` reads exactly these fields to decide
 * which CRM rows a subject may see, so an erased person kept a live ACL edge, and
 * the attainment report kept naming them in `repSplits`. Both erasure ratchets in
 * this repo are structurally blind to a store that never registers, which is why
 * this shipped: nothing was red.
 *
 * Following ADR 0464's taxonomy: a MEMBERSHIP/manager grant is the subject's own
 * access and is DELETED (an erased person must not carry authorisation), while a
 * quota SPLIT is a structurally-needed accounting row whose amount belongs to the
 * business, so it is ANONYMIZED in place — the split survives with `ERASED_USER_REF`
 * so the territory's quota still sums to what was authored.
 */

import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { subjectKeyForms, ERASED_USER_REF, ERASED } from '../../host/subjectErasureRedaction.js';
import { createLogger } from '../../observability/logger.js';
import {
  __territoriesForErasure, __putTerritoryForErasure, __modelsForErasure, __putModelForErasure,
} from './entities/territories.js';
import { __quotasForErasure, __putQuotaForErasure } from './entities/quota.js';
import { invalidateTerritoryIndex } from './visibility.js';

const log = createLogger('territories.erasure');

export async function eraseSubjectTerritories(tenantId: string, subjectKey: string): Promise<void> {
  const forms = subjectKeyForms(subjectKey).forms;
  let territoriesTouched = 0;
  let splitsTouched = 0;
  let modelsTouched = 0;
  // REVIEW B3 — `visibility.ts` answers every CRM row-visibility question from a CACHED
  // `TerritoryIndex` (5-minute backstop, keyed by modelId+assignVersion). Every other
  // writer of an ACTIVE model's rows is blocked by `requirePlanningModel`, so this
  // eraser is the ONLY in-place mutator of a live ACL — and it left the cache holding
  // the membership it had just deleted. The grant was cut durably and alive for up to
  // five minutes, on each instance independently, with nothing in the logs.
  const orgsTouched = new Set<string>();

  for (const terr of await __territoriesForErasure(tenantId)) {
    const members = terr.memberSubjectIds.filter((id) => !forms.has(id));
    const managerErased = terr.managerSubjectId !== undefined && forms.has(terr.managerSubjectId);
    if (members.length === terr.memberSubjectIds.length && !managerErased) continue;
    const next = { ...terr, memberSubjectIds: members };
    if (managerErased) delete next.managerSubjectId;
    await __putTerritoryForErasure(next);
    orgsTouched.add(terr.orgId);
    territoriesTouched += 1;
  }

  // REVIEW M2 — the model's author. Anonymised in place (the model is a structural row
  // the whole hierarchy hangs off; deleting it would delete other people's territories).
  for (const m of await __modelsForErasure(tenantId)) {
    if (!forms.has(m.createdBy)) continue;
    await __putModelForErasure({ ...m, createdBy: ERASED });
    modelsTouched += 1;
  }

  for (const q of await __quotasForErasure(tenantId)) {
    if (!q.repSplits.some((s) => forms.has(s.subjectId))) continue;
    // Anonymize rather than drop: dropping the split would silently reduce the
    // territory's authored quota, turning a privacy action into a performance
    // restatement. Collapsing several erased splits onto ONE sentinel id would do
    // the same in reverse (a Map keyed by subjectId elsewhere would keep the last),
    // so the amounts are summed into a single sentinel row.
    const kept = q.repSplits.filter((s) => !forms.has(s.subjectId));
    const erasedTotal = q.repSplits.filter((s) => forms.has(s.subjectId)).reduce((sum, s) => sum + s.amount, 0);
    const existingSentinel = kept.find((s) => s.subjectId === ERASED_USER_REF);
    if (existingSentinel) existingSentinel.amount += erasedTotal;
    else kept.push({ subjectId: ERASED_USER_REF, amount: erasedTotal });
    await __putQuotaForErasure({ ...q, repSplits: kept });
    splitsTouched += 1;
  }

  for (const orgId of orgsTouched) invalidateTerritoryIndex(tenantId, orgId);

  if (territoriesTouched || splitsTouched || modelsTouched) {
    log.info('territory subject erasure applied', { tenantId, territoriesTouched, splitsTouched, modelsTouched, indexesInvalidated: orgsTouched.size });
  }
}

export function registerTerritoryErasure(): void {
  registerSubjectEraser(eraseSubjectTerritories);
}
