/**
 * `campaign-connectors` namespace (ADR 0159) — user-facing copy for the Campaign
 * Performance page. Self-contained; generic actions come from `common`.
 */
export const messages = {
  eyebrow: 'Marketing',
  title: 'Campaign Performance',
  lede: 'Import your ad-platform CSV exports onto one unified metric schema and see KPI rollups per platform. Live OAuth sync (Google / Meta / LinkedIn Ads) connects once configured.',
  notEnabledTitle: 'Campaign Performance is not enabled',
  notEnabledBody: 'Ask a workspace admin to turn on the Campaign Connectors feature.',

  importCsv: 'Import CSV',
  importedSummary: 'Imported {{imported}} new rows · {{deduped}} updated · {{invalid}} skipped.',
  noOrgTitle: 'No organization yet',
  noOrgBody: 'Create an organization first — performance data belongs to one.',
  fieldOrg: 'Organization',
  loading: 'Loading performance…',
  emptyTitle: 'No performance data yet',
  emptyBody: 'Import a CSV export from Google, Meta, LinkedIn, or another platform to see your KPIs.',

  kpiSpend: 'Spend',
  kpiImpressions: 'Impressions',
  kpiClicks: 'Clicks',
  kpiConversions: 'Conversions',
  kpiRevenue: 'Revenue',
  kpiRoas: 'ROAS',
  byPlatformTitle: 'By platform',
  colPlatform: 'Platform',
  dateRange: '{{count}} records · {{start}} → {{end}}',

  importHint: 'Paste the CSV from your ad platform export. Columns are auto-detected (campaign, date, cost, impressions, clicks, conversions, revenue).',
  defaultPlatform: 'Default platform',
  csvLabel: 'CSV data',
  csvHelp: 'Header row + one row per day. A Platform column overrides the default.',
  import: 'Import',

  platform_google: 'Google Ads',
  platform_meta: 'Meta Ads',
  platform_linkedin: 'LinkedIn Ads',
  platform_tiktok: 'TikTok',
  platform_x: 'X (Twitter)',
  platform_pinterest: 'Pinterest',
  platform_snapchat: 'Snapchat',
  platform_reddit: 'Reddit',
  platform_youtube: 'YouTube',
} as const;
