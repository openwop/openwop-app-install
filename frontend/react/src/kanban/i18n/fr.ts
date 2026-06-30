/**
 * `kanban` namespace — user-facing strings for the top-level Kanban area
 * (`src/kanban/`). FLAT camelCase keys, one per line (ADR 0065). Plural keys use
 * i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // AssignedColumn — the "Assigned to me" rail
  assignedToMe: 'Assignées à moi',
  unclaimedWithRole: 'Non réclamée · {{role}}',
  priorityHigh: 'HAUTE',
  claiming: 'Réclamation en cours…',
  claim: 'Réclamer',
  openOnBoard: 'Ouvrir sur {{board}}',
  boardArrow: '{{board}} →',

  // AssigneeControl — assign a card to a workspace member
  unassigned: 'Non assignée',
  assignCardTitle: 'Assigner cette carte à quelqu\'un',
  assignTo: 'Assigner à',
  closeAssigneePicker: 'Fermer le sélecteur d\'assignation',

  // CreateBoardModal — "Create a board"
  createBoardLabel: 'Créer un tableau',
  newBoardEyebrow: 'Nouveau tableau',
  createBoardTitle: 'Créer un tableau',
  createBoardLedeBefore: 'Un tableau suit le travail de À faire → Terminé. Vous pouvez connecter un workflow qui se déclenche lorsque les cartes atteignent la colonne',
  createBoardLedeAfter: 'de déclenchement.',
  boardNameLabel: 'Nom du tableau',
  boardNamePlaceholder: 'ex. Intégration T3',
  triggerWorkflowLabel: 'Workflow de déclenchement',
  optionalSuffix: '· facultatif',
  noWorkflowOption: 'Aucun workflow — tableau manuel',
  owningAgentLabel: 'Agent propriétaire',
  noOwnerOption: 'Aucun propriétaire — tableau partagé',
  createBoardButton: '+ Créer le tableau',

  // KanbanBoardView — shared board renderer
  priorityLow: 'BASSE',
  dueDate: 'échéance {{date}}',
  whyAssigned: 'Raison de l\'assignation : {{reason}}',
  blocked: 'Bloquée : {{note}}',
  dragCardToLane: 'Faire glisser {{title}} vers une autre voie',
  deleteCard: 'Supprimer {{title}}',
  viewRunTitle: 'Voir l\'exécution déclenchée',
  viewRun: 'Voir l\'exécution',
  // Lane-contextual actions
  startWork: 'Commencer le travail',
  markDone: 'Marquer comme terminé',
  resolve: 'Résoudre',
  reopen: 'Rouvrir',
  // Add-card form
  taskTitlePlaceholder: 'Titre de la tâche…',
  taskDescriptionPlaceholder: 'Description (facultative) — Markdown pris en charge',
  taskDescriptionAria: 'Description de la tâche',
  taskSourceAria: 'Source de la tâche',
  workflowAria: 'Workflow',
  noWorkflowOptionShort: 'Aucun workflow',
  priorityAria: 'Priorité',
  priorityLowOption: 'Basse',
  priorityNormalOption: 'Normale',
  priorityHighOption: 'Haute',
  dueDateAria: 'Date d\'échéance',
  whyAssignedPlaceholder: 'Raison de l\'assignation (facultatif)',
  whyAssignedAria: 'Raison de l\'assignation',
  blockerPlaceholder: 'Élément bloquant, le cas échéant (facultatif)',
  blockerAria: 'Note de blocage',
  addCardButton: 'Ajouter',
  addCard: '+ Ajouter une carte',
  // Card sources
  sourceHuman: 'D\'un humain',
  sourceDiscord: 'Discord simulé',
  sourceAgent: 'D\'un autre agent',
  sourceApi: 'D\'une API',

  // KanbanPage — /boards route
  boardsEyebrow: 'Tableaux',
  boardsTitle: 'Tableaux',
  boardsLedePre: 'Les mêmes tableaux de tâches sur lesquels vos agents travaillent. Faites glisser une carte dans la colonne ',
  boardsLedeTrigger: 'À faire',
  boardsLedePost: ' pour déclencher son workflow.',
  boardActions: 'Actions du tableau',
  renameBoard: 'Renommer le tableau',
  duplicate: 'Dupliquer',
  deleteBoard: 'Supprimer le tableau',
  newBoard: '+ Nouveau tableau',
  waitingOnYou: '{{count}} en attente de vous',
  triggers: 'Déclencheurs :',
  loadingBoards: 'Chargement des tableaux…',
  noBoardsYet: 'Aucun tableau pour le moment',
  noBoardsBody: 'Créez un tableau pour commencer à suivre le travail — connectez un workflow et il se déclenche lorsque les cartes atteignent la colonne de déclenchement.',
  duplicatedNotice: '« {{name}} » dupliqué — vous consultez maintenant la copie.',
  renamePrompt: 'Renommer le tableau',
  renamedNotice: 'Renommé en « {{name}} ».',
  deleteBoardConfirm: 'Supprimer le tableau « {{name}} » ? Cela supprime le tableau ainsi que toutes ses cartes et est irréversible.',
  deleteCardConfirm: 'Supprimer la carte « {{title}} » ? Cette action est irréversible.',
  deleteCardConfirmNoTitle: 'Supprimer la carte ? Cette action est irréversible.',
  startedRunNotice: 'Exécution démarrée à partir de « {{title}} » — elle a atterri dans une voie de déclenchement.',
} as const;
