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
  conveneHint: 'To convene a board, open the AI chat and type its <1>@@handle</1> (e.g. <3>@@timeless what should we prioritize?</3>). Every advisor joins the chat’s Active agents and the council weighs in there.',

  // Board list
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
  planningContextHint: 'Give advisors your strategies and projects as planning context — their objectives, status, and milestones. For deep document search, use the “Shared knowledge” toggles on a board card.',
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
  visibilityPrivate: 'Private (only me)',
  visibilityShared: 'Shared (workspace)',
  personaKindLabel: 'Persona kind',
  advisorsLabel: 'Advisors',
  livingPersonaAck: 'I acknowledge these are simulated personas of living individuals for ideation only — not the real people, and not endorsed by them.',
  createBoard: 'Create board',
  editBoard: 'Edit board',
  saveChanges: 'Save changes',
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
  sharedKnowledgeLabel: 'Shared knowledge:',
  sharedKnowledgeOnTitle: 'All advisors can retrieve {{kind}} — click to stop sharing',
  sharedKnowledgeOffTitle: 'Give all advisors access to {{kind}}',
  sharedKnowledgeEmptyTitle: 'No {{kind}} to share yet — add knowledge to a project to share it with this board',
  sharedKind_strategy: 'Strategy KB',
  'sharedKind_priority-matrix': 'Priority Matrix KB',
  sharedKind_project: 'Project KBs',
} as const;
