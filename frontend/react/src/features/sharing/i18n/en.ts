/**
 * `sharing` namespace — user-facing copy for the sharing feature (ADR 0013).
 * Feature-self-contained: every sharing string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Platform',
  title: 'Sharing',
  lede: 'Mint unguessable public links to a page or knowledge collection.',

  // Gating / empty states
  notEnabledTitle: 'Sharing is not enabled',
  notEnabledBody: 'Ask an administrator to enable the Sharing feature for this tenant.',
  noOrgsTitle: 'No organizations',
  noOrgsBody: 'Create an organization first — share links belong to an org.',

  // aria-labels
  orgPickerLabel: 'Organization',

  // Resource-type display labels
  typeCmsPage: 'CMS page',
  typeKbCollection: 'KB collection',

  // Mint form
  mintTitle: 'Create a share link',
  fieldResourceType: 'Resource type',
  fieldResource: 'Resource',
  resourcePlaceholder: '— select —',
  fieldLabel: 'Label (optional)',
  labelPlaceholder: 'e.g. Draft for review',
  fieldExpiry: 'Expires in days (optional)',
  expiryPlaceholder: 'never',
  createLink: 'Create link',

  // Active links
  activeTitle: 'Active links',
  noActiveLinks: 'No active share links.',
  expiresAt: 'expires {{date}}',
  copyLinkLabel: 'Copy public link',
  revokeLinkLabel: 'Revoke',

  // Toasts
  linkCopied: 'Link copied',
  linkCreated: 'Share link created',
  loadFailed: 'Failed to load links.',
  createFailed: 'Create failed.',
  revokeFailed: 'Revoke failed.',
  revokeShareConfirm: 'Revoke this share link? Anyone with the URL loses access.',
  typeDocument: 'Document',
  typeConversation: 'Conversation',
  typePrompt: 'Prompt',

  // Public read-only viewer (ADR 0122 Phase 6)
  publicReadOnly: 'Read-only shared view',
  publicLoading: 'Loading the shared view',
  publicUntitled: 'Shared conversation',
  publicEmpty: 'Nothing to show here.',
  publicGoneTitle: 'This link is no longer available',
  publicGoneBody: 'The share link may have expired or been revoked by its owner.',
} as const;
