/**
 * Label-based record access policy (ADR 0268 / CDP-F) — a reusable decision keyed on
 * an entity's data CLASSIFICATION (`dataClassification.classificationOf`) + whether
 * the caller holds a PII-read grant. Read seams call this to decide whether to serve
 * a record `full` or `masked`. Generalizes the CDP resolve-seam masking into a
 * label-driven primitive so every PII-bearing read enforces the same rule.
 *
 * `deny` is reserved for a future stricter policy tier; today a scope-limited caller
 * gets a MASKED view of a confidential-pii entity (not a hard deny), which preserves
 * resolution (contactId/ops fields) while protecting PII.
 */
import { classificationOf, type DataClassification } from './dataClassification.js';

export type RecordAccessLevel = 'full' | 'masked' | 'deny';

/**
 * The access level for reading `entity` given the caller's PII grant. A
 * `confidential-pii` entity is `masked` for a caller WITHOUT the grant; everything
 * else (public/internal, or any entity with the grant) is `full`.
 */
export function resolveRecordAccess(entity: string, hasPiiGrant: boolean): RecordAccessLevel {
  const classification: DataClassification = classificationOf(entity);
  if (classification === 'confidential-pii' && !hasPiiGrant) return 'masked';
  return 'full';
}
