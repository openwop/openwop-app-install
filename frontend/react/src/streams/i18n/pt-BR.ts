/**
 * `streams` namespace — user-facing strings for the event-stream view
 * (`src/streams/`). FLAT camelCase keys, one per line (ADR 0065). The event
 * count uses i18next plural suffixes (`_one`/`_other`) with `{{count}}`.
 */
export const messages = {
  noEventsYet: 'Nenhum evento ainda.',
  emittedMediaAlt: 'mídia emitida',
  downloadAsset: 'baixar recurso',
  forkTitle: 'Bifurcar uma nova execução a partir deste evento (modo branch)',
  fork: 'bifurcar',
  payload: 'payload',
  copy: 'Copiar',
  copied: 'Copiado',
  copyTitle: 'Copiar eventos como markdown (cole no Claude Code, Slack, GitHub)',
  exportJson: 'Exportar JSON',
  exportJsonTitle: 'Baixar o log completo de eventos como JSON',
  eventCount_one: '{{count}} evento',
  eventCount_other: '{{count}} eventos',
  noEventsYetBody: 'Os eventos aparecem aqui ao vivo enquanto a execução acontece.',
  eventsUnreadableTitle: 'Não foi possível carregar os eventos desta execução.',
  eventsUnreadableBody: 'O log de eventos não carregou, então não podemos dizer o que esta execução fez. Isso não é o mesmo que a execução não ter produzido nada.',
  eventsLoadingTitle: 'Carregando eventos…',
} as const;
