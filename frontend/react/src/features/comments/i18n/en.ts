/**
 * `comments` namespace — user-facing copy for the Comments feature (ADR 0021).
 * Feature-self-contained: every comments string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Workspace',
  title: 'Comments',
  lede: 'Threaded comments on your CMS pages and KB collections.',

  // Gating / empty states
  notEnabledTitle: 'Comments is not enabled',
  notEnabledBody: 'Ask an administrator to enable the Comments feature for this tenant.',
  noOrgsTitle: 'No organizations',
  noOrgsBody: 'Create an organization first — comments belong to an org’s resources.',
  pickResourceTitle: 'Pick a resource',
  pickResourceBody: 'Choose a CMS page or KB collection above to view and add comments.',
  noCommentsTitle: 'No comments yet',
  noCommentsBody: 'Be the first to leave a note on this resource.',

  // Resource picker
  resourceTypeLabel: 'Resource type',
  resourceLabel: 'Resource',
  orgPickerLabel: 'Organization',
  resourceTypeCmsPage: 'CMS page',
  resourceTypeKbCollection: 'KB collection',
  noResourcesCmsPage: 'No CMS pages in this org',
  noResourcesKbCollection: 'No KB collections in this org',

  // Author label (agent-authored comments)
  authorAgent: 'Agent',

  // Comment status chips
  statusOpen: 'open',
  statusResolved: 'resolved',

  // Composer
  addCommentLabel: 'Add a comment',
  newCommentAria: 'New comment',
  newCommentPlaceholder: 'Leave a note on this resource…',
  commentButton: 'Comment',

  // Row actions
  reply: 'Reply',
  resolve: 'Resolve',
  reopen: 'Reopen',
  deleteComment: 'Delete comment',
  replyAria: 'Reply',
  replyPlaceholder: 'Write a reply…',

  // Confirms / toasts / errors
  deleteConfirm: 'Delete this comment? Its replies are removed too (an org admin is required if other people have replied). This can’t be undone.',
  loadFailed: 'Failed to load comments.',
  postFailed: 'Post failed.',
  updateFailed: 'Update failed.',
  deleteFailed: 'Delete failed.',
} as const;
