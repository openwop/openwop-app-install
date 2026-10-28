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
    'Prompts reutilizáveis para o chat e para os nós de IA dos seus workflows. Os prompts que você cria em Meus prompts ficam neste navegador; compartilhe um com sua equipe para adicioná-lo à Biblioteca da equipe, onde qualquer pessoa da organização pode inseri-lo em um chat com /p-.',
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
  pickerNone: '— nenhum —',
  pickerOptionWithName: '{{name}} ({{ref}})',
  pickerShowBody: 'Mostrar corpo do template',
  pickerVariables: 'Variáveis: {{vars}}',

  // Tier-1 lint findings (rendered as chips)
  lintNoOneOf: '`oneOf` — o Gemini descarta silenciosamente; prefira `anyOf` ou union com discriminador',
  lintObjectNeedsAdditionalPropertiesFalse:
    'esquema de objeto sem `additionalProperties: false` — obrigatório para o modo strict da OpenAI',
  loadFailedTitle: "Não foi possível carregar a biblioteca de prompts",
  loadFailedBody: "Esta é uma leitura que falhou, não uma biblioteca vazia: seus prompts continuam lá.",
  retry: "Tentar novamente",
  // ADR 0993 D8 — the Team library tab
  tabsLabel: 'Coleções de prompts',
  tabMine: 'Meus prompts',
  tabTeam: 'Biblioteca da equipe',
  shareWithTeamLabel: 'Compartilhar {{name}} com sua equipe',
  teamToolbarAria: 'Biblioteca da equipe',
  teamOrgPickerAria: 'Organização',
  teamHint: 'Digite /p- em um chat para inserir um destes. Você revisa antes de enviar.',
  teamPublishNew: '+ Publicar um prompt',
  teamPublishTitle: 'Publicar na Biblioteca da equipe',
  teamEditTitle: 'Editar prompt da equipe',
  teamPublishButton: 'Publicar',
  teamLoadFailedTitle: 'Não foi possível carregar a Biblioteca da equipe',
  teamLoadFailedBody: 'Esta é uma leitura que falhou, não uma biblioteca vazia. Os prompts da sua equipe continuam lá.',
  teamLoadingAria: 'Carregando a Biblioteca da equipe',
  teamEmptyTitle: 'Ainda não há prompts da equipe',
  teamEmptyBody: 'Publique um prompt, ou compartilhe um de Meus prompts, para que toda a organização possa usá-lo.',
  teamYours: 'Seu',
  teamUnavailable: 'Modelo ausente',
  teamUseInChat: 'Usar no chat',
  teamUseFailed: 'Não foi possível abrir este prompt no chat. Tente novamente.',
  teamDeleteTitle: 'Excluir {{name}}?',
  teamDeleteBody: 'Ele some da Biblioteca da equipe e do /p- no chat. O link público, se houver, deixa de funcionar.',
  teamDeleted: '{{name}} excluído',
  teamDeleteFailed: 'Não foi possível excluir este prompt. Tente novamente.',
  teamSaved: '{{name}} salvo',
  teamPublished: '{{name}} publicado',
  teamConflict: 'Alguém alterou este prompt desde que você o abriu. Suas alterações continuam no formulário; recarregue a versão mais recente para continuar.',
  teamSaveFailed: 'Não foi possível salvar este prompt. Tente novamente.',
  teamBindsTemplate: 'Este prompt usa o modelo {{ref}}. Para mudar o texto, edite o modelo em Meus prompts.',
  teamOrgsEmptyClause: 'A Biblioteca da equipe pertence a uma organização',
  teamOrgsFailedClause: 'A Biblioteca da equipe nunca foi solicitada',
  fieldVisibility: 'Quem pode usar',
  visibilityHelp: 'Só você: privado. Equipe: toda a organização.',
  visibilityPrivate: 'Só você',
  visibilityOrg: 'Equipe',
  visibilityShared: 'Equipe, com link público',
  teamForbidden: 'Você pode usar os prompts da equipe, mas não alterá-los. Peça acesso de edição a um administrador da organização.',
  teamGone: 'Este prompt não existe mais. A biblioteca foi recarregada.',
  teamConflictReload: 'Recarregar a versão mais recente',
  teamSaving: 'Salvando…',
  teamUnavailableHelp: 'O texto está faltando, então ele não pode ser usado. Edite para restaurar o texto, ou exclua.',
  teamVisibilityOwnerOnly: 'Só quem publicou este prompt pode mudar quem pode usá-lo.',
  commandInsertDescription: 'Inserir: {{name}}',
  commandInsertFailed: 'Não foi possível inserir o prompt da equipe {{command}}. Ele pode ter sido excluído ou alterado. Seu comando voltou ao editor.',
} as const;
