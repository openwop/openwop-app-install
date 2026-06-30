/**
 * `twin` namespace — user-facing copy for the digital-twin feature
 * (agent twin grants + recall). Auto-registered by the i18n catalog glob.
 * One `key: 'value',` per line, 2-space indent.
 */
export const messages = {
  // ProfileTwinGrantsTab — "Who can recall my memory"
  grantsIntro: 'Agentes a los que ha permitido recuperar su corpus como su <0>gemelo digital</0>. La revocación surte efecto de inmediato, incluso en cualquier ejecución ya en curso.',
  failedToLoadGrants: 'No se han podido cargar las concesiones.',
  recallRevokedEverywhere: 'Recuperación revocada: efectiva de inmediato, en todas partes.',
  revokeFailed: 'No se ha podido revocar.',
  loading: 'Cargando…',
  noAgentTitle: 'Ningún agente puede recuperar su memoria',
  noAgentBody: 'Cuando convierta a un agente en su gemelo y permita la recuperación (en el perfil del agente), aparecerá aquí.',
  noScopes: 'sin ámbitos',
  revoke: 'Revocar',

  // AgentTwinPanel — "Twin of …" affordance
  digitalTwin: 'Gemelo digital',
  panelIntro: 'Vincule a {{persona}} con una persona para que pueda actuar como su gemelo digital. El agente puede recuperar la memoria o el conocimiento de esa persona <0>solo después de que lo conceda</0>: un vínculo por sí solo no concede nada.',
  failedToLoadTwinLink: 'No se ha podido cargar el vínculo de gemelo.',
  actionFailed: 'La acción ha fallado.',
  notTwinYet: '{{persona}} aún no es gemelo de nadie.',
  nowYourTwin: '{{persona}} ahora es su gemelo.',
  makeTwinOfMe: 'Convertir a {{persona}} en un gemelo mío',
  twinOfYou: 'Gemelo de <0>usted</0>',
  twinOfPerson: 'Gemelo de',
  twinLinkRemoved: 'Vínculo de gemelo eliminado.',
  unlink: 'Desvincular',
  allowRecallHeading: 'Permitir que {{persona}} recupere su…',
  scopeMemory: 'memoria',
  scopeKnowledge: 'conocimiento',
  recallConsentSaved: 'Consentimiento de recuperación guardado.',
  updateConsent: 'Actualizar consentimiento',
  allowRecall: 'Permitir recuperación',
  recallRevoked: 'Recuperación revocada.',
  revokeRecall: 'Revocar recuperación',
  recallActive: 'Activo: {{persona}} puede recuperar su {{scopes}}. La revocación es inmediata, en todas partes.',
  recallActiveNothing: 'nada',
  noRecallGranted: 'Aún no se ha concedido recuperación: {{persona}} no puede leer su memoria ni su conocimiento.',
  onlyLinkedCanAllow: 'Solo {{name}} puede permitir que {{persona}} recupere su memoria o conocimiento.',
} as const;
