/**
 * `advisory-board` namespace — user-facing copy for the Board of Advisors feature
 * (ADR 0040). Feature-self-contained: every advisory-board string lives here.
 * Generic actions/states are reused from the `common` namespace via `t('common:…')`
 * and are NOT duplicated.
 */
export const messages = {
  // Gating
  notEnabledTitle: 'El consejo asesor no está habilitado',
  notEnabledBody: 'Active la función de consejo asesor para este espacio de trabajo para formar consejos de agentes asesores.',

  // Page chrome
  eyebrow: 'Agentes',
  title: 'Consejo asesor',
  lede: 'Forme un consejo de agentes asesores — luego convóquelo en el chat de IA escribiendo su @@handle.',

  // Convene hint (rich)
  boardsEmptyTitle: 'Aún no hay consejos',
  boardsEmptyBody: 'Cree su primer consejo asesor arriba.',

  // Collection-view filterbar (§4.5 rule 11)
  filterGroup: 'Filtrar consejos',
  filterPlaceholder: 'Filtrar consejos…',
  filterAria: 'Filtrar consejos por nombre o handle',
  noMatchTitle: 'No hay consejos coincidentes',
  noMatchBody: 'Ningún consejo coincide con su búsqueda. Pruebe otro término.',
  clearSearch: 'Limpiar búsqueda',
  advisorsCount_one: '{{count}} asesor',
  advisorsCount_other: '{{count}} asesores',
  strategyContextCount_one: '{{count}} estrategia',
  strategyContextCount_other: '{{count}} estrategias',
  deleteBoardLabel: 'Eliminar {{name}}',
  confirmDeleteTitle: '¿Eliminar {{name}}?',
  confirmDeleteBody: 'Esto elimina el consejo y libera su @@handle. Los agentes asesores permanecen en tu lista — solo se elimina esta agrupación. Esta acción no se puede deshacer.',

  // Strategy context picker (ADR 0076 Phase 5)
  strategyContextLabel: 'Contexto de estrategia',
  planningContextLabel: 'Contexto de planificación',
  planningContextHint: 'Da a los asesores tus estrategias y proyectos como contexto de planificación — una instantánea de objetivos, estado e hitos tomada al abrir o convocar el chat del consejo. Para búsqueda de documentos en vivo en cada turno, usa la sección «Conocimiento compartido» al editar un consejo.',
  projectContextLabel: 'Contexto de proyecto',
  projectContextCount_one: '{{count}} proyecto',
  projectContextCount_other: '{{count}} proyectos',

  // Create form — no roster
  noAdvisorsTitle: 'Aún no hay agentes asesores',
  noAdvisorsBody: 'Añada primero agentes a su lista — los asesores son agentes de la lista con su propia persona y conocimiento.',

  // Create form
  newBoard: 'Nuevo consejo',
  boardNameLabel: 'Nombre del consejo',
  boardNamePlaceholder: 'Consejo de fundadores',
  organizationLabel: 'Organización',
  visibilityLabel: 'Visibilidad',
  // ADR 0665 D3 — was "Private (only me)", which the access rule does not deliver:
  // `resolveBoardAccess` grants an org `workspace:write` holder authority over the
  // board SUBJECT regardless of visibility — the documented cross-feature
  // "visibility is not authority" rule (ADR 0054 D5), which projects implement
  // identically. The rule is unchanged; the promise now matches it, in the wording
  // `features/projects/i18n` already ships for the same rule.
  visibilityPrivate: 'Privado',
  visibilityPrivateHelp: 'Solo tú y quienes tengan permiso de escritura en el espacio de trabajo pueden ver este consejo: sus asesores y la transcripción de la sala.',
  visibilityShared: 'Compartido (espacio de trabajo)',
  personaKindLabel: 'Tipo de persona',
  advisorsLabel: 'Asesores',
  livingPersonaAck: 'Reconozco que estas son personas simuladas de individuos vivos solo para la generación de ideas — no son las personas reales y no cuentan con su aprobación.',
  createBoard: 'Crear consejo',
  editBoard: 'Editar consejo',
  saveChanges: 'Guardar cambios',
  openingChatAction: 'Abriendo…',
  openChatAction: 'Abrir chat',
  openBoardChatLabel: 'Abrir el chat del consejo {{name}}',
  openChatError: 'No se pudo abrir el chat del consejo.',
  editAction: 'Editar',
  cloneAction: 'Clonar',
  editBoardLabel: 'Editar {{name}}',
  cloneBoardLabel: 'Clonar {{name}}',
  cloneNameSuffix: '{{name}} (copia)',

  // Persona kinds
  personaHistorical: 'Figuras históricas / de dominio público',
  personaFictional: 'Personajes ficticios',
  personaOriginal: 'Personas originales',
  personaLiving: 'Individuos vivos (requiere reconocimiento)',
  sharedKnowledgeLabel: 'Conocimiento compartido',
  sharedKnowledgeHint: 'Da a cada asesor de este consejo acceso de recuperación a estas bases de conocimiento — se consultan en vivo en cada turno, así las respuestas siguen el contenido más reciente.',
  sharedKnowledgeLoadFailed: 'No se pudo cargar la configuración de conocimiento compartido. Vuelve a abrir el consejo para intentarlo de nuevo.',
  sharedKnowledgeOnTitle: 'Todos los asesores pueden recuperar {{kind}} — haz clic para dejar de compartir',
  sharedKnowledgeOffTitle: 'Dar a todos los asesores acceso a {{kind}}',
  sharedKnowledgeEmptyTitle: 'Aún no hay {{kind}} para compartir — añade conocimiento a un proyecto para compartirlo con este consejo',
  sharedKind_strategy: 'KB de Estrategia',
  'sharedKind_priority-matrix': 'KB de Matriz de Prioridades',
  sharedKind_project: 'KBs de proyectos',
  'sharedKind_team-portfolio': 'KB de portafolio del equipo',
  contextLoadFailed: "No se pudieron cargar las estrategias ni los proyectos, así que ahora no se puede adjuntar contexto de planificación a este consejo. El contexto ya guardado no se modifica.",
  dialogErrorAnnounce: "No se guardó. El motivo aparece en el diálogo.",
  deleteErrorAnnounce: "No se eliminó. El motivo aparece en el diálogo.",
  moderatorLabel: "Presidente (sintetiza)",
  moderatorHint: "El presidente resume al final. Si no se define, el primer asesor que habla también escribe la recomendación: una parte juzgando la disputa.",
  moderatorNone: "Sin presidente — el primer asesor sintetiza",
  moderatorOutOfCohort: "{{persona}} — preside, fuera de este grupo",
  boardContextStaleBody: "No pudimos actualizar el registro guardado de los planes que recibió esta sala, así que ese registro está desfasado. Tus asesores siguen fundamentados en los planes que puedes leer, comprobados en cada turno.",
  boardContextStaleOpen: "Abrir la sala de todos modos",
} as const;
