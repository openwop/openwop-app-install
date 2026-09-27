/**
 * `ui` namespace — core cross-cutting strings for the app ui surface.
 * Populated as strings are externalized (ADR 0065 Phase 2).
 */
export const messages = {

  // OrgSelectionState (HG-4) — the ONE noun + the ONE branch order.
  orgStateFailedTitle: 'Não foi possível carregar suas organizações',
  // `conta vazia` nomeava a COBRANÇA, não esta coleção — ver o catálogo en.
  orgStateFailedBody: 'Esta é uma leitura que falhou, não uma lista de organizações vazia.',
  orgStateFailedBodyWith: '{{what}}. Esta é uma leitura que falhou, não uma lista de organizações vazia.',
  orgStateEmptyTitle: 'Nenhuma organização',
  // Sem instrução (quem a carrega é o CTA) e sem o substantivo (quem o carrega é
  // a cláusula): «Crie uma organização primeiro — … pertencem a uma organização.»
  // dizia-o duas vezes. Ver o catálogo en.
  orgStateEmptyBody: '{{what}}.',
  orgStateEmptyAction: 'Criar uma organização',
  orgStateEmptyAskAdmin: 'Peça a um administrador para criar uma.',
  orgStateInlineSentence: '{{title}}. {{body}}',
  orgStateRetry: 'Tentar novamente',
  orgPickerLabel: 'Organização',
  orgPickerGroupLabel: 'Organizações',
  orgPickerLoading: 'Carregando organizações…',
  // CommandPalette
  cmdkLabel: 'Paleta de comandos',
  cmdkPlaceholder: 'Ir para uma página ou ação…',
  cmdkSearchLabel: 'Pesquisar comandos',
  cmdkEsc: 'esc',
  cmdkNoMatches: 'Nenhum resultado para “{{query}}”.',
  cmdkListLabel: 'Comandos',
  cmdkFootNavigate: 'navegar',
  cmdkFootOpen: 'abrir',
  cmdkFootOpenStay: 'abrir · permanecer',
  cmdkFootToggle: 'alternar',
  cmdkActionsGroup: 'Ações',
  // CommandPalette quick actions
  cmdkActNewRunLabel: 'Criar uma execução',
  cmdkActNewRunHint: 'Enviar um fluxo de trabalho neste host',
  cmdkActNewAgentLabel: 'Novo agente',
  cmdkActNewAgentHint: 'Criar um colega de IA com nome',
  cmdkActCompareLabel: 'Comparar execuções',
  cmdkActCompareHint: 'Comparar duas execuções',
  cmdkActReseedLabel: 'Resemear dados de exemplo',
  cmdkActReseedHint: 'Redefinir a lista de exemplo integrada',
  // Toast
  toastDismiss: 'Dispensar',
  toastDismissAll: 'Dispensar tudo ({{count}})',
  toastRegionLabel: 'Notificações',
  // ErrorBoundary
  errorTitle: 'Algo deu errado',
  errorBodyRegion: 'A região {{region}} encontrou um erro inesperado. ',
  errorBodyGeneric: 'Esta visualização encontrou um erro inesperado. ',
  errorBodyRecover: 'Você pode recarregar para recuperar.',
  errorReload: 'Recarregar',
  // ThemeToggle
  themeGroupLabel: 'Tema',
  themeSystem: 'Tema do sistema',
  themeLight: 'Tema claro',
  themeDark: 'Tema escuro',
  // DataTable
  tableBulkActionsLabel: 'Ações em massa',
  tableSelectedCount: '{{n}} selecionado(s)',
  tableClear: 'Limpar',
  tableNoFilterMatches: 'Nenhuma linha corresponde a “{{query}}”.',
  tableFilterMatches_one: '{{n}} linha corresponde.',
  tableFilterMatches_other: '{{n}} linhas correspondem.',
  tableSelectHeader: 'Selecionar',
  tableSelectAll: 'Selecionar tudo',
  tableDeselectAll: 'Desmarcar tudo',
  tableSelectRow: 'Selecionar linha',
  tableSortBy: 'Ordenar por {{column}}',
  // MarkdownEditor toolbar
  mdToolbarLabel: 'Formatação',
  mdBold: 'Negrito',
  mdItalic: 'Itálico',
  mdHeading: 'Título',
  mdLink: 'Link',
  mdBulletedList: 'Lista com marcadores',
  mdNumberedList: 'Lista numerada',
  mdChecklist: 'Lista de verificação',
  mdQuote: 'Citação',
  mdInlineCode: 'Código embutido',
  mdCodeBlock: 'Bloco de código',
  // MarkdownEditor controls
  mdWrite: 'Escrever',
  mdPreview: 'Visualizar',
  mdDraftSaved: 'Rascunho salvo',
  mdDraftFound: 'Um rascunho não salvo foi encontrado.',
  mdRestoreDraft: 'Restaurar rascunho',
  mdDiscard: 'Descartar',
  mdNothingToPreview: 'Nada para visualizar ainda.',
  mdMarkdownSupported: 'Markdown suportado',
  mdCharCount_one: '{{formatted}} caractere',
  mdCharCount_other: '{{formatted}} caracteres',
  mdCharCountMax: '{{n}} / {{max}}',
  mdOverWarning: 'Acima dos {{max}} caracteres sugeridos — considere reduzir.',
  // IllustrativeBadge
  illustrativeLabel: 'Ilustrativo',
  illustrativeDetail: 'Dados de exemplo ilustrativos — não derivados de registros reais',
  // KeyFigureBand
  keyFiguresLabel: 'Números-chave',
  // ViewToggle (grid/list collection switch)
  viewToggleLabel: 'Ver como grade ou lista',
  viewGrid: 'Grade',
  viewList: 'Lista',
  colorSwatches: "Cores do tema",
  colorAccent: "Destaque",
  colorText: "Texto",
  colorMuted: "Suave",
  colorSuccess: "Sucesso",
  colorWarn: "Aviso",
  colorDanger: "Perigo",
  colorInfo: "Info",
  colorNone: "Nenhum",
  colorRecent: "Cor recente {{value}}",
  colorHexPlaceholder: "#rrggbb ou uma cor CSS",
  colorPickFromScreen: "Escolher uma cor da tela",

  cmdkLocked: 'Bloqueado — desbloqueie na loja de recursos',

  // FORM-UX-2 (ADR 0584) — a proteção IN-APP contra a perda de alterações.
  unsavedLeaveTitle: 'Sair sem salvar?',
  unsavedLeaveBody: 'As alterações não salvas desta página serão descartadas. Salve antes para mantê-las.',
  unsavedLeaveConfirm: 'Descartar alterações',
} as const;
