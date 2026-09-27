/**
 * Consent workflow surface (ADR 0014) — `ctx.features.consent`. Exposes the SAME
 * `isAllowed` / `record` helper that Analytics (0018) + Email (0019) consume
 * in-process (single enforcement path — no second consent rule) to workflow nodes.
 * Tenant comes from the run scope.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { OpenwopError } from '../../types.js';
import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import {
  isAllowed, mergeConsentCategories, partialCategories,
  CONSENT_CATEGORIES, type ConsentCategory,
} from './consentService.js';

/**
 * WF-CONS-3 — the read lane had NO subject guard.
 *
 * `surfaceStr` coerces an absent `subjectKey` to `''`, and `isAllowed` then
 * looks up `${tenantId}:`, misses, and falls through to
 * `policy?.defaultMode === 'opt-out'` (`consentService.ts`). On an opt-out
 * tenant that returns `true` — a FABRICATED authorisation for a person the gate
 * never received — and the node wrapped it as `status:'success'`, so a
 * consuming chain could not tell it from a real "yes". This is the `WF-ANL-2`
 * false-empty family landing in the one node whose whole job is to say whether
 * a person may be contacted.
 *
 * The honest idiom was already in this feature on the WRITE lane:
 * `assertSubjectKey` (`consentService.ts`) throws a typed `validation_error`
 * naming the field, and both `recordConsent` and `mergeConsentCategories` call
 * it (CONS-18). Only the read lane was silent. It now fails the same way.
 */
function requireSubjectKey(v: unknown): string {
  const s = str(v);
  if (!s || !s.trim()) {
    throw new OpenwopError('validation_error', 'Field `subjectKey` must be a non-empty string.', 400, { field: 'subjectKey' });
  }
  return s;
}

/**
 * WF-CONS-3, the same shape one argument over. `str(args.category) as
 * ConsentCategory` was an UNCHECKED cast: a typo'd or absent category met no
 * record, so it took the identical `defaultMode === 'opt-out'` branch and
 * fabricated an `allowed:true` for a category that does not exist. Typed here,
 * and it NAMES the enum — the `WF-CMNT-2` idiom.
 */
function requireCategory(v: unknown): ConsentCategory {
  const s = str(v);
  if (!(CONSENT_CATEGORIES as readonly string[]).includes(s)) {
    throw new OpenwopError('validation_error', `Field \`category\` MUST be one of: ${CONSENT_CATEGORIES.join(', ')}.`, 400, { field: 'category' });
  }
  return s as ConsentCategory;
}

/**
 * WF-CONS-3, the write lane's own success-with-empty. `partialCategories`
 * silently DROPS every key it does not recognise (a typo'd `marketting`, a
 * string `"true"`, an absent `categories` block), so a `record` node could
 * answer `status:'success'` having recorded nothing a caller asked for — while
 * still clearing the subject's erasure tombstone. A recognised `false` is a
 * legitimate, meaningful update and stays success; nothing recognised at all is
 * now typed.
 */
/** DERIVED from the category SSoT, never hand-listed: `partialCategories`
 *  accepts exactly `CONSENT_CATEGORIES` minus `necessary` (which is `true` by
 *  definition and not settable). A new channel added to the enum reaches this
 *  message for free. */
const RECORDABLE_CATEGORIES = CONSENT_CATEGORIES.filter((c) => c !== 'necessary');

export function requireCategories(v: unknown): ReturnType<typeof partialCategories> {
  const cats = partialCategories(v);
  if (Object.keys(cats).length === 0) {
    throw new OpenwopError(
      'validation_error',
      `\`categories\` must set at least one recordable boolean; recordable keys are: ${RECORDABLE_CATEGORIES.join(', ')}.`,
      400, { field: 'categories' },
    );
  }
  return cats;
}

export function buildConsentSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    isAllowed: async (args) => {
      const subjectKey = requireSubjectKey(args.subjectKey);
      const category = requireCategory(args.category);
      const allowed = await isAllowed(tenantId, subjectKey, category);
      // Echo the VALIDATED category so the node never has to re-derive it (and
      // never labels a verdict with a value the gate did not actually evaluate).
      return { allowed, category };
    },
    // CONS-3 — a workflow node writes a PARTIAL update, never a wholesale
    // record. It used to call `recordConsent`, which replaces: a node that set
    // `marketing:true` dropped the subject's recorded `marketing.sms:false`,
    // and `isAllowed` falls back to the umbrella when a specific is absent, so
    // the omission became a GRANT.
    record: async (args) => {
      const rec = await mergeConsentCategories({
        tenantId, subjectKey: requireSubjectKey(args.subjectKey), categories: requireCategories(args.categories), source: 'workflow',
      });
      return { categories: rec.categories };
    },
  };
}
