/**
 * `advisory-board` namespace — user-facing copy for the Board of Advisors feature
 * (ADR 0040). Feature-self-contained: every advisory-board string lives here.
 * Generic actions/states are reused from the `common` namespace via `t('common:…')`
 * and are NOT duplicated.
 */
export const messages = {
  // Gating
  notEnabledTitle: 'Board of Advisors is not enabled',
  notEnabledBody: 'Turn on the Board of Advisors feature for this workspace to assemble councils of advisor agents.',

  // Page chrome
  eyebrow: 'Agents',
  title: 'Board of Advisors',
  lede: 'Assemble a council of advisor agents — then convene it in the AI chat by typing its @@handle.',

  // Convene hint (rich)
  boardsEmptyTitle: 'No boards yet',
  boardsEmptyBody: 'Assemble your first council of advisor agents to get started.',

  // Collection-view filterbar (§4.5 rule 11)
  filterGroup: 'Filter boards',
  filterPlaceholder: 'Filter boards…',
  filterAria: 'Filter boards by name or handle',
  noMatchTitle: 'No matching boards',
  noMatchBody: 'No board matches your search. Try a different term.',
  clearSearch: 'Clear search',
  advisorsCount_one: '{{count}} advisor',
  advisorsCount_other: '{{count}} advisors',
  strategyContextCount_one: '{{count}} strategy',
  strategyContextCount_other: '{{count}} strategies',
  deleteBoardLabel: 'Delete {{name}}',
  confirmDeleteTitle: 'Delete {{name}}?',
  confirmDeleteBody: 'This deletes the board and frees its @@handle. The advisor agents themselves stay in your roster — only this grouping is removed. This can’t be undone.',

  // Strategy context picker (ADR 0076 Phase 5)
  strategyContextLabel: 'Strategy context',
  planningContextLabel: 'Planning context',
  planningContextHint: 'Give advisors your strategies and projects as planning context — a snapshot of objectives, status, and milestones taken when the board chat opens or is summoned. For live document search on every turn, use the “Shared knowledge” section when editing a board.',
  projectContextLabel: 'Project context',
  projectContextCount_one: '{{count}} project',
  projectContextCount_other: '{{count}} projects',

  // Create form — no roster
  noAdvisorsTitle: 'No advisor agents yet',
  noAdvisorsBody: 'Add agents to your roster first — advisors are roster agents with their own persona and knowledge.',

  // Create form
  newBoard: 'New board',
  boardNameLabel: 'Board name',
  boardNamePlaceholder: 'Founders board',
  organizationLabel: 'Organization',
  visibilityLabel: 'Visibility',
  // ADR 0665 D3 — was "Private (only me)", which the access rule does not deliver:
  // `resolveBoardAccess` grants an org `workspace:write` holder authority over the
  // board SUBJECT regardless of visibility — the documented cross-feature
  // "visibility is not authority" rule (ADR 0054 D5), which projects implement
  // identically. The rule is unchanged; the promise now matches it, in the wording
  // `features/projects/i18n` already ships for the same rule.
  visibilityPrivate: 'Private',
  visibilityPrivateHelp: 'Only you and workspace writers can see this board — its advisors and its boardroom transcript.',
  visibilityShared: 'Shared (workspace)',
  personaKindLabel: 'Persona kind',
  advisorsLabel: 'Advisors',
  livingPersonaAck: 'I acknowledge these are simulated personas of living individuals for ideation only — not the real people, and not endorsed by them.',
  createBoard: 'Create board',
  editBoard: 'Edit board',
  saveChanges: 'Save changes',
  openingChatAction: 'Opening…',
  openChatAction: 'Open chat',
  openBoardChatLabel: 'Open the {{name}} board chat',
  openChatError: 'Could not open the board chat.',
  editAction: 'Edit',
  cloneAction: 'Clone',
  editBoardLabel: 'Edit {{name}}',
  cloneBoardLabel: 'Clone {{name}}',
  cloneNameSuffix: '{{name}} (copy)',

  // Persona kinds
  personaHistorical: 'Historical / public-domain figures',
  personaFictional: 'Fictional characters',
  personaOriginal: 'Original personas',
  personaLiving: 'Living individuals (requires acknowledgement)',
  sharedKnowledgeLabel: 'Shared knowledge',
  sharedKnowledgeHint: 'Give every advisor on this board retrieval access to these knowledge bases — searched live on each turn, so answers track the latest content.',
  sharedKnowledgeLoadFailed: 'Couldn\'t load shared-knowledge settings. Reopen the board to try again.',
  sharedKnowledgeOnTitle: 'All advisors can retrieve {{kind}} — click to stop sharing',
  sharedKnowledgeOffTitle: 'Give all advisors access to {{kind}}',
  sharedKnowledgeEmptyTitle: 'No {{kind}} to share yet — add knowledge to a project to share it with this board',
  sharedKind_strategy: 'Strategy KB',
  'sharedKind_priority-matrix': 'Priority Matrix KB',
  sharedKind_project: 'Project KBs',
  'sharedKind_team-portfolio': 'Team Portfolio KB',
  contextLoadFailed: "Strategies and projects could not be loaded, so no planning context can be attached to this board right now. Any context already saved on it is left untouched.",
  dialogErrorAnnounce: "That didn’t save. The reason is shown in the dialog.",
  deleteErrorAnnounce: "That didn’t delete. The reason is shown in the dialog.",
  moderatorLabel: "Chair (synthesizes)",
  moderatorHint: "The chair sums up at the end. Leave unset and the first advisor to speak also writes the recommendation — a disputant judging the dispute.",
  moderatorNone: "No chair — the first advisor synthesizes",
  moderatorOutOfCohort: "{{persona}} — chairing, not in this cohort",
  boardContextStaleBody: "We couldn’t refresh this boardroom’s saved record of the plans it was given, so that record is out of date. Your advisors are still grounded in the plans you can read, checked fresh on every turn.",
  boardContextStaleOpen: "Open the boardroom anyway",
} as const;
