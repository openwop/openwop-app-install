/**
 * `devtools` namespace — user-facing strings for the network inspector
 * (`src/devtools/NetworkPanel.tsx`). Developer-facing surface, but its visible
 * UI copy is externalized per ADR 0065. FLAT camelCase keys, one per line. The
 * call count uses i18next plural suffixes (`_one`/`_other`) with `{{count}}`.
 */
export const messages = {
  inspectorLabel: 'Inspetor de rede',
  network: 'Rede',
  callCount_one: '· {{count}} chamada',
  callCount_other: '· {{count}} chamadas',
  clearTitle: 'Limpar o buffer',
  clear: 'Limpar',
  closePanel: 'Fechar painel de rede',
  filterAll: 'Todas ({{count}})',
  filterRest: 'REST ({{count}})',
  filterSse: 'SSE ({{count}})',
  filterErrors: 'Erros ({{count}})',
  filterByPath: 'Filtrar por caminho…',
  noActivity: 'Nenhuma atividade de rede ainda. Use o app e as chamadas aparecerão aqui.',
  noMatch: 'Nenhuma chamada corresponde ao filtro atual.',
  bufferNote: 'O buffer guarda as últimas 200 chamadas. Limpo ao recarregar.',
  errShort: 'ERR',
  urlLabel: 'URL',
  startedLabel: 'Iniciado',
  requestBodyLabel: 'Corpo da requisição',
  responseBodyLabel: 'Corpo da resposta',
  responseBodyTruncatedLabel: 'Corpo da resposta (truncado)',
  sseEventsLabel: 'Eventos SSE ({{count}})',
} as const;
