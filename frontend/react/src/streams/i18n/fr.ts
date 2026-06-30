/**
 * `streams` namespace — user-facing strings for the event-stream view
 * (`src/streams/`). FLAT camelCase keys, one per line (ADR 0065). The event
 * count uses i18next plural suffixes (`_one`/`_other`) with `{{count}}`.
 */
export const messages = {
  noEventsYet: 'Aucun événement pour l\'instant.',
  emittedMediaAlt: 'média émis',
  downloadAsset: 'télécharger la ressource',
  forkTitle: 'Dériver une nouvelle exécution depuis cet événement (mode branche)',
  fork: 'dériver',
  payload: 'charge utile',
  copy: 'Copier',
  copied: 'Copié',
  copyTitle: 'Copier les événements en markdown (coller dans Claude Code, Slack, GitHub)',
  exportJson: 'Exporter en JSON',
  exportJsonTitle: 'Télécharger le journal d\'événements complet en JSON',
  eventCount_one: '{{count}} événement',
  eventCount_other: '{{count}} événements',
} as const;
