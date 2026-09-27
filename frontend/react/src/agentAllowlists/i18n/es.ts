/**
 * `agentAllowlists` namespace — editor de listas de herramientas de agentes (ADR 0104).
 * Spanish (es).
 */
export const messages = {
  eyebrow: 'Plataforma',
  title: 'Listas de herramientas de agentes',
  lede: 'Concede o revoca las herramientas que se ofrecen a un agente, sin editar un paquete. Las anulaciones se aplican por espacio de trabajo y surten efecto en la próxima ejecución.',
  loading: 'Cargando agentes…',
  loadFailed: 'No se pudieron cargar los agentes.',
  saveFailed: 'No se pudo guardar la anulación.',
  resetFailed: 'No se pudo restablecer al valor del paquete.',
  noAgentsTitle: 'No se encontraron agentes',
  noAgentsBody: 'No hay agentes ejecutables instalados para este espacio de trabajo.',
  agentListLabel: 'Agentes',
  overriddenChip: 'anulación',
  pickAgentTitle: 'Elige un agente',
  pickAgentBody: 'Elige un agente a la izquierda para ver y editar las herramientas que se le ofrecen.',
  agentIdChip: 'id: {{id}}',
  usingOverride: 'Anulación ({{n}} herramientas)',
  usingManifest: 'Valor del paquete + herramientas de plataforma',
  explainer: 'Las herramientas marcadas se ofrecen a este agente. Seis herramientas de plataforma están activas por defecto para todos los agentes (etiquetadas «activa por defecto»); desmarcar una la revoca para este agente, marcar otra la concede. Una herramienta no instalada solo se ofrece cuando su paquete esté montado.',
  toolChecklistLabel: 'Herramientas para {{label}}',
  defaultOnTag: 'activa por defecto',
  manifestTag: 'valor del paquete',
  notMountedTag: 'no montada',
  resetToManifest: 'Restablecer al paquete',
  saveOverride: 'Guardar anulación',
  pinWarning: 'Al guardar, este agente queda fijado a las herramientas marcadas aquí. Ya no recibirá automáticamente nuevas herramientas activas por defecto hasta que restablezcas el valor del paquete.',
  saving: 'Guardando…',
  loadFailedTitle: "No se pudieron cargar las listas de herramientas permitidas",
  loadFailedBody: "Es una lectura fallida, no una lista vacía: la lista de cada agente no ha cambiado.",
  retry: "Reintentar",
} as const;
