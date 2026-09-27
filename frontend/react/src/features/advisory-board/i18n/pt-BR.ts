/**
 * `advisory-board` namespace — user-facing copy for the Board of Advisors feature
 * (ADR 0040). Feature-self-contained: every advisory-board string lives here.
 * Generic actions/states are reused from the `common` namespace via `t('common:…')`
 * and are NOT duplicated.
 */
export const messages = {
  // Gating
  notEnabledTitle: 'O Conselho de Consultores não está ativado',
  notEnabledBody: 'Ative o recurso Conselho de Consultores para este workspace para montar conselhos de agentes consultores.',

  // Page chrome
  eyebrow: 'Agentes',
  title: 'Conselho de Consultores',
  lede: 'Monte um conselho de agentes consultores — depois convoque-o no chat de IA digitando seu @@handle.',

  // Convene hint (rich)
  boardsEmptyTitle: 'Nenhum conselho ainda',
  boardsEmptyBody: 'Crie seu primeiro conselho de consultores acima.',

  // Collection-view filterbar (§4.5 rule 11)
  filterGroup: 'Filtrar conselhos',
  filterPlaceholder: 'Filtrar conselhos…',
  filterAria: 'Filtrar conselhos por nome ou handle',
  noMatchTitle: 'Nenhum conselho correspondente',
  noMatchBody: 'Nenhum conselho corresponde à sua busca. Tente outro termo.',
  clearSearch: 'Limpar busca',
  advisorsCount_one: '{{count}} consultor',
  advisorsCount_other: '{{count}} consultores',
  strategyContextCount_one: '{{count}} estratégia',
  strategyContextCount_other: '{{count}} estratégias',
  deleteBoardLabel: 'Excluir {{name}}',
  confirmDeleteTitle: 'Excluir {{name}}?',
  confirmDeleteBody: 'Isto exclui o conselho e libera seu @@handle. Os agentes consultores permanecem na sua lista — apenas este agrupamento é removido. Esta ação não pode ser desfeita.',

  // Seletor de contexto estratégico (ADR 0076 Fase 5)
  strategyContextLabel: 'Contexto estratégico',
  planningContextLabel: 'Contexto de planejamento',
  planningContextHint: 'Dê aos consultores suas estratégias e projetos como contexto de planejamento — um retrato de objetivos, status e marcos capturado ao abrir ou convocar o chat do conselho. Para busca de documentos ao vivo a cada turno, use a seção “Conhecimento compartilhado” ao editar um conselho.',
  projectContextLabel: 'Contexto de projeto',
  projectContextCount_one: '{{count}} projeto',
  projectContextCount_other: '{{count}} projetos',

  // Create form — no roster
  noAdvisorsTitle: 'Nenhum agente consultor ainda',
  noAdvisorsBody: 'Adicione agentes ao seu elenco primeiro — consultores são agentes do elenco com persona e conhecimento próprios.',

  // Create form
  newBoard: 'Novo conselho',
  boardNameLabel: 'Nome do conselho',
  boardNamePlaceholder: 'Conselho de fundadores',
  organizationLabel: 'Organização',
  visibilityLabel: 'Visibilidade',
  // ADR 0665 D3 — was "Private (only me)", which the access rule does not deliver:
  // `resolveBoardAccess` grants an org `workspace:write` holder authority over the
  // board SUBJECT regardless of visibility — the documented cross-feature
  // "visibility is not authority" rule (ADR 0054 D5), which projects implement
  // identically. The rule is unchanged; the promise now matches it, in the wording
  // `features/projects/i18n` already ships for the same rule.
  visibilityPrivate: 'Privado',
  visibilityPrivateHelp: 'Apenas você e quem tem permissão de escrita no workspace podem ver este conselho: seus conselheiros e a transcrição da sala.',
  visibilityShared: 'Compartilhado (workspace)',
  personaKindLabel: 'Tipo de persona',
  advisorsLabel: 'Consultores',
  livingPersonaAck: 'Reconheço que estas são personas simuladas de indivíduos vivos apenas para ideação — não as pessoas reais e sem o endosso delas.',
  createBoard: 'Criar conselho',
  editBoard: 'Editar conselho',
  saveChanges: 'Salvar alterações',
  openingChatAction: 'Abrindo…',
  openChatAction: 'Abrir chat',
  openBoardChatLabel: 'Abrir o chat do conselho {{name}}',
  openChatError: 'Não foi possível abrir o chat do conselho.',
  editAction: 'Editar',
  cloneAction: 'Clonar',
  editBoardLabel: 'Editar {{name}}',
  cloneBoardLabel: 'Clonar {{name}}',
  cloneNameSuffix: '{{name}} (cópia)',

  // Persona kinds
  personaHistorical: 'Figuras históricas / de domínio público',
  personaFictional: 'Personagens fictícios',
  personaOriginal: 'Personas originais',
  personaLiving: 'Indivíduos vivos (requer reconhecimento)',
  sharedKnowledgeLabel: 'Conhecimento compartilhado',
  sharedKnowledgeHint: 'Dê a cada consultor deste conselho acesso de recuperação a estas bases de conhecimento — consultadas ao vivo a cada turno, para respostas sempre atualizadas.',
  sharedKnowledgeLoadFailed: 'Não foi possível carregar as configurações de conhecimento compartilhado. Reabra o conselho para tentar novamente.',
  sharedKnowledgeOnTitle: 'Todos os conselheiros podem recuperar {{kind}} — clique para parar de compartilhar',
  sharedKnowledgeOffTitle: 'Dar a todos os conselheiros acesso a {{kind}}',
  sharedKnowledgeEmptyTitle: 'Ainda não há {{kind}} para compartilhar — adicione conhecimento a um projeto para compartilhá-lo com este conselho',
  sharedKind_strategy: 'KB de Estratégia',
  'sharedKind_priority-matrix': 'KB de Matriz de Prioridades',
  sharedKind_project: 'KBs de projetos',
  'sharedKind_team-portfolio': 'KB de portfólio da equipe',
  contextLoadFailed: "Não foi possível carregar estratégias e projetos, então nenhum contexto de planejamento pode ser anexado a este conselho agora. O contexto já salvo permanece intacto.",
  dialogErrorAnnounce: "Não foi salvo. O motivo aparece na caixa de diálogo.",
  deleteErrorAnnounce: "Não foi excluído. O motivo aparece na caixa de diálogo.",
  moderatorLabel: "Presidente (sintetiza)",
  moderatorHint: "O presidente conclui. Sem presidente, o primeiro conselheiro a falar também escreve a recomendação — uma parte julgando a disputa.",
  moderatorNone: "Sem presidente — o primeiro conselheiro sintetiza",
  moderatorOutOfCohort: "{{persona}} — preside, fora deste grupo",
  boardContextStaleBody: "Não conseguimos atualizar o registro salvo dos planos que esta sala recebeu, então esse registro está desatualizado. Seus conselheiros continuam fundamentados nos planos que você pode ler, verificados a cada turno.",
  boardContextStaleOpen: "Abrir a sala mesmo assim",
} as const;
