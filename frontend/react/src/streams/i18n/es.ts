/**
 * `streams` namespace — user-facing strings for the event-stream view
 * (`src/streams/`). FLAT camelCase keys, one per line (ADR 0065). The event
 * count uses i18next plural suffixes (`_one`/`_other`) with `{{count}}`.
 */
export const messages = {
  noEventsYet: 'Aún no hay eventos.',
  emittedMediaAlt: 'medios emitidos',
  downloadAsset: 'descargar recurso',
  forkTitle: 'Bifurcar una nueva ejecución a partir de este evento (modo de ramificación)',
  fork: 'bifurcar',
  payload: 'carga útil',
  copy: 'Copiar',
  copied: 'Copiado',
  copyTitle: 'Copiar los eventos como markdown (pegar en Claude Code, Slack, GitHub)',
  exportJson: 'Exportar JSON',
  exportJsonTitle: 'Descargar el registro completo de eventos en JSON',
  eventCount_one: '{{count}} evento',
  eventCount_other: '{{count}} eventos',
  noEventsYetBody: 'Los eventos aparecen aquí en vivo mientras se ejecuta la ejecución.',
  eventsUnreadableTitle: 'No se pudieron cargar los eventos de esta ejecución.',
  eventsUnreadableBody: 'El registro de eventos no se cargó, así que no podemos decir qué hizo esta ejecución. Esto no es lo mismo que la ejecución no haya producido nada.',
  eventsLoadingTitle: 'Cargando eventos…',
} as const;
