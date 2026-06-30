/** Namespace `usage-analytics` (ADR 0118) — painel de uso/custos de LLM. */
export const messages = {
  eyebrow: 'Espaço',
  title: 'Uso de LLM',
  lede: 'Uso de tokens por modelo neste espaço. Somente leitura; apenas contagens de tokens.',
  org: 'Espaço',
  colProvider: 'Provedor',
  colModel: 'Modelo',
  colInput: 'Tokens de entrada',
  colOutput: 'Tokens de saída',
  colCalls: 'Chamadas',
  empty: 'Nenhum uso registrado ainda.',
  emptyHint: 'O uso aparece aqui quando conversas são executadas em um provedor configurado.',
  loadError: 'Não foi possível carregar o uso.',
  disabled: 'A análise de uso está desativada neste espaço.',
  colCost: 'Custo est.',
} as const;
