/**
 * `knowledge` namespace — user-facing strings for the knowledge-curation area
 * (`src/knowledge/`): the subject-agnostic SubjectKnowledgePanel (ADR 0046
 * follow-on) that creates/binds KB collections, ingests documents, and searches
 * the corpus. FLAT camelCase keys, one per line (ADR 0065). Plural keys use
 * i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // SubjectKnowledgePanel — errors / notices
  loadError: 'Falha ao carregar o conhecimento.',
  actionError: 'A ação falhou.',
  sourceCreated: 'Fonte de conhecimento criada.',
  documentAdded: 'Documento adicionado.',
  documentRemoved: 'Documento removido.',
  sourceUnbound: 'Fonte desvinculada.',
  // SubjectKnowledgePanel — list / states
  loadingTitle: 'Carregando conhecimento…',
  emptyTitle: 'Nenhuma fonte de conhecimento ainda',
  // CreateSource — form
  workspaceLabel: 'Workspace',
  newSourceLabel: 'Nome da nova fonte',
  newSourcePlaceholder: 'Meu manual',
  createSource: 'Criar fonte',
  // CollectionCard — header / docs
  docCount_one: '{{count}} documento',
  docCount_other: '{{count}} documentos',
  unbind: 'Desvincular',
  externalUnverified: 'Externo · não verificado',
  externalUnverifiedTitle: 'Importado de uma fonte externa — tratado como não confiável (ADR 0038 §C).',
  removeDocument: 'Remover documento',
  // CollectionCard — ingest form
  documentTitleLabel: 'Título do documento',
  documentTitlePlaceholder: 'Prioridades do 3º tri',
  documentTextLabel: 'Texto do documento',
  documentTextPlaceholder: 'Cole o conteúdo a ser citado.',
  addDocument: 'Adicionar documento',
  // RetrieveSection — search
  searchError: 'A busca falhou.',
  searching: 'Buscando…',
  search: 'Buscar',
  note: 'nota',
  external: 'externo',
  noMatches: 'Nenhuma correspondência ainda.',
  syncedBadge: 'Sincronizado',
  syncedTitle: 'Sincronizado automaticamente de {{source}} — o conteúdo é somente leitura aqui',
  syncedNotice: 'Esta coleção é mantida em sincronia com seus itens de {{source}}. Gerencie-os naquela página; os documentos aqui são somente leitura.',
  syncedSource_strategy: 'Estratégia',
  'syncedSource_priority-matrix': 'Matriz de Prioridades',
} as const;
