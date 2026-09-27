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
  lockNoticeFull: 'This brand is locked. Only an org admin can save changes to it — anyone else will be refused when they try to save.',
  lockNoticePartial: 'This brand restricts editing. Only its creator, a listed editor, or an org admin can save changes to it.',
  archivedChip: 'Archived',

  // Editor — sections
  editorCreateTitle: 'New brand',
  editorEditTitle: 'Edit brand',
  auditTrail: "Change history",
  auditLoadFailed: "The change history could not be loaded. This is a failed read, not an empty history.",
  auditEmpty: "No guardrail changes recorded yet.",
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
  saveConflict: 'This brand changed since you opened it — close the editor, reload, and reapply your edits.',
  deleteConfirmTitle: 'Delete this brand?',
  deleteConfirmBody: 'Campaign assets that grounded against it will lose their brand reference. This cannot be undone.',
  noOrgTitle: 'No organization yet',
  noOrgBody: 'Create an organization first — a brand belongs to one.',
  // §4.5 collection kit (DESIGN.md rule 13)
  filterGroup: 'Filters',
  filterBrandsPlaceholder: 'Search brands…',
  filterBrandsAria: 'Search brands by name',
  filterStatusLabel: 'Filter by status',
  allStatuses: 'All statuses',
  statusActive: 'Active',
  noMatchTitle: 'No matches',
  noMatchBody: 'Nothing matches the current filters.',
  clearFilters: 'Clear filters',

  // ADR 0399 OQ-1 — brand custom fonts for ad rendering
  secAdFonts: 'Ad fonts',
  adFontsLede: 'Upload a font for composed ad creatives (TTF/OTF). Requires that you hold redistribution rights.',
  adFontRole_sans: 'Sans (headlines & body)',
  adFontRole_serif: 'Serif',
  adFontsAttest: 'I have the right to embed this font in exported creatives.',
  adFontsAttestFirst: 'Confirm the license attestation before uploading.',
  adFontsChoose: 'Choose a {{role}} font file',
  adFontsRemove: 'Remove',
  adFontsLoadFailed: 'Could not load brand fonts.',
  adFontsUploadFailed: 'Font upload failed.',
} as const;
