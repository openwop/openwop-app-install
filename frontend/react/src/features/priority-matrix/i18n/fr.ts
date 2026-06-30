/**
 * `priority-matrix` namespace — user-facing copy for the priority-matrix feature.
 * Feature-self-contained: every priority-matrix string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Espace de travail',
  title: 'Matrice de priorités',
  lede: 'Notez les idées selon des critères pondérés, classez-les et transformez les meilleures en ordre du jour de réunion.',
  newList: 'Nouvelle liste',

  // Status columns (board statuses)
  statusNew: 'Nouveau',
  statusUnderReview: 'En cours d\'examen',
  statusInProcess: 'En cours',
  statusBlocked: 'Bloqué',
  statusDeferred: 'Reporté',
  statusWontDo: 'Non retenu',
  statusDone: 'Terminé',

  // Scoring model labels
  modelWeighted: 'Pondéré',
  modelWsjf: 'WSJF',
  modelRice: 'RICE',
  modelIce: 'ICE',
  modelValueEffort: 'Valeur vs Effort',
  modelCustom: 'Personnalisé',

  // Agenda sort labels
  agendaSortPriority: 'Priorité',
  agendaSortCreated: 'Date de soumission',
  agendaSortOwner: 'Responsable',
  agendaSortStatus: 'Statut',
  agendaSortTitle: 'Titre',

  // Generic fallbacks
  emDash: '—',
  unknown: 'Inconnu',

  // Create-list modal
  createModalLabel: 'Créer une liste de priorités',
  createModalHeading: 'Nouvelle liste de priorités',

  // Loading / empty states (lists)
  loadingLists: 'Chargement des listes…',
  noListsTitle: 'Aucune liste de priorités pour le moment',
  noListsBody: 'Une liste recueille des idées, les note selon des critères pondérés et les classe. Créez-en une pour commencer.',
  createFirstList: 'Créez votre première liste',

  // Tabs
  tablistLabel: 'Listes de priorités',
  tabPortfolio: 'Portefeuille',
  tabProjectSuffix: ' · projet',

  // Errors (toasts / notices)
  loadListsFailed: 'Échec du chargement des listes de priorités.',
  loadPortfolioFailed: 'Échec du chargement du portefeuille.',
  loadIdeasFailed: 'Échec du chargement des idées.',
  addPeerFailed: 'Échec de l\'ajout du pair (superadministrateur uniquement).',
  removePeerFailed: 'Échec de la suppression du pair.',
  setCredentialFailed: 'Échec de l\'enregistrement de l\'identifiant.',
  createListFailed: 'Échec de la création de la liste.',
  setVoterWeightFailed: 'Échec de la définition du poids du votant (autorité de propriétaire/administrateur requise).',
  submitIdeaFailed: 'Échec de la soumission de l\'idée.',
  saveScoreFailed: 'Échec de l\'enregistrement du score.',
  changeStatusFailed: 'Échec du changement de statut.',
  deleteListFailed: 'Échec de la suppression de la liste.',
  buildAgendaFailed: 'Échec de la création de l\'ordre du jour (accès en écriture à l\'espace de travail requis).',
  reorderAgendaFailed: 'Échec de la réorganisation de l\'ordre du jour.',
  saveWeightsFailed: 'Échec de l\'enregistrement des poids (autorité de propriétaire/administrateur requise).',

  // Portfolio section
  portfolioHeading: 'Portefeuille',
  portfolioSummaryFederated: 'principales priorités sur cet espace de travail + les pairs fédérés',
  portfolioSummaryLocal_one: 'principales priorités sur {{formattedCount}} liste',
  portfolioSummaryLocal_other: 'principales priorités sur {{formattedCount}} listes',
  includePeers: 'Inclure les pairs',
  compareLabel: 'Comparer',
  compareRaw: 'Priorité brute',
  compareListRelative: 'Relatif à la liste (0–100)',
  comparePercentile: 'Centile',
  topN: 'Top N',
  portfolioBlurbFederated: 'Classé par priorité brute sur cet espace de travail et chaque pair fédéré. Les priorités inter-hôtes ne sont pas strictement comparables — chaque ligne indique sa source.',
  portfolioBlurbRaw: 'Classé par priorité brute. Les priorités ne sont pas strictement comparables entre des listes ayant des critères ou des modèles de notation différents — chaque ligne indique sa liste source, son rang dans la liste et son modèle.',
  portfolioBlurbListRelative: 'Classé selon la priorité de chaque idée par rapport au sommet de sa propre liste (0–100) — une aide à la comparabilité, et non une vérité absolue inter-listes.',
  portfolioBlurbPercentile: 'Classé selon le centile de chaque idée au sein de sa propre liste (sommet = 100). Utile lorsque les listes diffèrent en taille ; reste relatif, et non absolu.',
  peerChip: '{{label}} : {{value}}',
  peerError: 'erreur',
  loadingPortfolio: 'Chargement du portefeuille…',

  // Portfolio table
  colRank: '#',
  colIdea: 'Idée',
  colStrategy: 'Stratégie',
  colSource: 'Source',
  sourceLocal: 'local',
  colList: 'Liste',
  listCell: '#{{rank}} · {{model}}',
  colStatus: 'Statut',
  colPriority: 'Priorité',
  colPercentile: 'Centile',
  colNormalized: 'Normalisé',
  captionPortfolio: 'Portefeuille',
  noScoredIdeasTitle: 'Aucune idée notée pour le moment',
  noScoredIdeasBody: 'Notez des idées dans vos listes pour les voir classées ici.',

  // Federated peers admin
  federatedPeers: 'Pairs fédérés ({{n}})',
  peerLabel: 'Libellé du pair',
  peerLabelPlaceholder: 'Acme Est',
  baseUrl: 'URL de base',
  baseUrlPlaceholder: 'https://east.acme.example',
  addPeer: 'Ajouter un pair',
  removePeerLabel: 'Supprimer {{label}}',

  // Peer credential form
  bearerToken: 'Jeton bearer',
  bearerTokenPlaceholder: 'collez le bearer du pair',
  scope: 'Portée',
  scopeUser: 'Personnel',
  scopeTenant: 'Partagé sur l\'espace de travail (administrateur)',
  saved: 'enregistré',

  // Create-list form
  listName: 'Nom de la liste',
  listNamePlaceholder: 'Initiatives stratégiques',
  workspace: 'Espace de travail',
  projectOptional: 'Projet (facultatif)',
  workspaceWide: 'À l\'échelle de l\'espace de travail',
  scoringModel: 'Modèle de notation',
  scoringModelWeighted: 'Notation pondérée',
  scoringModelWsjf: 'WSJF (SAFe)',
  scoringModelRice: 'RICE',
  scoringModelIce: 'ICE',
  scoringModelValueEffort: 'Valeur vs Effort',
  scoringMode: 'Mode de notation',
  scoringModeSingle: 'Score partagé unique',
  scoringModeMulti: 'Multivotant (chaque membre vote)',
  createList: 'Créer la liste',

  // List detail — delete confirm
  editList: 'Modifier la liste',
  updateListFailed: 'Échec de la mise à jour de la liste.',
  confirmDeleteTitle: 'Supprimer {{name}} ?',
  confirmDeleteBody: 'Cela supprime définitivement la liste, ses idées et leurs classements. Cette action est irréversible.',

  // Vote breakdown modal
  voteBreakdownLabel: 'Détail des votes — {{title}}',
  voteBreakdownHeading: 'Votes — {{title}}',
  voteBreakdownRestricted: 'Le détail par votant n\'est visible que par le propriétaire de la liste ou un administrateur de l\'organisation.',
  noVotesYet: 'Aucun vote pour le moment.',
  weightExplainer: 'Pondérez le vote d\'une partie prenante de 1 à 10 (1 par défaut). Les votes à pondération plus élevée comptent proportionnellement davantage dans l\'agrégat (ADR 0059).',
  criterionScore: '{{name}} {{score}}',
  weight: 'Poids',
  weightForLabel: 'Poids pour {{name}}',

  // List header
  priorityListEyebrow: 'Liste de priorités',
  chipMultiVoter: 'multivotant · {{aggregation}}',
  chipSingleScore: 'score unique',
  ideaCount_one: '{{formattedCount}} idée',
  ideaCount_other: '{{formattedCount}} idées',
  criteria: 'Critères',
  deleteList: 'Supprimer la liste',

  // Ranked ideas section
  rankedIdeas: 'Idées classées',
  rankedIdeasHint: 'cliquez sur une colonne pour trier · sélectionnez des lignes pour créer un ordre du jour',
  loadingIdeas: 'Chargement des idées…',
  captionRankedIdeas: 'Idées classées',
  viewToggleAria: 'Vue des idées',
  viewMatrix: 'Matrice',
  viewGrid: 'Grille',
  viewList: 'Liste',
  matrixUnavailable: 'Ce modèle de notation n\'a pas d\'axe d\'effort — ajoutez un critère de coût',
  quadQuickWins: 'Gains rapides',
  quadBigBets: 'Gros paris',
  quadFillIns: 'Bouche-trous',
  quadReconsider: 'À reconsidérer',
  quadEmpty: 'Rien ici',
  matrixLegend: 'Colonnes : effort (faible → élevé). Lignes : impact (élevé → faible). Les gains rapides sont à fort impact et faible effort.',
  matrixUnscored_one: '{{formattedCount}} idée non notée',
  matrixUnscored_other: '{{formattedCount}} idées non notées',
  matrixUnscoredHint: 'Notez-les dans la vue Liste pour les placer sur la matrice.',
  colPriorityAgg: 'Priorité (agg)',
  colOwner: 'Responsable',
  colCreated: 'Créé le',
  colVotes: 'Votes',
  votesChip_one: '{{formattedCount}} vote',
  votesChip_other: '{{formattedCount}} votes',
  strategyAlignedCount_one: '{{formattedCount}} stratégie',
  strategyAlignedCount_other: '{{formattedCount}} stratégies',
  scoreInputLabel: '{{title}} — score {{criterion}}',
  voteBreakdownButtonLabel: 'Détail des votes pour {{title}}',
  statusSelectLabel: '{{title}} — statut',
  addToAgendaBulk: 'Ajouter {{n}} à l\'ordre du jour de la réunion',
  noIdeasTitle: 'Aucune idée pour le moment',
  noIdeasBody: 'Ajoutez-en une ci-dessus, puis notez-la selon chaque critère pour la classer.',

  // Idea form
  ideaTitleLabel: 'Nouvelle idée / demande',
  ideaTitlePlaceholder: 'Migrer la facturation vers le nouveau grand livre',
  ideaContextLabel: 'Contexte (facultatif)',
  ideaContextPlaceholder: 'Contexte, périmètre, liens — tout ce que les évaluateurs doivent savoir',
  addIdea: 'Ajouter une idée',

  // Criteria modal
  criteriaModalLabel: 'Modifier les critères de notation',
  criteriaWeights: 'Poids des critères',
  criteriaModalBlurb: '{{preset}} · {{aggregation}}. Un poids plus élevé fait compter davantage un critère dans le classement.',
  criteriaPresetCustom: 'personnalisé',
  criterionCostLabel: '{{name}} (coût)',
  criterionLabel: '{{name}}',
  weightValue: '{{value}}/10',
  saveWeights: 'Enregistrer les poids',

  // Agenda panel
  meetingAgenda: 'Ordre du jour de la réunion',
  orBuildFromTop: 'ou créez-le à partir du sommet',
  buildTopN: 'Créer le top {{n}}',
  agendaEyebrow: 'Ordre du jour',
  orderBy: 'Trier par',
  captionMeetingAgenda: 'Ordre du jour de la réunion',
  agendaDocument: 'Document de l\'ordre du jour',
  agendaEmpty: 'Sélectionnez des idées ci-dessus et choisissez <0>Ajouter à l\'ordre du jour</0>, ou créez-en un à partir des idées les mieux classées. L\'ordre du jour est triable — par priorité, responsable, statut ou date.',
  previousSessions: 'Sessions précédentes',
  savedAsDocument: '· enregistré comme document',
  indexedForAgentsTitle: 'Indexé pour les agents — partagé avec les agents et les conseils',

  // État du calendrier (ADR 0103)
  colSchedule: 'Calendrier',
  scheduleOnTrack: 'Dans les temps',
  scheduleAtRisk: 'À risque',
  scheduleBehind: 'En retard',
  scheduleDoneEarly: 'Fait en avance',
  scheduleDoneLate: 'Fait en retard',
  scheduleUnscheduled: 'Sans date',
  scheduleDueIn: 'dans {{n}}j',
  scheduleOverdueBy: '{{n}}j de retard',
  setTargetDateAria: 'Définir la date cible pour {{title}}',
  clearScheduleAria: 'Effacer la date cible de {{title}}',
  scheduleRollupSummary: '{{onTrack}} dans les temps · {{atRisk}} à risque · {{behind}} en retard',
  scheduleNoTargets: 'Aucune date cible pour l’instant — définissez-en une sur une idée pour suivre l’avance ou le retard.',
  saveScheduleFailed: 'Impossible d’enregistrer la date cible.',
} as const;
