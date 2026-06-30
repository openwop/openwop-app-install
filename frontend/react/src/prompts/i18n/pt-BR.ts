/**
 * `prompts` namespace — user-facing strings for the prompt-library area
 * (`src/prompts/`). FLAT camelCase keys, one per line (ADR 0065). Plural keys
 * use i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // Kind labels (filter + chips)
  kindAll: 'Todos',
  kindAllKinds: 'Todos os tipos',
  kindSystem: 'Sistema',
  kindUser: 'Usuário',
  kindFewShot: 'Few-shot',
  kindSchemaHint: 'Dica de esquema',

  // Page header
  pageEyebrow: 'Construir',
  pageTitle: 'Biblioteca de prompts',
  pageLede:
    'Prompts reutilizáveis que os nós de IA do seu workflow podem escolher. Edite um em um único lugar e todo nó que o usa se atualiza na próxima execução — sem copiar e colar, sem divergência. Prompts de sistema definem o papel e o tom da IA; prompts de usuário moldam o que você pede a ela.',
  newPrompt: '+ Novo prompt',

  // Tier-1 subset banner (segments — markup stays in the component)
  tierOneStrong: 'Subconjunto Tier-1',
  tierOnePosture: '({{posture}}):',
  tierOneFlagged_one: 'prompt de dica de esquema sinalizado contra',
  tierOneFlagged_other: 'prompts de dica de esquema sinalizados contra',
  tierOneLinkText: 'structured-output-subset.md',
  tierOneFindingHint: 'Chips inline em cada infrator apontam para a constatação específica.',

  // Key-figure band
  figureAllPrompts: 'Todos os prompts',
  filterByKindAria: 'Filtrar prompts por tipo',

  // Filter bar
  filterGroupAria: 'Filtrar prompts',
  searchPlaceholder: 'templateId, nome, descrição, tag…',
  searchAria: 'Buscar prompts',
  filterByKindSelectAria: 'Filtrar por tipo',
  countSummary_one: '{{filtered}} de {{total}} prompt',
  countSummary_other: '{{filtered}} de {{total}} prompts',

  // Loading / empty states
  loadingPromptsAria: 'Carregando prompts',
  noMatchTitle: 'Nenhum prompt corresponde',
  noMatchBody: 'Tente limpar a busca ou o filtro de tipo.',
  clearFilters: 'Limpar filtros',
  emptyTitle: 'Nenhum prompt ainda',
  emptyBody: 'Crie um prompt reutilizável que os nós de IA do seu workflow possam escolher.',

  // View toggle / collection-view canon
  subNoDescription: 'Sem descrição',
  openPrompt: 'Abrir {{name}}',
  usePromptAction: 'Usar',

  // Card actions
  editLabel: 'Editar {{name}}',
  deleteLabel: 'Excluir {{name}}',
  tierOneFindingTitle: 'Constatação do subconjunto Tier-1 — veja structured-output-subset.md',

  // Delete modal
  deleteModalLabel: 'Excluir {{name}}',
  deleteModalTitle: 'Excluir prompt',
  deleteModalBodyPrefix: 'Excluir',
  deleteModalBodySuffix:
    '? Isso não pode ser desfeito — qualquer nó de workflow que ainda o referencie voltará para seu padrão inline.',
  deletePromptButton: 'Excluir prompt',

  // Editor modal
  editModalTitle: 'Editar prompt',
  newModalTitle: 'Novo prompt',
  fieldName: 'Nome',
  namePlaceholder: 'ex.: Editor de tom de voz',
  fieldKind: 'Tipo',
  fieldDescription: 'Descrição',
  descriptionPlaceholder: 'O que este prompt faz e quando usá-lo.',
  fieldPromptText: 'Texto do prompt',
  promptTextPlaceholderUser: 'Template no estilo Mustache. Use {{token}} para entradas.',
  promptTextPlaceholderSystem: 'A instrução de sistema. Defina papel, tom e formato de saída.',
  fieldTags: 'Tags',
  tagsHint: '(separadas por vírgula)',
  tagsPlaceholder: 'editorial, escrita',
  templateIdLabel: 'ID do template',
  templateIdHelp: 'IDs são imutáveis depois de criados para que referências existentes não quebrem.',
  saveChanges: 'Salvar alterações',
  createPrompt: 'Criar prompt',
  errorNameRequired: 'O nome é obrigatório.',
  errorTextRequired: 'O texto do prompt é obrigatório.',

  // Detail modal
  detailRef: 'Ref',
  detailKind: 'Tipo',
  detailDescription: 'Descrição',
  detailVariables: 'Variáveis',
  variableMeta: '({{type}})',
  variableMetaFromSource: '({{type}} de {{source}})',
  variableDefault: 'padrão: {{value}}',
  previewLabel: 'Prévia (renderização local)',
  missingRequired: 'Obrigatório(s) ausente(s): {{vars}}',
  localRenderNotePrefix: 'Esta é uma renderização local no estilo Mustache. Quando o host anunciar',
  localRenderNoteMiddle: ', a prévia passará por',
  localRenderNoteSuffix: 'para o invariante de hash determinístico.',

  // Prompt picker input
  pickerFailedToLoad: 'Falha ao carregar prompts: {{error}}',
  pickerLoading: 'Carregando prompts…',
  pickerNone: '— nenhum —',
  pickerOptionWithName: '{{name}} ({{ref}})',
  pickerShowBody: 'Mostrar corpo do template',
  pickerVariables: 'Variáveis: {{vars}}',

  // Tier-1 lint findings (rendered as chips)
  lintNoOneOf: '`oneOf` — o Gemini descarta silenciosamente; prefira `anyOf` ou union com discriminador',
  lintObjectNeedsAdditionalPropertiesFalse:
    'esquema de objeto sem `additionalProperties: false` — obrigatório para o modo strict da OpenAI',
} as const;
