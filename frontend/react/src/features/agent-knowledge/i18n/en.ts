/**
 * `agent-knowledge` namespace — user-facing copy for the Agent Knowledge & Memory
 * feature (ADR 0038 / ADR 0041). Feature-self-contained: every agent-knowledge
 * string lives here. Generic actions/states are reused from the `common`
 * namespace via `t('common:…')` and are NOT duplicated. Plural keys use
 * i18next `_one`/`_other` suffixes (Intl.PluralRules).
 */
export const messages = {
  // Panel loading / chrome
  loadingKnowledge: 'Loading knowledge…',
  intro: 'Give {{persona}} its own knowledge: <1>documents</1> it can cite, and private <3>notes &amp; facts</3> it recalls each turn. Host-local config — not the agent’s protocol manifest.',

  // Run notices (success)
  collectionCreated: 'Collection created and bound.',
  documentIngested: 'Document ingested.',
  importedFromDrive: 'Imported from Google Drive.',
  collectionUnbound: 'Collection unbound.',
  documentRemoved: 'Document removed.',
  curatedNotesEnabled: 'Curated notes enabled.',
  curatedNotesDisabled: 'Curated notes disabled.',

  // Documents section
  documentsTitle: 'Documents',
  documentsHint: 'Bound knowledge collections — chunked, embedded, and cited when recalled.',
  documentsCreateOrgFirst: 'Create an organization first to hold this agent’s documents.',
  organizationLabel: 'Organization',
  newCollectionNameLabel: 'New collection name',
  newCollectionNamePlaceholder: 'Account playbook',
  createCollection: 'Create collection',
  noDocumentsBound: 'No documents bound yet. Create a collection, then add a document below.',

  // Collection card
  docCount_one: '{{count}} doc',
  docCount_other: '{{count}} docs',
  unbind: 'Unbind',
  unbindConfirm: 'Unbind "{{name}}" from this agent? The collection itself is kept.',
  externalUnverified: 'External · unverified',
  externalUnverifiedTitle: 'Imported from an external source (e.g. Google Drive or a trigger). Treated as untrusted — fenced when the agent reads it, never followed as instructions (ADR 0038 §C).',
  chunkCount_one: '· {{count}} chunk',
  chunkCount_other: '· {{count}} chunks',
  removeDocumentLabel: 'Remove {{title}}',
  removeDocumentTitle: 'Remove document',
  removeDocumentConfirm: 'Remove "{{title}}"?',
  documentTitleLabel: 'Document title',
  documentTitlePlaceholder: 'Q3 account notes',
  documentTextLabel: 'Document text',
  documentTextHelp: 'Pasted text is chunked + embedded for cited retrieval.',
  documentTextPlaceholder: 'Paste the document content…',
  untitledDocument: 'Untitled',
  addDocument: 'Add document',
  importFromDriveLabel: 'Import from Google Drive',
  importFromDrivePlaceholder: 'https://docs.google.com/document/d/…',
  importFromDrive: 'Import from Drive',
  importFromDriveHint: 'Paste a Drive/Docs link — imported with citation. Requires a connected Google account.',

  // Notes section
  notesTitle: 'Notes & facts',
  notesHint: 'Private to this agent; recalled automatically each turn (not cited).',
  allowCuratedNotes: 'Allow curated notes for this agent',
  enabled: 'enabled',
  disabled: 'disabled',
  notesStored_one: '{{count}} memory stored — browse, add, and remove them in the <1>Memory</1> tab.',
  notesStored_other: '{{count}} memories stored — browse, add, and remove them in the <1>Memory</1> tab.',
  notesEnablePrompt: 'Enable curated notes, then add private facts this agent will recall in the <1>Memory</1> tab.',

  // Retrieve preview
  retrieveTitle: 'Try a retrieval',
  retrieveHint: 'Preview what {{persona}} would recall for a query.',
  queryLabel: 'Query',
  queryPlaceholder: 'What do we know about the account?',
  retrieve: 'Retrieve',
  retrieveNoteChip: 'note',
  retrieveExternalChip: 'external',
  retrieveExternalTitle: 'Untrusted external content — fenced when the agent reads it (ADR 0038 §C).',
  retrieveNoMatches: 'No matches — add documents or notes above.',

  // Memory tab (ADR 0041)
  memoryFailedToLoadSettings: 'Failed to load memory settings.',
  memoryFailedToEnable: 'Failed to enable curated memories.',
  memoryIntro: '{{persona}}’s long-term memory — facts and preferences it recalls when relevant. Durable; private to this agent.',
  memoryCuratedOff: 'Curated memories are off for this agent. <1>Enable them</1> to add facts it will recall.',
  memoryAddPlaceholder: 'The CFO prefers Friday status updates.',
  memoryEmptyBody: 'Add facts {{persona}} should remember; they are recalled when relevant.',
} as const;
