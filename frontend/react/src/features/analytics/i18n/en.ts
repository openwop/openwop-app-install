/**
 * `analytics` namespace — user-facing copy for the Analytics feature (ADR 0018).
 * Feature-self-contained: every analytics string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  orgsEmptyClause: 'Analytics belong to an organization',
  orgsFailedClause: 'The analytics summary was never requested',
  // Page chrome
  eyebrow: 'Workspace',
  title: 'Analytics',

  // Gating / empty states
  notEnabledTitle: 'Analytics is not enabled',
  notEnabledBody: 'Ask an administrator to enable the Analytics feature for this tenant.',
  noAnalyticsTitle: 'No analytics yet',
  summaryFailedTitle: 'Analytics didn’t load',
  summaryFailedBody: 'The summary read failed — these figures are unavailable, not zero.',
  noEventsInWindowTitle: 'No events in the last {{days}} days',
  noEventsInWindowBody: 'This beacon has reported before — its first event was {{since}} — so the window is just quiet. Try a longer period.',
  noBusinessEventsTitle: 'Only performance telemetry so far',
  noBusinessEventsBody: 'The beacon has been reporting Web Vitals since {{since}}, but no pageviews, events or conversions have been recorded yet.',
  showAllTime: 'Show all time',
  streamSampleNote: 'the newest 25 of a 100-event sample — the figures above count everything',
  trendTitle: 'Pageviews',
  trendLede: 'per UTC day over the last {{days}} days',
  trendSrSummary: 'Pageviews per UTC day across the last {{days}} calendar days: {{total}} in these buckets, peaking at {{peak}} in one day. This calendar total is measured differently from the rolling Pageviews figure above.',
  trendPartialNote: 'Today is still in progress, so the last point covers only the hours elapsed so far.',
  navReportTruncated: 'Showing the top {{shown}} of {{total}} route–source pairs.',
  noAnalyticsBody: 'Events appear here once your published pages report to the public beacon.',
  // ANL-UX-2 R2 - the honest third state: the signal that says whether this
  // beacon has ever reported did not arrive, so we claim neither answer.
  historyUnknownTitle: 'No events to show',
  historyUnknownBody: "We couldn't confirm whether this beacon has ever reported, so we can't tell an uninstalled snippet from a quiet period. Reload in a moment, or check that the snippet is on your published pages.",

  // aria-labels
  orgPickerLabel: 'Organization',
  windowPickerLabel: 'Reporting period',
  window7: 'Last 7 days',
  window30: 'Last 30 days',
  window90: 'Last 90 days',
  windowAll: 'All time',
  ledeWindow: 'Public-surface measurement over the last {{days}} days.',
  ledeAllTime: 'Public-surface measurement over all recorded activity.',
  summaryBandLabel: 'Analytics summary — pageviews and conversions filter recent events',

  // Key figures
  figureEvents: 'Events',
  deltaVsPrior: '{{pct}} vs prior {{days}} days',
  deltaNew: 'new vs prior {{days}} days',
  deltaFlat: 'level with prior {{days}} days',
  figureSessions: 'Sessions',
  // ADR 0569 — daily uniques (cookieless)
  figureVisitors: 'Daily uniques',
  visitorsDisclosure: 'Daily uniques are cookieless: a salted visitor hash that rotates every UTC day, so no cross-day identity exists and a multi-day figure is the sum of each day\u2019s uniques. Counting began {{since}}.',
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
  eventsUnavailable: 'Recent events couldn\u2019t be loaded — the figures above are unaffected.',
  trendUnavailable: 'The daily trend couldn\u2019t be loaded — the figures above are unaffected.',
  navReportLoading: 'Loading navigation counts…',
  topListTruncated: 'Showing the top {{shown}} of {{total}}.',
  emptyEventsFiltered: 'No {{type}} events.',

  // Errors
  loadFailed: 'Failed to load analytics.',

  // ADR 0018 CWV fold-in — Core Web Vitals
  vitalsHeading: 'Web Vitals',
  vitalsHint: 'Real-user Core Web Vitals (p75) from published pages. Client-measured, so approximate.',
  captionVitals: 'Core Web Vitals p75 by metric',
  vitalMetric: 'Metric',
  vitalP75: 'p75',
  vitalRating: 'Rating',
  vitalSamples: 'Samples',
  vitalMs: '{{n}} ms',
  rating_good: 'Good',
  'rating_needs-improvement': 'Needs work',
  rating_poor: 'Poor',
  navReportHeading: 'Workspace navigation',
  navReportHint: 'Anonymous counts of which pages members open and from which menu (this workspace, last {{weeks}} weeks). Recorded only while the workspace-nav-telemetry toggle is on.',
  navReportUnavailable: "The navigation report couldn't be loaded.",
  navReportEmpty: 'No navigation recorded yet.',
  navColRoute: 'Route',
  navColSource: 'Source',
  navColCount: 'Count',
} as const;
