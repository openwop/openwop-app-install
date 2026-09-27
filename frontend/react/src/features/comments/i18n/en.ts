/**
 * `comments` namespace — user-facing copy for the Comments feature (ADR 0021).
 * Feature-self-contained: every comments string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and NOT duplicated.
 */
export const messages = {
  orgsEmptyClause: 'Comments belong to an organization’s resources',
  orgsFailedClause: 'The resource list was never requested',
  // Page chrome
  eyebrow: 'Workspace',
  title: 'Comments',
  lede: 'Threaded comments on your CMS pages and KB collections.',

  // Gating / empty states
  notEnabledTitle: 'Comments is not enabled',
  notEnabledBody: 'Ask an administrator to enable the Comments feature for this tenant.',
  resourcesFailed: 'Couldn\'t load this org\'s resources — the list may be incomplete, not empty.',
  resourcesFailedOption: 'Couldn\'t load — retry',
  resourceFromLink: 'From your link',
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
  resourceTypeChatMessage: 'Chat message',
  resourceTypeCanvasDocument: 'Rich document',
  noResourcesChatMessage: 'No chat messages in this org',
  noResourcesCanvasDocument: 'No documents yet.',
  resourceTypePriorityIdea: 'Priority idea',
  resourceTypeCreativeBrief: 'Creative brief',
  noResourcesPriorityIdea: 'No priority ideas in this org',
  noResourcesCreativeBrief: 'No creative briefs in this org',

  // CMNT-1 — the notification deep-link round trip
  linkedThreadLabel: 'Thread from your link',
  backToPicker: 'Browse other resources',
  // CMNT-UX-19 / ADR 0659 D2 — ONE uniform sentence, used by the hub's hedge AND
  // by the panel's gone-state. The read answers the SAME 404 for "deleted" and
  // for "you are not bound to this subject-bound collection", deliberately, so
  // this copy must not claim to know which: saying "it was deleted" would be a
  // guess, and saying "you lack access" would be the existence oracle the
  // uniform status exists to close. It also no longer promises "showing its
  // thread anyway" — there is no thread to show.
  linkedResourceMissing: 'This resource isn’t available to you. It may have been deleted, or you may not have access to it.',
  resourceGoneTitle: 'This resource isn’t available',
  unsupportedTypeTitle: 'Unsupported resource type',
  unsupportedTypeBody: 'This link names a resource type this workspace does not comment on ({{type}}). Nothing was substituted — the link is probably stale or mistyped.',
  browseAllComments: 'Browse comments',
  // ADR 0021 extension — inline-in-chat comment affordance
  inlineToggle: 'Comment',
  inlineToggleAria: 'Show comments on this message',

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

  // CMNT-UX-2 / CMNT-UX-3 — failed-read honesty + write feedback
  threadFailedBody: 'We couldn’t read this thread, so we can’t say what’s in it — it is not necessarily empty. Retry, or reload the page.',
  composerBlockedByFailure: 'Commenting is paused until the thread loads — otherwise you might repeat something already said.',
  composerBlockedByReadOnly: 'You have read-only access to this workspace, so you can read this thread but not add to it. Ask an organization admin for edit access (workspace:write) to comment.',
  commentPosted: 'Comment posted.',
  replyPosted: 'Reply posted.',
  markedResolved: 'Marked resolved.',
  markedReopened: 'Reopened.',
  commentDeleted: 'Comment deleted.',

  // CMNT-UX-5 / -8 / -9 — identity, the body cap, and named delete refusals
  directoryNamesFallback: 'We couldn’t load this organization’s member directory, so authors below are shown by id rather than by name.',
  bodyCounter: '{{used}} / {{max}} characters',
  deleteForbidden: 'You can’t delete this comment — only its author or an organization admin can. You can resolve it instead.',
  deleteHasForeignReplies: 'Other people have replied to this comment, so only an organization admin can delete it. Resolve it instead to close the thread.',

  // Confirms / toasts / errors
  deleteConfirm: 'Delete this comment? Its replies are removed too (an org admin is required if other people have replied). This can’t be undone.',
  loadFailed: 'Failed to load comments.',
  postFailed: 'Post failed.',
  updateFailed: 'Update failed.',
  deleteFailed: 'Delete failed.',
  writeGone: 'This isn’t available any more, so nothing was saved. It may have been deleted, or you may no longer have access to it.',
  writeForbidden: 'You can’t make that change — only its author or an organization admin can.',
  writeForbiddenScope: 'You have read-only access to this workspace, so that change wasn’t saved. Ask an organization admin for edit access.',
  writeInvalid: 'That couldn’t be saved — check the text and try again.',
} as const;
