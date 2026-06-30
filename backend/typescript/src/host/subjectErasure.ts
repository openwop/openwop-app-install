/**
 * Subject-erasure registry (GDPR data-subject erasure, cross-feature).
 *
 * A neutral host-level seam so a data-subject "delete" reaches ALL of a subject's
 * data, not just the feature that fielded the request. Consent (ADR 0020) owns the
 * request and calls `eraseSubject`; feature packages that store subject-keyed data
 * (Analytics events, future Email send-logs) register a `purgeSubject` handler.
 * Decoupled — Consent stays the foundation and does NOT depend on its consumers;
 * it just fans out to whoever registered.
 */

import { createLogger } from '../observability/logger.js';

const log = createLogger('host.subjectErasure');

export type SubjectEraser = (tenantId: string, subjectKey: string) => Promise<void>;

const erasers: SubjectEraser[] = [];

/** Register a per-feature subject-purge handler (idempotent by reference). */
export function registerSubjectEraser(fn: SubjectEraser): void {
  if (!erasers.includes(fn)) erasers.push(fn);
}

/** Fan out a data-subject erasure to every registered feature (best-effort — one
 *  feature's failure must not block the others). Returns the number of erasers
 *  that FAILED so the caller can react; each failure is also logged so a GDPR
 *  erasure that didn't fully complete leaves an audit trail (SEC-4) instead of
 *  silently swallowing — previously a failed eraser was invisible. */
export async function eraseSubject(tenantId: string, subjectKey: string): Promise<{ total: number; failed: number }> {
  let failed = 0;
  for (let i = 0; i < erasers.length; i++) {
    try {
      await erasers[i]!(tenantId, subjectKey);
    } catch (err) {
      failed++;
      log.error('subject_eraser_failed', {
        tenantId,
        subjectKey,
        eraserIndex: i,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (failed > 0) {
    log.warn('subject_erasure_incomplete', { tenantId, subjectKey, failed, total: erasers.length });
  }
  return { total: erasers.length, failed };
}

/** Test-only: clear registered erasers. */
export function __resetSubjectErasers(): void { erasers.length = 0; }
