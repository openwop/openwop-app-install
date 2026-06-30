/** Namespace `evals` (ADR 0123) — clasificación de calidad de modelos. */
export const messages = {
  eyebrow: 'Plataforma',
  title: 'Clasificación de modelos',
  lede: 'Mira qué modelo prefiere tu equipo, clasificado por los votos a favor y en contra de las respuestas reales del chat.',
  org: 'Espacio',
  colModel: 'Modelo',
  colUp: 'A favor',
  colDown: 'En contra',
  colWinRate: 'Tasa de aciertos',
  colElo: 'Elo',
  empty: 'Aún no hay turnos valorados.',
  emptyHint: 'Los pulgares arriba/abajo en las respuestas construyen esta clasificación.',
  loadError: 'No se pudo cargar la clasificación.',
  disabled: 'La clasificación de evaluación está desactivada en este espacio.',
} as const;
