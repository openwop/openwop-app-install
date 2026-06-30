/**
 * `analytics` namespace — user-facing copy for the Analytics feature (ADR 0018).
 * Feature-self-contained: every analytics string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Espacio de trabajo',
  title: 'Analíticas',
  lede: 'Tráfico, sesiones y conversiones en su superficie pública.',

  // Gating / empty states
  notEnabledTitle: 'Las analíticas no están habilitadas',
  notEnabledBody: 'Pida a un administrador que habilite la función de Analíticas para este inquilino.',
  noOrgsTitle: 'Sin organizaciones',
  noOrgsBody: 'Cree primero una organización — las analíticas pertenecen a una organización.',
  noAnalyticsTitle: 'Aún no hay analíticas',
  noAnalyticsBody: 'Los eventos aparecen aquí una vez que sus páginas publicadas informan al baliza pública.',

  // aria-labels
  orgPickerLabel: 'Organización',
  summaryBandLabel: 'Resumen de analíticas — las páginas vistas y las conversiones filtran los eventos recientes',

  // Key figures
  figureEvents: 'Eventos',
  figureSessions: 'Sesiones',
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
  emptyEventsFiltered: 'Sin eventos de {{type}}.',

  // Errors
  loadFailed: 'No se pudieron cargar las analíticas.',
} as const;
