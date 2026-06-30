/**
 * `consent` namespace — user-facing copy for the Consent feature (ADR 0020).
 * Feature-self-contained: every consent string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Workspace',
  title: 'Consent',
  lede: 'Region-aware consent policy + data-subject (GDPR) tools.',

  // Gating / empty states
  notEnabledTitle: 'Consent is not enabled',
  notEnabledBody: 'Ask an administrator to enable the Consent feature for this tenant.',
  noOrgsTitle: 'No organizations',
  noOrgsBody: 'Create an organization first — consent policy belongs to an org.',

  // aria-labels
  orgPickerLabel: 'Organization',

  // Policy form
  regulatedRegionsLabel: 'Regulated regions (comma-separated)',
  regulatedRegionsPlaceholder: 'EU, CA',
  defaultModeLabel: 'Default mode',
  defaultModeOptInLabel: 'opt-in (fail-closed)',
  defaultModeOptOutLabel: 'opt-out',
  savePolicy: 'Save policy',

  // Data subject (GDPR)
  dataSubjectTitle: 'Data subject (GDPR)',
  subjectKeyLabel: 'Subject key',
  subjectKeyPlaceholder: 'visitor cookie / user id',
  lookup: 'Look up',
  erase: 'Erase',
  eraseConfirm: 'Erase all data for subject "{{subjectKey}}"? GDPR data-subject delete — cannot be undone.',
  lookupNoRecord: 'No consent record for that subject — downstream data (if any) is still erased.',

  // Category chips
  categoryAnalytics: 'analytics',
  categoryMarketing: 'marketing',
  categoryNecessaryOnly: 'necessary only',

  // Consent records
  recordsTitle: 'Consent records',
  noRecords: 'No consent records yet.',

  // Toasts — success
  policySaved: 'Policy saved',
  subjectErased: 'Subject data erased',

  // Toasts / errors
  loadPolicyFailed: 'Failed to load policy.',
  saveFailed: 'Save failed.',
  lookupFailed: 'Lookup failed.',
  eraseFailed: 'Erase failed.',
} as const;
