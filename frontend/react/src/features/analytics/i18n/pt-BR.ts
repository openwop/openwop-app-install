/**
 * `analytics` namespace — user-facing copy for the Analytics feature (ADR 0018).
 * Feature-self-contained: every analytics string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Espaço de trabalho',
  title: 'Análises',
  lede: 'Tráfego, sessões e conversões na sua superfície pública.',

  // Gating / empty states
  notEnabledTitle: 'As análises não estão habilitadas',
  notEnabledBody: 'Peça a um administrador para habilitar a feature de Análises para este tenant.',
  noOrgsTitle: 'Nenhuma organização',
  noOrgsBody: 'Crie uma organização primeiro — as análises pertencem a uma org.',
  noAnalyticsTitle: 'Nenhuma análise ainda',
  noAnalyticsBody: 'Os eventos aparecem aqui assim que suas páginas publicadas reportarem ao beacon público.',

  // aria-labels
  orgPickerLabel: 'Organização',
  summaryBandLabel: 'Resumo de análises — visualizações de página e conversões filtram eventos recentes',

  // Key figures
  figureEvents: 'Eventos',
  figureSessions: 'Sessões',
  figurePageviews: 'Visualizações de página',
  figureConversions: 'Conversões',

  // Section headings
  topPathsHeading: 'Principais caminhos',
  acquisitionHeading: 'Aquisição (origem UTM)',
  recentEventsHeading: 'Eventos recentes',
  recentEventsHeadingFiltered: 'Eventos recentes — {{type}}',

  // Table captions
  captionTopPaths: 'Caminhos mais visualizados',
  captionUtmSources: 'Tráfego por origem UTM',
  captionRecentEvents: 'Eventos de análise recentes',

  // Column headers
  colType: 'Tipo',
  colDetail: 'Caminho / nome',
  colWhen: 'Quando',
  colPath: 'Caminho',
  colViews: 'Visualizações',
  colSource: 'Origem',
  colHits: 'Acessos',

  // Cell content
  utmDetail: 'utm: {{source}}',
  emDash: '—',

  // Event-type labels (display only — persisted enum stays in data)
  typePageview: 'pageview',
  typeEvent: 'event',
  typeConversion: 'conversion',

  // Table empty states
  emptyTopPaths: 'Nenhuma visualização de página ainda.',
  emptyUtmSources: 'Nenhum tráfego marcado com UTM ainda.',
  emptyEvents: 'Nenhum evento.',
  emptyEventsFiltered: 'Nenhum evento {{type}}.',

  // Errors
  loadFailed: 'Falha ao carregar análises.',
} as const;
