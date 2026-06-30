/**
 * `kanban` namespace — user-facing strings for the top-level Kanban area
 * (`src/kanban/`). FLAT camelCase keys, one per line (ADR 0065). Plural keys use
 * i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // AssignedColumn — the "Assigned to me" rail
  assignedToMe: 'Asignado a mí',
  unclaimedWithRole: 'Sin reclamar · {{role}}',
  priorityHigh: 'ALTA',
  claiming: 'Reclamando…',
  claim: 'Reclamar',
  openOnBoard: 'Abrir en {{board}}',
  boardArrow: '{{board}} →',

  // AssigneeControl — assign a card to a workspace member
  unassigned: 'Sin asignar',
  assignCardTitle: 'Asignar esta tarjeta a alguien',
  assignTo: 'Asignar a',
  closeAssigneePicker: 'Cerrar el selector de asignación',

  // CreateBoardModal — "Create a board"
  createBoardLabel: 'Crear un tablero',
  newBoardEyebrow: 'Nuevo tablero',
  createBoardTitle: 'Crear un tablero',
  createBoardLedeBefore: 'Un tablero hace el seguimiento del trabajo de Por hacer → Hecho. Opcionalmente, conecte un flujo de trabajo que se active cuando las tarjetas lleguen a la',
  createBoardLedeAfter: 'columna de activación.',
  boardNameLabel: 'Nombre del tablero',
  boardNamePlaceholder: 'p. ej. Incorporación del 3.er trimestre',
  triggerWorkflowLabel: 'Flujo de trabajo de activación',
  optionalSuffix: '· opcional',
  noWorkflowOption: 'Sin flujo de trabajo — tablero manual',
  owningAgentLabel: 'Agente propietario',
  noOwnerOption: 'Sin propietario — tablero compartido',
  createBoardButton: '+ Crear tablero',

  // KanbanBoardView — shared board renderer
  priorityLow: 'BAJA',
  dueDate: 'vence {{date}}',
  whyAssigned: 'Motivo de la asignación: {{reason}}',
  blocked: 'Bloqueado: {{note}}',
  dragCardToLane: 'Arrastre {{title}} a otra columna',
  deleteCard: 'Eliminar {{title}}',
  viewRunTitle: 'Ver la ejecución activada',
  viewRun: 'Ver ejecución',
  // Lane-contextual actions
  startWork: 'Empezar a trabajar',
  markDone: 'Marcar como hecho',
  resolve: 'Resolver',
  reopen: 'Reabrir',
  // Add-card form
  taskTitlePlaceholder: 'Título de la tarea…',
  taskDescriptionPlaceholder: 'Descripción (opcional) — compatible con Markdown',
  taskDescriptionAria: 'Descripción de la tarea',
  taskSourceAria: 'Origen de la tarea',
  workflowAria: 'Flujo de trabajo',
  noWorkflowOptionShort: 'Sin flujo de trabajo',
  priorityAria: 'Prioridad',
  priorityLowOption: 'Baja',
  priorityNormalOption: 'Normal',
  priorityHighOption: 'Alta',
  dueDateAria: 'Fecha de vencimiento',
  whyAssignedPlaceholder: 'Motivo de la asignación (opcional)',
  whyAssignedAria: 'Motivo de la asignación',
  blockerPlaceholder: 'Bloqueo, si lo hay (opcional)',
  blockerAria: 'Nota de bloqueo',
  addCardButton: 'Añadir',
  addCard: '+ Añadir tarjeta',
  // Card sources
  sourceHuman: 'De una persona',
  sourceDiscord: 'Discord simulado',
  sourceAgent: 'De otro agente',
  sourceApi: 'De una API',

  // KanbanPage — /boards route
  boardsEyebrow: 'Tableros',
  boardsTitle: 'Tableros',
  boardsLedePre: 'Los mismos tableros de tareas desde los que trabajan sus agentes. Arrastre una tarjeta a la columna ',
  boardsLedeTrigger: 'Por hacer',
  boardsLedePost: ' para activar su flujo de trabajo.',
  boardActions: 'Acciones del tablero',
  renameBoard: 'Cambiar el nombre del tablero',
  duplicate: 'Duplicar',
  deleteBoard: 'Eliminar tablero',
  newBoard: '+ Nuevo tablero',
  waitingOnYou: '{{count}} esperándole',
  triggers: 'Activadores:',
  loadingBoards: 'Cargando tableros…',
  noBoardsYet: 'Aún no hay tableros',
  noBoardsBody: 'Cree un tablero para empezar a hacer el seguimiento del trabajo — conecte un flujo de trabajo y se activará cuando las tarjetas lleguen a la columna de activación.',
  duplicatedNotice: 'Se ha duplicado "{{name}}" — ahora está viendo la copia.',
  renamePrompt: 'Cambiar el nombre del tablero',
  renamedNotice: 'Renombrado a "{{name}}".',
  deleteBoardConfirm: '¿Eliminar el tablero "{{name}}"? Esto elimina el tablero y todas sus tarjetas y no se puede deshacer.',
  deleteCardConfirm: '¿Eliminar la tarjeta “{{title}}”? Esto no se puede deshacer.',
  deleteCardConfirmNoTitle: '¿Eliminar la tarjeta? Esto no se puede deshacer.',
  startedRunNotice: 'Se ha iniciado una ejecución desde "{{title}}" — llegó a una columna de activación.',
} as const;
