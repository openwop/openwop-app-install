/**
 * `ui` namespace — core cross-cutting strings for the app ui surface.
 * Populated as strings are externalized (ADR 0065 Phase 2).
 */
export const messages = {
  // CommandPalette
  cmdkLabel: 'Command palette',
  cmdkPlaceholder: 'Jump to a page or action…',
  cmdkSearchLabel: 'Search commands',
  cmdkEsc: 'esc',
  cmdkNoMatches: 'No matches for “{{query}}”.',
  cmdkListLabel: 'Commands',
  cmdkFootNavigate: 'navigate',
  cmdkFootOpen: 'open',
  cmdkFootOpenStay: 'open · stay',
  cmdkFootToggle: 'toggle',
  cmdkActionsGroup: 'Actions',
  // CommandPalette quick actions
  cmdkActNewRunLabel: 'Create a run',
  cmdkActNewRunHint: 'Submit a workflow on this host',
  cmdkActNewAgentLabel: 'New agent',
  cmdkActNewAgentHint: 'Create a named AI coworker',
  cmdkActCompareLabel: 'Compare runs',
  cmdkActCompareHint: 'Diff two run executions',
  cmdkActReseedLabel: 'Re-seed example data',
  cmdkActReseedHint: 'Reset the built-in example roster',
  // Toast
  toastDismiss: 'Dismiss',
  // ErrorBoundary
  errorTitle: 'Something went wrong',
  errorBodyRegion: 'The {{region}} hit an unexpected error. ',
  errorBodyGeneric: 'This view hit an unexpected error. ',
  errorBodyRecover: 'You can reload to recover.',
  errorReload: 'Reload',
  // ThemeToggle
  themeGroupLabel: 'Theme',
  themeSystem: 'System theme',
  themeLight: 'Light theme',
  themeDark: 'Dark theme',
  // DataTable
  tableBulkActionsLabel: 'Bulk actions',
  tableSelectedCount: '{{n}} selected',
  tableClear: 'Clear',
  tableSelectHeader: 'Select',
  tableSelectAll: 'Select all',
  tableDeselectAll: 'Deselect all',
  tableSelectRow: 'Select row',
  tableSortBy: 'Sort by {{column}}',
  tableDensityLabel: 'Row density',
  tableDensityComfortable: 'Comfortable',
  tableDensityCompact: 'Compact',
  // MarkdownEditor toolbar
  mdToolbarLabel: 'Formatting',
  mdBold: 'Bold',
  mdItalic: 'Italic',
  mdHeading: 'Heading',
  mdLink: 'Link',
  mdBulletedList: 'Bulleted list',
  mdNumberedList: 'Numbered list',
  mdChecklist: 'Checklist',
  mdQuote: 'Quote',
  mdInlineCode: 'Inline code',
  mdCodeBlock: 'Code block',
  // MarkdownEditor controls
  mdWrite: 'Write',
  mdPreview: 'Preview',
  mdDraftSaved: 'Draft saved',
  mdDraftFound: 'An unsaved draft was found.',
  mdRestoreDraft: 'Restore draft',
  mdDiscard: 'Discard',
  mdNothingToPreview: 'Nothing to preview yet.',
  mdMarkdownSupported: 'Markdown supported',
  mdCharCount_one: '{{formatted}} char',
  mdCharCount_other: '{{formatted}} chars',
  mdCharCountMax: '{{n}} / {{max}}',
  mdOverWarning: 'Over the suggested {{max}} characters — consider trimming.',
  // IllustrativeBadge
  illustrativeLabel: 'Illustrative',
  illustrativeDetail: 'Illustrative example data — not derived from live records',
  // KeyFigureBand
  keyFiguresLabel: 'Key figures',
  // ViewToggle (grid/list collection switch)
  viewToggleLabel: 'View as grid or list',
  viewGrid: 'Grid',
  viewList: 'List',
} as const;
