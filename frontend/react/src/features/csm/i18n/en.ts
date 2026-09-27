/**
 * `csm` namespace — user-facing copy for the csm feature.
 * Feature-self-contained: every csm string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // The feature-specific REASON an organization is needed — a capitalised
  // sentence minus its stop, which `ui:orgStateEmptyBody` supplies. The frame
  // carries no instruction (that is the CTA's) and no noun, so this clause is
  // the one place the noun appears: say "organization", never "org".
  orgsEmptyClause: 'CRM links belong to an organization',
  orgsFailedClause: 'The company list was never requested',
  // Page chrome
  eyebrow: 'Business',
  title: 'CSM',
  lede: 'Customer-success accounts, lowest health first.',
  askHealthInsights: 'Ask health insights',
  healthInsightsSeed: 'Review my customer-success accounts and tell me which are at risk and why. Read the account book first, then summarize the health drivers and suggest next steps.',

  // Gating / empty states
  notEnabledTitle: 'CSM is not enabled',
  notEnabledBody: 'Ask an administrator to turn on the CSM feature in Admin → Feature toggles.',
  noAccountsTitle: 'No accounts yet',
  noAccountsBody: 'Add your first customer account with the form above — lowest health sorts to the top.',

  // Table
  captionAccounts: 'Accounts',
  colAccount: 'Account',
  colHealth: 'Health',
  colArr: 'ARR',
  colOwner: 'Owner',
  companiesLoadFailed: 'Company names didn’t load',
  retryCompaniesLabel: 'Retry loading company names',
  companyNameUnavailable: 'name unavailable',
  fieldArrCurrency: 'Currency',
  arrCurrencyPlaceholder: 'USD',
  filterRenewalLabel: 'Filter by renewal',
  allRenewals: 'All renewals',
  renewalFacetSoon: 'Renewing in 90 days',
  renewalFacetPast: 'Past due',
  scoreOutOfRange: 'Health score must be a number from 0 to 100.',
  portfolioBandLabel: 'Portfolio summary',
  portfolioTotalArr: 'Total ARR',
  portfolioArrAtRisk: 'ARR at risk',
  portfolioRenewals90: 'Renewals in 90 days',
  colRenewal: 'Renewal',
  renewalSoon: 'in {{count}}d',
  renewalPast: 'Past due',
  colLinkedCompany: 'Linked company',
  colFactors: 'Factors',
  notLinked: 'Not linked',
  factorsCount_one: '{{count}} factor',
  factorsCount_other: '{{count}} factors',
  factorHeaderFactor: 'Factor',
  factorHeaderWeight: 'Weight',
  factorHeaderValue: 'Value',
  computedStamp: 'computed {{time}}',

  // aria-labels
  deleteRowLabel: 'Delete {{name}}',
  linkLabel: 'Link {{name}} to a CRM company',
  editLinkLabel: 'Edit CRM company link for {{name}}',

  // Link-to-CRM panel
  linkCompany: 'Link company',
  editLink: 'Edit link',
  clearLink: 'Clear link',
  linkPanelTitle: 'Link "{{name}}" to a CRM company',
  fieldCompany: 'Company',
  selectOrgPlaceholder: 'Select an organization…',
  selectCompanyPlaceholder: 'Select a company…',
  linkSaved: 'Company linked.',
  linkCleared: 'Link cleared.',
  linkFailed: 'Failed to update the CRM link.',

  // Form field labels / placeholders
  fieldAccount: 'Account',
  fieldHealth: 'Health (0–100)',
  fieldArr: 'ARR',
  fieldRenewal: 'Renewal date',
  fieldOwner: 'Owner',
  arrPlaceholder: 'Annual recurring revenue',
  ownerPlaceholder: 'Account owner',
  accountNamePlaceholder: 'Customer account name',

  // Buttons
  addAccount: 'Add account',

  // Toasts — success
  accountAdded: 'Account added.',

  // Toasts / errors
  loadAccountsFailed: 'Failed to load accounts.',
  addFailed: 'Add failed.',
  deleteFailed: 'Delete failed.',
  updateFailed: 'Update failed.',
  arrInvalid: 'ARR must be a number of 0 or more.',
  deleteAccountConfirm: 'Delete account "{{name}}"?',

  // ADR 0582 §6 — the localized failure map. `csmClient` now throws a TYPED
  // error carrying the status, so these are reachable; previously every one of
  // them was dead by construction and failures rendered raw English server text.
  failureForbidden: 'You do not have permission to do that here.',
  failureNotFound: 'That account is no longer here.',
  failureRejected: 'The account book refused that change.',
  failureRateLimited: 'Too many requests — wait a moment and try again.',
  failureServer: 'The account book is unavailable right now.',
  failureOffline: 'Could not reach the account book.',
  loadFailedConsequence: 'This is not an empty book of business — the accounts could not be read.',
  staleClause: 'These figures are the last ones that loaded, not live.',

  // ADR 0582 §4/§6 — measurement states
  healthUnscored: 'Not scored',
  healthUnscoredHint: 'No health has been measured yet',
  companyGone: 'Company no longer in CRM',
  companyGoneHint: 'It was merged or deleted — re-link this account to keep measuring.',
  healthFailedSince: 'Failing since {{date}}',
  healthFailedRelink: 'Re-link company',
  healthMeasureFailed: 'Measurement failed',
  healthStalePrevious: 'last known {{score}}',
  healthOptionalPlaceholder: 'optional',
  fieldHealthHint: 'Leave empty to add the account unscored.',
  fieldHealthEditHint: 'Clear the field to un-assert the score and its breakdown.',
  portfolioUnmeasured: 'Health not measured',
  portfolioUnmeasuredCount_one: '{{count}} account',
  portfolioUnmeasuredCount_other: '{{count}} accounts',
  portfolioUnmeasuredArr: '{{arr}} excluded from ARR at risk',

  // ADR 0582 §5 — the two in-tree formulas, stated so the breakdown is readable
  'formula_penalty-sum': 'Score = 100 − sum of (weight × count). Higher counts lower the score.',
  'formula_weighted-mean': 'Score = sum of (weight × value) ÷ total weight. Higher values raise the score.',
  formulaUnstated: 'This breakdown was recorded without a stated formula.',
  // ADR 0582 §16 — zero-weight rows are coverage denominators, not inputs.
  contextRowsNote: 'Rows with a weight of 0 are context, not scored — they show how much of the source data could be attributed to this account.',
  factorHeaderCount: 'Count',
  noBreakdown: 'No breakdown',

  // Edit panel (CSM-UX-5)
  editPanelTitle: 'Edit "{{name}}"',
  editRowLabel: 'Edit {{name}}',
  accountUpdated: 'Account updated.',
  accountDeleted: 'Deleted "{{name}}".',

  // Collection kit (§4.5 rules 11+13)
  filterGroup: 'Filters',
  filterAccountsPlaceholder: 'Search accounts…',
  filterAccountsAria: 'Search accounts by name or owner',
  filterHealthLabel: 'Filter by health',
  allHealth: 'All health levels',
  health_healthy: 'Healthy (70+)',
  health_at_risk: 'At risk (40–69)',
  health_critical: 'Critical (below 40)',
  health_unscored: 'Not scored',
  noMatchTitle: 'No matching accounts',
  noMatchBody: 'No accounts match the current filters.',
  clearFilters: 'Clear filters',
  viewTable: 'Table',
} as const;
