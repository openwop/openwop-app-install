/**
 * `kanban` namespace — user-facing strings for the top-level Kanban area
 * (`src/kanban/`). FLAT camelCase keys, one per line (ADR 0065). Plural keys use
 * i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // AssignedColumn — the "Assigned to me" rail
  assignedToMe: 'Assigned to me',
  unclaimedWithRole: 'Unclaimed · {{role}}',
  priorityHigh: 'HIGH',
  claiming: 'Claiming…',
  claim: 'Claim',
  openOnBoard: 'Open on {{board}}',
  boardArrow: '{{board}} →',

  // AssigneeControl — assign a card to a workspace member
  unassigned: 'Unassigned',
  assignCardTitle: 'Assign this card to someone',
  assignTo: 'Assign to',
  closeAssigneePicker: 'Close assignee picker',

  // CreateBoardModal — "Create a board"
  createBoardLabel: 'Create a board',
  newBoardEyebrow: 'New board',
  createBoardTitle: 'Create a board',
  createBoardLedeBefore: 'A board tracks work through To do → Done. Optionally connect a workflow that fires when cards hit the',
  createBoardLedeAfter: 'trigger column.',
  boardNameLabel: 'Board name',
  boardNamePlaceholder: 'e.g. Q3 onboarding',
  triggerWorkflowLabel: 'Trigger workflow',
  optionalSuffix: '· optional',
  noWorkflowOption: 'No workflow — manual board',
  owningAgentLabel: 'Owning agent',
  noOwnerOption: 'No owner — shared board',
  createBoardButton: '+ Create board',

  // KanbanBoardView — shared board renderer
  priorityLow: 'LOW',
  dueDate: 'due {{date}}',
  whyAssigned: 'Why assigned: {{reason}}',
  blocked: 'Blocked: {{note}}',
  dragCardToLane: 'Drag {{title}} to another lane',
  deleteCard: 'Delete {{title}}',
  viewRunTitle: 'View the triggered run',
  viewRun: 'View run',
  // Lane-contextual actions
  startWork: 'Start work',
  markDone: 'Mark done',
  resolve: 'Resolve',
  reopen: 'Reopen',
  // Add-card form
  taskTitlePlaceholder: 'Task title…',
  taskDescriptionPlaceholder: 'Description (optional) — Markdown supported',
  taskDescriptionAria: 'Task description',
  taskSourceAria: 'Task source',
  workflowAria: 'Workflow',
  noWorkflowOptionShort: 'No workflow',
  priorityAria: 'Priority',
  priorityLowOption: 'Low',
  priorityNormalOption: 'Normal',
  priorityHighOption: 'High',
  dueDateAria: 'Due date',
  whyAssignedPlaceholder: 'Why assigned (optional)',
  whyAssignedAria: 'Why assigned',
  blockerPlaceholder: 'Blocker, if any (optional)',
  blockerAria: 'Blocker note',
  addCardButton: 'Add',
  addCard: '+ Add card',
  // Card sources
  sourceHuman: 'From a human',
  sourceDiscord: 'Simulated Discord',
  sourceAgent: 'From another agent',
  sourceApi: 'From an API',

  // KanbanPage — /boards route
  boardsEyebrow: 'Boards',
  boardsTitle: 'Boards',
  boardsLedePre: 'The same task boards your agents work from. Drag a card into the ',
  boardsLedeTrigger: 'To do',
  boardsLedePost: ' column to fire its workflow.',
  boardActions: 'Board actions',
  renameBoard: 'Rename board',
  duplicate: 'Duplicate',
  deleteBoard: 'Delete board',
  newBoard: '+ New board',
  waitingOnYou: '{{count}} waiting on you',
  triggers: 'Triggers:',
  loadingBoards: 'Loading boards…',
  noBoardsYet: 'No boards yet',
  noBoardsBody: 'Create a board to start tracking work — connect a workflow and it fires when cards hit the trigger column.',
  duplicatedNotice: 'Duplicated "{{name}}" — now viewing the copy.',
  renamePrompt: 'Rename board',
  renamedNotice: 'Renamed to "{{name}}".',
  deleteBoardConfirm: 'Delete the board "{{name}}"? This removes the board and all its cards and can\'t be undone.',
  deleteCardConfirm: 'Delete the card “{{title}}”? This can\'t be undone.',
  deleteCardConfirmNoTitle: 'Delete the card? This can\'t be undone.',
  startedRunNotice: 'Started a run from "{{title}}" — it landed in a trigger lane.',
} as const;
