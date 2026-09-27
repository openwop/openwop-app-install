/**
 * `analytics` namespace — user-facing copy for the Analytics feature (ADR 0018).
 * Feature-self-contained: every analytics string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  orgsEmptyClause: 'Las analíticas pertenecen a una organización',
  orgsFailedClause: 'El resumen de analítica nunca llegó a solicitarse',
  // Page chrome
  eyebrow: 'Espacio de trabajo',
  title: 'Analíticas',

  // Gating / empty states
  notEnabledTitle: 'Las analíticas no están habilitadas',
  notEnabledBody: 'Pida a un administrador que habilite la función de Analíticas para este inquilino.',
  noAnalyticsTitle: 'Aún no hay analíticas',
  summaryFailedTitle: 'Las analíticas no cargaron',
  summaryFailedBody: 'La lectura del resumen falló: estas cifras no están disponibles, no son cero.',
  noEventsInWindowTitle: 'Sin eventos en los últimos {{days}} días',
  noEventsInWindowBody: 'Este beacon ya ha informado antes — su primer evento fue el {{since}} —, así que esta ventana simplemente está tranquila. Prueba un período más largo.',
  noBusinessEventsTitle: 'Por ahora solo telemetría de rendimiento',
  noBusinessEventsBody: 'El beacon informa Web Vitals desde el {{since}}, pero aún no se ha registrado ninguna página vista, evento ni conversión.',
  showAllTime: 'Ver todo el tiempo',
  streamSampleNote: 'los 25 más recientes de una muestra de 100 eventos; las cifras de arriba lo cuentan todo',
  trendTitle: 'Páginas vistas',
  trendLede: 'por día UTC en los últimos {{days}} días',
  trendSrSummary: 'Páginas vistas por día UTC en los últimos {{days}} días naturales: {{total}} en estos intervalos, con un pico de {{peak}} en un día. Este total por días naturales se mide de forma distinta a la cifra de Páginas vistas de arriba, que usa una ventana móvil.',
  trendPartialNote: 'Hoy aún está en curso, así que el último punto solo cubre las horas transcurridas.',
  navReportTruncated: 'Mostrando los {{shown}} primeros de {{total}} pares ruta–origen.',
  noAnalyticsBody: 'Los eventos aparecen aquí una vez que sus páginas publicadas informan al baliza pública.',
  historyUnknownTitle: 'No hay eventos que mostrar',
  historyUnknownBody: 'No pudimos confirmar si esta baliza ha informado alguna vez, así que no podemos distinguir un fragmento sin instalar de un periodo sin actividad. Vuelva a cargar en un momento o compruebe que el fragmento esté en sus páginas publicadas.',

  // aria-labels
  orgPickerLabel: 'Organización',
  windowPickerLabel: 'Periodo del informe',
  window7: 'Últimos 7 días',
  window30: 'Últimos 30 días',
  window90: 'Últimos 90 días',
  windowAll: 'Todo el histórico',
  ledeWindow: 'Medición de la superficie pública de los últimos {{days}} días.',
  ledeAllTime: 'Medición de la superficie pública de toda la actividad registrada.',
  summaryBandLabel: 'Resumen de analíticas — las páginas vistas y las conversiones filtran los eventos recientes',

  // Key figures
  figureEvents: 'Eventos',
  deltaVsPrior: '{{pct}} vs. los {{days}} días anteriores',
  deltaNew: 'nuevo vs. los {{days}} días anteriores',
  deltaFlat: 'igual que los {{days}} días anteriores',
  figureSessions: 'Sesiones',
  // ADR 0569 — únicos diarios (sin cookies)
  figureVisitors: 'Únicos diarios',
  visitorsDisclosure: 'Los únicos diarios no usan cookies: un hash de visitante con sal que rota cada día UTC, por lo que no existe identidad entre días y una cifra de varios días es la suma de los únicos de cada día. El conteo comenzó el {{since}}.',
  figurePageviews: 'Páginas vistas',
  figureConversions: 'Conversiones',

  // Section headings
  topPathsHeading: 'Rutas principales',
  acquisitionHeading: 'Adquisición (origen UTM)',
  recentEventsHeading: 'Eventos recientes',
  recentEventsHeadingFiltered: 'Eventos recientes — {{type}}',

  // Table captions
  captionTopPaths: 'Rutas más vistas',
  captionUtmSources: 'Tráfico por origen UTM',
  captionRecentEvents: 'Eventos de analíticas recientes',

  // Column headers
  colType: 'Tipo',
  colDetail: 'Ruta / nombre',
  colWhen: 'Cuándo',
  colPath: 'Ruta',
  colViews: 'Vistas',
  colSource: 'Origen',
  colHits: 'Visitas',

  // Cell content
  utmDetail: 'utm: {{source}}',
  emDash: '—',

  // Event-type labels (display only — persisted enum stays in data)
  typePageview: 'página vista',
  typeEvent: 'evento',
  typeConversion: 'conversión',

  // Table empty states
  emptyTopPaths: 'Aún no hay páginas vistas.',
  emptyUtmSources: 'Aún no hay tráfico etiquetado con UTM.',
  emptyEvents: 'Sin eventos.',
  eventsUnavailable: 'No se pudieron cargar los eventos recientes; las cifras de arriba no se ven afectadas.',
  trendUnavailable: 'No se pudo cargar la tendencia diaria; las cifras de arriba no se ven afectadas.',
  navReportLoading: 'Cargando recuentos de navegación…',
  topListTruncated: 'Se muestran los {{shown}} principales de {{total}}.',
  emptyEventsFiltered: 'Sin eventos de {{type}}.',

  // Errors
  loadFailed: 'No se pudieron cargar las analíticas.',

  // ADR 0018 CWV — Core Web Vitals
  vitalsHeading: 'Web Vitals',
  vitalsHint: 'Core Web Vitals reales (p75) de páginas publicadas. Medidos en el cliente, por lo que son aproximados.',
  captionVitals: 'p75 de Core Web Vitals por métrica',
  vitalMetric: 'Métrica',
  vitalP75: 'p75',
  vitalRating: 'Valoración',
  vitalSamples: 'Muestras',
  vitalMs: '{{n}} ms',
  rating_good: 'Bueno',
  'rating_needs-improvement': 'Mejorable',
  rating_poor: 'Deficiente',
  navReportHeading: 'Navegación del espacio',
  navReportHint: 'Recuentos anónimos de qué páginas abren los miembros y desde qué menú (este espacio, últimas {{weeks}} semanas). Solo se registra con el toggle workspace-nav-telemetry activo.',
  navReportUnavailable: 'No se pudo cargar el informe de navegación.',
  navReportEmpty: 'Aún no hay navegación registrada.',
  navColRoute: 'Ruta',
  navColSource: 'Origen',
  navColCount: 'Recuento',
} as const;
