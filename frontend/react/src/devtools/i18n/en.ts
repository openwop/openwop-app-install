/**
 * `devtools` namespace — user-facing strings for the network inspector
 * (`src/devtools/NetworkPanel.tsx`). Developer-facing surface, but its visible
 * UI copy is externalized per ADR 0065. FLAT camelCase keys, one per line. The
 * call count uses i18next plural suffixes (`_one`/`_other`) with `{{count}}`.
 */
export const messages = {
  inspectorLabel: 'Network inspector',
  network: 'Network',
  callCount_one: '· {{count}} call',
  callCount_other: '· {{count}} calls',
  clearTitle: 'Clear the buffer',
  clear: 'Clear',
  closePanel: 'Close network panel',
  filterAll: 'All ({{count}})',
  filterRest: 'REST ({{count}})',
  filterSse: 'SSE ({{count}})',
  filterErrors: 'Errors ({{count}})',
  filterByPath: 'Filter by path…',
  noActivity: 'No network activity yet. Use the app and calls will appear here.',
  noMatch: 'No calls match the current filter.',
  bufferNote: 'Buffer holds the last 200 calls. Cleared on reload.',
  errShort: 'ERR',
  urlLabel: 'URL',
  startedLabel: 'Started',
  requestBodyLabel: 'Request body',
  responseBodyLabel: 'Response body',
  responseBodyTruncatedLabel: 'Response body (truncated)',
  sseEventsLabel: 'SSE events ({{count}})',
} as const;
