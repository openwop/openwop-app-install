/**
 * Data classification taxonomy + PII field registry (ADR 0077 Phase 1).
 *
 * The FOUNDATION the PII log-masking pass (Phase 2) and the retention sweep
 * (Phase 3) consume. Phase 1 ships only the type + the registry — it changes no
 * masking and no retention behavior.
 *
 * Two pieces:
 *  - `DataClassification` — a Public / Internal / Confidential-PII label. Unlabeled
 *    data defaults to `internal` (an operational default — `confidential-pii`-by-default
 *    would mask everything and destroy log usefulness; the lint below backstops
 *    under-classification).
 *  - a process-global, code-declared **PII field registry**: which field names of which
 *    entity are PII. Features declare their PII fields once at module load via
 *    `declarePiiFields(...)` — the SAME side-effect-registration pattern as
 *    `host/subjectErasure.ts` (host owns the data; features import the host helper;
 *    core never imports features → no cycle).
 *
 * The registry is a SYNCHRONOUS in-memory point lookup (Phase 2 calls it on the log
 * hot path — no async, no DurableCollection scan). It exposes both a per-entity query
 * (`isPiiField`) and an entity-agnostic union (`isKnownPiiFieldName`), because the
 * log-masking deep walk usually has only a leaf key, not the entity it belongs to.
 *
 * @see docs/adr/0077-data-classification-pii-masking-retention.md
 */

import { createHash } from 'node:crypto';

export type DataClassification = 'public' | 'internal' | 'confidential-pii';

/** entity → set of its PII field names. */
const registry = new Map<string, Set<string>>();
/** Union of every declared PII field name (entity-agnostic fast path for log masking). */
const allPiiFieldNames = new Set<string>();

/**
 * Declare, once at module load, which fields of an entity are PII. Idempotent +
 * additive (re-declaring an entity merges). Co-locate the call in the feature's
 * service module next to the entity definition (mirrors `registerSubjectEraser`).
 */
export function declarePiiFields(entity: string, fields: readonly string[]): void {
  const set = registry.get(entity) ?? new Set<string>();
  for (const f of fields) {
    set.add(f);
    allPiiFieldNames.add(f);
  }
  registry.set(entity, set);
}

/** O(1) — is `field` a declared PII field of `entity`? */
export function isPiiField(entity: string, field: string): boolean {
  return registry.get(entity)?.has(field) ?? false;
}

/** O(1) — is `field` a PII field of ANY declared entity? The masking deep-walk fast path. */
export function isKnownPiiFieldName(field: string): boolean {
  return allPiiFieldNames.has(field);
}

/**
 * The classification of an entity: `confidential-pii` if it has any declared PII field,
 * else the `internal` default. (`public` is opt-in via a future explicit declaration —
 * nothing defaults to public.)
 */
export function classificationOf(entity: string): DataClassification {
  return (registry.get(entity)?.size ?? 0) > 0 ? 'confidential-pii' : 'internal';
}

/** Introspection for tests + the lint. */
export function piiFieldRegistry(): ReadonlyMap<string, ReadonlySet<string>> {
  return registry;
}

/**
 * Heuristic: does a field NAME look like PII? Used by (a) the Phase-1 lint that flags
 * obvious-PII fields lacking an explicit declaration, and (b) Phase-2 masking as a
 * conservative secondary signal. Deliberately narrow — high-precision shapes only.
 */
// High-precision PII-name detection. Two checks on the snake-normalized name:
//  - EXACT standalone PII words (so `email`/`phone` match, but `emailSubject`,
//    `phoneType` do NOT — substring matching over-masked operational compounds like
//    `ipAddress`/`fromAddress`/`emailSubject`, code-review MEDIUM); and
//  - explicit PII COMPOUNDS (so `firstName`/`dateOfBirth`/`streetAddress` match, but
//    `ipAddress`/`addressBookId` do not, since `ip_address`/`address_book` aren't listed).
// (Declared fields like `email`/`displayName` are masked everywhere anyway via the
// registry UNION — the heuristic exists only to catch UNDECLARED PII.)
const PII_EXACT = new Set(['email', 'phone', 'mobile', 'ssn', 'sin', 'dob', 'fax', 'surname', 'passport']);
const PII_COMPOUND = /(first_name|last_name|full_name|display_name|given_name|family_name|date_of_birth|email_address|home_address|street_address|mailing_address|postal_address|billing_address|shipping_address|phone_number|mobile_number|zip_code|post_code|national_id|tax_id)/;
export function looksLikePiiName(field: string): boolean {
  // Normalize camelCase / kebab / dotted → snake so all spellings collapse to one form.
  const normalized = field
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[.\-\s]+/g, '_')
    .toLowerCase();
  return PII_EXACT.has(normalized) || PII_COMPOUND.test(normalized);
}

// ── PII log masking (ADR 0077 Phase 2) ──────────────────────────────────────────
//
// Pseudonymize a PII value for logs: `pii_<first 10 hex of sha256(value)>`. PLAIN
// SHA-256 (keyless) is deliberate — it is DETERMINISTIC across processes + restarts, so
// the same value yields the same token and log lines stay correlatable. This is
// correlation-preserving PSEUDONYMIZATION, NOT encryption: low-cardinality PII (a small
// name set) is dictionary-reversible by anyone who already has log access + the value
// space. That is acceptable here — the control's goal is preventing CASUAL/accidental
// log exposure (screenshots, a non-targeted pipeline breach), not defeating a targeted
// attacker (who must never have log access). For true irreversibility, swap to an opaque
// marker for `confidential-pii` contexts (loses correlation).
export function maskPiiValue(value: string): string {
  return `pii_${createHash('sha256').update(value).digest('hex').slice(0, 10)}`;
}

/**
 * Key-aware deep walk that masks the VALUES of PII-named fields (ADR 0077 P2). A value
 * is masked iff its KEY is a declared PII field (`isKnownPiiFieldName`) or — when
 * `heuristic` is on — its key `looksLikePiiName`. Operational fields (`runId`, `count`,
 * `status`) are never touched, so this cannot over-mask. A NEW walk (not
 * `sanitizeFreeTextDeep`, which is value-only and loses the key). Cycle-SAFE (GOV-6): a
 * `WeakSet` of in-progress objects short-circuits a reference cycle to `'[Circular]'`
 * instead of recursing forever — a self-referential log payload no longer stack-overflows
 * the logger's emit() (it still runs inside emit()'s try/catch as defence in depth).
 */
export function maskPiiDeep(value: unknown, opts: { heuristic?: boolean } = {}): unknown {
  const heuristic = opts.heuristic ?? true;
  const seen = new WeakSet<object>();
  const keyIsPii = (k: string): boolean => isKnownPiiFieldName(k) || (heuristic && looksLikePiiName(k));
  const maskLeaf = (v: unknown): unknown =>
    (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') ? maskPiiValue(String(v)) : walk(v);
  function walk(v: unknown): unknown {
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[Circular]'; // a cycle — short-circuit instead of recursing forever
      seen.add(v);
      const out: unknown = Array.isArray(v)
        ? v.map(walk)
        : Object.fromEntries(
            Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, keyIsPii(k) ? maskLeaf(val) : walk(val)]),
          );
      seen.delete(v); // allow the SAME object reached via a sibling path (not a cycle) to mask normally
      return out;
    }
    return v;
  }
  return walk(value);
}

/** TEST-ONLY — clear the registry (mirrors `__resetSubjectErasers`). */
export function __resetPiiRegistry(): void {
  registry.clear();
  allPiiFieldNames.clear();
}
