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
  conveneHint: 'Para convocar um conselho, abra o chat de IA e digite seu <1>@@handle</1> (ex.: <3>@@timeless o que devemos priorizar?</3>). Cada consultor entra nos Agentes ativos do chat e o conselho opina ali.',

  // Board list
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
  planningContextHint: 'Dê aos consultores suas estratégias e projetos como contexto de planejamento — seus objetivos, status e marcos. Para busca profunda de documentos, use os botões de “Conhecimento compartilhado” em um cartão de conselho.',
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
  visibilityPrivate: 'Privado (somente eu)',
  visibilityShared: 'Compartilhado (workspace)',
  personaKindLabel: 'Tipo de persona',
  advisorsLabel: 'Consultores',
  livingPersonaAck: 'Reconheço que estas são personas simuladas de indivíduos vivos apenas para ideação — não as pessoas reais e sem o endosso delas.',
  createBoard: 'Criar conselho',
  editBoard: 'Editar conselho',
  saveChanges: 'Salvar alterações',
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
  sharedKnowledgeLabel: 'Conhecimento compartilhado:',
  sharedKnowledgeOnTitle: 'Todos os conselheiros podem recuperar {{kind}} — clique para parar de compartilhar',
  sharedKnowledgeOffTitle: 'Dar a todos os conselheiros acesso a {{kind}}',
  sharedKnowledgeEmptyTitle: 'Ainda não há {{kind}} para compartilhar — adicione conhecimento a um projeto para compartilhá-lo com este conselho',
  sharedKind_strategy: 'KB de Estratégia',
  'sharedKind_priority-matrix': 'KB de Matriz de Prioridades',
  sharedKind_project: 'KBs de projetos',
} as const;
