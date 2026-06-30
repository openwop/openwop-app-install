/**
 * `analytics` namespace — user-facing copy for the Analytics feature (ADR 0018).
 * Feature-self-contained: every analytics string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Workspace',
  title: 'Analytics',
  lede: 'Traffic, sessions, and conversions on your public surface.',

  // Gating / empty states
  notEnabledTitle: 'Analytics is not enabled',
  notEnabledBody: 'Ask an administrator to enable the Analytics feature for this tenant.',
  noOrgsTitle: 'No organizations',
  noOrgsBody: 'Create an organization first — analytics belong to an org.',
  noAnalyticsTitle: 'No analytics yet',
  noAnalyticsBody: 'Events appear here once your published pages report to the public beacon.',

  // aria-labels
  orgPickerLabel: 'Organization',
  summaryBandLabel: 'Analytics summary — pageviews and conversions filter recent events',

  // Key figures
  figureEvents: 'Events',
  figureSessions: 'Sessions',
  figurePageviews: 'Pageviews',
  figureConversions: 'Conversions',

  // Section headings
  topPathsHeading: 'Top paths',
  acquisitionHeading: 'Acquisition (UTM source)',
  recentEventsHeading: 'Recent events',
  recentEventsHeadingFiltered: 'Recent events — {{type}}',

  // Table captions
  captionTopPaths: 'Most-viewed paths',
  captionUtmSources: 'Traffic by UTM source',
  captionRecentEvents: 'Recent analytics events',

  // Column headers
  colType: 'Type',
  colDetail: 'Path / name',
  colWhen: 'When',
  colPath: 'Path',
  colViews: 'Views',
  colSource: 'Source',
  colHits: 'Hits',

  // Cell content
  utmDetail: 'utm: {{source}}',
  emDash: '—',

  // Event-type labels (display only — persisted enum stays in data)
  typePageview: 'pageview',
  typeEvent: 'event',
  typeConversion: 'conversion',

  // Table empty states
  emptyTopPaths: 'No pageviews yet.',
  emptyUtmSources: 'No UTM-tagged traffic yet.',
  emptyEvents: 'No events.',
  emptyEventsFiltered: 'No {{type}} events.',

  // Errors
  loadFailed: 'Failed to load analytics.',
} as const;
