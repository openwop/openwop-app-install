/**
 * `kanban` namespace — user-facing strings for the top-level Kanban area
 * (`src/kanban/`). FLAT camelCase keys, one per line (ADR 0065). Plural keys use
 * i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // AssignedColumn — the "Assigned to me" rail
  assignedToMe: 'Atribuídos a mim',
  unclaimedWithRole: 'Não reivindicado · {{role}}',
  priorityHigh: 'ALTA',
  claiming: 'Reivindicando…',
  claim: 'Reivindicar',
  openOnBoard: 'Abrir em {{board}}',
  boardArrow: '{{board}} →',

  // AssigneeControl — assign a card to a workspace member
  unassigned: 'Não atribuído',
  assignCardTitle: 'Atribuir este cartão a alguém',
  assignTo: 'Atribuir a',
  closeAssigneePicker: 'Fechar seletor de responsável',

  // CreateBoardModal — "Create a board"
  createBoardLabel: 'Criar um quadro',
  newBoardEyebrow: 'Novo quadro',
  createBoardTitle: 'Criar um quadro',
  createBoardLedeBefore: 'Um quadro acompanha o trabalho de A fazer → Concluído. Opcionalmente, conecte um workflow que dispara quando os cartões chegam à coluna de gatilho',
  createBoardLedeAfter: '.',
  boardNameLabel: 'Nome do quadro',
  boardNamePlaceholder: 'ex.: Onboarding do Q3',
  triggerWorkflowLabel: 'Workflow de gatilho',
  optionalSuffix: '· opcional',
  noWorkflowOption: 'Sem workflow — quadro manual',
  owningAgentLabel: 'Agente responsável',
  noOwnerOption: 'Sem responsável — quadro compartilhado',
  createBoardButton: '+ Criar quadro',

  // KanbanBoardView — shared board renderer
  priorityLow: 'BAIXA',
  dueDate: 'vence {{date}}',
  whyAssigned: 'Por que atribuído: {{reason}}',
  blocked: 'Bloqueado: {{note}}',
  dragCardToLane: 'Arraste {{title}} para outra raia',
  deleteCard: 'Excluir {{title}}',
  viewRunTitle: 'Ver a execução disparada',
  viewRun: 'Ver execução',
  // Lane-contextual actions
  startWork: 'Iniciar trabalho',
  markDone: 'Marcar como concluído',
  resolve: 'Resolver',
  reopen: 'Reabrir',
  // Add-card form
  taskTitlePlaceholder: 'Título da tarefa…',
  taskDescriptionPlaceholder: 'Descrição (opcional) — suporta Markdown',
  taskDescriptionAria: 'Descrição da tarefa',
  taskSourceAria: 'Origem da tarefa',
  workflowAria: 'Workflow',
  noWorkflowOptionShort: 'Sem workflow',
  priorityAria: 'Prioridade',
  priorityLowOption: 'Baixa',
  priorityNormalOption: 'Normal',
  priorityHighOption: 'Alta',
  dueDateAria: 'Data de vencimento',
  whyAssignedPlaceholder: 'Por que atribuído (opcional)',
  whyAssignedAria: 'Por que atribuído',
  blockerPlaceholder: 'Bloqueio, se houver (opcional)',
  blockerAria: 'Nota de bloqueio',
  addCardButton: 'Adicionar',
  addCard: '+ Adicionar cartão',
  // Card sources
  sourceHuman: 'De um humano',
  sourceDiscord: 'Discord simulado',
  sourceAgent: 'De outro agente',
  sourceApi: 'De uma API',

  // KanbanPage — /boards route
  boardsEyebrow: 'Quadros',
  boardsTitle: 'Quadros',
  boardsLedePre: 'Os mesmos quadros de tarefas com que seus agentes trabalham. Arraste um cartão para a coluna ',
  boardsLedeTrigger: 'A fazer',
  boardsLedePost: ' para disparar seu workflow.',
  boardActions: 'Ações do quadro',
  renameBoard: 'Renomear quadro',
  duplicate: 'Duplicar',
  deleteBoard: 'Excluir quadro',
  newBoard: '+ Novo quadro',
  waitingOnYou: '{{count}} aguardando você',
  triggers: 'Gatilhos:',
  loadingBoards: 'Carregando quadros…',
  noBoardsYet: 'Nenhum quadro ainda',
  noBoardsBody: 'Crie um quadro para começar a acompanhar o trabalho — conecte um workflow e ele dispara quando os cartões chegam à coluna de gatilho.',
  duplicatedNotice: 'Duplicado "{{name}}" — agora visualizando a cópia.',
  renamePrompt: 'Renomear quadro',
  renamedNotice: 'Renomeado para "{{name}}".',
  deleteBoardConfirm: 'Excluir o quadro "{{name}}"? Isso remove o quadro e todos os seus cartões e não pode ser desfeito.',
  deleteCardConfirm: 'Excluir o cartão “{{title}}”? Isso não pode ser desfeito.',
  deleteCardConfirmNoTitle: 'Excluir o cartão? Isso não pode ser desfeito.',
  startedRunNotice: 'Iniciou uma execução a partir de "{{title}}" — ela chegou a uma raia de gatilho.',
} as const;
