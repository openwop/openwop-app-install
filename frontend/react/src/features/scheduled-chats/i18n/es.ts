/** `scheduled-chats` namespace (ADR 0125). */
export const messages = {
  eyebrow: 'Plataforma',
  title: 'Chats programados',
  lede: 'Haz que un agente ejecute un chat de forma programada (un resumen diario, un informe de los lunes) y publique el resultado en una conversación.',
  org: 'Espacio',
  colAgent: 'Agente',
  colSchedule: 'Programación',
  colStatus: 'Estado',
  delete: 'Eliminar',
  active: 'Activo',
  inert: 'Inerte',
  empty: 'Aún no hay chats programados.',
  emptyHint: 'Crea un chat programado para ejecutar un agente con cron.',
  loadError: 'No se pudieron cargar los chats programados.',
  disabled: 'Los chats programados están desactivados en este espacio.',
  colNextRun: 'Próxima ejecución',
} as const;
