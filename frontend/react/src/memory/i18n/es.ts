/**
 * `memory` namespace — user-facing strings for the memory area (`src/memory/`):
 * the subject MemoryBrowser (ADR 0041) and the `/memory` MemoryInspectorPage
 * (RFC 0004). FLAT camelCase keys, one per line (ADR 0065). Plural keys use
 * i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // MemoryBrowser — errors
  loadError: 'No se han podido cargar las memorias.',
  addError: 'No se ha podido añadir la memoria.',
  removeError: 'No se ha podido eliminar la memoria.',
  // MemoryBrowser — add form
  addLabel: 'Añadir una memoria',
  addPlaceholderDefault: 'Un hecho, una preferencia o un detalle que recordar.',
  storedCount_one: '{{n}} memoria almacenada',
  storedCount_other: '{{n}} memorias almacenadas',
  addMemory: 'Añadir memoria',
  // MemoryBrowser — list / states
  loadingTitle: 'Cargando memorias…',
  emptyTitle: 'Aún no hay memorias',
  emptyBodyDefault: 'Añada aquí hechos y preferencias; se recuperan cuando son relevantes.',
  externalUnverified: 'Externa · sin verificar',
  externalUnverifiedTitle: 'Importada de una fuente externa: se trata como no fiable (ADR 0038 §C).',
  removeMemory: 'Eliminar memoria',
  // MemoryInspectorPage — header
  eyebrow: 'Memoria',
  inspectorTitle: 'Inspector de memoria',
  inspectorLedePrefix:
    'Explore el registro de memoria del tenant. Las entradas se escriben de forma interna en el host: el ejecutor escribe un resumen de la ejecución al completarse. Las lecturas y eliminaciones se limitan a su credencial en el servidor; el inspector no puede ver la memoria de otro tenant.',
  inspectorLedeShowing: 'Mostrando',
  // MemoryInspectorPage — redaction
  redactedBadge: 'redactado',
  redactedTitle: 'Contiene material secreto redactado por el host (SR-1)',
  // MemoryInspectorPage — search / filter
  searchLabel: 'Buscar',
  searchHint: '(contenido o etiquetas)',
  searchPlaceholder: 'filtrar entradas…',
  tagFilterLabel: 'Filtro de etiquetas',
  tagFilterHint: '(en el servidor)',
  tagFilterPlaceholder: 'p. ej. run-summary',
  // MemoryInspectorPage — columns
  columnContent: 'Contenido',
  columnTags: 'Etiquetas',
  columnCreated: 'Creado',
  ttlSuffix: 'TTL',
  expiresTitle: 'Caduca el {{date}}',
  // MemoryInspectorPage — delete
  deleteEntryTitle: 'Eliminar esta entrada de memoria',
  deleteEntryAria: 'Eliminar la entrada de memoria {{id}}',
  confirmDelete: '¿Eliminar la entrada de memoria "{{id}}"? Esta acción no se puede deshacer.',
  confirmBulkDelete_one: '¿Eliminar {{n}} entrada de memoria? Esta acción no se puede deshacer.',
  confirmBulkDelete_other: '¿Eliminar {{n}} entradas de memoria? Esta acción no se puede deshacer.',
  deleteSuccess: 'Entrada de memoria eliminada.',
  deleteError: 'No se ha podido eliminar la entrada de memoria.',
  bulkDeleteSuccess_one: 'Se ha eliminado {{n}} entrada de memoria.',
  bulkDeleteSuccess_other: 'Se han eliminado {{n}} entradas de memoria.',
  bulkDeleteError_one: 'No se ha podido eliminar {{n}} entrada.',
  bulkDeleteError_other: 'No se han podido eliminar {{n}} entradas.',
  deleteSelected: 'Eliminar seleccionadas',
  // MemoryInspectorPage — count line
  entryCount_one: '{{n}} entrada',
  entryCount_other: '{{n}} entradas',
  entryCountOf: '{{shown}} de {{total}}',
  // MemoryInspectorPage — table / empty
  tableCaption: 'Entradas de memoria',
  emptyNoMatchTitle: 'No hay entradas de memoria coincidentes',
  emptyNoEntriesTitle: 'Aún no hay entradas de memoria',
  emptyNoMatchBody: 'Ninguna entrada coincide con la búsqueda o el filtro de etiquetas actual. Borre los filtros para ver el registro completo.',
  emptyNoEntriesBody: 'Las entradas se escriben de forma interna en el host: el ejecutor escribe un resumen de la ejecución al completarse. Ejecute un flujo de trabajo para poblar el registro.',
  // memoryClient — errors
  getEntryError: 'getMemoryEntry ha devuelto {{status}}',
  deleteEntryRequestError: 'deleteMemoryEntry ha devuelto {{status}}',
} as const;
