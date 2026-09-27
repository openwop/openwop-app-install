/**
 * `twin` namespace — user-facing copy for the digital-twin feature
 * (agent twin grants + recall). Auto-registered by the i18n catalog glob.
 * One `key: 'value',` per line, 2-space indent.
 */
export const messages = {
  // ProfileTwinGrantsTab — "Who can recall my memory"
  grantsIntro: 'Agentes a los que ha permitido recuperar su corpus como su <0>gemelo digital</0>. Revocar detiene de inmediato toda recuperación posterior, incluso a mitad de un turno en curso. No puede retirar lo ya recuperado: el contenido recuperado antes en ese mismo turno permanece en él, y no puede borrar lo que un agente ya escribió en una conversación anterior. La recuperación solo le responde a usted: cuando cualquier otra persona — un colega, o una automatización sin atribución — se dirige a su gemelo, no obtiene nada de su memoria. En una llamada de voz en vivo, el contenido compuesto al inicio de la llamada permanece en esa llamada hasta que termina.',
  failedToLoadGrants: 'No se han podido cargar las concesiones.',
  recallRevokedEverywhere: 'Recuperación revocada. Sin más recuperación a partir de ahora.',
  revokeFailed: 'No se ha podido revocar.',
  loading: 'Cargando…',
  noAgentTitle: 'Ningún agente puede recuperar su memoria',
  noAgentBody: 'Abra la <0>pestaña Integraciones</0> de un agente para convertirlo en su gemelo y permitir la recuperación. Después aparecerá aquí.',
  noScopes: 'sin ámbitos',
  identityUnknown: 'No pudimos confirmar cuál es tu perfil, así que no podemos saber si este gemelo está vinculado a ti. Los ajustes de recuerdo quedan ocultos hasta saberlo: esto no confirma que no haya recuerdo concedido.',
  twinOfUnknown: 'Gemelo de (propietario sin confirmar)',
  agentNamesUnavailable: 'No se pudieron cargar los nombres de los agentes, así que los permisos de abajo muestran ids sin procesar. Revocar sigue funcionando.',
  revoke: 'Revocar',
  revokeNothingToRevoke: 'Nada que revocar: ese acceso ya había terminado.',
  scopeUnknown: 'un tipo de acceso no reconocido',
  // TWIN-UX-4 — visibilidad de uso en las tarjetas de consentimiento
  failedToLoadRecalls: 'No se pudo cargar la actividad de recuerdo.',
  recallsUnavailable: 'No se pudo cargar la actividad de recuerdo: es una lectura fallida, no una confirmación de que no se recordó nada.',
  lastRecalled_one: 'Último recuerdo: {{date}} · {{count}} vez',
  lastRecalled_other: 'Último recuerdo: {{date}} · {{count}} veces',
  neverRecalled: 'Aún no ha recordado nada.',
  deniedRecallAttempts_one: 'Se denegó {{count}} intento de otra persona',
  deniedRecallAttempts_other: 'Se denegaron {{count}} intentos de otras personas',

  // AgentTwinPanel — "Twin of …" affordance
  digitalTwin: 'Gemelo digital',
  panelIntro: 'Vincule a {{persona}} con una persona para que pueda actuar como su gemelo digital. El agente puede recuperar la memoria o el conocimiento de esa persona <0>solo después de que lo conceda</0>: un vínculo por sí solo no concede nada.',
  failedToLoadTwinLink: 'No se ha podido cargar el vínculo de gemelo.',
  twinLoadFailedBody: 'No se ha podido leer el vínculo de gemelo de {{persona}}. Es una lectura fallida, no una respuesta: no significa que {{persona}} no esté vinculado, así que la acción de vincular se retiene hasta que funcione.',
  twinRetry: 'Reintentar',
  actionFailed: 'La acción ha fallado.',
  notTwinYet: '{{persona}} aún no es gemelo de nadie.',
  nowYourTwin: '{{persona}} ahora es su gemelo.',
  makeTwinOfMe: 'Convertir a {{persona}} en un gemelo mío',
  twinOfYou: 'Gemelo de <0>usted</0>',
  twinOfPerson: 'Gemelo de',
  twinLinkRemoved: 'Vínculo de gemelo eliminado.',
  unlink: 'Desvincular',
  unlinkConfirmTitle: '¿Desvincular a {{persona}} de esta persona?',
  unlinkConfirmBody: 'Esto elimina el vínculo del gemelo Y revoca el consentimiento de {{name}} para que {{persona}} recupere su memoria o conocimiento. No se le notifica. Podrá concederlo de nuevo cuando vuelva a vincularlo.',
  unlinkConfirmBodySelf: 'Esto elimina el vínculo del gemelo Y revoca su consentimiento para que {{persona}} recupere su memoria o conocimiento. Podrá concederlo de nuevo cuando vuelva a vincularlo.',
  unlinkNothingRemoved: 'No había ningún vínculo de gemelo que eliminar.',
  allowRecallHeading: 'Permitir que {{persona}} recupere su…',
  scopeMemory: 'memoria',
  scopeKnowledge: 'conocimiento',
  recallConsentSaved: 'Consentimiento de recuperación guardado.',
  updateConsent: 'Actualizar consentimiento',
  allowRecall: 'Permitir recuperación',
  recallRevoked: 'Recuperación revocada.',
  revokeRecall: 'Revocar recuperación',
  recallActive: 'Activo: {{persona}} puede recuperar su {{scopes}}. Revocar detiene de inmediato toda recuperación posterior; el contenido ya recuperado — incluso antes en el mismo turno — permanece, y no puede borrar lo que {{persona}} ya escribió. Solo recupera cuando usted mismo le habla: cualquier otra persona no obtiene nada.',
  recallActiveNothing: 'nada',
  recallActiveEmpty: 'Activo, pero sin ámbitos seleccionados: {{persona}} no puede leer nada. Elija memoria o conocimiento arriba.',
  noRecallGranted: 'Aún no se ha concedido recuperación: {{persona}} no puede leer su memoria ni su conocimiento.',
  onlyLinkedCanAllow: 'Solo {{name}} puede permitir que {{persona}} recupere su memoria o conocimiento.',
  grantsLoadFailedTitle: "No se pudo cargar el acceso de los agentes",
  grantsLoadFailedBody: "Es una lectura fallida, no una lista vacía: no significa que ningún agente tenga acceso a ti.",
  grantsRetry: "Reintentar",

  // ProfilePage — la pestaña de gemelo cuando falló la LECTURA del interruptor de función
  toggleReadFailedTitle: 'No se pudo comprobar si la recuperación de gemelo está habilitada aquí',
  toggleReadFailedBody: 'La comprobación de la función falló, así que no podemos mostrar su panel de consentimiento: es una lectura fallida, no una confirmación de que la recuperación esté desactivada ni de que ningún agente tenga acceso a usted.',
} as const;
