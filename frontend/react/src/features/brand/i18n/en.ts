/**
 * `brand` namespace (ADR 0155) — user-facing copy for the Brand & Guardrails
 * feature. Feature-self-contained: every brand string lives here. Generic actions
 * (save/cancel/delete/create) are reused from `common` via `t('common:…')`.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Marketing',
  title: 'Brand & Guardrails',
  lede: 'Define how your workspace sounds — voice, formality, approved and banned phrases, positioning, and per-channel rules — then enforce it across every generated asset.',
  newBrand: 'New brand',
  loading: 'Loading brands…',
  loadFailed: 'Could not load brands.',
  emptyTitle: 'No brands yet',
  emptyBody: 'Define a brand once — its voice and guardrails ground every Campaign Studio asset, so campaign #2 takes minutes.',
  createFirst: 'Create a brand',
  notEnabledTitle: 'Brand & Guardrails is not enabled',
  notEnabledBody: 'Ask a workspace admin to turn on the Brand feature for this workspace.',

  // List row chips
  formalityChip: 'Formality {{level}}/5',
  bannedChip_one: '{{count}} banned phrase',
  bannedChip_other: '{{count}} banned phrases',
  channelsChip_one: '{{count}} channel rule',
  channelsChip_other: '{{count}} channel rules',
  lockedChip: 'Locked',
  archivedChip: 'Archived',

  // Editor — sections
  editorCreateTitle: 'New brand',
  editorEditTitle: 'Edit brand',
  secIdentity: 'Identity',
  secVoice: 'Voice',
  secPhrases: 'Key phrases',
  secPositioning: 'Positioning',
  secChannels: 'Per-channel rules',
  secGovernance: 'Governance',

  // Editor — fields
  fieldOrg: 'Organization',
  fieldName: 'Brand name',
  fieldNamePlaceholder: 'e.g. FlashPick',
  fieldDescription: 'Description',
  fieldVoice: 'Voice',
  fieldVoicePlaceholder: 'e.g. confident, not arrogant',
  fieldFormality: 'Formality',
  fieldGuidelines: 'Writing guidelines',
  fieldGuidelinesHelp: 'How the brand should write. Markdown is fine.',
  fieldApproved: 'Approved phrases',
  fieldApprovedHelp: 'Taglines and value props to reach for first — one per line.',
  fieldBanned: 'Banned phrases',
  fieldBannedHelp: 'Hard violations — one per line. Any match caps a compliance score at 30.',
  fieldTagline: 'Tagline',
  fieldElevatorPitch: 'Elevator pitch',
  fieldChannel: 'Channel',
  fieldTone: 'Tone',
  fieldMaxLength: 'Max length',
  addChannelRule: 'Add channel rule',
  removeRule: 'Remove rule',
  fieldLockLevel: 'Edit lock',

  // Formality labels (1–5)
  formality_1: 'Very casual',
  formality_2: 'Casual',
  formality_3: 'Neutral',
  formality_4: 'Formal',
  formality_5: 'Very formal',

  // Lock levels
  lock_none: 'Anyone with write access',
  lock_partial: 'Creator + listed editors + org admins',
  lock_full: 'Org admins only',

  // Channel labels
  channel_landing_page: 'Landing page',
  channel_ad_variants: 'Ad variants',
  channel_email_sequence: 'Email sequence',
  channel_creative_briefs: 'Creative briefs',
  channel_social_posts: 'Social posts',

  // Misc
  saveFailed: 'Could not save the brand.',
  deleteConfirmTitle: 'Delete this brand?',
  deleteConfirmBody: 'Campaign assets that grounded against it will lose their brand reference. This cannot be undone.',
  noOrgTitle: 'No organization yet',
  noOrgBody: 'Create an organization first — a brand belongs to one.',
} as const;
