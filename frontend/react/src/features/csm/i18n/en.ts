/**
 * `csm` namespace — user-facing copy for the csm feature.
 * Feature-self-contained: every csm string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Business',
  title: 'CSM',
  lede: 'Customer-success accounts, lowest health first.',

  // Gating / empty states
  notEnabledTitle: 'CSM is not enabled',
  notEnabledBody: 'Ask an administrator to turn on the CSM feature in Admin → Feature toggles.',
  noAccountsTitle: 'No accounts yet',
  noAccountsBody: 'Add your first customer account with the form above — lowest health sorts to the top.',

  // Table
  captionAccounts: 'Accounts',
  colAccount: 'Account',
  colHealth: 'Health',

  // aria-labels
  deleteRowLabel: 'Delete {{name}}',

  // Form field labels / placeholders
  fieldAccount: 'Account',
  fieldHealth: 'Health (0–100)',
  accountNamePlaceholder: 'Acme Corp',

  // Buttons
  addAccount: 'Add account',

  // Toasts — success
  accountAdded: 'Account added.',

  // Toasts / errors
  loadAccountsFailed: 'Failed to load accounts.',
  addFailed: 'Add failed.',
  deleteFailed: 'Delete failed.',
} as const;
