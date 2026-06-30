/**
 * `connections` namespace — user-facing copy for the Connections feature
 * (ADR 0024 / 0025 / 0028). Feature-self-contained: every connections string
 * lives here. Generic actions/states are reused from the `common` namespace via
 * `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Acceso y datos',
  title: 'Conexiones',
  lede: 'Conecte las aplicaciones con las que trabaja su asistente — Google, Slack, ServiceNow, Zoom.',

  // Manager — generic load/connect errors & toasts
  loadFailed: 'No se pudo cargar.',
  connectFailed: 'La conexión falló.',
  revokeFailed: 'La revocación falló.',
  testFailed: 'La prueba falló.',
  connected: '{{label}} conectado.',
  connectedForOrg: '{{label}} conectado para la organización.',
  couldNotStart: 'No se pudo iniciar {{label}}.',
  connectionHealthy: '{{name}} está correcto.',
  connectionNeedsReconnect: '{{name}} necesita volver a conectarse.',

  // OAuth consent card
  connectWithConsent: 'Conectar con consentimiento',
  consentBlurb:
    'Se le enviará al proveedor para aprobar el acceso de lectura y después se le devolverá aquí. Sus tokens se almacenan cifrados y nunca se le vuelven a mostrar.',
  connectProvider: 'Conectar {{label}}',
  connectingProvider: 'Conectando {{label}}…',
  notConfiguredHint:
    'Los proveedores atenuados aún no están configurados para OAuth en este host — el operador debe añadir las credenciales de cliente.',
  oauthNotConfiguredTitle: 'OAuth de {{label}} no está configurado en este host',

  // Secret connect form
  providerLabel: 'Proveedor (clave de API / token)',
  loadingProviders: 'Cargando proveedores…',
  secretLabel: 'Clave de API / token',
  secretPlaceholder: 'pegue su token',
  sharedWith: 'Compartido con',
  shareJustMe: 'Solo yo',
  shareOrganization: 'Organización',
  connect: 'Conectar',

  // Connections table
  tableCaption: 'Sus conexiones',
  colConnection: 'Conexión',
  colProvider: 'Proveedor',
  colSharing: 'Uso compartido',
  colStatus: 'Estado',
  sharingOrganization: 'Organización',
  sharingPersonal: 'Personal',
  sharingWrite: 'escritura',
  grantWriteAccess: 'Conceder acceso de escritura',
  grantWriteAccessLabel: 'Conceder acceso de escritura para {{name}}',
  grantWriteAccessConnect: 'acceso de escritura de {{label}}',
  connectProviderConnect: 'conectar {{label}}',
  testConnectionLabel: 'Probar {{name}}',
  test: 'Probar',
  revokeConnectionLabel: 'Revocar {{name}}',
  revoke: 'Revocar',
  noConnectionsTitle: 'Aún no hay conexiones',
  noConnectionsBody: 'Conecte una aplicación arriba para que su asistente pueda leer de ella.',

  // OAuth callback toast
  callbackConnected: '{{provider}} conectado.',
  callbackConsentDenied: 'Se rechazó el consentimiento.',
  callbackInvalidState: 'La sesión de consentimiento caducó — inténtelo de nuevo.',
  callbackMissingParams: 'La respuesta del proveedor estaba incompleta — inténtelo de nuevo.',
  callbackExchangeFailed: 'No se pudo completar el intercambio de tokens. Inténtelo de nuevo.',
  callbackGenericError: 'No se pudo conectar {{provider}}.',

  // Governance panel
  governanceTitle: 'Gobernanza',
  governanceBlurb:
    'Política del espacio de trabajo: qué proveedores pueden conectarse y qué puede hacer cada tipo de acción del asistente. Se aplica en los puntos de conexión, resolución y envío.',
  governanceSaved: 'Política de gobernanza guardada.',
  saveFailed: 'No se pudo guardar.',
  providerAllowlist: 'Lista de proveedores permitidos',
  restrictProviders: 'Restringir los proveedores conectables',
  actionPolicy: 'Política de acciones',
  policyApprovalRequired: 'Se requiere aprobación (ejecutar al aprobar)',
  policyDraftOnly: 'Solo borrador (nunca se ejecuta)',
  policyDisabled: 'Desactivado (sin borradores)',
  savePolicy: 'Guardar política',
  mediaBudgetTitle: 'Presupuestos de generación multimedia',
  mediaBudgetBlurb:
    'Límites diarios por organización para la generación multimedia de pago (transcripción y texto a voz), configurados por el operador mediante variables de entorno. El uso se restablece a las 00:00 UTC.',
  mediaBudgetTts: 'Texto a voz',
  mediaBudgetStt: 'Transcripción',
  mediaBudgetUsage: '{{used}} / {{cap}} {{unit}} usados hoy',
  mediaBudgetUncapped: '{{used}} {{unit}} usados hoy · sin límite',
  mediaUnitChars: 'caracteres',
  mediaUnitBytes: 'bytes',
  mediaBudgetBlurbEditable: 'Límites diarios por organización para la generación multimedia de pago. Deje un campo en blanco para usar el valor predeterminado del host; introduzca 0 para quitar el límite de esta organización. El uso se restablece a las 00:00 UTC.',
  mediaBudgetTtsOverride: 'Presupuesto de texto a voz (caracteres/día)',
  mediaBudgetSttOverride: 'Presupuesto de transcripción (bytes/día)',
  mediaBudgetEnvPlaceholder: 'Predeterminado del host: {{value}}',
  mediaBudgetNoDefault: 'sin límite',
  mediaBudgetSave: 'Guardar presupuestos multimedia',
  mediaBudgetSaved: 'Presupuestos multimedia actualizados.',
  mediaBudgetInvalid: 'Los presupuestos deben estar en blanco o ser un número entero no negativo.',

  // OAuth client admin panel
  oauthClientSetup: 'Configuración del cliente OAuth (operador)',
  oauthClientBlurb:
    'Configure la aplicación OAuth de cada proveedor para que funcione su botón Conectar — sin variables de entorno, sin redespliegue. Registre con el proveedor la URI de redirección que se muestra abajo y después pegue aquí su Client ID y Secret. El secreto se sella en el servidor y no se vuelve a mostrar.',
  loadOAuthClientFailed: 'No se pudo cargar la configuración del cliente OAuth.',
  oauthClientSaved: 'Cliente OAuth guardado — {{provider}} ya puede ejecutar el consentimiento.',
  oauthClientRemoved: 'Cliente OAuth eliminado para {{provider}}.',
  removeFailed: 'No se pudo eliminar.',
  configured: 'Configurado',
  notConfigured: 'Sin configurar',
  redirectUriLabel: 'URI de redirección para registrar con {{label}}',
  clientIdLabel: 'Client ID',
  clientIdLabelCurrent: 'Client ID (actual: {{clientId}})',
  clientIdPlaceholder: 'pegue el client id de OAuth',
  clientIdPlaceholderReplace: 'reemplace el client id',
  clientSecretLabel: 'Client secret',
  clientSecretPlaceholder: 'pegue el client secret de OAuth',
  replace: 'Reemplazar',
  removeOAuthClientLabel: 'Eliminar el cliente OAuth para {{label}}',
} as const;
