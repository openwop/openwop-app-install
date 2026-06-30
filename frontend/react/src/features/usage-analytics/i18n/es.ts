/** Namespace `usage-analytics` (ADR 0118) — panel de uso/costes de LLM. */
export const messages = {
  eyebrow: 'Espacio',
  title: 'Uso de LLM',
  lede: 'Uso de tokens por modelo en este espacio. Solo lectura; solo recuentos de tokens.',
  org: 'Espacio',
  colProvider: 'Proveedor',
  colModel: 'Modelo',
  colInput: 'Tokens de entrada',
  colOutput: 'Tokens de salida',
  colCalls: 'Llamadas',
  empty: 'Aún no hay uso registrado.',
  emptyHint: 'El uso aparece aquí cuando se ejecutan conversaciones con un proveedor configurado.',
  loadError: 'No se pudo cargar el uso.',
  disabled: 'El análisis de uso está desactivado en este espacio.',
  colCost: 'Coste est.',
} as const;
