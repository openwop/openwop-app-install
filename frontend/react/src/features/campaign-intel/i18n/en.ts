/**
 * `campaign-intel` namespace (ADR 0160) — user-facing copy for Campaign
 * Intelligence. Self-contained; generic actions come from `common`.
 */
export const messages = {
  eyebrow: 'Marketing',
  intelTitle: 'Campaign Intelligence',
  intelLede: 'Data-backed recommendations from your campaign performance — where to shift budget, which creatives are fatiguing, and where the period is heading. Ask the Analyst for specifics.',
  intelNotEnabledTitle: 'Campaign Intelligence is not enabled',
  intelNotEnabledBody: 'Ask a workspace admin to turn on the Campaign Intelligence feature.',

  askAnalyst: 'Ask the Analyst',
  noOrgTitle: 'No organization yet',
  noOrgBody: 'Create an organization first — intelligence runs over its performance data.',
  fieldOrg: 'Organization',
  loading: 'Analyzing performance…',
  intelEmptyTitle: 'Not enough data yet',
  intelEmptyBody: 'Import campaign performance (on the Performance page) so the Analyst can recommend budget shifts and spot creative fatigue.',

  budgetTitle: 'Budget recommendation',
  projectedGain: 'Projected return on the shift: {{gain}}.',
  colPlatform: 'Platform',
  colCurrent: 'Current',
  colSuggested: 'Suggested',
  colRoas: 'ROAS',

  forecastTitle: 'Forecast',
  fatigueFlag: 'Creative fatigue · CTR −{{drop}}',
  healthy: 'Healthy',
  projectionLabel: 'Projected {{spend}} · {{conv}} conv. over {{days}}d',

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
