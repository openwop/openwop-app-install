/**
 * `memory` namespace — user-facing strings for the memory area (`src/memory/`):
 * the subject MemoryBrowser (ADR 0041) and the `/memory` MemoryInspectorPage
 * (RFC 0004). FLAT camelCase keys, one per line (ADR 0065). Plural keys use
 * i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // MemoryBrowser — errors
  loadError: 'Failed to load memories.',
  addError: 'Failed to add the memory.',
  removeError: 'Failed to remove the memory.',
  // MemoryBrowser — add form
  addLabel: 'Add a memory',
  addPlaceholderDefault: 'A fact, preference, or detail to remember.',
  storedCount_one: '{{n}} memory stored',
  storedCount_other: '{{n}} memories stored',
  addMemory: 'Add memory',
  // MemoryBrowser — list / states
  loadingTitle: 'Loading memories…',
  emptyTitle: 'No memories yet',
  emptyBodyDefault: 'Add facts and preferences here; they are recalled when relevant.',
  externalUnverified: 'External · unverified',
  externalUnverifiedTitle: 'Imported from an external source — treated as untrusted.',
  autoLearned: 'Auto-learned',
  autoLearnedTitle: 'Your assistant inferred this from a conversation — it is not something you typed, so it is treated as unverified.',
  learnedOn: 'Learned {{date}}',
  recallOnlyDisclosure_one: '{{n}} more thing was remembered from a conversation and is not listed here. Your assistant can still recall it; it is not editable from this list.',
  recallOnlyDisclosure_other: '{{n}} more things were remembered from conversations and are not listed here. Your assistant can still recall them; they are not editable from this list.',
  removeMemory: 'Remove memory',
  // MemoryInspectorPage — header
  eyebrow: 'Memory',
  inspectorTitle: 'Run summaries',
  inspectorLede: 'Short summaries written when a workflow run completes, plus notes a workflow step saved. Agents do not read this list — an agent\'s memories live on its Memory tab.',
  inspectorOwnRunsOnly: 'You see the runs you started; workspace admins see every run.',
  // MemoryInspectorPage — redaction
  redactedBadge: 'redacted',
  redactedTitle: 'Contains host-redacted secret material (SR-1)',
  // MemoryInspectorPage — search / filter
  searchLabel: 'Search',
  searchHint: '(content or tags)',
  searchPlaceholder: 'filter entries…',
  tagFilterLabel: 'Tag filter',
  tagFilterHint: '(server-side)',
  tagFilterPlaceholder: 'e.g. run-summary',
  // MemoryInspectorPage — columns
  columnContent: 'Content',
  columnTags: 'Tags',
  columnCreated: 'Created',
  ttlSuffix: 'TTL',
  expiresTitle: 'Expires {{date}}',
  // MemoryInspectorPage — delete
  deleteEntryTitle: 'Delete this memory entry',
  deleteEntryAria: 'Delete memory entry {{id}}',
  confirmDelete: 'Delete memory entry "{{id}}"? This cannot be undone.',
  confirmBulkDelete_one: 'Delete {{n}} memory entry? This cannot be undone.',
  confirmBulkDelete_other: 'Delete {{n}} memory entries? This cannot be undone.',
  deleteSuccess: 'Memory entry deleted.',
  deleteError: 'Could not delete the memory entry.',
  bulkDeleteSuccess_one: 'Deleted {{n}} memory entry.',
  bulkDeleteSuccess_other: 'Deleted {{n}} memory entries.',
  bulkDeleteError_one: '{{n}} entry could not be deleted.',
  bulkDeleteError_other: '{{n}} entries could not be deleted.',
  deleteSelected: 'Delete selected',
  // MemoryInspectorPage — count line
  entryCount_one: '{{n}} entry',
  entryCount_other: '{{n}} entries',
  entryCountOf: '{{shown}} of {{total}}',
  // MemoryInspectorPage — table / empty
  tableCaption: 'Memory entries',
  emptyNoMatchTitle: 'No matching memory entries',
  emptyNoEntriesTitle: 'No memory entries yet',
  emptyNoMatchBody: 'No entries match the current search or tag filter. Clear the filters to see the full ledger.',
  clearFilters: 'Clear filters',
  emptyNoEntriesBody: 'A summary appears here when a workflow run completes. Runs that used demo or placeholder output write none.',
  // memoryClient — errors
  getEntryError: 'getMemoryEntry returned {{status}}',
  deleteEntryRequestError: 'deleteMemoryEntry returned {{status}}',
  removeMemoryConfirmBody: 'Remove this memory? It will no longer be recalled.',
  storedUnknown: "Stored memories: unknown",
  loadFailedTitle: "Could not load these memories",
  loadFailedBody: "This is a failed read, not an empty memory — anything stored is still there.",
  retry: "Try again",
} as const;
