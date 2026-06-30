/**
 * `kb` namespace — Knowledge Base / RAG feature copy (ADR 0011).
 * Feature-specific strings; generic actions/states reuse `common:`.
 */
export const messages = {
  // Page header
  eyebrow: 'Platform',
  title: 'Knowledge Base',
  lede: 'Give your AI a library of your own documents to draw on — it finds the most relevant passages and cites them in its answers.',
  // Feature gate / empty states
  disabledTitle: 'Knowledge Base is not enabled',
  disabledBody: 'Ask an administrator to enable the Knowledge Base feature for this tenant.',
  noOrgsTitle: 'No organizations',
  noOrgsBody: 'Create an organization first — collections belong to an org.',
  selectCollectionTitle: 'Select a collection',
  selectCollectionBody: 'Pick a collection on the left, or create one — then add documents and search.',
  // Org picker
  organizationLabel: 'Organization',
  // Collections panel
  collectionsHeading: 'Collections',
  noCollections: 'No collections yet.',
  documentsTooltip: 'documents',
  deleteCollection: 'Delete collection',
  newCollectionPlaceholder: 'New collection',
  createCollection: 'Create collection',
  // Search panel
  searchHeading: 'Search “{{name}}”',
  searchPlaceholder: 'Ask a question…',
  retrievalModeLabel: 'Retrieval',
  retrievalModeDense: 'Standard (semantic)',
  retrievalModeHybrid: 'Hybrid (keyword + semantic)',
  retrievalModeRerank: 'Best match (hybrid + rerank)',
  retrievalModeFailed: 'Could not update retrieval mode.',
  noMatches: 'No matches — add documents, or try a different question.',
  cosineScoreTooltip: 'cosine score',
  // Ingest panel
  addDocumentHeading: 'Add a document',
  titlePlaceholder: 'Title (optional)',
  ingestPlaceholder: 'Paste text to chunk + embed into this collection…',
  untitled: 'Untitled',
  ingest: 'Ingest',
  // Documents panel
  documentsHeading: 'Documents',
  noDocuments: 'No documents yet.',
  noDocumentsTitle: 'No documents',
  chunksTooltip: 'chunks',
  chunkCount_one: '{{count}} chunk',
  chunkCount_other: '{{count}} chunks',
  deleteDocument: 'Delete document',
  // Document source provenance (collection-view chip + sub-line)
  sourceText: 'Pasted text',
  sourceMedia: 'Media import',
  // Document list filter + grid/list view (§4.5 collection-view canon)
  docFilterGroup: 'Filter documents',
  docFilterPlaceholder: 'Filter documents…',
  docFilterAria: 'Filter documents by title',
  docNoMatchTitle: 'No matching documents',
  docNoMatchBody: 'No document matches your search. Try a different term.',
  clearDocSearch: 'Clear search',
  // Toast errors
  loadCollectionsFailed: 'Failed to load collections.',
  loadOrgsFailed: 'Failed to load organizations.',
  loadDocumentsFailed: 'Failed to load documents.',
  createFailed: 'Create failed.',
  deleteFailed: 'Delete failed.',
  ingestFailed: 'Ingest failed.',
  uploadFileLabel: 'Upload a file',
  uploadFileHint: 'PDF, DOCX, or text — extracted and added to this collection.',
  documentAdded: 'Document added.',
  fileTooLarge: 'That file is too large (max {{max}} MB).',
  uploading: 'Uploading…',
  searchFailed: 'Search failed.',
  managedBadge: 'Synced',
  managedTitle: 'Auto-synced from {{source}} — read-only here',
  managedNotice: 'This collection is kept in sync with your {{source}} items. Manage them on that page; documents here are read-only.',
  managedSource_strategy: 'Strategy',
  'managedSource_priority-matrix': 'Priority Matrix',
} as const;
