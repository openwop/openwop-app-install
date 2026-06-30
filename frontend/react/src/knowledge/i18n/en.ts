/**
 * `knowledge` namespace — user-facing strings for the knowledge-curation area
 * (`src/knowledge/`): the subject-agnostic SubjectKnowledgePanel (ADR 0046
 * follow-on) that creates/binds KB collections, ingests documents, and searches
 * the corpus. FLAT camelCase keys, one per line (ADR 0065). Plural keys use
 * i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // SubjectKnowledgePanel — errors / notices
  loadError: 'Failed to load knowledge.',
  actionError: 'Action failed.',
  sourceCreated: 'Knowledge source created.',
  documentAdded: 'Document added.',
  documentRemoved: 'Document removed.',
  sourceUnbound: 'Source unbound.',
  // SubjectKnowledgePanel — list / states
  loadingTitle: 'Loading knowledge…',
  emptyTitle: 'No knowledge sources yet',
  // CreateSource — form
  workspaceLabel: 'Workspace',
  newSourceLabel: 'New source name',
  newSourcePlaceholder: 'My playbook',
  createSource: 'Create source',
  // CollectionCard — header / docs
  docCount_one: '{{count}} doc',
  docCount_other: '{{count}} docs',
  unbind: 'Unbind',
  externalUnverified: 'External · unverified',
  externalUnverifiedTitle: 'Imported from an external source — treated as untrusted (ADR 0038 §C).',
  removeDocument: 'Remove document',
  // CollectionCard — ingest form
  documentTitleLabel: 'Document title',
  documentTitlePlaceholder: 'Q3 priorities',
  documentTextLabel: 'Document text',
  documentTextPlaceholder: 'Paste the content to cite.',
  addDocument: 'Add document',
  // RetrieveSection — search
  searchError: 'Search failed.',
  searching: 'Searching…',
  search: 'Search',
  note: 'note',
  external: 'external',
  noMatches: 'No matches yet.',
  syncedBadge: 'Synced',
  syncedTitle: 'Auto-synced from {{source}} — content is read-only here',
  syncedNotice: 'This collection is kept in sync with your {{source}} items. Manage them on that page; documents here are read-only.',
  syncedSource_strategy: 'Strategy',
  'syncedSource_priority-matrix': 'Priority Matrix',
} as const;
