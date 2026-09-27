/**
 * `analytics` namespace — user-facing copy for the Analytics feature (ADR 0018).
 * Feature-self-contained: every analytics string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  orgsEmptyClause: 'Les analyses appartiennent à une organisation',
  orgsFailedClause: 'Le récapitulatif analytique n’a jamais été demandé',
  // Page chrome
  eyebrow: 'Espace de travail',
  title: 'Analyses',

  // Gating / empty states
  notEnabledTitle: 'Les analyses ne sont pas activées',
  notEnabledBody: 'Demandez à un administrateur d’activer la fonctionnalité Analyses pour ce locataire.',
  noAnalyticsTitle: 'Aucune analyse pour le moment',
  summaryFailedTitle: 'Les statistiques n’ont pas chargé',
  summaryFailedBody: 'La lecture du résumé a échoué — ces chiffres sont indisponibles, pas nuls.',
  noEventsInWindowTitle: 'Aucun événement sur les {{days}} derniers jours',
  noEventsInWindowBody: 'Ce beacon a déjà transmis des données — son premier événement date du {{since}} —, cette période est donc simplement calme. Essayez une période plus longue.',
  noBusinessEventsTitle: 'Pour l’instant, uniquement de la télémétrie de performance',
  noBusinessEventsBody: 'Le beacon transmet des Web Vitals depuis le {{since}}, mais aucune page vue, aucun événement ni aucune conversion n’a encore été enregistré.',
  showAllTime: 'Voir tout l’historique',
  streamSampleNote: 'les 25 plus récents d’un échantillon de 100 événements — les chiffres ci-dessus comptent tout',
  trendTitle: 'Pages vues',
  trendLede: 'par jour UTC sur les {{days}} derniers jours',
  trendSrSummary: 'Pages vues par jour UTC sur les {{days}} derniers jours calendaires : {{total}} dans ces intervalles, avec un pic de {{peak}} en une journée. Ce total calendaire ne se mesure pas comme le chiffre Pages vues ci-dessus, qui utilise une fenêtre glissante.',
  trendPartialNote: 'La journée d’aujourd’hui est encore en cours : le dernier point ne couvre que les heures écoulées.',
  navReportTruncated: 'Affichage des {{shown}} premiers sur {{total}} paires route–source.',
  noAnalyticsBody: 'Les événements apparaissent ici une fois que vos pages publiées remontent vers la balise publique.',
  historyUnknownTitle: 'Aucun événement à afficher',
  historyUnknownBody: "Nous n'avons pas pu confirmer si cette balise a déjà remonté des données : impossible de distinguer un extrait non installé d'une période sans activité. Rechargez dans un instant ou vérifiez que l'extrait figure sur vos pages publiées.",

  // aria-labels
  orgPickerLabel: 'Organisation',
  windowPickerLabel: 'Période du rapport',
  window7: '7 derniers jours',
  window30: '30 derniers jours',
  window90: '90 derniers jours',
  windowAll: 'Tout l’historique',
  ledeWindow: 'Mesure de la surface publique sur les {{days}} derniers jours.',
  ledeAllTime: 'Mesure de la surface publique sur toute l’activité enregistrée.',
  summaryBandLabel: 'Résumé des analyses — les pages vues et conversions filtrent les événements récents',

  // Key figures
  figureEvents: 'Événements',
  deltaVsPrior: '{{pct}} vs les {{days}} jours précédents',
  deltaNew: 'nouveau vs les {{days}} jours précédents',
  deltaFlat: 'stable vs les {{days}} jours précédents',
  figureSessions: 'Sessions',
  // ADR 0569 — uniques quotidiens (sans cookies)
  figureVisitors: 'Uniques quotidiens',
  visitorsDisclosure: 'Les uniques quotidiens sont sans cookies : un hachage de visiteur salé qui change chaque jour UTC — aucune identité inter-jours n\u2019existe et un chiffre multi-jours est la somme des uniques de chaque jour. Le comptage a commencé le {{since}}.',
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
  captionRecentEvents: 'Événements d’analyse récents',

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
  eventsUnavailable: 'Impossible de charger les événements récents — les chiffres ci-dessus ne sont pas concernés.',
  trendUnavailable: 'Impossible de charger la tendance quotidienne — les chiffres ci-dessus ne sont pas concernés.',
  navReportLoading: 'Chargement des comptages de navigation…',
  topListTruncated: 'Affichage des {{shown}} premiers sur {{total}}.',
  emptyEventsFiltered: 'Aucun événement {{type}}.',

  // Errors
  loadFailed: 'Échec du chargement des analyses.',

  // ADR 0018 CWV — Core Web Vitals
  vitalsHeading: 'Web Vitals',
  vitalsHint: 'Core Web Vitals réels (p75) des pages publiées. Mesurés côté client, donc approximatifs.',
  captionVitals: 'p75 des Core Web Vitals par métrique',
  vitalMetric: 'Métrique',
  vitalP75: 'p75',
  vitalRating: 'Évaluation',
  vitalSamples: 'Échantillons',
  vitalMs: '{{n}} ms',
  rating_good: 'Bon',
  'rating_needs-improvement': 'À améliorer',
  rating_poor: 'Médiocre',
  navReportHeading: 'Navigation de l’espace',
  navReportHint: 'Comptages anonymes des pages ouvertes et du menu d’origine (cet espace, {{weeks}} dernières semaines). Enregistré uniquement quand le toggle workspace-nav-telemetry est actif.',
  navReportUnavailable: 'Le rapport de navigation n’a pas pu être chargé.',
  navReportEmpty: 'Aucune navigation enregistrée pour l’instant.',
  navColRoute: 'Route',
  navColSource: 'Source',
  navColCount: 'Total',
} as const;
