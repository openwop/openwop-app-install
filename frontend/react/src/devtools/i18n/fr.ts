/**
 * `devtools` namespace — user-facing strings for the network inspector
 * (`src/devtools/NetworkPanel.tsx`). Developer-facing surface, but its visible
 * UI copy is externalized per ADR 0065. FLAT camelCase keys, one per line. The
 * call count uses i18next plural suffixes (`_one`/`_other`) with `{{count}}`.
 */
export const messages = {
  inspectorLabel: 'Inspecteur réseau',
  network: 'Réseau',
  callCount_one: '· {{count}} appel',
  callCount_other: '· {{count}} appels',
  clearTitle: 'Vider le tampon',
  clear: 'Vider',
  closePanel: 'Fermer le panneau réseau',
  filterAll: 'Tous ({{count}})',
  filterRest: 'REST ({{count}})',
  filterSse: 'SSE ({{count}})',
  filterErrors: 'Erreurs ({{count}})',
  filterByPath: 'Filtrer par chemin…',
  noActivity: 'Aucune activité réseau pour l\'instant. Utilisez l\'application et les appels apparaîtront ici.',
  noMatch: 'Aucun appel ne correspond au filtre actuel.',
  bufferNote: 'Le tampon conserve les 200 derniers appels. Vidé au rechargement.',
  errShort: 'ERR',
  urlLabel: 'URL',
  startedLabel: 'Démarré',
  requestBodyLabel: 'Corps de la requête',
  responseBodyLabel: 'Corps de la réponse',
  responseBodyTruncatedLabel: 'Corps de la réponse (tronqué)',
  sseEventsLabel: 'Événements SSE ({{count}})',
} as const;
