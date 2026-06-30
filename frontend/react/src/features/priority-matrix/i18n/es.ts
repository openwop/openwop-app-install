/**
 * `priority-matrix` namespace — user-facing copy for the priority-matrix feature.
 * Feature-self-contained: every priority-matrix string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 * Spanish (es) translation.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Espacio de trabajo',
  title: 'Matriz de prioridades',
  lede: 'Puntúe ideas frente a criterios ponderados, ordénelas y convierta las mejores en un orden del día de reunión.',
  newList: 'Nueva lista',

  // Status columns (board statuses)
  statusNew: 'Nueva',
  statusUnderReview: 'En revisión',
  statusInProcess: 'En proceso',
  statusBlocked: 'Bloqueada',
  statusDeferred: 'Aplazada',
  statusWontDo: 'No se hará',
  statusDone: 'Hecha',

  // Scoring model labels
  modelWeighted: 'Ponderado',
  modelWsjf: 'WSJF',
  modelRice: 'RICE',
  modelIce: 'ICE',
  modelValueEffort: 'Valor frente a esfuerzo',
  modelCustom: 'Personalizado',

  // Agenda sort labels
  agendaSortPriority: 'Prioridad',
  agendaSortCreated: 'Fecha de envío',
  agendaSortOwner: 'Responsable',
  agendaSortStatus: 'Estado',
  agendaSortTitle: 'Título',

  // Generic fallbacks
  emDash: '—',
  unknown: 'Desconocido',

  // Create-list modal
  createModalLabel: 'Crear una lista de prioridades',
  createModalHeading: 'Nueva lista de prioridades',

  // Loading / empty states (lists)
  loadingLists: 'Cargando listas…',
  noListsTitle: 'Aún no hay listas de prioridades',
  noListsBody: 'Una lista recoge ideas, las puntúa frente a criterios ponderados y las ordena. Cree una para empezar.',
  createFirstList: 'Cree su primera lista',

  // Tabs
  tablistLabel: 'Listas de prioridades',
  tabPortfolio: 'Cartera',
  tabProjectSuffix: ' · proyecto',

  // Errors (toasts / notices)
  loadListsFailed: 'No se han podido cargar las listas de prioridades.',
  loadPortfolioFailed: 'No se ha podido cargar la cartera.',
  loadIdeasFailed: 'No se han podido cargar las ideas.',
  addPeerFailed: 'No se ha podido añadir el par (solo superadministrador).',
  removePeerFailed: 'No se ha podido eliminar el par.',
  setCredentialFailed: 'No se ha podido establecer la credencial.',
  createListFailed: 'No se ha podido crear la lista.',
  setVoterWeightFailed: 'No se ha podido establecer el peso del votante (se necesita autoridad de propietario/administrador).',
  submitIdeaFailed: 'No se ha podido enviar la idea.',
  saveScoreFailed: 'No se ha podido guardar la puntuación.',
  changeStatusFailed: 'No se ha podido cambiar el estado.',
  deleteListFailed: 'No se ha podido eliminar la lista.',
  buildAgendaFailed: 'No se ha podido crear el orden del día (se necesita permiso de escritura en el espacio de trabajo).',
  reorderAgendaFailed: 'No se ha podido reordenar el orden del día.',
  saveWeightsFailed: 'No se han podido guardar los pesos (se necesita autoridad de propietario/administrador).',

  // Portfolio section
  portfolioHeading: 'Cartera',
  portfolioSummaryFederated: 'prioridades principales en este espacio de trabajo + pares federados',
  portfolioSummaryLocal_one: 'prioridades principales en {{formattedCount}} lista',
  portfolioSummaryLocal_other: 'prioridades principales en {{formattedCount}} listas',
  includePeers: 'Incluir pares',
  compareLabel: 'Comparar',
  compareRaw: 'Prioridad bruta',
  compareListRelative: 'Relativa a la lista (0–100)',
  comparePercentile: 'Percentil',
  topN: 'Top N',
  portfolioBlurbFederated: 'Ordenadas por prioridad bruta en este espacio de trabajo y en cada par federado. Las prioridades entre hosts no son estrictamente comparables: cada fila muestra su origen.',
  portfolioBlurbRaw: 'Ordenadas por prioridad bruta. Las prioridades no son estrictamente comparables entre listas con criterios o modelos de puntuación distintos: cada fila muestra su lista de origen, su rango dentro de la lista y su modelo.',
  portfolioBlurbListRelative: 'Ordenadas por la prioridad de cada idea en relación con la cabeza de su propia lista (0–100): una ayuda a la comparabilidad, no una verdad absoluta entre listas.',
  portfolioBlurbPercentile: 'Ordenadas por el percentil de cada idea dentro de su propia lista (cabeza = 100). Útil cuando las listas difieren en tamaño; sigue siendo relativo, no absoluto.',
  peerChip: '{{label}}: {{value}}',
  peerError: 'error',
  loadingPortfolio: 'Cargando cartera…',

  // Portfolio table
  colRank: '#',
  colIdea: 'Idea',
  colStrategy: 'Estrategia',
  colSource: 'Origen',
  sourceLocal: 'local',
  colList: 'Lista',
  listCell: '#{{rank}} · {{model}}',
  colStatus: 'Estado',
  colPriority: 'Prioridad',
  colPercentile: 'Percentil',
  colNormalized: 'Normalizada',
  captionPortfolio: 'Cartera',
  noScoredIdeasTitle: 'Aún no hay ideas puntuadas',
  noScoredIdeasBody: 'Puntúe ideas en sus listas para verlas ordenadas aquí.',

  // Federated peers admin
  federatedPeers: 'Pares federados ({{n}})',
  peerLabel: 'Etiqueta del par',
  peerLabelPlaceholder: 'Acme Este',
  baseUrl: 'URL base',
  baseUrlPlaceholder: 'https://east.acme.example',
  addPeer: 'Añadir par',
  removePeerLabel: 'Eliminar {{label}}',

  // Peer credential form
  bearerToken: 'Token de portador',
  bearerTokenPlaceholder: 'pegue el portador del par',
  scope: 'Ámbito',
  scopeUser: 'Solo mío',
  scopeTenant: 'Compartido en el espacio de trabajo (administrador)',
  saved: 'guardado',

  // Create-list form
  listName: 'Nombre de la lista',
  listNamePlaceholder: 'Iniciativas estratégicas',
  workspace: 'Espacio de trabajo',
  projectOptional: 'Proyecto (opcional)',
  workspaceWide: 'Todo el espacio de trabajo',
  scoringModel: 'Modelo de puntuación',
  scoringModelWeighted: 'Puntuación ponderada',
  scoringModelWsjf: 'WSJF (SAFe)',
  scoringModelRice: 'RICE',
  scoringModelIce: 'ICE',
  scoringModelValueEffort: 'Valor frente a esfuerzo',
  scoringMode: 'Modo de puntuación',
  scoringModeSingle: 'Puntuación única compartida',
  scoringModeMulti: 'Multivotante (cada miembro vota)',
  createList: 'Crear lista',

  // List detail — delete confirm
  editList: 'Editar lista',
  updateListFailed: 'No se pudo actualizar la lista.',
  confirmDeleteTitle: '¿Eliminar {{name}}?',
  confirmDeleteBody: 'Esto elimina permanentemente la lista, sus ideas y sus clasificaciones. Esta acción no se puede deshacer.',

  // Vote breakdown modal
  voteBreakdownLabel: 'Desglose de votos — {{title}}',
  voteBreakdownHeading: 'Votos — {{title}}',
  voteBreakdownRestricted: 'El desglose por votante solo es visible para el propietario de la lista o para un administrador de la organización.',
  noVotesYet: 'Aún no hay votos.',
  weightExplainer: 'Pondere el voto de una parte interesada de 1 a 10 (predeterminado 1). Los votos con mayor peso cuentan proporcionalmente más en el agregado (ADR 0059).',
  criterionScore: '{{name}} {{score}}',
  weight: 'Peso',
  weightForLabel: 'Peso de {{name}}',

  // List header
  priorityListEyebrow: 'Lista de prioridades',
  chipMultiVoter: 'multivotante · {{aggregation}}',
  chipSingleScore: 'puntuación única',
  ideaCount_one: '{{formattedCount}} idea',
  ideaCount_other: '{{formattedCount}} ideas',
  criteria: 'Criterios',
  deleteList: 'Eliminar lista',

  // Ranked ideas section
  rankedIdeas: 'Ideas ordenadas',
  rankedIdeasHint: 'haga clic en una columna para ordenar · seleccione filas para crear un orden del día',
  loadingIdeas: 'Cargando ideas…',
  captionRankedIdeas: 'Ideas ordenadas',
  viewToggleAria: 'Vista de ideas',
  viewMatrix: 'Matriz',
  viewGrid: 'Cuadrícula',
  viewList: 'Lista',
  matrixUnavailable: 'Este modelo de puntuación no tiene eje de esfuerzo — añade un criterio de coste',
  quadQuickWins: 'Victorias rápidas',
  quadBigBets: 'Grandes apuestas',
  quadFillIns: 'Rellenos',
  quadReconsider: 'Reconsiderar',
  quadEmpty: 'Nada aquí',
  matrixLegend: 'Columnas: esfuerzo (bajo → alto). Filas: impacto (alto → bajo). Las victorias rápidas son de alto impacto y bajo esfuerzo.',
  matrixUnscored_one: '{{formattedCount}} idea sin puntuar',
  matrixUnscored_other: '{{formattedCount}} ideas sin puntuar',
  matrixUnscoredHint: 'Puntúalas en la vista Lista para situarlas en la matriz.',
  colPriorityAgg: 'Prioridad (agreg.)',
  colOwner: 'Responsable',
  colCreated: 'Creada',
  colVotes: 'Votos',
  votesChip_one: '{{formattedCount}} voto',
  votesChip_other: '{{formattedCount}} votos',
  strategyAlignedCount_one: '{{formattedCount}} estrategia',
  strategyAlignedCount_other: '{{formattedCount}} estrategias',
  scoreInputLabel: '{{title}} — puntuación de {{criterion}}',
  voteBreakdownButtonLabel: 'Desglose de votos de {{title}}',
  statusSelectLabel: '{{title}} — estado',
  addToAgendaBulk: 'Añadir {{n}} al orden del día de la reunión',
  noIdeasTitle: 'Aún no hay ideas',
  noIdeasBody: 'Añada una arriba y, después, puntúela frente a cada criterio para ordenarla.',

  // Idea form
  ideaTitleLabel: 'Nueva idea / solicitud',
  ideaTitlePlaceholder: 'Migrar la facturación al nuevo libro mayor',
  ideaContextLabel: 'Contexto (opcional)',
  ideaContextPlaceholder: 'Antecedentes, alcance, enlaces: cualquier cosa que deban saber quienes puntúan',
  addIdea: 'Añadir idea',

  // Criteria modal
  criteriaModalLabel: 'Editar criterios de puntuación',
  criteriaWeights: 'Pesos de los criterios',
  criteriaModalBlurb: '{{preset}} · {{aggregation}}. Un peso mayor hace que un criterio cuente más en la ordenación.',
  criteriaPresetCustom: 'personalizado',
  criterionCostLabel: '{{name}} (coste)',
  criterionLabel: '{{name}}',
  weightValue: '{{value}}/10',
  saveWeights: 'Guardar pesos',

  // Agenda panel
  meetingAgenda: 'Orden del día de la reunión',
  orBuildFromTop: 'o créelo a partir de las mejores',
  buildTopN: 'Crear las {{n}} mejores',
  agendaEyebrow: 'Orden del día',
  orderBy: 'Ordenar por',
  captionMeetingAgenda: 'Orden del día de la reunión',
  agendaDocument: 'Documento del orden del día',
  agendaEmpty: 'Seleccione ideas arriba y elija <0>Añadir al orden del día de la reunión</0>, o cree uno a partir de las ideas mejor clasificadas. El orden del día se puede ordenar: por prioridad, responsable, estado o fecha.',
  previousSessions: 'Sesiones anteriores',
  savedAsDocument: '· guardado como documento',
  indexedForAgentsTitle: 'Indexado para agentes — compartido con agentes y consejos',

  // Estado de cronograma (ADR 0103)
  colSchedule: 'Cronograma',
  scheduleOnTrack: 'En tiempo',
  scheduleAtRisk: 'En riesgo',
  scheduleBehind: 'Atrasado',
  scheduleDoneEarly: 'Hecho antes',
  scheduleDoneLate: 'Hecho tarde',
  scheduleUnscheduled: 'Sin fecha',
  scheduleDueIn: 'en {{n}}d',
  scheduleOverdueBy: '{{n}}d de retraso',
  setTargetDateAria: 'Establecer fecha objetivo para {{title}}',
  clearScheduleAria: 'Quitar fecha objetivo de {{title}}',
  scheduleRollupSummary: '{{onTrack}} en tiempo · {{atRisk}} en riesgo · {{behind}} atrasado',
  scheduleNoTargets: 'Aún no hay fechas objetivo — establece una en una idea para saber si va adelantada o atrasada.',
  saveScheduleFailed: 'No se pudo guardar la fecha objetivo.',
} as const;
