/**
 * `devtools` namespace — user-facing strings for the network inspector
 * (`src/devtools/NetworkPanel.tsx`). Developer-facing surface, but its visible
 * UI copy is externalized per ADR 0065. FLAT camelCase keys, one per line. The
 * call count uses i18next plural suffixes (`_one`/`_other`) with `{{count}}`.
 */
export const messages = {
  inspectorLabel: 'Inspector de red',
  network: 'Red',
  callCount_one: '· {{count}} llamada',
  callCount_other: '· {{count}} llamadas',
  clearTitle: 'Vaciar el búfer',
  clear: 'Vaciar',
  closePanel: 'Cerrar el panel de red',
  filterAll: 'Todas ({{count}})',
  filterRest: 'REST ({{count}})',
  filterSse: 'SSE ({{count}})',
  filterErrors: 'Errores ({{count}})',
  filterByPath: 'Filtrar por ruta…',
  noActivity: 'Aún no hay actividad de red. Utilice la aplicación y las llamadas aparecerán aquí.',
  noMatch: 'Ninguna llamada coincide con el filtro actual.',
  bufferNote: 'El búfer conserva las últimas 200 llamadas. Se vacía al recargar.',
  errShort: 'ERR',
  urlLabel: 'URL',
  startedLabel: 'Iniciada',
  requestBodyLabel: 'Cuerpo de la solicitud',
  responseBodyLabel: 'Cuerpo de la respuesta',
  responseBodyTruncatedLabel: 'Cuerpo de la respuesta (truncado)',
  sseEventsLabel: 'Eventos SSE ({{count}})',
} as const;
