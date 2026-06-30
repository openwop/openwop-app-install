/**
 * `settings` namespace — user-facing strings for the Settings area
 * (`src/settings/`). FLAT camelCase keys, one per line (ADR 0065). Plural keys
 * use i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // AdminOverviewPage
  adminEyebrow: 'Admin',
  adminTitle: 'Overview',
  adminLede: 'Platform configuration and console surfaces. Day-to-day work lives in the workspace rail; everything that configures the deployment lives here.',

  // ExampleDataPage — header
  exampleDataEyebrow: 'Settings',
  exampleDataTitle: 'Example data',
  exampleDataLede: 'Load sample data so the dashboards have something to show — agents, workforces, and their history. Everything here is explicit and clearly example data; a clean install starts empty.',

  // ExampleDataPage — types list
  typesHeading: 'Example data types',
  typesIntro: 'Idempotent and non-destructive: each type is created only where it’s missing, so loading never duplicates and never touches data you created yourself. Scoped to your tenant.',
  noTypesTitle: 'No example data types registered',
  noTypesBody: 'This host advertises no seedable example data.',
  selectAria: 'Select {{label}}',
  countPresent: '{{n}} present',

  // ExampleDataPage — actions
  dryRunLabel: 'Dry run (preview)',
  loadAllExampleData: 'Load all example data',
  loadSelected: 'Load selected ({{n}})',
  clearExampleData: 'Clear example data',
  clearTitle: 'Remove example entities (your own agents are untouched)',
  clearing: 'Clearing…',
  clearConfirm: 'Clear {{label}}? This removes the example entities for your tenant (your own agents are not touched).',
  clearAllFallback: 'all example data',

  // ExampleDataPage — results
  dryRunNotice: 'Dry run — nothing was written.',
  summaryCreated_one: '{{n}} created',
  summaryCreated_other: '{{n}} created',
  summaryCleared_one: '{{n}} cleared',
  summaryCleared_other: '{{n}} cleared',
  summarySkipped_one: '{{n}} skipped',
  summarySkipped_other: '{{n}} skipped',
  summaryErrors_one: '{{n}} error',
  summaryErrors_other: '{{n}} errors',

  // ExampleDataPage — per-step action labels
  actionCreated: 'created',
  actionCleared: 'cleared',
  actionError: 'error',
  actionSkipped: 'skipped',
} as const;
