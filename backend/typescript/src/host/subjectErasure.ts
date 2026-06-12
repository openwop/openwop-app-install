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

export type SubjectEraser = (tenantId: string, subjectKey: string) => Promise<void>;

const erasers: SubjectEraser[] = [];

/** Register a per-feature subject-purge handler (idempotent by reference). */
export function registerSubjectEraser(fn: SubjectEraser): void {
  if (!erasers.includes(fn)) erasers.push(fn);
}

/** Fan out a data-subject erasure to every registered feature (best-effort — one
 *  feature's failure must not block the others). */
export async function eraseSubject(tenantId: string, subjectKey: string): Promise<void> {
  for (const fn of erasers) {
    try { await fn(tenantId, subjectKey); } catch { /* best-effort: keep erasing */ }
  }
}

/** Test-only: clear registered erasers. */
export function __resetSubjectErasers(): void { erasers.length = 0; }
