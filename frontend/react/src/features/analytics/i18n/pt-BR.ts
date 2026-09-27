/**
 * `analytics` namespace — user-facing copy for the Analytics feature (ADR 0018).
 * Feature-self-contained: every analytics string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  orgsEmptyClause: 'As análises pertencem a uma organização',
  orgsFailedClause: 'O resumo de analytics nunca chegou a ser solicitado',
  // Page chrome
  eyebrow: 'Espaço de trabalho',
  title: 'Análises',

  // Gating / empty states
  notEnabledTitle: 'As análises não estão habilitadas',
  notEnabledBody: 'Peça a um administrador para habilitar a feature de Análises para este tenant.',
  noAnalyticsTitle: 'Nenhuma análise ainda',
  summaryFailedTitle: 'As análises não carregaram',
  summaryFailedBody: 'A leitura do resumo falhou — estes números estão indisponíveis, não zerados.',
  noEventsInWindowTitle: 'Sem eventos nos últimos {{days}} dias',
  noEventsInWindowBody: 'Este beacon já enviou dados antes — o primeiro evento foi em {{since}} —, então esta janela está apenas quieta. Tente um período maior.',
  noBusinessEventsTitle: 'Por enquanto, apenas telemetria de desempenho',
  noBusinessEventsBody: 'O beacon envia Web Vitals desde {{since}}, mas nenhuma visualização, evento ou conversão foi registrada ainda.',
  showAllTime: 'Ver todo o período',
  streamSampleNote: 'os 25 mais recentes de uma amostra de 100 eventos — os números acima contam tudo',
  trendTitle: 'Visualizações',
  trendLede: 'por dia UTC nos últimos {{days}} dias',
  trendSrSummary: 'Visualizações por dia UTC nos últimos {{days}} dias corridos: {{total}} nesses intervalos, com pico de {{peak}} em um dia. Este total por dias corridos é medido de forma diferente do número de Visualizações acima, que usa uma janela móvel.',
  trendPartialNote: 'Hoje ainda está em andamento, então o último ponto cobre apenas as horas decorridas.',
  navReportTruncated: 'Mostrando os {{shown}} primeiros de {{total}} pares rota–origem.',
  noAnalyticsBody: 'Os eventos aparecem aqui assim que suas páginas publicadas reportarem ao beacon público.',
  historyUnknownTitle: 'Nenhum evento para exibir',
  historyUnknownBody: 'Não foi possível confirmar se este beacon já reportou algum dado, então não dá para distinguir um snippet não instalado de um período sem movimento. Recarregue em instantes ou verifique se o snippet está nas suas páginas publicadas.',

  // aria-labels
  orgPickerLabel: 'Organização',
  windowPickerLabel: 'Período do relatório',
  window7: 'Últimos 7 dias',
  window30: 'Últimos 30 dias',
  window90: 'Últimos 90 dias',
  windowAll: 'Todo o histórico',
  ledeWindow: 'Medição da superfície pública nos últimos {{days}} dias.',
  ledeAllTime: 'Medição da superfície pública de toda a atividade registrada.',
  summaryBandLabel: 'Resumo de análises — visualizações de página e conversões filtram eventos recentes',

  // Key figures
  figureEvents: 'Eventos',
  deltaVsPrior: '{{pct}} vs. os {{days}} dias anteriores',
  deltaNew: 'novo vs. os {{days}} dias anteriores',
  deltaFlat: 'estável vs. os {{days}} dias anteriores',
  figureSessions: 'Sessões',
  // ADR 0569 — únicos diários (sem cookies)
  figureVisitors: 'Únicos diários',
  visitorsDisclosure: 'Os únicos diários não usam cookies: um hash de visitante com sal que muda a cada dia UTC — não existe identidade entre dias e um número de vários dias é a soma dos únicos de cada dia. A contagem começou em {{since}}.',
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
  typePageview: 'visualização de página',
  typeEvent: 'evento',
  typeConversion: 'conversão',

  // Table empty states
  emptyTopPaths: 'Nenhuma visualização de página ainda.',
  emptyUtmSources: 'Nenhum tráfego marcado com UTM ainda.',
  emptyEvents: 'Nenhum evento.',
  eventsUnavailable: 'Não foi possível carregar os eventos recentes — os números acima não são afetados.',
  trendUnavailable: 'Não foi possível carregar a tendência diária — os números acima não são afetados.',
  navReportLoading: 'Carregando contagens de navegação…',
  topListTruncated: 'Mostrando os {{shown}} principais de {{total}}.',
  emptyEventsFiltered: 'Nenhum evento {{type}}.',

  // Errors
  loadFailed: 'Falha ao carregar análises.',

  // ADR 0018 CWV — Core Web Vitals
  vitalsHeading: 'Web Vitals',
  vitalsHint: 'Core Web Vitals reais (p75) de páginas publicadas. Medidos no cliente, portanto aproximados.',
  captionVitals: 'p75 dos Core Web Vitals por métrica',
  vitalMetric: 'Métrica',
  vitalP75: 'p75',
  vitalRating: 'Classificação',
  vitalSamples: 'Amostras',
  vitalMs: '{{n}} ms',
  rating_good: 'Bom',
  'rating_needs-improvement': 'A melhorar',
  rating_poor: 'Ruim',
  navReportHeading: 'Navegação do espaço',
  navReportHint: 'Contagens anônimas de quais páginas os membros abrem e por qual menu (este espaço, últimas {{weeks}} semanas). Registrado apenas com o toggle workspace-nav-telemetry ativo.',
  navReportUnavailable: 'Não foi possível carregar o relatório de navegação.',
  navReportEmpty: 'Nenhuma navegação registrada ainda.',
  navColRoute: 'Rota',
  navColSource: 'Origem',
  navColCount: 'Contagem',
} as const;
