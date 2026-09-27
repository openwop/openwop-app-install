/**
 * ADR 0120 Phase 1 — memory auto-extraction consent grant (the opt-in gate).
 *
 * Auto-extracting durable memory from chat is a cross-content→personal-memory
 * WRITE path, so it is FAIL-CLOSED: nothing is extracted for a subject without an
 * explicit, revocable grant (the ADR 0044 consent-fence shape). This Phase ships
 * ONLY the grant — no extraction happens yet (Phase 2). The grant is keyed by the
 * subject (`user:<id>` / `agent:<id>`) within a tenant; default = NOT granted.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { subjectKeyForms } from '../../host/subjectErasureRedaction.js';

export interface MemoryExtractionGrant {
  tenantId: string;
  /** The subject whose memory may be auto-written (`user:<id>` / `agent:<id>`). */
  subject: string;
  granted: boolean;
  /** The principal who set the grant (audit attribution, ADR 0044). */
  grantedBy: string;
  updatedAt: string;
}

const grants = new DurableCollection<MemoryExtractionGrant>('memextract:grant', (g) => `${g.tenantId}:${g.subject}`);

/** Set (or clear) the extraction grant for a subject. Idempotent. */
export async function setExtractionGrant(tenantId: string, subject: string, granted: boolean, actor: string): Promise<MemoryExtractionGrant> {
  const g: MemoryExtractionGrant = { tenantId, subject, granted, grantedBy: actor, updatedAt: new Date().toISOString() };
  await grants.put(g);
  return g;
}

/** Read the grant record (null when never set). */
export async function getExtractionGrant(tenantId: string, subject: string): Promise<MemoryExtractionGrant | null> {
  return (await grants.get(`${tenantId}:${subject}`)) ?? null;
}

/** FAIL-CLOSED: true ONLY when an explicit grant exists AND is `granted`. The
 *  extraction op (Phase 2) gates on this — absent/revoked ⇒ no write. */
export async function isExtractionGranted(tenantId: string, subject: string): Promise<boolean> {
  const g = await getExtractionGrant(tenantId, subject);
  return g?.granted === true;
}

// ── AGMEM-4 (ADR 0587 §3) — DSAR erasure ─────────────────────────────────────
//
// This row holds a person's userId in THREE places: the key (`${tenantId}:${subject}`),
// `subject` (the person whose memory may be written) and `grantedBy` (the actor who
// set it). Before this, the feature registered ZERO erasers, so `eraseSubjectMemory`
// destroyed the person's memory and left behind a live, subject-named consent record
// **authorising future writes to the memory that had just been erased**.
//
// It was invisible to BOTH erasure gates, which is why nothing went red:
//   - the host gate's denominator is namespaces declared under `src/host/**` only;
//   - the feature-store gate's matchers bound every DECORATED spelling of "subject"
//     (`subjectKey`, `subjectId`, `managerSubjectId`) and NOT the bare field name
//     `subject` — the spelling this entire subject-memory lane standardised on. The
//     gate was blindest exactly where the app is most subject-aware. That matcher is
//     widened in its own commit; this is the instance, that is the class.
//
// BOTH DIRECTIONS are handled, per the symmetric-pair rule: `subject` as topic
// (delete the grant — an erased person has no standing consent) and `grantedBy` as
// actor (re-attribute, never delete: another person's grant is not the DSAR
// subject's data to destroy, but the erased person's id must not survive in it).

/** Tombstone for an erased actor attribution (matches the host convention). */
const ERASED_SUBJECT = 'erased:subject';

/**
 * DSAR eraser for `memextract:grant`. Idempotent; fail-closed on falsy input.
 * Matches every form of the subject key (`user:<id>`, the bare id, the scoped
 * form), because the grant is written keyed `user:<id>` while a DSAR may arrive
 * with either spelling.
 */
export async function eraseExtractionGrants(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const g of await grants.listByPrefix(`${tenantId}:`)) {
    if (g.tenantId !== tenantId) continue;
    // TOPIC — the grant is ABOUT the erased person. Delete it: leaving it would
    // leave a live authorisation to re-populate the memory the DSAR just cleared.
    if (forms.has(g.subject)) {
      await grants.delete(`${g.tenantId}:${g.subject}`);
      continue;
    }
    // ACTOR — someone else's grant that the erased person set. The grant is not
    // theirs to destroy, but their id must not survive in it.
    if (forms.has(g.grantedBy)) {
      await grants.put({ ...g, grantedBy: ERASED_SUBJECT });
    }
  }
}

registerSubjectEraser(eraseExtractionGrants);
