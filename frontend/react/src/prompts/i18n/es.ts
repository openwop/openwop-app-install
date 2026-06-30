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
    'Prompts reutilizables que pueden elegir los nodos de IA de su flujo de trabajo. Edite uno en un solo lugar y cada nodo que lo use se actualizará la próxima vez que se ejecute — sin copiar y pegar, sin desviaciones. Los prompts de sistema definen el rol y el tono de la IA; los prompts de usuario dan forma a lo que le pide.',
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
  pickerLoading: 'Cargando prompts…',
  pickerNone: '— ninguno —',
  pickerOptionWithName: '{{name}} ({{ref}})',
  pickerShowBody: 'Mostrar el cuerpo de la plantilla',
  pickerVariables: 'Variables: {{vars}}',

  // Tier-1 lint findings (rendered as chips)
  lintNoOneOf: '`oneOf` — Gemini lo descarta silenciosamente; prefiera `anyOf` o una unión con discriminador',
  lintObjectNeedsAdditionalPropertiesFalse:
    'al esquema de objeto le falta `additionalProperties: false` — obligatorio para el modo estricto de OpenAI',
} as const;
