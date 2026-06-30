/**
 * `conversationTools` namespace (ADR 0132) — alcance de herramientas por conversación.
 * Spanish (es).
 */
export const messages = {
  openTitle: 'Alcance de herramientas para esta conversación',
  heading: 'Alcance de herramientas de la conversación',
  blurb: 'Controla qué herramientas del agente puede usar en esta conversación y cuáles requieren tu aprobación primero. Solo restringe: nunca concede herramientas más allá de los permisos del agente.',
  pendingHeading: 'Aprobaciones pendientes',
  noPending: 'No hay herramientas esperando aprobación.',
  approve: 'Aprobar',
  deny: 'Denegar',
  approveAria: 'Aprobar {{tool}}',
  denyAria: 'Denegar {{tool}}',
  scopeHeading: 'Acceso a herramientas',
  modeLegend: 'Modo de alcance de herramientas',
  modeDefault: 'Predeterminado del agente (todas sus herramientas)',
  modeRestricted: 'Restringido (solo las herramientas de abajo)',
  list_enabled: 'Habilitadas',
  list_disabled: 'Deshabilitadas',
  list_requireApproval: 'Requieren aprobación',
  addPlaceholder: 'id de herramienta (p. ej. crm.contact.update)',
  removeAria: 'Quitar {{tool}}',
  close: 'Cerrar',
  save: 'Guardar alcance',
  saving: 'Guardando…',
  saved: 'Alcance de herramientas guardado',
  loadFailed: 'No se pudo cargar el alcance de herramientas.',
  decisionFailed: 'No se pudo registrar tu decisión.',
  saveFailed: 'No se pudo guardar el alcance de herramientas.',
};
