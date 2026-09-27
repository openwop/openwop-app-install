/**
 * `memory` namespace — user-facing strings for the memory area (`src/memory/`):
 * the subject MemoryBrowser (ADR 0041) and the `/memory` MemoryInspectorPage
 * (RFC 0004). FLAT camelCase keys, one per line (ADR 0065). Plural keys use
 * i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // MemoryBrowser — errors
  loadError: 'Falha ao carregar as memórias.',
  addError: 'Falha ao adicionar a memória.',
  removeError: 'Falha ao remover a memória.',
  // MemoryBrowser — add form
  addLabel: 'Adicionar uma memória',
  addPlaceholderDefault: 'Um fato, preferência ou detalhe para lembrar.',
  storedCount_one: '{{n}} memória armazenada',
  storedCount_other: '{{n}} memórias armazenadas',
  addMemory: 'Adicionar memória',
  // MemoryBrowser — list / states
  loadingTitle: 'Carregando memórias…',
  emptyTitle: 'Nenhuma memória ainda',
  emptyBodyDefault: 'Adicione fatos e preferências aqui; eles são recuperados quando relevantes.',
  externalUnverified: 'Externa · não verificada',
  externalUnverifiedTitle: 'Importada de uma fonte externa — tratada como não confiável (ADR 0038 §C).',
  autoLearned: 'Aprendida automaticamente',
  autoLearnedTitle: 'Seu assistente deduziu isto de uma conversa — não foi você quem digitou, portanto é tratada como não verificada.',
  learnedOn: 'Aprendida em {{date}}',
  recallOnlyDisclosure_one: 'Mais {{n}} item foi lembrado de uma conversa e não aparece aqui. Seu assistente ainda pode recordá-lo; ele não é editável nesta lista.',
  recallOnlyDisclosure_other: 'Mais {{n}} itens foram lembrados de conversas e não aparecem aqui. Seu assistente ainda pode recordá-los; eles não são editáveis nesta lista.',
  removeMemory: 'Remover memória',
  // MemoryInspectorPage — header
  eyebrow: 'Memória',
  inspectorTitle: 'Inspetor de memória',
  inspectorLedePrefix:
    'Navegue pelo ledger de memória do tenant. As entradas são gravadas internamente pelo host — o executor grava um resumo de execução na conclusão. Leituras e exclusões têm escopo na sua credencial do lado do servidor; o inspetor não consegue ver a memória de outro tenant.',
  inspectorLedeShowing: 'Mostrando',
  // MemoryInspectorPage — redaction
  redactedBadge: 'censurado',
  redactedTitle: 'Contém material secreto censurado pelo host (SR-1)',
  // MemoryInspectorPage — search / filter
  searchLabel: 'Pesquisar',
  searchHint: '(conteúdo ou tags)',
  searchPlaceholder: 'filtrar entradas…',
  tagFilterLabel: 'Filtro de tag',
  tagFilterHint: '(do lado do servidor)',
  tagFilterPlaceholder: 'ex.: run-summary',
  // MemoryInspectorPage — columns
  columnContent: 'Conteúdo',
  columnTags: 'Tags',
  columnCreated: 'Criado',
  ttlSuffix: 'TTL',
  expiresTitle: 'Expira em {{date}}',
  // MemoryInspectorPage — delete
  deleteEntryTitle: 'Excluir esta entrada de memória',
  deleteEntryAria: 'Excluir entrada de memória {{id}}',
  confirmDelete: 'Excluir a entrada de memória "{{id}}"? Isso não pode ser desfeito.',
  confirmBulkDelete_one: 'Excluir {{n}} entrada de memória? Isso não pode ser desfeito.',
  confirmBulkDelete_other: 'Excluir {{n}} entradas de memória? Isso não pode ser desfeito.',
  deleteSuccess: 'Entrada de memória excluída.',
  deleteError: 'Não foi possível excluir a entrada de memória.',
  bulkDeleteSuccess_one: '{{n}} entrada de memória excluída.',
  bulkDeleteSuccess_other: '{{n}} entradas de memória excluídas.',
  bulkDeleteError_one: '{{n}} entrada não pôde ser excluída.',
  bulkDeleteError_other: '{{n}} entradas não puderam ser excluídas.',
  deleteSelected: 'Excluir selecionadas',
  // MemoryInspectorPage — count line
  entryCount_one: '{{n}} entrada',
  entryCount_other: '{{n}} entradas',
  entryCountOf: '{{shown}} de {{total}}',
  // MemoryInspectorPage — table / empty
  tableCaption: 'Entradas de memória',
  emptyNoMatchTitle: 'Nenhuma entrada de memória correspondente',
  emptyNoEntriesTitle: 'Nenhuma entrada de memória ainda',
  emptyNoMatchBody: 'Nenhuma entrada corresponde à pesquisa ou ao filtro de tag atual. Limpe os filtros para ver o ledger completo.',
  clearFilters: 'Limpar filtros',
  emptyNoEntriesBody: 'As entradas são gravadas internamente pelo host — o executor grava um resumo de execução na conclusão. Execute um workflow para popular o ledger.',
  // memoryClient — errors
  getEntryError: 'getMemoryEntry retornou {{status}}',
  deleteEntryRequestError: 'deleteMemoryEntry retornou {{status}}',
  removeMemoryConfirmBody: 'Remover esta memória? O agente não vai mais lembrá-la.',
  storedUnknown: "Memórias armazenadas: desconhecido",
  loadFailedTitle: "Não foi possível carregar estas memórias",
  loadFailedBody: "Esta é uma leitura que falhou, não uma memória vazia: o que estiver armazenado continua lá.",
  retry: "Tentar novamente",
} as const;
