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
  // ANL-UX-23 / ADR 0857 — every figure is consent-filtered while consent management is on
  consentFilterNote: 'Consent management is on: a visitor is counted only if their analytics consent allows it, so these figures exclude everyone who declined.',
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
  heatHeading: "Heat maps",
  heatHint: "Where visitors click, how far they scroll and what holds their attention. Counts only: no visitor is identified, bots are left out, and only visitors who allowed analytics are counted.",
  heatLoading: "Loading heat maps…",
  heatPagesFailed: "The list of measured pages could not be loaded.",
  heatFailed: "This heat map could not be loaded.",
  heatNoPages: "No page has heat data yet. Data appears once visitors who allowed analytics use your published pages.",
  heatEmpty: "No heat data for this page, device and period.",
  heatPageLabel: "Page",
  heatDeviceLabel: "Device",
  heatDeviceAll: "All devices",
  heatDeviceDesktop: "Desktop",
  heatDeviceTablet: "Tablet",
  heatDeviceMobile: "Mobile",
  heatModeLabel: "Heat map view",
  heatModeClicks: "Clicks",
  heatModeScroll: "Scroll depth",
  heatModeAttention: "Attention",
  heatSummary: "{{views}} page views, {{clicks}} clicks. {{bots}} bot visits left out.",
  heatArmsSuppressed: "Some experiment versions had fewer than {{n}} page views and are not shown on their own.",
  heatGridAlt: "Click map of the page: {{clicks}} clicks, darker squares had more.",
  heatGridCaption: "Each square is 2% of the page's width and height, top of the page at the top. The map is drawn on the page's proportions, not a screenshot.",
  heatOpenPage: "Open the page",
  heatNamedCaption: "Most-clicked named elements",
  heatAreasCaption: "Most-clicked areas",
  heatColElement: "Element",
  heatColArea: "Area",
  heatColClicks: "Clicks",
  heatColShare: "Share",
  heatArea: "{{x}}% across, {{y}}% down",
  heatScrollCaption: "Share of page views that scrolled at least this far",
  heatColDepth: "Depth",
  heatColReached: "Page views reaching it",
  heatReachedAria: "{{share}} of page views reached {{depth}}",
  heatNoSections: "No sections are measured on this page. Give sections an id (or a data-owx-section attribute) to see attention.",
  heatAttentionCaption: "Average time each section was in view",
  heatColSection: "Section",
  heatColAvgSeconds: "Average seconds",
  heatColViews: "Page views",
  behaviorHeading: "Behavior capture",
  behaviorLoading: "Loading behavior capture status…",
  behaviorUnavailable: "Behavior capture status could not be loaded.",
  behaviorHeatmaps: "Heat maps",
  behaviorReplay: "Session replay",
  behaviorOn: "On",
  behaviorOff: "Off",
  behaviorNotConfigured: "Not configured",
  behaviorNotAvailable: "Not available",
  behaviorReplayNotAvailable: "Session recording is not available in this release.",
  behaviorNeedsConsent: "Needs consent management",
  behaviorReplayNoStorage: "Session replay needs durable blob storage (GCS or S3). Nothing is recorded, and visitors are not asked, until an operator configures it.",
  behaviorReplayNoConsent: "Visitors can only opt in to session recording through the consent banner. Turn on consent management to offer it.",
  behaviorReplayReady: "Visitors are asked separately whether to allow session recording. Recordings are deleted after {{days}} days, or straight away when a visitor withdraws.",
  navReportHeading: 'Workspace navigation',
  navReportHint: 'Anonymous counts of which pages members open and from which menu (this workspace, last {{weeks}} weeks). Recorded only while the workspace-nav-telemetry toggle is on.',
  navReportUnavailable: "The navigation report couldn't be loaded.",
  navReportEmpty: 'No navigation recorded yet.',
  navColRoute: 'Route',
  navColSource: 'Source',
  navColCount: 'Count',
  // ADR 0768 D5 — the Pocket assistant; its agent reads only orgs the caller can read.
  pocketTitle: 'Insights assistant',
  pocketScope: 'analytics for organizations you can read',
  pocketHint: 'Ask what changed, e.g. "why did conversions drop last week?"',
} as const;
