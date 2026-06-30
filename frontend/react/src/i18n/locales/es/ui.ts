/**
 * `ui` namespace — core cross-cutting strings for the app ui surface.
 * Populated as strings are externalized (ADR 0065 Phase 2).
 */
export const messages = {
  // CommandPalette
  cmdkLabel: 'Paleta de comandos',
  cmdkPlaceholder: 'Ir a una página o acción…',
  cmdkSearchLabel: 'Buscar comandos',
  cmdkEsc: 'esc',
  cmdkNoMatches: 'No hay coincidencias para «{{query}}».',
  cmdkListLabel: 'Comandos',
  cmdkFootNavigate: 'navegar',
  cmdkFootOpen: 'abrir',
  cmdkFootOpenStay: 'abrir · permanecer',
  cmdkFootToggle: 'alternar',
  cmdkActionsGroup: 'Acciones',
  // CommandPalette quick actions
  cmdkActNewRunLabel: 'Crear una ejecución',
  cmdkActNewRunHint: 'Enviar un flujo de trabajo en este host',
  cmdkActNewAgentLabel: 'Nuevo agente',
  cmdkActNewAgentHint: 'Crear un compañero de IA con nombre',
  cmdkActCompareLabel: 'Comparar ejecuciones',
  cmdkActCompareHint: 'Comparar dos ejecuciones',
  cmdkActReseedLabel: 'Volver a sembrar datos de ejemplo',
  cmdkActReseedHint: 'Restablecer la plantilla de ejemplo integrada',
  // Toast
  toastDismiss: 'Descartar',
  // ErrorBoundary
  errorTitle: 'Algo ha salido mal',
  errorBodyRegion: 'La sección {{region}} ha sufrido un error inesperado. ',
  errorBodyGeneric: 'Esta vista ha sufrido un error inesperado. ',
  errorBodyRecover: 'Puede recargar para recuperarla.',
  errorReload: 'Recargar',
  // ThemeToggle
  themeGroupLabel: 'Tema',
  themeSystem: 'Tema del sistema',
  themeLight: 'Tema claro',
  themeDark: 'Tema oscuro',
  // DataTable
  tableBulkActionsLabel: 'Acciones en lote',
  tableSelectedCount: '{{n}} seleccionados',
  tableClear: 'Borrar',
  tableSelectHeader: 'Seleccionar',
  tableSelectAll: 'Seleccionar todo',
  tableDeselectAll: 'Deseleccionar todo',
  tableSelectRow: 'Seleccionar fila',
  tableSortBy: 'Ordenar por {{column}}',
  tableDensityLabel: 'Densidad de filas',
  tableDensityComfortable: 'Cómoda',
  tableDensityCompact: 'Compacta',
  // MarkdownEditor toolbar
  mdToolbarLabel: 'Formato',
  mdBold: 'Negrita',
  mdItalic: 'Cursiva',
  mdHeading: 'Encabezado',
  mdLink: 'Enlace',
  mdBulletedList: 'Lista con viñetas',
  mdNumberedList: 'Lista numerada',
  mdChecklist: 'Lista de comprobación',
  mdQuote: 'Cita',
  mdInlineCode: 'Código en línea',
  mdCodeBlock: 'Bloque de código',
  // MarkdownEditor controls
  mdWrite: 'Escribir',
  mdPreview: 'Vista previa',
  mdDraftSaved: 'Borrador guardado',
  mdDraftFound: 'Se ha encontrado un borrador sin guardar.',
  mdRestoreDraft: 'Restaurar borrador',
  mdDiscard: 'Descartar',
  mdNothingToPreview: 'Aún no hay nada que previsualizar.',
  mdMarkdownSupported: 'Se admite Markdown',
  mdCharCount_one: '{{formatted}} carácter',
  mdCharCount_other: '{{formatted}} caracteres',
  mdCharCountMax: '{{n}} / {{max}}',
  mdOverWarning: 'Supera los {{max}} caracteres sugeridos: considere recortar.',
  // IllustrativeBadge
  illustrativeLabel: 'Ilustrativo',
  illustrativeDetail: 'Datos de ejemplo ilustrativos: no proceden de registros reales',
  // KeyFigureBand
  keyFiguresLabel: 'Cifras clave',
  // ViewToggle (grid/list collection switch)
  viewToggleLabel: 'Ver como cuadrícula o lista',
  viewGrid: 'Cuadrícula',
  viewList: 'Lista',
} as const;
