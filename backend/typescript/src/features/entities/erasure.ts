/**
 * UX_UPGRADE-entities R2 (ENT2-M1) — subject erasure for the entity kernel's
 * ATTRIBUTION fields.
 *
 * `entities` is subject-signalled and registered no eraser, so `eraseSubject`
 * fanned out to every registered feature and silently skipped this one. What it
 * skipped is narrow but real: `createdBy` on entity types, `createdBy`/`updatedBy`
 * on entity records — fields this codebase already classifies itself:
 * the anonymous-wire projection strips them because they are "member subjects
 * (PII-adjacent — MUST NOT reach the public wire)" (`entitiesService.ts`, ADR
 * 0407 D2). A field the public wire must not carry is a field a DSAR must reach.
 *
 * WHAT THIS DELIBERATELY DOES NOT TOUCH: `values`. An entity record's values
 * are the tenant's OWN data model — a "Customers" type's row may BE a person's
 * record — but only that data model knows which fields are personal. A generic
 * eraser guessing at value keys would either miss (false completeness) or
 * destroy business data (a "customer since" date is not PII; an "assigned rep"
 * might be a name). Erasing a person who exists AS AN ENTITY is the tenant's
 * kernel-level record deletion, driven by whoever understands the schema —
 * flagged in `UX_UPGRADE-entities.md` as the operator-facing boundary, not
 * silently half-covered here.
 *
 * Anonymize, never delete (the documents precedent): types and records are org
 * infrastructure; the author identifier is the personal data. Idempotent;
 * tenant-scoped via each collection's tenant index.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { subjectKeyForms, ERASED } from '../../host/subjectErasureRedaction.js';
import { createLogger } from '../../observability/logger.js';
import type { EntityTypeRecord, EntityRecord } from './entitiesService.js';

const log = createLogger('features.entities.erasure');

// The same collection names/keys as entitiesService — this module writes the
// SAME rows; kept here so the erasure seam does not widen the service surface.
const types = new DurableCollection<EntityTypeRecord>('entity:type', (t) => t.typeId, undefined, (t) => t.tenantId);
const records = new DurableCollection<EntityRecord>('entity:record', (e) => e.recordKey, undefined, (e) => e.tenantId);

export async function eraseEntitiesSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  // `subjectKeyForms` — the host's linked-identity expansion (the service-desk
  // eraser's pattern), so a DSAR keyed on any linked form of the subject matches.
  const { forms } = subjectKeyForms(subjectKey);
  let touched = 0;

  for (const t of await types.listForTenantIndexed(tenantId)) {
    if (!forms.has(t.createdBy)) continue;
    await types.put({ ...t, createdBy: ERASED });
    touched += 1;
  }

  for (const r of await records.listForTenantIndexed(tenantId)) {
    const created = forms.has(r.createdBy);
    const updated = forms.has(r.updatedBy);
    if (!created && !updated) continue;
    await records.put({
      ...r,
      ...(created ? { createdBy: ERASED } : {}),
      ...(updated ? { updatedBy: ERASED } : {}),
    });
    touched += 1;
  }

  log.info('entities_subject_erased', { tenantId, rows: touched, values: 'untouched-by-design' });
}

/** Registered from `feature.ts` so the wiring is greppable and testable. */
export function registerEntitiesErasure(): void {
  registerSubjectEraser(eraseEntitiesSubject);
}
