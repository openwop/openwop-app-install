/**
 * `media` namespace — user-facing copy for the media library feature.
 * Feature-self-contained: every media string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Plataforma',
  title: 'Biblioteca de mídia',
  lede: 'Ativos + coleções no escopo da organização.',

  // Gating / empty states
  notEnabledTitle: 'A biblioteca de mídia não está ativada',
  notEnabledBody: 'Peça a um administrador para ativar o recurso de mídia para este tenant.',
  noOrgsTitle: 'Nenhuma organização',
  noOrgsBody: 'Crie uma organização primeiro — coleções de mídia pertencem a uma organização.',
  noAssetsTitle: 'Nenhum ativo',
  noAssetsBody: 'Faça upload de um arquivo para iniciar esta coleção.',
  orgsFailedTitle: 'Não foi possível carregar as organizações',
  orgsFailedBody: 'A leitura das organizações falhou, portanto a biblioteca de mídia ainda não pode ser aberta.',
  collectionsFailedTitle: 'Não foi possível carregar as coleções',
  collectionsFailedBody: 'A leitura das coleções falhou. Isso não significa que a organização não tenha coleções.',

  // aria-labels
  orgPickerLabel: 'Organização',

  // Collections sidebar
  collectionsHeading: 'Coleções',
  allAssets: 'Todos os ativos',
  uncategorized: 'Sem categoria',
  deleteCollectionLabel: 'Excluir coleção',
  newCollectionPlaceholder: 'Nova coleção',

  // Assets toolbar
  searchPlaceholder: 'Buscar por nome…',
  upload: 'Upload',
  deleteAssetLabel: 'Excluir ativo',
  assetResultsLabel: 'Recursos de mídia',

  // Asset-list filterbar + grid/list toggle
  filterGroup: 'Filtrar ativos',
  filterAria: 'Filtrar ativos por nome',
  noMatchTitle: 'Nenhum ativo correspondente',
  noMatchBody: 'Nenhum ativo corresponde à sua busca. Tente outro termo.',
  clearSearch: 'Limpar busca',

  // Asset usage badge ({{used}} is the locale-formatted count; {{count}} drives plural selection)
  usageCount_one: 'usado {{used}}×',
  usageCount_other: 'usado {{used}}×',
  unused: 'não usado',

  // Toasts — success / info
  collectionCreated: 'Coleção criada.',
  collectionDeleted: 'Coleção excluída (ativos realocados).',
  assetDeleted: '{{name}} excluído. O foco foi movido para a lista de recursos.',
  uploaded: 'Upload de {{name}} concluído.',

  // Toasts / errors
  loadOrgsFailed: 'Falha ao carregar as organizações.',
  loadAssetsFailed: 'Falha ao carregar os ativos.',
  assetsFailedTitle: 'Não foi possível carregar os recursos',
  assetsFailedBody: 'A biblioteca está indisponível no momento — é uma leitura com falha, não uma biblioteca vazia.',
  createFailed: 'Falha ao criar.',
  deleteFailed: 'Falha ao excluir.',
  uploadFailed: 'Falha no upload.',
  deleteAssetConfirm: 'Excluir este recurso? Esta ação não pode ser desfeita.',
  deleteCollectionConfirm: 'Excluir a coleção "{{name}}"?',

  // Media picker dialog (ADR 0206 B4)
  pickerTitle: 'Escolher um recurso',
  pickerSearchPlaceholder: 'Buscar recursos…',
  pickerUpload: 'Enviar',
  pickerEmptyTitle: 'Nenhum recurso encontrado',
  pickerLoadFailedTitle: 'Não foi possível carregar suas mídias',
  pickerLoadFailedBody: 'A leitura da biblioteca falhou — ela não está vazia até que uma leitura bem-sucedida confirme.',
  pickerEmpty: 'Envie um para começar ou ajuste a busca.',
  pickerChooseAria: 'Escolher {{name}}',
  pickerUploaded: '"{{name}}" enviado.',
  pickerUploadFailed: 'Falha no upload.',

  // "Used by" (ADR 0206 B4 usage refs)
  usedByLabel: 'Onde isto é usado?',
  usedByTitle: 'Usado por — {{name}}',
  usedByFailed: 'Não foi possível verificar onde este recurso é usado. Isto NÃO confirma que ele esteja sem uso — excluí-lo ainda pode quebrar uma página.',
  usedByFailedTitle: 'Não foi possível verificar o uso',
  usedByEmpty: 'Não é referenciado por nenhuma página.',
  usedByKindCmsPage: 'Página do CMS',
  usedByKindCampaign: 'Campanha',
  usedByKindCreativeBrief: 'Briefing criativo',
  chooseImage: "Escolher imagem",
  replaceImage: "Substituir imagem",
  clearImage: "Limpar {{field}}",
  useImageUrl: "Usar URL da imagem",
  imageUrl: "URL da imagem para {{field}}",
  imageUrlPlaceholder: "https://exemplo.com/imagem.jpg",
  applyUrl: "Aplicar",
  cancelUrl: "Cancelar",

  // ADR 0363 P1 — texto alternativo
  altEditLabel: 'Editar texto alternativo',
  altPresentLabel: 'Com texto alternativo',
  altMissingLabel: 'Sem texto alternativo',
  altDecorativeChip: 'Decorativa',
  altDialogTitle: 'Texto alternativo — {{name}}',
  altDialogHelp: 'O texto alternativo descreve uma imagem para usuários de leitores de tela. Escreva uma descrição concisa, gere com IA ou marque a imagem como decorativa.',
  altTextLabel: 'Texto alternativo',
  altTextPlaceholder: 'ex. Um barista servindo latte art em uma cafeteria ensolarada',
  altCharCount: '{{n}} / {{max}}',
  altDecorativeLabel: 'Esta imagem é decorativa (sem texto alternativo)',
  altGenerate: 'Gerar com IA',
  altGenerating: 'Gerando…',
  altGenerated: 'Texto alternativo sugerido.',
  altGeneratedDecorative: 'A imagem parece decorativa — marcada assim (sem texto alternativo).',
  altGenerateError: 'Não foi possível gerar o texto alternativo.',
  altSaveError: 'Não foi possível salvar o texto alternativo.',

  // ADR 0401 — AI image generation
  generateImage: 'Gerar com IA',
  generateDialogTitle: 'Gerar uma imagem',
  generateLoadFailed: 'Não foi possível carregar os provedores de imagens.',
  generateNoProviderTitle: 'Nenhum provedor de imagens conectado',
  generateNoProviderBody: 'Adicione uma chave de API da OpenAI ou do Google ao seu espaço de trabalho para gerar imagens. Sua chave permanece no servidor e nunca é enviada ao navegador.',
  generateOpenProviders: 'Abrir Provedores',
  generatePrompt: 'Prompt',
  generatePromptPlaceholder: 'Descreva a imagem que você quer…',
  generateProvider: 'Provedor',
  generateSize: 'Tamanho',
  generateModel: 'Modelo (opcional)',
  generateModelPlaceholder: 'Padrão do provedor',
  generateAction: 'Gerar',
  generating: 'Gerando…',
  generateFailed: 'A geração da imagem falhou.',
  generateResultAlt: 'Prévia da imagem gerada',
  generateUseImage: 'Usar esta imagem',
  generateRetry: 'Gerar novamente',

  // ADR 0401 P3 — AI image editing
  editImageAi: 'Editar com IA',
  editDialogTitle: 'Editar imagem com IA',
  editOpPickerLabel: 'Operação de edição',
  editOp_edit: 'Editar',
  editOp_inpaint: 'Preenchimento generativo',
  'editOp_background-remove': 'Remover fundo',
  editOp_upscale: 'Ampliar',
  editOpUnsupported: 'Não suportado por {{provider}}',
  editPromptPlaceholder: 'Descreva a mudança…',
  editInpaintPromptPlaceholder: 'Descreva o que pintar na região marcada…',
  editMaskHint: 'Pinte sobre a região a repintar.',
  editMaskClear: 'Limpar máscara',
  editMaskRequired: 'Pinte uma máscara sobre a região a preencher primeiro.',
  editScaleLabel: 'Fator de ampliação',
  editApply: 'Aplicar',
  editApplying: 'Aplicando…',
  editFailed: 'A edição da imagem falhou.',
  editResultAlt: 'Prévia da imagem editada',
  editNotLibraryTitle: 'Não é uma imagem da biblioteca',
  editNotLibraryBody: 'A edição com IA funciona com imagens da sua biblioteca de mídia. URLs externas podem ser substituídas via Gerar ou o seletor.',

  // UXB-1 — rectangle mask mode (keyboard-accessible inpaint masking)
  maskModeLabel: 'Modo de máscara',
  maskModeBrush: 'Pincel',
  maskModeRect: 'Retângulo',
  editMaskRectHint: 'Arraste um retângulo sobre a região a repintar, ou adicione um por números abaixo.',
  maskRectX: 'X (%)',
  maskRectY: 'Y (%)',
  maskRectW: 'Largura (%)',
  maskRectH: 'Altura (%)',
  maskRectAdd: 'Adicionar região',
  maskRectListLabel: 'Regiões da máscara',
  maskRectItem: 'Região {{n}}: {{x}}%, {{y}}% · {{w}}×{{h}}%',
  maskRectRemove: 'Remover região {{n}}',
  editOpsSupported: '{{provider}} suporta: {{ops}}',
  editOpsNone: 'nenhuma operação de edição',
  generateLoadFailedTitle: "Não foi possível verificar seus provedores de imagem",
  generateLoadFailedBody: "A requisição não foi concluída, então não podemos dizer quais provedores estão conectados. Isso NÃO significa que não há nenhum.",
  editSourceLookupFailed: "Não foi possível ler sua biblioteca de mídia, então esta imagem não pôde ser associada a um recurso.",
  retry: "Tentar de novo",
  editSourceLookupFailedTitle: "Não foi possível ler sua biblioteca de mídia",
} as const;
