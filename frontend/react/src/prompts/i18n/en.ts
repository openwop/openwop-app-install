/**
 * `prompts` namespace — user-facing strings for the prompt-library area
 * (`src/prompts/`). FLAT camelCase keys, one per line (ADR 0065). Plural keys
 * use i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // Kind labels (filter + chips)
  kindAll: 'All',
  kindAllKinds: 'All kinds',
  kindSystem: 'System',
  kindUser: 'User',
  kindFewShot: 'Few-shot',
  kindSchemaHint: 'Schema hint',

  // Page header
  pageEyebrow: 'Build',
  pageTitle: 'Prompt library',
  pageLede:
    'Reusable prompts for chat and for your workflows\' AI nodes. Prompts you create on My prompts are kept in this browser; share one with your team to add it to the Team library, where everyone in the organization can insert it into a chat with /p-.',
  newPrompt: '+ New prompt',

  // Tier-1 subset banner (segments — markup stays in the component)
  tierOneStrong: 'Tier-1 subset',
  tierOnePosture: '({{posture}}):',
  tierOneFlagged_one: 'schema-hint prompt flagged against',
  tierOneFlagged_other: 'schema-hint prompts flagged against',
  tierOneLinkText: 'structured-output-subset.md',
  tierOneFindingHint: 'Inline chips on each offender point to the specific finding.',

  // Key-figure band
  figureAllPrompts: 'All prompts',
  filterByKindAria: 'Filter prompts by kind',

  // Filter bar
  filterGroupAria: 'Filter prompts',
  searchPlaceholder: 'templateId, name, description, tag…',
  searchAria: 'Search prompts',
  filterByKindSelectAria: 'Filter by kind',
  countSummary_one: '{{filtered}} of {{total}} prompt',
  countSummary_other: '{{filtered}} of {{total}} prompts',

  // Loading / empty states
  loadingPromptsAria: 'Loading prompts',
  noMatchTitle: 'No prompts match',
  noMatchBody: 'Try clearing the search or kind filter.',
  clearFilters: 'Clear filters',
  emptyTitle: 'No prompts yet',
  emptyBody: "Author a reusable prompt your workflow's AI nodes can pick from.",

  // View toggle / collection-view canon
  subNoDescription: 'No description',
  openPrompt: 'Open {{name}}',
  usePromptAction: 'Use',

  // Card actions
  editLabel: 'Edit {{name}}',
  deleteLabel: 'Delete {{name}}',
  tierOneFindingTitle: 'Tier-1 subset finding — see structured-output-subset.md',

  // Delete modal
  deleteModalLabel: 'Delete {{name}}',
  deleteModalTitle: 'Delete prompt',
  deleteModalBodyPrefix: 'Delete',
  deleteModalBodySuffix:
    "? This can't be undone — any workflow node still referencing it will fall back to its inline default.",
  deletePromptButton: 'Delete prompt',

  // Editor modal
  editModalTitle: 'Edit prompt',
  newModalTitle: 'New prompt',
  fieldName: 'Name',
  namePlaceholder: 'e.g., Tone-of-voice editor',
  fieldKind: 'Kind',
  fieldDescription: 'Description',
  descriptionPlaceholder: 'What this prompt does and when to use it.',
  fieldPromptText: 'Prompt text',
  promptTextPlaceholderUser: 'Mustache-style template. Use {{token}} for inputs.',
  promptTextPlaceholderSystem: 'The system instruction. Set role, tone, output shape.',
  fieldTags: 'Tags',
  tagsHint: '(comma-separated)',
  tagsPlaceholder: 'editorial, writing',
  templateIdLabel: 'Template ID',
  templateIdHelp: "IDs are immutable once created so existing references don't break.",
  saveChanges: 'Save changes',
  createPrompt: 'Create prompt',
  errorNameRequired: 'Name is required.',
  errorTextRequired: 'Prompt text is required.',

  // Detail modal
  detailRef: 'Ref',
  detailKind: 'Kind',
  detailDescription: 'Description',
  detailVariables: 'Variables',
  variableMeta: '({{type}})',
  variableMetaFromSource: '({{type}} from {{source}})',
  variableDefault: 'default: {{value}}',
  previewLabel: 'Preview (local render)',
  missingRequired: 'Missing required: {{vars}}',
  localRenderNotePrefix: 'This is a local Mustache-style render. Once the host advertises',
  localRenderNoteMiddle: ', the preview will route through',
  localRenderNoteSuffix: 'for the deterministic-hash invariant.',

  // Prompt picker input
  pickerFailedToLoad: 'Failed to load prompts: {{error}}',
  pickerNone: '— none —',
  pickerOptionWithName: '{{name}} ({{ref}})',
  pickerShowBody: 'Show template body',
  pickerVariables: 'Variables: {{vars}}',

  // Tier-1 lint findings (rendered as chips)
  lintNoOneOf: '`oneOf` — Gemini silently drops; prefer `anyOf` or discriminator union',
  lintObjectNeedsAdditionalPropertiesFalse:
    'object schema missing `additionalProperties: false` — required for OpenAI strict',
  loadFailedTitle: "Could not load the prompt library",
  loadFailedBody: "This is a failed read, not an empty library — your prompts are still there.",
  retry: "Try again",
  // ADR 0993 D8 — the Team library tab
  tabsLabel: 'Prompt collections',
  tabMine: 'My prompts',
  tabTeam: 'Team library',
  shareWithTeamLabel: 'Share {{name}} with your team',
  teamToolbarAria: 'Team library',
  teamOrgPickerAria: 'Organization',
  teamHint: 'Type /p- in a chat to insert one of these. You review it before it is sent.',
  teamPublishNew: '+ Publish a prompt',
  teamPublishTitle: 'Publish to the Team library',
  teamEditTitle: 'Edit team prompt',
  teamPublishButton: 'Publish',
  teamLoadFailedTitle: 'Could not load the Team library',
  teamLoadFailedBody: 'This is a failed read, not an empty library. Your team prompts are still there.',
  teamLoadingAria: 'Loading the Team library',
  teamEmptyTitle: 'No team prompts yet',
  teamEmptyBody: 'Publish a prompt, or share one from My prompts, so everyone in the organization can use it.',
  teamYours: 'Yours',
  teamUnavailable: 'Template missing',
  teamUseInChat: 'Use in chat',
  teamUseFailed: 'Could not open this prompt in chat. Try again.',
  teamDeleteTitle: 'Delete {{name}}?',
  teamDeleteBody: 'It disappears from the Team library and from /p- in chat. Its public link, if it has one, stops working.',
  teamDeleted: 'Deleted {{name}}',
  teamDeleteFailed: 'Could not delete this prompt. Try again.',
  teamSaved: 'Saved {{name}}',
  teamPublished: 'Published {{name}}',
  teamConflict: 'Someone changed this prompt since you opened it. Your edits are still in the form; reload the latest version to continue.',
  teamSaveFailed: 'Could not save this prompt. Try again.',
  teamBindsTemplate: 'This prompt uses the template {{ref}}. To change its text, edit the template on My prompts.',
  teamOrgsEmptyClause: 'The Team library belongs to an organization',
  teamOrgsFailedClause: 'The Team library was never requested',
  fieldVisibility: 'Who can use it',
  visibilityHelp: 'Only you: private to you. Team: everyone in the organization.',
  visibilityPrivate: 'Only you',
  visibilityOrg: 'Team',
  visibilityShared: 'Team, with a public link',
  teamForbidden: 'You can use team prompts but not change them. Ask an organization admin for edit access.',
  teamGone: 'This prompt no longer exists. The library has been reloaded.',
  teamConflictReload: 'Reload the latest version',
  teamSaving: 'Saving…',
  teamUnavailableHelp: 'Its text is missing, so it cannot be used. Edit it to restore the text, or delete it.',
  teamVisibilityOwnerOnly: 'Only the person who published this prompt can change who can use it.',
  commandInsertDescription: 'Insert: {{name}}',
  commandInsertFailed: 'Could not insert the team prompt {{command}}. It may have been deleted or changed. Your command is back in the composer.',
} as const;
