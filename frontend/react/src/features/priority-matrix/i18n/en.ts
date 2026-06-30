/**
 * `priority-matrix` namespace — user-facing copy for the priority-matrix feature.
 * Feature-self-contained: every priority-matrix string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Workspace',
  title: 'Priority Matrix',
  lede: 'Score ideas against weighted criteria, rank them, and turn the top picks into a meeting agenda.',
  newList: 'New list',

  // Status columns (board statuses)
  statusNew: 'New',
  statusUnderReview: 'Under Review',
  statusInProcess: 'In Process',
  statusBlocked: 'Blocked',
  statusDeferred: 'Deferred',
  statusWontDo: "Won't Do",
  statusDone: 'Done',

  // Scoring model labels
  modelWeighted: 'Weighted',
  modelWsjf: 'WSJF',
  modelRice: 'RICE',
  modelIce: 'ICE',
  modelValueEffort: 'Value vs Effort',
  modelCustom: 'Custom',

  // Agenda sort labels
  agendaSortPriority: 'Priority',
  agendaSortCreated: 'Date submitted',
  agendaSortOwner: 'Owner',
  agendaSortStatus: 'Status',
  agendaSortTitle: 'Title',

  // Generic fallbacks
  emDash: '—',
  unknown: 'Unknown',

  // Create-list modal
  createModalLabel: 'Create a priority list',
  createModalHeading: 'New priority list',

  // Loading / empty states (lists)
  loadingLists: 'Loading lists…',
  noListsTitle: 'No priority lists yet',
  noListsBody: 'A list captures ideas, scores them against weighted criteria, and ranks them. Create one to start.',
  createFirstList: 'Create your first list',

  // Tabs
  tablistLabel: 'Priority lists',
  tabPortfolio: 'Portfolio',
  tabProjectSuffix: ' · project',

  // Errors (toasts / notices)
  loadListsFailed: 'Failed to load priority lists.',
  loadPortfolioFailed: 'Failed to load the portfolio.',
  loadIdeasFailed: 'Failed to load ideas.',
  addPeerFailed: 'Failed to add the peer (superadmin only).',
  removePeerFailed: 'Failed to remove the peer.',
  setCredentialFailed: 'Failed to set the credential.',
  createListFailed: 'Failed to create the list.',
  setVoterWeightFailed: 'Failed to set voter weight (need owner/admin authority).',
  submitIdeaFailed: 'Failed to submit the idea.',
  saveScoreFailed: 'Failed to save the score.',
  changeStatusFailed: 'Failed to change status.',
  deleteListFailed: 'Failed to delete the list.',
  buildAgendaFailed: 'Failed to build the agenda (need workspace write).',
  reorderAgendaFailed: 'Failed to re-order the agenda.',
  saveWeightsFailed: 'Failed to save weights (need owner/admin authority).',

  // Portfolio section
  portfolioHeading: 'Portfolio',
  portfolioSummaryFederated: 'top priorities across this workspace + federated peers',
  portfolioSummaryLocal_one: 'top priorities across {{formattedCount}} list',
  portfolioSummaryLocal_other: 'top priorities across {{formattedCount}} lists',
  includePeers: 'Include peers',
  compareLabel: 'Compare',
  compareRaw: 'Raw priority',
  compareListRelative: 'List-relative (0–100)',
  comparePercentile: 'Percentile',
  topN: 'Top N',
  portfolioBlurbFederated: 'Ranked by raw priority across this workspace and each federated peer. Cross-host priorities are not strictly comparable — each row shows its source.',
  portfolioBlurbRaw: 'Ranked by raw priority. Priorities are not strictly comparable across lists with different criteria or scoring models — each row shows its source list, in-list rank, and model.',
  portfolioBlurbListRelative: 'Ranked by each idea’s priority relative to the top of its own list (0–100) — a comparability aid, not an absolute cross-list truth.',
  portfolioBlurbPercentile: 'Ranked by each idea’s percentile within its own list (top = 100). Useful when lists differ in size; still relative, not absolute.',
  peerChip: '{{label}}: {{value}}',
  peerError: 'error',
  loadingPortfolio: 'Loading portfolio…',

  // Portfolio table
  colRank: '#',
  colIdea: 'Idea',
  colStrategy: 'Strategy',
  colSource: 'Source',
  sourceLocal: 'local',
  colList: 'List',
  listCell: '#{{rank}} · {{model}}',
  colStatus: 'Status',
  colPriority: 'Priority',
  colPercentile: 'Percentile',
  colNormalized: 'Normalized',
  captionPortfolio: 'Portfolio',
  noScoredIdeasTitle: 'No scored ideas yet',
  noScoredIdeasBody: 'Score ideas in your lists to see them ranked here.',

  // Federated peers admin
  federatedPeers: 'Federated peers ({{n}})',
  peerLabel: 'Peer label',
  peerLabelPlaceholder: 'Acme East',
  baseUrl: 'Base URL',
  baseUrlPlaceholder: 'https://east.acme.example',
  addPeer: 'Add peer',
  removePeerLabel: 'Remove {{label}}',

  // Peer credential form
  bearerToken: 'Bearer token',
  bearerTokenPlaceholder: 'paste peer bearer',
  scope: 'Scope',
  scopeUser: 'My own',
  scopeTenant: 'Workspace shared (admin)',
  saved: 'saved',

  // Create-list form
  listName: 'List name',
  listNamePlaceholder: 'Strategic Initiatives',
  workspace: 'Workspace',
  projectOptional: 'Project (optional)',
  workspaceWide: 'Workspace-wide',
  scoringModel: 'Scoring model',
  scoringModelWeighted: 'Weighted Scoring',
  scoringModelWsjf: 'WSJF (SAFe)',
  scoringModelRice: 'RICE',
  scoringModelIce: 'ICE',
  scoringModelValueEffort: 'Value vs Effort',
  scoringMode: 'Scoring mode',
  scoringModeSingle: 'Single shared score',
  scoringModeMulti: 'Multi-voter (each member votes)',
  createList: 'Create list',

  // List detail — delete confirm
  editList: 'Edit list',
  updateListFailed: 'Failed to update the list.',
  confirmDeleteTitle: 'Delete {{name}}?',
  confirmDeleteBody: 'This permanently deletes the list, its ideas, and their rankings. This can’t be undone.',

  // Vote breakdown modal
  voteBreakdownLabel: 'Vote breakdown — {{title}}',
  voteBreakdownHeading: 'Votes — {{title}}',
  voteBreakdownRestricted: 'The per-voter breakdown is visible to the list owner or an org admin only.',
  noVotesYet: 'No votes yet.',
  weightExplainer: 'Weight a stakeholder’s vote 1–10 (default 1). Higher-weighted votes count proportionally more in the aggregate (ADR 0059).',
  criterionScore: '{{name}} {{score}}',
  weight: 'Weight',
  weightForLabel: 'Weight for {{name}}',

  // List header
  priorityListEyebrow: 'Priority list',
  chipMultiVoter: 'multi-voter · {{aggregation}}',
  chipSingleScore: 'single score',
  ideaCount_one: '{{formattedCount}} idea',
  ideaCount_other: '{{formattedCount}} ideas',
  criteria: 'Criteria',
  deleteList: 'Delete list',

  // Ranked ideas section
  rankedIdeas: 'Ranked ideas',
  rankedIdeasHint: 'click a column to sort · select rows to build an agenda',
  loadingIdeas: 'Loading ideas…',
  captionRankedIdeas: 'Ranked ideas',
  // View toggle (Matrix / Grid / List)
  viewToggleAria: 'Idea view',
  viewMatrix: 'Matrix',
  viewGrid: 'Grid',
  viewList: 'List',
  matrixUnavailable: 'This scoring model has no effort axis — add a cost criterion',
  // 2×2 quadrant
  quadQuickWins: 'Quick wins',
  quadBigBets: 'Big bets',
  quadFillIns: 'Fill-ins',
  quadReconsider: 'Reconsider',
  quadEmpty: 'Nothing here',
  matrixLegend: 'Columns: effort (low → high). Rows: impact (high → low). Quick wins are high-impact, low-effort.',
  matrixUnscored_one: '{{formattedCount}} unscored idea',
  matrixUnscored_other: '{{formattedCount}} unscored ideas',
  matrixUnscoredHint: 'Score these in the List view to place them on the matrix.',
  colPriorityAgg: 'Priority (agg)',
  colOwner: 'Owner',
  colCreated: 'Created',
  colVotes: 'Votes',
  votesChip_one: '{{formattedCount}} vote',
  votesChip_other: '{{formattedCount}} votes',
  strategyAlignedCount_one: '{{formattedCount}} strategy',
  strategyAlignedCount_other: '{{formattedCount}} strategies',
  scoreInputLabel: '{{title}} — {{criterion}} score',
  voteBreakdownButtonLabel: 'Vote breakdown for {{title}}',
  statusSelectLabel: '{{title}} — status',
  addToAgendaBulk: 'Add {{n}} to meeting agenda',
  noIdeasTitle: 'No ideas yet',
  noIdeasBody: 'Add one above, then score it against each criterion to rank it.',

  // Idea form
  ideaTitleLabel: 'New idea / request',
  ideaTitlePlaceholder: 'Migrate billing to the new ledger',
  ideaContextLabel: 'Context (optional)',
  ideaContextPlaceholder: 'Background, scope, links — anything the scorers should know',
  addIdea: 'Add idea',

  // Criteria modal
  criteriaModalLabel: 'Edit scoring criteria',
  criteriaWeights: 'Criteria weights',
  criteriaModalBlurb: '{{preset}} · {{aggregation}}. A higher weight makes a criterion matter more in the ranking.',
  criteriaPresetCustom: 'custom',
  criterionCostLabel: '{{name}} (cost)',
  criterionLabel: '{{name}}',
  weightValue: '{{value}}/10',
  saveWeights: 'Save weights',

  // Agenda panel
  meetingAgenda: 'Meeting agenda',
  orBuildFromTop: 'or build from the top',
  buildTopN: 'Build top {{n}}',
  agendaEyebrow: 'Agenda',
  orderBy: 'Order by',
  captionMeetingAgenda: 'Meeting agenda',
  agendaDocument: 'Agenda document',
  agendaEmpty: 'Select ideas above and choose <0>Add to meeting agenda</0>, or build one from the top-ranked ideas. The agenda is sortable — by priority, owner, status, or date.',
  previousSessions: 'Previous sessions',
  savedAsDocument: '· saved as document',
  indexedForAgentsTitle: 'Indexed for agents — shared with agents and boards',

  // Schedule status (ADR 0103)
  colSchedule: 'Schedule',
  scheduleOnTrack: 'On track',
  scheduleAtRisk: 'At risk',
  scheduleBehind: 'Behind',
  scheduleDoneEarly: 'Done early',
  scheduleDoneLate: 'Done late',
  scheduleUnscheduled: 'No date',
  scheduleDueIn: 'in {{n}}d',
  scheduleOverdueBy: '{{n}}d over',
  setTargetDateAria: 'Set target date for {{title}}',
  clearScheduleAria: 'Clear target date for {{title}}',
  scheduleRollupSummary: '{{onTrack}} on track · {{atRisk}} at risk · {{behind}} behind',
  scheduleNoTargets: 'No target dates yet — set one on an idea to track whether it’s ahead or behind schedule.',
  saveScheduleFailed: 'Could not save the target date.',
} as const;
