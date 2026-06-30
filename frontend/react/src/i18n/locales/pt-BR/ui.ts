/**
 * `ui` namespace — core cross-cutting strings for the app ui surface.
 * Populated as strings are externalized (ADR 0065 Phase 2).
 */
export const messages = {
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
  tableSelectHeader: 'Selecionar',
  tableSelectAll: 'Selecionar tudo',
  tableDeselectAll: 'Desmarcar tudo',
  tableSelectRow: 'Selecionar linha',
  tableSortBy: 'Ordenar por {{column}}',
  tableDensityLabel: 'Densidade das linhas',
  tableDensityComfortable: 'Confortável',
  tableDensityCompact: 'Compacta',
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
} as const;
