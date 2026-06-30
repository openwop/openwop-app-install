/**
 * `kb` namespace — Knowledge Base / RAG feature copy (ADR 0011).
 * Feature-specific strings; generic actions/states reuse `common:`.
 */
export const messages = {
  // Page header
  eyebrow: 'Plataforma',
  title: 'Base de conocimiento',
  lede: 'Dale a tu IA una biblioteca de tus propios documentos para consultar: encuentra los pasajes más relevantes y los cita en sus respuestas.',
  // Feature gate / empty states
  disabledTitle: 'La base de conocimiento no está habilitada',
  disabledBody: 'Pida a un administrador que habilite la función de base de conocimiento para este inquilino.',
  noOrgsTitle: 'Sin organizaciones',
  noOrgsBody: 'Cree primero una organización — las colecciones pertenecen a una organización.',
  selectCollectionTitle: 'Seleccione una colección',
  selectCollectionBody: 'Elija una colección a la izquierda, o cree una — luego añada documentos y busque.',
  // Org picker
  organizationLabel: 'Organización',
  // Collections panel
  collectionsHeading: 'Colecciones',
  noCollections: 'Aún no hay colecciones.',
  documentsTooltip: 'documentos',
  deleteCollection: 'Eliminar colección',
  newCollectionPlaceholder: 'Nueva colección',
  createCollection: 'Crear colección',
  // Search panel
  searchHeading: 'Buscar en “{{name}}”',
  searchPlaceholder: 'Haga una pregunta…',
  retrievalModeLabel: 'Recuperación',
  retrievalModeDense: 'Estándar (semántica)',
  retrievalModeHybrid: 'Híbrida (palabras clave + semántica)',
  retrievalModeRerank: 'Mejor coincidencia (híbrida + reordenamiento)',
  retrievalModeFailed: 'No se pudo actualizar el modo de recuperación.',
  noMatches: 'Sin coincidencias — añada documentos, o pruebe con otra pregunta.',
  cosineScoreTooltip: 'puntuación de coseno',
  // Ingest panel
  addDocumentHeading: 'Añadir un documento',
  titlePlaceholder: 'Título (opcional)',
  ingestPlaceholder: 'Pegue texto para fragmentar + incrustar en esta colección…',
  untitled: 'Sin título',
  ingest: 'Ingerir',
  // Documents panel
  documentsHeading: 'Documentos',
  noDocuments: 'Aún no hay documentos.',
  noDocumentsTitle: 'Sin documentos',
  chunksTooltip: 'fragmentos',
  chunkCount_one: '{{count}} fragmento',
  chunkCount_other: '{{count}} fragmentos',
  deleteDocument: 'Eliminar documento',
  // Procedencia del documento (chip + subtítulo de la vista)
  sourceText: 'Texto pegado',
  sourceMedia: 'Importación de medios',
  // Filtro de la lista de documentos + vista cuadrícula/lista (canon §4.5)
  docFilterGroup: 'Filtrar documentos',
  docFilterPlaceholder: 'Filtrar documentos…',
  docFilterAria: 'Filtrar documentos por título',
  docNoMatchTitle: 'No hay documentos coincidentes',
  docNoMatchBody: 'Ningún documento coincide con tu búsqueda. Prueba con otro término.',
  clearDocSearch: 'Limpiar búsqueda',
  // Toast errors
  loadCollectionsFailed: 'No se pudieron cargar las colecciones.',
  loadOrgsFailed: 'No se pudieron cargar las organizaciones.',
  loadDocumentsFailed: 'No se pudieron cargar los documentos.',
  createFailed: 'Error al crear.',
  deleteFailed: 'Error al eliminar.',
  ingestFailed: 'Error al ingerir.',
  uploadFileLabel: 'Subir un archivo',
  uploadFileHint: 'PDF, DOCX o texto: se extrae y se añade a esta colección.',
  documentAdded: 'Documento añadido.',
  fileTooLarge: 'Ese archivo es demasiado grande (máx. {{max}} MB).',
  uploading: 'Subiendo…',
  searchFailed: 'Error al buscar.',
  managedBadge: 'Sincronizado',
  managedTitle: 'Sincronizado automáticamente desde {{source}} — solo lectura aquí',
  managedNotice: 'Esta colección se mantiene sincronizada con tus elementos de {{source}}. Gestiónalos en esa página; los documentos aquí son de solo lectura.',
  managedSource_strategy: 'Estrategia',
  'managedSource_priority-matrix': 'Matriz de prioridades',
} as const;
