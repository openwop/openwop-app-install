/**
 * `consent` namespace — user-facing copy for the Consent feature (ADR 0020).
 * Feature-self-contained: every consent string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  orgsEmptyClause: 'La política de consentimiento pertenece a una organización',
  orgsFailedClause: 'La política de consentimiento nunca llegó a solicitarse',
  // Page chrome
  eyebrow: 'Espacio de trabajo',
  title: 'Consentimiento',
  lede: 'Política de consentimiento por región + herramientas para interesados (RGPD).',

  // Gating / empty states
  notEnabledTitle: 'El consentimiento no está habilitado',
  notEnabledBody: 'Mientras el consentimiento está desactivado, el consentimiento de marketing no se aplica: solo se aplican la supresión y el borrado. Pida a un administrador que habilite la función Consentimiento para este inquilino.',

  // aria-labels
  orgPickerLabel: 'Organización',

  // Policy form
  regulatedRegionsLabel: 'Regiones reguladas (separadas por comas)',
  regulatedRegionsNotEnforced: 'Solo informativo — ninguna ruta de aplicación lee esta lista. La aplicación proviene del modo predeterminado y del consentimiento registrado de cada sujeto.',
  channel_email: 'Correo',
  channel_sms: 'SMS',
  channel_push: 'Push',
  channel_whatsapp: 'WhatsApp',
  sourceLine: 'Capturado vía {{source}}',
  legalBasisLine: 'Base: {{basis}}',
  purposesLine: 'Propósitos: {{purposes}}',
  receiptFailedFeatures: 'Sistemas fallidos: {{features}}.',
  regulatedRegionsPlaceholder: 'UE, CA',
  defaultModeLabel: 'Modo predeterminado',
  defaultModeOptInLabel: 'consentimiento explícito (fallo cerrado)',
  defaultModeOptOutLabel: 'exclusión voluntaria',
  savePolicy: 'Guardar política',

  // Data subject (GDPR)
  dataSubjectTitle: 'Interesado (RGPD)',
  subjectKeyLabel: 'Clave del interesado',
  subjectKeyPlaceholder: 'cookie de visitante / id de usuario',
  lookup: 'Buscar',
  erase: 'Borrar',
  eraseConfirm: '¿Borrar todos los datos del interesado "{{subjectKey}}"? Eliminación de datos del interesado conforme al RGPD: no se puede deshacer.',
  lookupNoRecord: 'No hay registro de consentimiento para ese interesado: los datos posteriores (si los hay) se borran igualmente.',

  legalHoldTitle: 'Este espacio de trabajo est\u00e1 bajo retenci\u00f3n legal',
  legalHoldBody: 'El borrado est\u00e1 bloqueado mientras la retenci\u00f3n est\u00e9 vigente: una reclamaci\u00f3n legal u obligaci\u00f3n de conservaci\u00f3n prevalece sobre el derecho de supresi\u00f3n. Motivo: {{reason}}. Vigente desde {{since}}. Un superadministrador debe levantar la retenci\u00f3n antes de que pueda ejecutarse cualquier eliminaci\u00f3n de datos del interesado.',
  legalHoldEraseDisabled: 'El borrado est\u00e1 bloqueado por una retenci\u00f3n legal en este espacio de trabajo.',
  eraseFailedHeld: 'Borrado rechazado: este espacio de trabajo est\u00e1 bajo retenci\u00f3n legal.',
  retryErasure: 'Reintentar el borrado',
  lookupResultFor: 'Consentimiento de \u201c{{subjectKey}}\u201d',
  lookupFailedTitle: 'No se pudo leer el consentimiento de este interesado',
  lookupFailedBody: 'La lectura de \u201c{{subjectKey}}\u201d fall\u00f3, as\u00ed que a\u00fan no se sabe nada sobre esta persona. Eso no es lo mismo que no tener registro de consentimiento: reint\u00e9ntalo antes de concluir nada.',
  // Category chips
  categoryAnalytics: 'analítica',
  categoryMarketing: 'márquetin',
  categoryNecessaryOnly: 'solo necesarias',

  // Consent records
  recordsTitle: 'Registros de consentimiento',
  noRecords: 'Aún no hay registros de consentimiento.',

  // Toasts — success
  policySaved: 'Política guardada',
  eraseConfirmBody: 'Se recorren todos los almacenes de funciones registrados, en todas las claves de identidad vinculadas de este interesado. No todo se destruye: sus datos propios se ELIMINAN; las filas que el espacio de trabajo sigue necesitando (pertenencias de acceso, versiones de documentos, tareas programadas) se ANONIMIZAN en el sitio \u2014 la fila sobrevive con los identificadores y el texto del interesado sobrescritos; y los registros que la ley obliga a conservar, como pedidos y facturas, se CONSERVAN con las partes personales redactadas (importes, identificadores y regi\u00f3n aproximada se mantienen). El borrado también bloquea de forma permanente los envíos de marketing y toda resuscripción pública de este interesado hasta que un administrador lo readmita. No se puede deshacer.',
  receiptOk: 'Borrado completado para "{{subjectKey}}" en {{keys}} clave(s) de identidad vinculada(s); los {{total}} almac\u00e9n(es) informaron \u00e9xito \u2014 datos eliminados o anonimizados en el sitio, con los registros de conservaci\u00f3n legal (pedidos, facturas) mantenidos de forma redactada. Los envíos de marketing y toda resuscripción pública de este interesado quedan bloqueados de forma permanente hasta que un administrador lo readmita.',
  receiptPartial: 'Borrado parcial de "{{subjectKey}}": fallaron {{failed}} paso(s) de borrado (entre {{total}} almacenes + la resolución de enlaces de identidad) — los datos de este interesado PUEDEN persistir.',
  receiptFoundNothing: 'El borrado de "{{subjectKey}}" se ejecutó sin errores, pero NO encontró nada que borrar en este espacio de trabajo ({{keys}} clave(s) de identidad vinculada(s) comprobadas en {{total}} almacenes). El borrado solo alcanza los datos de este espacio de trabajo — si esta persona existe en otro lugar, sus datos personales pueden estar en su espacio de trabajo personal; ejecuta el borrado también allí. Los envíos de marketing y toda resuscripción pública de este interesado quedan bloqueados aquí de forma permanente hasta que un administrador lo readmita.',
  receiptHadRecord: 'Había un registro de consentimiento y se eliminó.',
  receiptNoRecord: 'No había registro de consentimiento.',
  receiptRetry: 'El borrado es idempotente: vuelve a ejecutarlo; si sigue fallando, escala antes de dar la solicitud por completada.',
  receiptMissing: 'Esperados pero no registrados en este host: {{features}}.',
  receiptRowsTouched: '{{count}} fila(s) eliminada(s) o depurada(s).',
  eraseRefusedHeldTitle: 'Borrado rechazado: retención legal',
  eraseRefusedHeldBody: 'El borrado de "{{subjectKey}}" fue rechazado: este espacio de trabajo está bajo retención legal. No se eliminó nada. Un superadministrador del espacio de trabajo debe levantar la retención antes de que esta solicitud pueda ejecutarse.',
  readmitButton: 'Readmitir interesado',
  readmitHintAfterErasure: 'Si esta persona pide volver más adelante, un administrador puede readmitirla. Eso solo levanta el bloqueo: no se otorga ningún consentimiento hasta que vuelva a optar por participar.',
  readmitHintNoRecord: 'Si esta persona fue borrada y ha pedido volver, un administrador puede readmitirla. Eso solo levanta el bloqueo: no se otorga ningún consentimiento hasta que vuelva a optar por participar.',
  readmitDialogTitle: '¿Readmitir a «{{subjectKey}}»?',
  readmitDialogBody: 'Esto levanta el bloqueo del borrado sobre los envíos de marketing y la resuscripción pública de este interesado. Por sí solo no otorga nada: no se registra ningún consentimiento; su próxima aceptación afirmativa es lo que lo vuelve a otorgar. Tu declaración a continuación es tu constancia de que la persona pidió volver, y se escribe en el registro de auditoría.',
  readmitAttestationLabel: 'Tu declaración de que esta persona pidió volver',
  readmitAttestationPlaceholder: 'p. ej. Pidió por correo el 11 de sep. volver a recibir nuestro boletín; ticket n.º 4821.',
  readmitAttestationHint: '{{count}} de al menos {{min}} caracteres',
  readmitConfirm: 'Readmitir',
  readmitDone: 'Se readmitió a «{{subjectKey}}». No se otorgó ningún consentimiento: su próxima aceptación afirmativa lo vuelve a otorgar.',
  readmitNotErased: '«{{subjectKey}}» no está borrado en este host: no había ningún bloqueo que levantar.',
  readmitFailed: 'La readmisión falló.',
  readmitForbidden: 'Solo un administrador del espacio de trabajo puede readmitir a un interesado.',
  readmitAttestationTooShort: 'La declaración debe tener al menos {{min}} caracteres.',

  // Toasts / errors
  loadPolicyFailed: 'No se ha podido cargar la política.',
  policyLoadRetry: 'Reintentar',
  policyLoadFailedTitle: 'No se pudo cargar la política de consentimiento',
  saveFailed: 'No se ha podido guardar.',
  lookupFailed: 'La búsqueda ha fallado.',
  eraseFailed: 'El borrado ha fallado.',
  // §4.5 collection kit — records filtering + designed empty/zero-match states
  recordsFilterGroup: 'Filtrar',
  recordsSearchPlaceholder: 'Buscar por sujeto…',
  recordsSearchAria: 'Buscar registros de consentimiento por sujeto',
  categoryFacetAria: 'Filtrar por categoría',
  categoryAll: 'Todas las categorías',
  regionFacetAria: 'Filtrar por región',
  regionAll: 'Todas las regiones',
  noRecordsTitle: 'Aún no hay registros de consentimiento',
  recordsLoadFailedTitle: 'No se pudieron cargar los registros de consentimiento',
  recordsLoadFailedBody: 'La lectura de registros falló: esta lista NO está vacía hasta que una lectura exitosa lo confirme.',
  unsavedChanges: 'Cambios sin guardar',
  nothingToSave: 'No hay cambios que guardar',
  discardEditsTitle: '¿Descartar los cambios de política sin guardar?',
  discardEditsBody: 'Cambiar de espacio de trabajo descartará tus ediciones de la política de consentimiento sin guardar.',
  discardEditsConfirm: 'Descartar y cambiar',
  recordsNoMatchTitle: 'Sin coincidencias',
  recordsNoMatchBody: 'Ningún registro de consentimiento coincide con los filtros actuales.',
  recordsClearFilters: 'Limpiar filtros',
} as const;
