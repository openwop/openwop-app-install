/**
 * `priority-matrix` namespace — user-facing copy for the priority-matrix feature.
 * Feature-self-contained: every priority-matrix string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Espaço de trabalho',
  title: 'Matriz de prioridades',
  lede: 'Pontue ideias em relação a critérios ponderados, classifique-as e transforme as principais escolhas em uma pauta de reunião.',
  newList: 'Nova lista',

  // Status columns (board statuses)
  statusNew: 'Nova',
  statusUnderReview: 'Em revisão',
  statusInProcess: 'Em andamento',
  statusBlocked: 'Bloqueada',
  statusDeferred: 'Adiada',
  statusWontDo: 'Não será feita',
  statusDone: 'Concluída',

  // Scoring model labels
  modelWeighted: 'Ponderado',
  modelWsjf: 'WSJF',
  modelRice: 'RICE',
  modelIce: 'ICE',
  modelValueEffort: 'Valor vs. Esforço',
  modelCustom: 'Personalizado',

  // Agenda sort labels
  agendaSortPriority: 'Prioridade',
  agendaSortCreated: 'Data de envio',
  agendaSortOwner: 'Responsável',
  agendaSortStatus: 'Status',
  agendaSortTitle: 'Título',

  // Generic fallbacks
  emDash: '—',
  unknown: 'Desconhecido',

  // Create-list modal
  createModalLabel: 'Criar uma lista de prioridades',
  createModalHeading: 'Nova lista de prioridades',

  // Loading / empty states (lists)
  loadingLists: 'Carregando listas…',
  noListsTitle: 'Nenhuma lista de prioridades ainda',
  noListsBody: 'Uma lista captura ideias, pontua-as em relação a critérios ponderados e as classifica. Crie uma para começar.',
  createFirstList: 'Crie sua primeira lista',

  // Tabs
  tablistLabel: 'Listas de prioridades',
  tabPortfolio: 'Portfólio',
  tabProjectSuffix: ' · projeto',

  // Errors (toasts / notices)
  loadListsFailed: 'Falha ao carregar as listas de prioridades.',
  loadPortfolioFailed: 'Falha ao carregar o portfólio.',
  loadIdeasFailed: 'Falha ao carregar as ideias.',
  addPeerFailed: 'Falha ao adicionar o par (somente superadmin).',
  removePeerFailed: 'Falha ao remover o par.',
  setCredentialFailed: 'Falha ao definir a credencial.',
  createListFailed: 'Falha ao criar a lista.',
  setVoterWeightFailed: 'Falha ao definir o peso do votante (é necessária autoridade de proprietário/admin).',
  submitIdeaFailed: 'Falha ao enviar a ideia.',
  saveScoreFailed: 'Falha ao salvar a pontuação.',
  changeStatusFailed: 'Falha ao alterar o status.',
  deleteListFailed: 'Falha ao excluir a lista.',
  buildAgendaFailed: 'Falha ao montar a pauta (é necessária permissão de escrita no espaço de trabalho).',
  reorderAgendaFailed: 'Falha ao reordenar a pauta.',
  saveWeightsFailed: 'Falha ao salvar os pesos (é necessária autoridade de proprietário/admin).',

  // Portfolio section
  portfolioHeading: 'Portfólio',
  portfolioSummaryFederated: 'principais prioridades neste espaço de trabalho + pares federados',
  portfolioSummaryLocal_one: 'principais prioridades em {{formattedCount}} lista',
  portfolioSummaryLocal_other: 'principais prioridades em {{formattedCount}} listas',
  includePeers: 'Incluir pares',
  compareLabel: 'Comparar',
  compareRaw: 'Prioridade bruta',
  compareListRelative: 'Relativa à lista (0–100)',
  comparePercentile: 'Percentil',
  topN: 'Top N',
  portfolioBlurbFederated: 'Classificadas por prioridade bruta neste espaço de trabalho e em cada par federado. Prioridades entre hosts não são estritamente comparáveis — cada linha mostra sua origem.',
  portfolioBlurbRaw: 'Classificadas por prioridade bruta. As prioridades não são estritamente comparáveis entre listas com critérios ou modelos de pontuação diferentes — cada linha mostra sua lista de origem, a posição na lista e o modelo.',
  portfolioBlurbListRelative: 'Classificadas pela prioridade de cada ideia em relação ao topo de sua própria lista (0–100) — um auxílio de comparabilidade, não uma verdade absoluta entre listas.',
  portfolioBlurbPercentile: 'Classificadas pelo percentil de cada ideia dentro de sua própria lista (topo = 100). Útil quando as listas diferem em tamanho; ainda relativo, não absoluto.',
  peerChip: '{{label}}: {{value}}',
  peerError: 'erro',
  loadingPortfolio: 'Carregando portfólio…',

  // Portfolio table
  colRank: '#',
  colIdea: 'Ideia',
  colStrategy: 'Estratégia',
  colSource: 'Origem',
  sourceLocal: 'local',
  colList: 'Lista',
  listCell: '#{{rank}} · {{model}}',
  colStatus: 'Status',
  colPriority: 'Prioridade',
  colPercentile: 'Percentil',
  colNormalized: 'Normalizada',
  captionPortfolio: 'Portfólio',
  noScoredIdeasTitle: 'Nenhuma ideia pontuada ainda',
  noScoredIdeasBody: 'Pontue ideias nas suas listas para vê-las classificadas aqui.',

  // Federated peers admin
  federatedPeers: 'Pares federados ({{n}})',
  peerLabel: 'Rótulo do par',
  peerLabelPlaceholder: 'Acme Leste',
  baseUrl: 'URL base',
  baseUrlPlaceholder: 'https://east.acme.example',
  addPeer: 'Adicionar par',
  removePeerLabel: 'Remover {{label}}',

  // Peer credential form
  bearerToken: 'Token bearer',
  bearerTokenPlaceholder: 'cole o bearer do par',
  scope: 'Escopo',
  scopeUser: 'Apenas meu',
  scopeTenant: 'Compartilhado no espaço de trabalho (admin)',
  saved: 'salvo',

  // Create-list form
  listName: 'Nome da lista',
  listNamePlaceholder: 'Iniciativas estratégicas',
  workspace: 'Espaço de trabalho',
  projectOptional: 'Projeto (opcional)',
  workspaceWide: 'Todo o espaço de trabalho',
  scoringModel: 'Modelo de pontuação',
  scoringModelWeighted: 'Pontuação ponderada',
  scoringModelWsjf: 'WSJF (SAFe)',
  scoringModelRice: 'RICE',
  scoringModelIce: 'ICE',
  scoringModelValueEffort: 'Valor vs. Esforço',
  scoringMode: 'Modo de pontuação',
  scoringModeSingle: 'Pontuação única compartilhada',
  scoringModeMulti: 'Múltiplos votantes (cada membro vota)',
  createList: 'Criar lista',

  // List detail — delete confirm
  editList: 'Editar lista',
  updateListFailed: 'Falha ao atualizar a lista.',
  confirmDeleteTitle: 'Excluir {{name}}?',
  confirmDeleteBody: 'Isto exclui permanentemente a lista, suas ideias e suas classificações. Esta ação não pode ser desfeita.',

  // Vote breakdown modal
  voteBreakdownLabel: 'Detalhamento de votos — {{title}}',
  voteBreakdownHeading: 'Votos — {{title}}',
  voteBreakdownRestricted: 'O detalhamento por votante é visível apenas para o proprietário da lista ou um admin da organização.',
  noVotesYet: 'Nenhum voto ainda.',
  weightExplainer: 'Pondere o voto de um stakeholder de 1 a 10 (padrão 1). Votos com peso maior contam proporcionalmente mais no agregado (ADR 0059).',
  criterionScore: '{{name}} {{score}}',
  weight: 'Peso',
  weightForLabel: 'Peso para {{name}}',

  // List header
  priorityListEyebrow: 'Lista de prioridades',
  chipMultiVoter: 'múltiplos votantes · {{aggregation}}',
  chipSingleScore: 'pontuação única',
  ideaCount_one: '{{formattedCount}} ideia',
  ideaCount_other: '{{formattedCount}} ideias',
  criteria: 'Critérios',
  deleteList: 'Excluir lista',

  // Ranked ideas section
  rankedIdeas: 'Ideias classificadas',
  rankedIdeasHint: 'clique em uma coluna para ordenar · selecione linhas para montar uma pauta',
  loadingIdeas: 'Carregando ideias…',
  captionRankedIdeas: 'Ideias classificadas',
  viewToggleAria: 'Visualização de ideias',
  viewMatrix: 'Matriz',
  viewGrid: 'Grade',
  viewList: 'Lista',
  matrixUnavailable: 'Este modelo de pontuação não tem eixo de esforço — adicione um critério de custo',
  quadQuickWins: 'Ganhos rápidos',
  quadBigBets: 'Grandes apostas',
  quadFillIns: 'Preenchimentos',
  quadReconsider: 'Reconsiderar',
  quadEmpty: 'Nada aqui',
  matrixLegend: 'Colunas: esforço (baixo → alto). Linhas: impacto (alto → baixo). Ganhos rápidos têm alto impacto e baixo esforço.',
  matrixUnscored_one: '{{formattedCount}} ideia sem pontuação',
  matrixUnscored_other: '{{formattedCount}} ideias sem pontuação',
  matrixUnscoredHint: 'Pontue-as na visualização Lista para posicioná-las na matriz.',
  colPriorityAgg: 'Prioridade (agg)',
  colOwner: 'Responsável',
  colCreated: 'Criada',
  colVotes: 'Votos',
  votesChip_one: '{{formattedCount}} voto',
  votesChip_other: '{{formattedCount}} votos',
  strategyAlignedCount_one: '{{formattedCount}} estratégia',
  strategyAlignedCount_other: '{{formattedCount}} estratégias',
  scoreInputLabel: '{{title}} — pontuação de {{criterion}}',
  voteBreakdownButtonLabel: 'Detalhamento de votos de {{title}}',
  statusSelectLabel: '{{title}} — status',
  addToAgendaBulk: 'Adicionar {{n}} à pauta da reunião',
  noIdeasTitle: 'Nenhuma ideia ainda',
  noIdeasBody: 'Adicione uma acima e então pontue-a em relação a cada critério para classificá-la.',

  // Idea form
  ideaTitleLabel: 'Nova ideia / solicitação',
  ideaTitlePlaceholder: 'Migrar o faturamento para o novo razão',
  ideaContextLabel: 'Contexto (opcional)',
  ideaContextPlaceholder: 'Histórico, escopo, links — qualquer coisa que os avaliadores devam saber',
  addIdea: 'Adicionar ideia',

  // Criteria modal
  criteriaModalLabel: 'Editar critérios de pontuação',
  criteriaWeights: 'Pesos dos critérios',
  criteriaModalBlurb: '{{preset}} · {{aggregation}}. Um peso maior faz um critério importar mais na classificação.',
  criteriaPresetCustom: 'personalizado',
  criterionCostLabel: '{{name}} (custo)',
  criterionLabel: '{{name}}',
  weightValue: '{{value}}/10',
  saveWeights: 'Salvar pesos',

  // Agenda panel
  meetingAgenda: 'Pauta da reunião',
  orBuildFromTop: 'ou monte a partir do topo',
  buildTopN: 'Montar top {{n}}',
  agendaEyebrow: 'Pauta',
  orderBy: 'Ordenar por',
  captionMeetingAgenda: 'Pauta da reunião',
  agendaDocument: 'Documento da pauta',
  agendaEmpty: 'Selecione ideias acima e escolha <0>Adicionar à pauta da reunião</0>, ou monte uma a partir das ideias mais bem classificadas. A pauta é ordenável — por prioridade, responsável, status ou data.',
  previousSessions: 'Sessões anteriores',
  savedAsDocument: '· salvo como documento',
  indexedForAgentsTitle: 'Indexado para agentes — compartilhado com agentes e conselhos',

  // Estado do cronograma (ADR 0103)
  colSchedule: 'Cronograma',
  scheduleOnTrack: 'No prazo',
  scheduleAtRisk: 'Em risco',
  scheduleBehind: 'Atrasado',
  scheduleDoneEarly: 'Concluído antes',
  scheduleDoneLate: 'Concluído atrasado',
  scheduleUnscheduled: 'Sem data',
  scheduleDueIn: 'em {{n}}d',
  scheduleOverdueBy: '{{n}}d de atraso',
  setTargetDateAria: 'Definir data-alvo para {{title}}',
  clearScheduleAria: 'Remover data-alvo de {{title}}',
  scheduleRollupSummary: '{{onTrack}} no prazo · {{atRisk}} em risco · {{behind}} atrasado',
  scheduleNoTargets: 'Ainda não há datas-alvo — defina uma em uma ideia para saber se está adiantada ou atrasada.',
  saveScheduleFailed: 'Não foi possível salvar a data-alvo.',
} as const;
