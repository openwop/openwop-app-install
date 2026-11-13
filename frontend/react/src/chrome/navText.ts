/**
 * The ONE reader of a nav entry's words (ADR 0874 P3). An entry carries a
 * catalog key (`labelKey` / `hintKey`, the `nav` namespace) or, for an adopter's
 * feature with no catalog, an English literal (`label` / `hint`). Every surface
 * that shows a nav entry — rail, admin rail, ⌘K, pinned agents, menu settings,
 * admin overview, breadcrumbs — resolves it here, so dropping a literal never
 * leaves a surface rendering `undefined`. `navCopyRatchet.test.ts` refuses a
 * hand-written `t(item.labelKey…)` elsewhere.
 */
import type { TFunction } from 'i18next';
import i18n from '../i18n/index.js';

/** The `nav`-namespace `t` from `useTranslation('nav')`; defaults to i18next's own. */
type NavT = TFunction<'nav'>;

interface NavWords { label?: string | undefined; labelKey?: string | undefined; hint?: string | undefined; hintKey?: string | undefined }


function words(key: string | undefined, literal: string | undefined, t: NavT): string {
  if (key) return literal === undefined ? t(key) : t(key, { defaultValue: literal });
  return literal ?? '';
}

/** The entry's label in the active language. */
export function navLabel(item: NavWords, t: NavT = i18n.getFixedT(null, 'nav')): string {
  return words(item.labelKey, item.label, t);
}

/** The entry's hint in the active language (`''` when it has none). */
export function navHint(item: NavWords, t: NavT = i18n.getFixedT(null, 'nav')): string {
  return words(item.hintKey, item.hint, t);
}
