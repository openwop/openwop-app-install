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
  usingManifest: 'Usando el valor del paquete',
  explainer: 'Las herramientas marcadas se ofrecen a este agente. Desmarcar una herramienta del paquete la revoca; marcar otra la concede. Una herramienta no instalada solo se ofrece cuando su paquete esté montado.',
  toolChecklistLabel: 'Herramientas para {{label}}',
  manifestTag: 'valor del paquete',
  notMountedTag: 'no montada',
  resetToManifest: 'Restablecer al paquete',
  saveOverride: 'Guardar anulación',
  saving: 'Guardando…',
} as const;
