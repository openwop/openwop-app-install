/**
 * `knowledge` namespace — user-facing strings for the knowledge-curation area
 * (`src/knowledge/`): the subject-agnostic SubjectKnowledgePanel (ADR 0046
 * follow-on) that creates/binds KB collections, ingests documents, and searches
 * the corpus. FLAT camelCase keys, one per line (ADR 0065). Plural keys use
 * i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // SubjectKnowledgePanel — errors / notices
  loadError: 'No se ha podido cargar el conocimiento.',
  actionError: 'La acción ha fallado.',
  sourceCreated: 'Fuente de conocimiento creada.',
  documentAdded: 'Documento añadido.',
  documentRemoved: 'Documento eliminado.',
  sourceUnbound: 'Fuente desvinculada.',
  // SubjectKnowledgePanel — list / states
  loadingTitle: 'Cargando conocimiento…',
  emptyTitle: 'Aún no hay fuentes de conocimiento',
  // CreateSource — form
  workspaceLabel: 'Espacio de trabajo',
  newSourceLabel: 'Nombre de la nueva fuente',
  newSourcePlaceholder: 'Mi manual de estrategias',
  createSource: 'Crear fuente',
  // CollectionCard — header / docs
  docCount_one: '{{count}} documento',
  docCount_other: '{{count}} documentos',
  unbind: 'Desvincular',
  externalUnverified: 'Externo · no verificado',
  externalUnverifiedTitle: 'Importado de una fuente externa: se trata como no fiable (ADR 0038 §C).',
  removeDocument: 'Eliminar documento',
  // CollectionCard — ingest form
  documentTitleLabel: 'Título del documento',
  documentTitlePlaceholder: 'Prioridades del T3',
  documentTextLabel: 'Texto del documento',
  documentTextPlaceholder: 'Pegue el contenido que desea citar.',
  addDocument: 'Añadir documento',
  // RetrieveSection — search
  searchError: 'La búsqueda ha fallado.',
  searching: 'Buscando…',
  search: 'Buscar',
  note: 'nota',
  external: 'externo',
  noMatches: 'Aún no hay coincidencias.',
  syncedBadge: 'Sincronizado',
  syncedTitle: 'Sincronizado automáticamente desde {{source}} — el contenido es de solo lectura aquí',
  syncedNotice: 'Esta colección se mantiene sincronizada con tus elementos de {{source}}. Gestiónalos en esa página; los documentos aquí son de solo lectura.',
  syncedSource_strategy: 'Estrategia',
  'syncedSource_priority-matrix': 'Matriz de prioridades',
} as const;
