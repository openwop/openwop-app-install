/**
 * `common` namespace — cross-cutting generic strings (actions, states) reused
 * across many surfaces. Feature-specific copy lives in that feature's own
 * catalog (`src/features/<id>/i18n/en.ts`) or its top-level area catalog.
 * Plural keys use i18next `_one`/`_other` suffixes (Intl.PluralRules).
 */
export const messages = {
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
  create: 'Create',
  remove: 'Remove',
  retry: 'Retry',
  refresh: 'Refresh',
  search: 'Search',
  searching: 'Searching…',
  // Generic states
  loading: 'Loading…',
  saving: 'Saving…',
  none: 'None',
} as const;
