/** Namespace `usage-analytics` (ADR 0118) — painel de uso/custos de LLM. */
export const messages = {
  // The feature-specific REASON an organization is needed — a capitalised
  // sentence minus its stop, which `ui:orgStateEmptyBody` supplies. The frame
  // carries no instruction (that is the CTA's) and no noun, so this clause is
  // the one place the noun appears: say "organization", never "org".
  orgsEmptyClause: 'O uso de modelos pertence a uma organização',
  orgsFailedClause: 'O resumo de uso nunca chegou a ser solicitado',
  eyebrow: 'Espaço',
  title: 'Uso de LLM',
  lede: 'Uso de tokens por modelo neste espaço. Somente leitura; apenas contagens de tokens.',
  colProvider: 'Provedor',
  colModel: 'Modelo',
  colInput: 'Tokens de entrada',
  colOutput: 'Tokens de saída',
  colCalls: 'Chamadas',
  empty: 'Nenhum uso registrado ainda.',
  emptyHint: 'O uso aparece aqui quando conversas são executadas em um provedor configurado.',
  loadError: 'Não foi possível carregar o uso.',
  loadFailedTitle: 'Não foi possível carregar o uso',
  loadRetry: 'Tentar novamente',
  disabled: 'A análise de uso está desativada neste espaço.',
  colCost: 'Custo est.',

  // §4.5 collection kit — usage filter
  filterGroup: 'Filtros',
  filterPlaceholder: 'Buscar uso…',
  filterAria: 'Buscar uso por provedor ou modelo',
  filterProviderLabel: 'Filtrar por provedor',
  allProviders: 'Todos os provedores',
  noMatchTitle: 'Sem correspondências',
  noMatchBody: 'Nada corresponde aos filtros atuais.',
  clearFilters: 'Limpar filtros',
  costUnpriced: "—",
  costUnpricedHint: "Não há tarifa registrada para este modelo, então seu custo é desconhecido — não zero.",
  costIncomplete: "{{count}} modelo(s) não têm tarifa registrada, então seu custo é desconhecido e os totais aqui estão incompletos.",
} as const;
