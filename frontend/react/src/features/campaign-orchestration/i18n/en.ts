/**
 * `campaign-studio` namespace (ADR 0158) — user-facing copy for the Campaigns
 * page. Self-contained; generic actions come from `common`.
 */
export const messages = {
  eyebrow: 'Marketing',
  title: 'Campaigns',
  lede: 'Run a multi-channel campaign from a brief — the Campaign Strategist generates the messaging kernel, every channel, and a consistency check, then finalizes the campaign here.',
  notEnabledTitle: 'Campaign Studio is not enabled',
  notEnabledBody: 'Ask a workspace admin to turn on the Campaign Studio feature.',

  loading: 'Loading campaigns…',
  emptyTitle: 'No campaigns yet',
  emptyBody: 'Finalize a confirmed brief into a campaign, or run one end-to-end with the Campaign Strategist.',
  runWithStrategist: 'Run with the Strategist',
  finalizeBrief: 'Finalize a brief',
  hasKernel: 'Kernel',
  channelsCount_one: '{{count}} channel',
  channelsCount_other: '{{count}} channels',
  deleteTitle: 'Delete this campaign?',
  deleteBody: 'The campaign is removed. The brief it came from is untouched. This cannot be undone.',

  status_draft: 'Draft',
  status_active: 'Active',
  status_paused: 'Paused',
  status_completed: 'Completed',
  status_archived: 'Archived',

  // Finalize modal
  finalizeHint: 'Pick a confirmed brief — a campaign is created (or updated) from it. One campaign per brief.',
  fieldOrg: 'Organization',
  allOrgs: 'All organizations',
  fieldBrief: 'Brief',
  noBriefs: 'No briefs found',
  finalize: 'Finalize',

  // Detail
  backToCampaigns: 'Campaigns',
  statusLabel: 'Status',
  kernelTitle: 'Messaging kernel',
  kernelCta: 'CTA',
  kernelTone: 'Tone',
  noKernel: 'This campaign has no messaging kernel yet.',
  channelsTitle: 'Channels',
  noChannels: 'No channels enabled.',

  channel_landing_page: 'Landing page',
  channel_ad_variants: 'Ad variants',
  channel_email_sequence: 'Email sequence',
  channel_creative_briefs: 'Creative briefs',
  channel_social_posts: 'Social posts',
} as const;
