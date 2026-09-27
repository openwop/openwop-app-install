/** Namespace `usage-analytics` (ADR 0118) — panel de uso/costes de LLM. */
export const messages = {
  // The feature-specific REASON an organization is needed — a capitalised
  // sentence minus its stop, which `ui:orgStateEmptyBody` supplies. The frame
  // carries no instruction (that is the CTA's) and no noun, so this clause is
  // the one place the noun appears: say "organization", never "org".
  orgsEmptyClause: 'El uso de modelos pertenece a una organización',
  orgsFailedClause: 'El resumen de uso nunca llegó a solicitarse',
  eyebrow: 'Espacio',
  title: 'Uso de LLM',
  lede: 'Uso de tokens por modelo en este espacio. Solo lectura; solo recuentos de tokens.',
  colProvider: 'Proveedor',
  colModel: 'Modelo',
  colInput: 'Tokens de entrada',
  colOutput: 'Tokens de salida',
  colCalls: 'Llamadas',
  empty: 'Aún no hay uso registrado.',
  emptyHint: 'El uso aparece aquí cuando se ejecutan conversaciones con un proveedor configurado.',
  loadError: 'No se pudo cargar el uso.',
  loadFailedTitle: 'No se pudo cargar el uso',
  loadRetry: 'Reintentar',
  disabled: 'El análisis de uso está desactivado en este espacio.',
  colCost: 'Coste est.',

  // §4.5 collection kit — usage filter
  filterGroup: 'Filtros',
  filterPlaceholder: 'Buscar uso…',
  filterAria: 'Buscar uso por proveedor o modelo',
  filterProviderLabel: 'Filtrar por proveedor',
  allProviders: 'Todos los proveedores',
  noMatchTitle: 'Sin coincidencias',
  noMatchBody: 'Nada coincide con los filtros actuales.',
  clearFilters: 'Borrar filtros',
  costUnpriced: "—",
  costUnpricedHint: "No hay tarifa registrada para este modelo, así que su coste es desconocido, no cero.",
  costIncomplete: "{{count}} modelo(s) no tienen tarifa registrada, así que su coste es desconocido y los totales aquí están incompletos.",
} as const;
