/**
 * CRM entity shared caps/helpers (CRMGAP-10 — `crmEntitiesService.ts` god-file
 * split). Pure primitives with NO dependency on any other `entities/*.ts`
 * file, so this is the dependency-free foundation every entity file imports
 * from — never the other way around.
 *
 * `crmEntitiesService.ts` re-exports the two symbols that were ALREADY public
 * (`assertUnderCap`, `MAX_PER_ORG_ENTITIES`) as a pure barrel; everything else
 * here (`MAX`, `nowIso`, `cleanStr`, `optStr`, `cleanTags`, `isStrictDate`) was
 * always module-private and stays that way — only imported by sibling
 * `entities/*.ts` files.
 *
 * @see docs/adr/0008-crm-full-port.md
 */

import { OpenwopError } from '../../../types.js';
import { cleanString, optionalCleanString, cleanTagList } from '../../../host/boundedStrings.js';

export const MAX = { name: 160, short: 120, tags: 24, tag: 48, body: 4000, stages: 24, customKeys: 50, perOrgEntities: 5000 } as const;

/** The per-org entity cap every org-scoped CRM entity shares (companies,
 *  deals, tasks, activities) — exported so a bulk caller (the import route,
 *  CRMGAP-6) can seed its OWN running count from the same threshold instead
 *  of hardcoding a second copy. */
export const MAX_PER_ORG_ENTITIES = MAX.perOrgEntities;

export function nowIso(): string {
  return new Date().toISOString();
}
export const cleanStr = (raw: unknown, max: number, fallback = ''): string => cleanString(raw, max, fallback);
export const optStr = (raw: unknown, max: number): string | undefined => optionalCleanString(raw, max);
export const cleanTags = (raw: unknown): string[] => cleanTagList(raw, { maxTags: MAX.tags, maxLen: MAX.tag });

/** Strict `YYYY-MM-DD` — shared by `deals.ts`'s `parseCloseDate` and
 *  `fieldDefs.ts`'s `date` custom-field type (ADR 0213 §1 reuses the same
 *  shape deals enforce for `closeDate`) — ONE regex/parse definition instead
 *  of two copies (the pre-split file had two independent definitions of the
 *  same check). */
const STRICT_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function isStrictDate(value: string): boolean {
  return STRICT_DATE.test(value) && Number.isFinite(Date.parse(value));
}

/**
 * Shared soft-cap guard (CRMGAP-9) — the ONE cap-check primitive every
 * per-scope CRM entity count uses (companies/deals/tasks/activities here,
 * segments via `segmentsService` importing this), so the guard's shape
 * (message, error code, `details.max`) can't drift between entities. `count`
 * is either a caller's own running tally (the import route's CRMGAP-6 hoist)
 * or one fresh `list().length` — this function never lists anything itself.
 *
 * ADVISORY, not a security boundary: a plain read-then-throw against a
 * COUNT the caller already has, so two concurrent creates racing the exact
 * boundary can both pass the check and both land — the collection may end up
 * a few rows over `max`. That's acceptable because the cap exists to bound
 * SCAN COST (keep `list()`-based reads cheap), not to enforce an exact
 * billing/quota invariant; it is intentionally NOT CAS-guarded (unlike the
 * CRMGAP-8 TOCTOU fixes, which guard actual data-loss races, not a soft limit).
 */
export function assertUnderCap(count: number, max: number, label: string, scope: 'org' | 'tenant' = 'org'): void {
  if (count >= max) {
    throw new OpenwopError('validation_error', `This ${scope} has the maximum ${max} ${label}.`, 409, { max });
  }
}
