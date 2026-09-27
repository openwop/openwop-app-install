/**
 * `ui` namespace — core cross-cutting strings for the app ui surface.
 * Populated as strings are externalized (ADR 0065 Phase 2).
 */
export const messages = {

  // OrgSelectionState (HG-4) — the ONE noun + the ONE branch order.
  orgStateFailedTitle: 'Could not load your organizations',
  // §4.6 rule 2 — one clause of consequence, then stop. This used to run
  // "…not an empty account — it does not mean you have no organizations",
  // which is the same clause twice.
  //
  // "empty ACCOUNT" was a FOURTH noun for this collection (`workspace`,
  // `store`, `organization` were the first three), and the Romance locales had
  // rendered it literally — `una cuenta vacía` / `uma conta vazia` — which in
  // an app that sells subscriptions reads as BILLING. The contrast is the whole
  // point of the sentence, so it stays; only the noun changes to the one this
  // card is actually about.
  orgStateFailedBody: 'This is a failed read, not an empty organization list.',
  // The same sentence with the feature's own consequence clause in front of it
  // ("The metric list was never requested"), which is the half a failed read
  // can honestly report.
  orgStateFailedBodyWith: '{{what}}. This is a failed read, not an empty organization list.',
  orgStateEmptyTitle: 'No organizations',
  // THE FRAME CARRIES NO INSTRUCTION AND NO NOUN, and both halves of that are
  // deliberate.
  //
  // It used to read "Create an organization first — {{what}}." beside a CTA
  // reading "Create an organization" — the action stated twice, which is
  // DESIGN.md §4.6 rule 7 ("offer the recovery, don't narrate it") lost to a
  // half-applied fix: the offer was added and the narration was left. Worse for
  // the callers who CANNOT create one, who read the instruction and then
  // "Ask an administrator to create one." immediately after — told to do a
  // thing, then told they may not. The CTA now carries the instruction, this
  // carries only the reason, and the unprivileged card simply ends on the ask.
  //
  // It also names no noun, so the clause can. The clause says "organization"
  // (one noun, no "org" abbreviation), and a frame that named it too produced
  // "Crea primero una organización — … pertenecen a una organización." in every
  // Romance locale — English had merely hidden the same repetition behind the
  // abbreviation. Clauses are therefore full, capitalised sentences minus the
  // stop; this supplies the stop and stays the one place a locale could add
  // punctuation or framing of its own.
  orgStateEmptyBody: '{{what}}.',
  orgStateEmptyAction: 'Create an organization',
  orgStateEmptyAskAdmin: 'Ask an administrator to create one.',
  // The INLINE variant renders title and body on one line, so it needs the
  // sentence break a card gets for free from two elements. Without it `csm` and
  // `marketplace` shipped the run-on "No organizations Create an organization
  // first…". Locale-owned rather than a `${title}. ${body}` in the component,
  // because sentence-joining punctuation is a translator's decision.
  orgStateInlineSentence: '{{title}}. {{body}}',
  orgStateRetry: 'Try again',
  // The ONE label for every organization picker (HG-4). Per-feature copies
  // drifted to "Workspace" and "Store" three lines from a card reading
  // "No organizations".
  orgPickerLabel: 'Organization',
  orgPickerGroupLabel: 'Organizations',
  orgPickerLoading: 'Loading organizations…',
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
  toastDismissAll: 'Dismiss all ({{count}})',
  toastRegionLabel: 'Notifications',
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
  tableNoFilterMatches: 'No rows match “{{query}}”.',
  tableFilterMatches_one: '{{n}} row matches.',
  tableFilterMatches_other: '{{n}} rows match.',
  tableSelectHeader: 'Select',
  tableSelectAll: 'Select all',
  tableDeselectAll: 'Deselect all',
  tableSelectRow: 'Select row',
  tableSortBy: 'Sort by {{column}}',
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
  colorSwatches: "Theme colors",
  colorAccent: "Accent",
  colorText: "Text",
  colorMuted: "Muted",
  colorSuccess: "Success",
  colorWarn: "Warning",
  colorDanger: "Danger",
  colorInfo: "Info",
  colorNone: "None",
  colorRecent: "Recent color {{value}}",
  colorHexPlaceholder: "#rrggbb or a CSS color",
  colorPickFromScreen: "Pick a color from the screen",

  cmdkLocked: 'Locked — unlock in the feature store',

  // FORM-UX-2 (ADR 0584) — the IN-APP unsaved-changes guard, for pages that
  // render their own exits (where `beforeunload` never fires).
  unsavedLeaveTitle: 'Leave without saving?',
  unsavedLeaveBody: 'Your unsaved changes on this page will be discarded. Save first to keep them.',
  unsavedLeaveConfirm: 'Discard changes',
} as const;
