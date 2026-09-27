/**
 * `common` namespace — cross-cutting generic strings (actions, states) reused
 * across many surfaces. Feature-specific copy lives in that feature's own
 * catalog (`src/features/<id>/i18n/en.ts`) or its top-level area catalog.
 * Plural keys use i18next `_one`/`_other` suffixes (Intl.PluralRules).
 */
export const messages = {
  inlineFailed: "Couldn't load this section.",
  inlineEmpty: 'Nothing here yet.',
  // App-shell chrome
  skipToContent: 'Skip to content',
  privacy: 'Privacy',
  language: 'Language',
  // Generic actions
  save: 'Save',
  cancel: 'Cancel',
  close: 'Close',
  delete: 'Delete',
  edit: 'Edit',
  back: 'Back',
  next: 'Next',
  confirm: 'Confirm',
  typeToConfirmLabel: 'Type {{value}} to confirm',
  create: 'Create',
  remove: 'Remove',
  retry: 'Retry',
  // Template gallery (DESIGN.md §4.5 rule 14 — ui/TemplateGallery.tsx)
  templatesFilterGroup: 'Filter templates',
  templatesSearchPlaceholder: 'Search templates…',
  templatesSearchAria: 'Search templates by name',
  templatesCategoryAria: 'Filter templates by category',
  templatesAllCategories: 'All categories',
  templatesResultCount_one: '{{count}} template matches',
  templatesResultCount_other: '{{count}} templates match',
  templatesNoMatchTitle: 'No templates match',
  templatesNoMatchBody: 'Try a different search, or clear the filters to see everything installed.',
  templatesEmptyTitle: 'No templates installed',
  templatesEmptyBody: 'Templates arrive with packs. Install one, or start from blank.',
  templatesClearFilters: 'Clear filters',
  templatesUse: 'Use template',
  templatesUseNamed: 'Use template: {{name}}',

  deepLinkMissing: 'The item you linked to is no longer available.',
  deepLinkMissingClear: 'Clear',
  refresh: 'Refresh',
  search: 'Search',
  searching: 'Searching…',
  // Generic states
  loading: 'Loading…',
  saving: 'Saving…',
  none: 'None',
  // Shared people-picker (UserPicker) — the empty/no-selection options.
  userPickerNone: 'Unassigned',
  runInputs: {
    title: 'Run {{name}}',
    blurb: 'Provide the inputs for this run. Defaults are prefilled — change them for this run only.',
    run: 'Run',
    starting: 'Starting…',
    requiredPlaceholder: 'Required',
    optionalPlaceholder: 'Optional',
    missingHint: 'Fill the {{n}} required input(s) to run.',
    credentialDefault: 'Workspace default key',
    credentialHelp: 'Which stored API key this run\'s AI steps use. Keys live under Settings → Keys.',
  },
  // KTUX-10 — ONE localized transport-failure vocabulary. `classifyHttpError`
  // returns hardcoded ENGLISH copy; consuming it verbatim would ship English
  // into every locale while `check-i18n` passed green (it verifies KEY parity,
  // not language). Features map its `kind` discriminator to these keys.
  loadFailed: 'Could not load this.',
  loadFailedTitle: 'Could not load this',
  loadFailedBody: 'The list could not be read, so we cannot say what is here. Retry, or reload the page.',
  'error_rate-limited': 'Too many requests just now — wait a moment and retry.',
  // ADR 0482 (ux-1) — the budget-exhausted 429 is a deliberate pause, not a
  // fault. The quoted key serves the dynamic `error_${kind}` family;
  // `errorBudgetExhausted` is its statically-checkable alias (check-i18n
  // cannot parse quoted keys) — keep the two values identical.
  'error_budget-exhausted': 'Daily budget reached — this workflow\'s runs are paused until tomorrow (UTC). Raise or remove the budget in the builder to continue.',
  errorBudgetExhausted: 'Daily budget reached — this workflow\'s runs are paused until tomorrow (UTC). Raise or remove the budget in the builder to continue.',
  errorBudgetTitle: 'Daily budget reached',
  errorBudgetDetail: 'This workflow\'s runs are paused until tomorrow (UTC). Raise or remove the budget in the builder to continue.',
  error_offline: 'Can\'t reach the server. Check your connection and retry.',
  error_auth: 'Your session may have expired. Sign in again.',
  error_forbidden: "You don't have permission to do that here. Ask an admin of this workspace for access.",
  'error_not-found': 'This is no longer available.',
  error_server: 'Something went wrong on our end. Retry shortly.',
  error_unknown: 'Something went wrong. Retry.',
  // ADR 0621 D5 — the three session-refusal 401s, keyed on `body.error`.
  'error_account-disabled': 'This account has been disabled by an administrator. Contact your workspace admin.',
  'error_account-erased': 'This account no longer exists.',
  'error_session-revoked': 'Your session was signed out on every device. Sign in again to continue.',
  cannotBeUndone: 'This cannot be undone.',
} as const;
