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
  conveneHint: 'Para convocar un consejo, abra el chat de IA y escriba su <1>@@handle</1> (p. ej. <3>@@timeless ¿qué deberíamos priorizar?</3>). Cada asesor se une a los Agentes activos del chat y el consejo aporta su opinión allí.',

  // Board list
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
  planningContextHint: 'Da a los asesores tus estrategias y proyectos como contexto de planificación — sus objetivos, estado e hitos. Para búsqueda profunda de documentos, usa los interruptores de «Conocimiento compartido» en una tarjeta de consejo.',
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
  visibilityPrivate: 'Privado (solo yo)',
  visibilityShared: 'Compartido (espacio de trabajo)',
  personaKindLabel: 'Tipo de persona',
  advisorsLabel: 'Asesores',
  livingPersonaAck: 'Reconozco que estas son personas simuladas de individuos vivos solo para la generación de ideas — no son las personas reales y no cuentan con su aprobación.',
  createBoard: 'Crear consejo',
  editBoard: 'Editar consejo',
  saveChanges: 'Guardar cambios',
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
  sharedKnowledgeLabel: 'Conocimiento compartido:',
  sharedKnowledgeOnTitle: 'Todos los asesores pueden recuperar {{kind}} — haz clic para dejar de compartir',
  sharedKnowledgeOffTitle: 'Dar a todos los asesores acceso a {{kind}}',
  sharedKnowledgeEmptyTitle: 'Aún no hay {{kind}} para compartir — añade conocimiento a un proyecto para compartirlo con este consejo',
  sharedKind_strategy: 'KB de Estrategia',
  'sharedKind_priority-matrix': 'KB de Matriz de Prioridades',
  sharedKind_project: 'KBs de proyectos',
} as const;
