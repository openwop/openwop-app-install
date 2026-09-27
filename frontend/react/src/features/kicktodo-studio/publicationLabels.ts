/**
 * KTUX-16 (grade-ux, DESIGN.md §4.5 rule 13) — a raw backend enum in a user-facing
 * chip is an i18n defect. The publication phase (`submitted`/`completed`, derived by
 * the backend `publicationView`) gets localized labels; an unknown value falls back
 * to its raw form rather than a wrong label. Literal `t('pubState_*')` keys keep
 * `check-i18n` able to see them.
 */
export function pubStateLabel(state: string, t: (k: string) => string): string {
  // Namespace-qualified: this helper has no `useTranslation` context of its own, so
  // the keys must name their namespace explicitly (check-i18n resolves them there).
  switch (state) {
    case 'submitted': return t('kicktodo-studio:pubState_submitted');
    case 'completed': return t('kicktodo-studio:pubState_completed');
    default: return state;
  }
}
