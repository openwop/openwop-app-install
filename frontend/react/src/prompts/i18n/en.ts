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
    "Reusable prompts your workflow's AI nodes can pick from. Edit one in a single place and every node that uses it updates the next time it runs — no copy-paste, no drift. System prompts set the AI's role and tone; user prompts shape what you ask of it.",
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
  pickerLoading: 'Loading prompts…',
  pickerNone: '— none —',
  pickerOptionWithName: '{{name}} ({{ref}})',
  pickerShowBody: 'Show template body',
  pickerVariables: 'Variables: {{vars}}',

  // Tier-1 lint findings (rendered as chips)
  lintNoOneOf: '`oneOf` — Gemini silently drops; prefer `anyOf` or discriminator union',
  lintObjectNeedsAdditionalPropertiesFalse:
    'object schema missing `additionalProperties: false` — required for OpenAI strict',
} as const;
