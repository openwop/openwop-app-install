/**
 * `prompts` namespace — user-facing strings for the prompt-library area
 * (`src/prompts/`). FLAT camelCase keys, one per line (ADR 0065). Plural keys
 * use i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // Kind labels (filter + chips)
  kindAll: 'Todos',
  kindAllKinds: 'Todos los tipos',
  kindSystem: 'Sistema',
  kindUser: 'Usuario',
  kindFewShot: 'Few-shot',
  kindSchemaHint: 'Sugerencia de esquema',

  // Page header
  pageEyebrow: 'Crear',
  pageTitle: 'Biblioteca de prompts',
  pageLede:
    'Prompts reutilizables para el chat y para los nodos de IA de sus flujos de trabajo. Los prompts que cree en Mis prompts se guardan en este navegador; compártalos con su equipo para añadirlos a la Biblioteca del equipo, donde cualquier miembro de la organización puede insertarlos en un chat con /p-.',
  newPrompt: '+ Nuevo prompt',

  // Tier-1 subset banner (segments — markup stays in the component)
  tierOneStrong: 'Subconjunto de nivel 1',
  tierOnePosture: '({{posture}}):',
  tierOneFlagged_one: 'prompt de sugerencia de esquema marcado contra',
  tierOneFlagged_other: 'prompts de sugerencia de esquema marcados contra',
  tierOneLinkText: 'structured-output-subset.md',
  tierOneFindingHint: 'Los chips en línea de cada infractor apuntan al hallazgo concreto.',

  // Key-figure band
  figureAllPrompts: 'Todos los prompts',
  filterByKindAria: 'Filtrar prompts por tipo',

  // Filter bar
  filterGroupAria: 'Filtrar prompts',
  searchPlaceholder: 'templateId, nombre, descripción, etiqueta…',
  searchAria: 'Buscar prompts',
  filterByKindSelectAria: 'Filtrar por tipo',
  countSummary_one: '{{filtered}} de {{total}} prompt',
  countSummary_other: '{{filtered}} de {{total}} prompts',

  // Loading / empty states
  loadingPromptsAria: 'Cargando prompts',
  noMatchTitle: 'Ningún prompt coincide',
  noMatchBody: 'Pruebe a borrar la búsqueda o el filtro de tipo.',
  clearFilters: 'Borrar filtros',
  emptyTitle: 'Aún no hay prompts',
  emptyBody: 'Cree un prompt reutilizable que puedan elegir los nodos de IA de su flujo de trabajo.',

  // View toggle / collection-view canon
  subNoDescription: 'Sin descripción',
  openPrompt: 'Abrir {{name}}',
  usePromptAction: 'Usar',

  // Card actions
  editLabel: 'Editar {{name}}',
  deleteLabel: 'Eliminar {{name}}',
  tierOneFindingTitle: 'Hallazgo del subconjunto de nivel 1 — consulte structured-output-subset.md',

  // Delete modal
  deleteModalLabel: 'Eliminar {{name}}',
  deleteModalTitle: 'Eliminar prompt',
  deleteModalBodyPrefix: 'Eliminar',
  deleteModalBodySuffix:
    '? Esto no se puede deshacer — cualquier nodo de flujo de trabajo que aún lo referencie recurrirá a su valor predeterminado en línea.',
  deletePromptButton: 'Eliminar prompt',

  // Editor modal
  editModalTitle: 'Editar prompt',
  newModalTitle: 'Nuevo prompt',
  fieldName: 'Nombre',
  namePlaceholder: 'p. ej., Editor de tono de voz',
  fieldKind: 'Tipo',
  fieldDescription: 'Descripción',
  descriptionPlaceholder: 'Qué hace este prompt y cuándo usarlo.',
  fieldPromptText: 'Texto del prompt',
  promptTextPlaceholderUser: 'Plantilla estilo Mustache. Use {{token}} para las entradas.',
  promptTextPlaceholderSystem: 'La instrucción de sistema. Defina rol, tono y forma de la salida.',
  fieldTags: 'Etiquetas',
  tagsHint: '(separadas por comas)',
  tagsPlaceholder: 'editorial, redacción',
  templateIdLabel: 'ID de plantilla',
  templateIdHelp: 'Los ID son inmutables una vez creados para que las referencias existentes no se rompan.',
  saveChanges: 'Guardar cambios',
  createPrompt: 'Crear prompt',
  errorNameRequired: 'El nombre es obligatorio.',
  errorTextRequired: 'El texto del prompt es obligatorio.',

  // Detail modal
  detailRef: 'Ref',
  detailKind: 'Tipo',
  detailDescription: 'Descripción',
  detailVariables: 'Variables',
  variableMeta: '({{type}})',
  variableMetaFromSource: '({{type}} de {{source}})',
  variableDefault: 'predeterminado: {{value}}',
  previewLabel: 'Vista previa (renderizado local)',
  missingRequired: 'Faltan obligatorios: {{vars}}',
  localRenderNotePrefix: 'Este es un renderizado local estilo Mustache. Una vez que el host anuncie',
  localRenderNoteMiddle: ', la vista previa se enrutará a través de',
  localRenderNoteSuffix: 'para el invariante de hash determinista.',

  // Prompt picker input
  pickerFailedToLoad: 'No se pudieron cargar los prompts: {{error}}',
  pickerNone: '— ninguno —',
  pickerOptionWithName: '{{name}} ({{ref}})',
  pickerShowBody: 'Mostrar el cuerpo de la plantilla',
  pickerVariables: 'Variables: {{vars}}',

  // Tier-1 lint findings (rendered as chips)
  lintNoOneOf: '`oneOf` — Gemini lo descarta silenciosamente; prefiera `anyOf` o una unión con discriminador',
  lintObjectNeedsAdditionalPropertiesFalse:
    'al esquema de objeto le falta `additionalProperties: false` — obligatorio para el modo estricto de OpenAI',
  loadFailedTitle: "No se pudo cargar la biblioteca de prompts",
  loadFailedBody: "Es una lectura fallida, no una biblioteca vacía: tus prompts siguen ahí.",
  retry: "Reintentar",
  // ADR 0993 D8 — the Team library tab
  tabsLabel: 'Colecciones de prompts',
  tabMine: 'Mis prompts',
  tabTeam: 'Biblioteca del equipo',
  shareWithTeamLabel: 'Compartir {{name}} con su equipo',
  teamToolbarAria: 'Biblioteca del equipo',
  teamOrgPickerAria: 'Organización',
  teamHint: 'Escriba /p- en un chat para insertar uno de estos. Lo revisa antes de enviarlo.',
  teamPublishNew: '+ Publicar un prompt',
  teamPublishTitle: 'Publicar en la Biblioteca del equipo',
  teamEditTitle: 'Editar prompt del equipo',
  teamPublishButton: 'Publicar',
  teamLoadFailedTitle: 'No se pudo cargar la Biblioteca del equipo',
  teamLoadFailedBody: 'Es una lectura fallida, no una biblioteca vacía. Los prompts de su equipo siguen ahí.',
  teamLoadingAria: 'Cargando la Biblioteca del equipo',
  teamEmptyTitle: 'Aún no hay prompts del equipo',
  teamEmptyBody: 'Publique un prompt, o comparta uno de Mis prompts, para que toda la organización pueda usarlo.',
  teamYours: 'Suyo',
  teamUnavailable: 'Falta la plantilla',
  teamUseInChat: 'Usar en el chat',
  teamUseFailed: 'No se pudo abrir este prompt en el chat. Inténtelo de nuevo.',
  teamDeleteTitle: '¿Eliminar {{name}}?',
  teamDeleteBody: 'Desaparece de la Biblioteca del equipo y de /p- en el chat. Su enlace público, si lo tiene, deja de funcionar.',
  teamDeleted: 'Se eliminó {{name}}',
  teamDeleteFailed: 'No se pudo eliminar este prompt. Inténtelo de nuevo.',
  teamSaved: 'Se guardó {{name}}',
  teamPublished: 'Se publicó {{name}}',
  teamConflict: 'Alguien cambió este prompt desde que lo abrió. Sus cambios siguen en el formulario; recargue la versión más reciente para continuar.',
  teamSaveFailed: 'No se pudo guardar este prompt. Inténtelo de nuevo.',
  teamBindsTemplate: 'Este prompt usa la plantilla {{ref}}. Para cambiar su texto, edite la plantilla en Mis prompts.',
  teamOrgsEmptyClause: 'La Biblioteca del equipo pertenece a una organización',
  teamOrgsFailedClause: 'La Biblioteca del equipo nunca se solicitó',
  fieldVisibility: 'Quién puede usarlo',
  visibilityHelp: 'Solo usted: privado. Equipo: toda la organización.',
  visibilityPrivate: 'Solo usted',
  visibilityOrg: 'Equipo',
  visibilityShared: 'Equipo, con enlace público',
  teamForbidden: 'Puede usar los prompts del equipo, pero no cambiarlos. Pida acceso de edición a un administrador de la organización.',
  teamGone: 'Este prompt ya no existe. Se recargó la biblioteca.',
  teamConflictReload: 'Recargar la versión más reciente',
  teamSaving: 'Guardando…',
  teamUnavailableHelp: 'Falta su texto, así que no se puede usar. Edítelo para restaurar el texto, o elimínelo.',
  teamVisibilityOwnerOnly: 'Solo quien publicó este prompt puede cambiar quién puede usarlo.',
  commandInsertDescription: 'Insertar: {{name}}',
  commandInsertFailed: 'No se pudo insertar el prompt del equipo {{command}}. Puede que se haya eliminado o cambiado. Su comando volvió al editor.',
} as const;
