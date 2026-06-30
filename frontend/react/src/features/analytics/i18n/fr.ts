/**
 * `analytics` namespace — user-facing copy for the Analytics feature (ADR 0018).
 * Feature-self-contained: every analytics string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Espace de travail',
  title: 'Analyses',
  lede: 'Trafic, sessions et conversions sur votre surface publique.',

  // Gating / empty states
  notEnabledTitle: 'Les analyses ne sont pas activées',
  notEnabledBody: 'Demandez à un administrateur d\'activer la fonctionnalité Analyses pour ce locataire.',
  noOrgsTitle: 'Aucune organisation',
  noOrgsBody: 'Créez d\'abord une organisation — les analyses appartiennent à une organisation.',
  noAnalyticsTitle: 'Aucune analyse pour le moment',
  noAnalyticsBody: 'Les événements apparaissent ici une fois que vos pages publiées remontent vers la balise publique.',

  // aria-labels
  orgPickerLabel: 'Organisation',
  summaryBandLabel: 'Résumé des analyses — les pages vues et conversions filtrent les événements récents',

  // Key figures
  figureEvents: 'Événements',
  figureSessions: 'Sessions',
  figurePageviews: 'Pages vues',
  figureConversions: 'Conversions',

  // Section headings
  topPathsHeading: 'Principaux chemins',
  acquisitionHeading: 'Acquisition (source UTM)',
  recentEventsHeading: 'Événements récents',
  recentEventsHeadingFiltered: 'Événements récents — {{type}}',

  // Table captions
  captionTopPaths: 'Chemins les plus consultés',
  captionUtmSources: 'Trafic par source UTM',
  captionRecentEvents: 'Événements d\'analyse récents',

  // Column headers
  colType: 'Type',
  colDetail: 'Chemin / nom',
  colWhen: 'Quand',
  colPath: 'Chemin',
  colViews: 'Vues',
  colSource: 'Source',
  colHits: 'Visites',

  // Cell content
  utmDetail: 'utm : {{source}}',
  emDash: '—',

  // Event-type labels (display only — persisted enum stays in data)
  typePageview: 'page vue',
  typeEvent: 'événement',
  typeConversion: 'conversion',

  // Table empty states
  emptyTopPaths: 'Aucune page vue pour le moment.',
  emptyUtmSources: 'Aucun trafic balisé UTM pour le moment.',
  emptyEvents: 'Aucun événement.',
  emptyEventsFiltered: 'Aucun événement {{type}}.',

  // Errors
  loadFailed: 'Échec du chargement des analyses.',
} as const;
