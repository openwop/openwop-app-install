/**
 * UX_UPGRADE-documents R2 (DOC2-B1) — subject erasure + PII classification for
 * Documents & Templates.
 *
 * `documents` is a subject-signalled feature and registered NEITHER a subject
 * eraser, NOR a retention purger, NOR any PII field declaration — so a
 * data-subject erasure fanned out by `eraseSubject` reached every feature that
 * had registered and silently skipped this one, leaving the person's identifier
 * on every document they authored, every version they produced, and every
 * template they created. Nothing failed and nothing was reported: the erasure
 * returned success having missed a store it never knew about. That is the
 * failure-rendered-as-success shape, on a compliance path.
 *
 * ANONYMIZE, DO NOT DELETE — and the distinction is the whole design here.
 * A document is ORGANIZATION content; the personal data is the author
 * IDENTIFIER attached to it. Deleting the documents would destroy the
 * workspace's own records to erase someone's name from them, which is both
 * disproportionate and unrecoverable. The host contract explicitly sanctions
 * this reading: `SubjectEraser` "deletes or anonymizes this tenant's rows keyed
 * by `subjectKey`".
 *
 * The one case treated differently is `ownerSubject` on a `user`-kind document —
 * held ON BEHALF OF the person rather than authored by them. Dropping the
 * ownership link is not enough there: `SHAREABLE_STATUSES` is
 * `['approved','final']`, so such a document stays exposed on the PUBLIC share
 * surface after its owner has asked to be erased. Its status is therefore
 * demoted to `'draft'`, which is the existing value that removes it from that
 * set. The row survives — the org keeps its record — but it stops being
 * published.
 *
 * (The first draft of this file set `status: 'archived'`, a value `DocStatus`
 * does not define, in a docstring that confidently described the behaviour.
 * `tsc` caught the type; the docstring would have shipped the claim. The public
 * share-surface consequence was only found by then reading what the statuses
 * actually gate.)
 *
 * Idempotent by construction (the contract requires it — the eraser is invoked
 * once per linked identity key, so any non-idempotent side effect would fire K
 * times): every write is "set the field to the tombstone", which is a no-op the
 * second time.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { createLogger } from '../../observability/logger.js';
import type { DocumentRecord, DocumentVersion, DocumentTemplate } from './documentsService.js';

const log = createLogger('features.documents.erasure');

/** What an erased identifier becomes. Not '' — an empty author reads as "unknown
 *  because nobody set it", which is a different fact from "erased on request". */
export const ERASED_SUBJECT = 'erased:subject';

// Same collection names/keys as documentsService — this module reads and writes
// the SAME rows. Kept here rather than exported from the service so the erasure
// seam does not widen the service's public surface.
const docs = new DurableCollection<DocumentRecord>('documents:doc', (d) => d.documentId);
const versions = new DurableCollection<DocumentVersion>('documents:version', (v) => v.versionId);
const templates = new DurableCollection<DocumentTemplate>('documents:template', (t) => t.templateId);

/** Registered once at feature registration. Split out so a test can call it
 *  directly without booting the whole feature.
 *
 *  Returns `{ rowsTouched }` (DOCT-4 / WF-DOC-8 — the WF-PRJ-3 transfer): the
 *  DSAR seam's `foundNothing` wrong-tenant tell counts only erasers that
 *  REPORT, so a `void` return opted this feature out of the one telemetry
 *  channel that can distinguish "nothing to erase" from "erased in the wrong
 *  tenant". The count was already computed and logged; now it is returned. */
export async function eraseDocumentSubject(tenantId: string, subjectKey: string): Promise<{ rowsTouched: number }> {
  if (!subjectKey) return { rowsTouched: 0 };
  let touched = 0;

  for (const d of await docs.list()) {
    if (d.tenantId !== tenantId) continue;
    const ownedByThem = d.ownerSubject?.kind === 'user' && d.ownerSubject.id === subjectKey;
    const authoredByThem = d.createdBy === subjectKey || d.updatedBy === subjectKey;
    const producedByThem = d.provenance?.producedBy?.kind === 'user' && d.provenance.producedBy.id === subjectKey;
    if (!ownedByThem && !authoredByThem && !producedByThem) continue;

    const next: DocumentRecord = {
      ...d,
      ...(d.createdBy === subjectKey ? { createdBy: ERASED_SUBJECT } : {}),
      ...(d.updatedBy === subjectKey ? { updatedBy: ERASED_SUBJECT } : {}),
      ...(producedByThem
        ? { provenance: { ...d.provenance, producedBy: { ...d.provenance.producedBy, id: ERASED_SUBJECT } } }
        : {}),
    };
    if (ownedByThem) {
      // Drop the ownership link AND unpublish: `SHAREABLE_STATUSES` is
      // ['approved','final'], so leaving the status alone would keep the
      // erased person's document on the public share surface.
      delete (next as { ownerSubject?: unknown }).ownerSubject;
      next.status = 'draft';
    }
    await docs.put(next);
    touched += 1;
  }

  for (const v of await versions.list()) {
    if (v.tenantId !== tenantId) continue;
    if (!(v.producedBy?.kind === 'user' && v.producedBy.id === subjectKey)) continue;
    await versions.put({ ...v, producedBy: { ...v.producedBy, id: ERASED_SUBJECT } });
    touched += 1;
  }

  for (const t of await templates.list()) {
    if (t.tenantId !== tenantId) continue;
    if (t.createdBy !== subjectKey) continue;
    await templates.put({ ...t, createdBy: ERASED_SUBJECT });
    touched += 1;
  }

  // Logged because a silent erasure is indistinguishable from one that never
  // ran — which is exactly how this feature's absence went unnoticed.
  log.info('documents_subject_erased', { tenantId, rows: touched });
  return { rowsTouched: touched };
}

export function registerDocumentsErasure(): void {
  registerSubjectEraser(eraseDocumentSubject);

  // R3 (the R2 known-open) — age-based retention now REACHES document versions.
  // R2 deferred this because "the correct retention age for a business document
  // is a product decision" — and it is, but the AGE is not this purger's to
  // decide: the host seam passes the operator-chosen cutoff in. What was
  // missing was the MECHANISM. Scope is deliberately narrow: only NON-CURRENT
  // versions (history) older than the cutoff are purged — the document row and
  // its current version are never touched, so no live content can age away;
  // what goes is stale PII sitting in superseded revisions (the declared
  // `content` field above).
  registerRetentionPurger({
    feature: 'documents',
    async purge(tenantId, classification, cutoffIso) {
      if (!tenantId || classification !== 'confidential-pii') return 0;
      const current = new Set((await docs.list()).filter((d) => d.tenantId === tenantId).map((d) => d.currentVersionId).filter(Boolean));
      const rows = (await versions.list()).filter((v) => v.tenantId === tenantId && !current.has(v.versionId));
      return purgeRowsByAge('documents', rows, tenantId, cutoffIso,
        (v) => ({ tenantId: v.tenantId, updatedAt: v.createdAt, id: v.versionId }),
        (id) => versions.delete(id));
    },
  });

  // PII declaration follows THIS repo's existing reasoning rather than declaring
  // everything that looks identifying. `comments` states it directly: a `body` is
  // author free-text that "may name/quote people" and is declared, while
  // `authorId` "is an opaque principal id (RFC 0048), not PII" and is not — yet
  // comments still ERASES by that id. The two decisions are separate, and the
  // first draft of this file conflated them: declaring `createdBy` PII would
  // have changed log-masking for opaque ids across the host, contradicting a
  // documented decision, to look more thorough.
  //
  // So: erase by the principal id (above), declare the free text (here). A
  // document version's `content` is exactly comments' `body` case — prose a
  // person wrote, which may name people.
  declarePiiFields('documents:version', ['content']);
}
