/**
 * `users` namespace — user-facing copy for the users feature (incl. SSO panel).
 * Feature-self-contained: every users string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Acceso y datos',
  title: 'Usuarios y autenticación',
  lede: 'Cuentas duraderas tras el principal autenticado — la base de la identidad.',

  // Signed-in notice
  signedInAs: 'Sesión iniciada como <0>{{name}}</0> (origen: {{source}}; estado: {{status}}).',
  meFailed: 'No se pudo cargar tu propio registro de usuario. La lista y los ajustes de SSO de abajo no se ven afectados.',

  // Form field labels
  fieldPrincipalId: 'Id del principal',
  fieldDisplayName: 'Nombre visible',

  // Placeholders
  principalIdPlaceholder: 'oidc:sub-123',
  displayNamePlaceholder: 'Juana Pérez',

  // Buttons
  addUser: 'Añadir usuario',
  disable: 'Deshabilitar',
  enable: 'Habilitar',

  // aria-labels
  deleteRowLabel: 'Eliminar {{name}}',
  disableRowLabel: 'Desactivar {{name}}',
  enableRowLabel: 'Activar {{name}}',

  // Table caption + column headers
  captionUsers: 'Usuarios',
  colPrincipal: 'Principal',
  colEmail: 'Correo electrónico',
  colSource: 'Origen',
  colGroups: 'Grupos',
  colStatus: 'Estado',

  // Empty state
  noUsers: 'Aún no hay usuarios — añada uno arriba o inicie sesión para crear su registro.',

  // Toasts
  userAdded: 'Usuario añadido.',
  addFailed: 'Error al añadir.',
  updateFailed: 'Error al actualizar.',
  deleteFailed: 'Error al eliminar.',
  loadUsersFailed: 'No se pudieron cargar los usuarios.',

  // ── SSO panel ──────────────────────────────────────────────────────────────
  ssoTitle: 'SSO empresarial y aprovisionamiento',
  ssoLede:
    'Inicio de sesión único SAML 2.0 y aprovisionamiento SCIM 2.0. Puntos de integración del host para despliegues de marca blanca / B2B — anunciados solo cuando están configurados y respetados.',
  ssoReadingCaps: 'Leyendo las capacidades del host…',
  ssoCapsFailed: 'No se pudieron leer las capacidades anunciadas por este host, así que no podemos decir si SAML o SCIM está habilitado. Esto no confirma que estén desactivados.',

  // SSO row state chips
  ssoAdvertised: 'Anunciado',
  ssoNotConfigured: 'No configurado',
  ssoActive: 'Activo',

  // SSO rows
  ssoOidcName: 'OIDC (Google / GitHub)',
  ssoOidcDetail: 'Bearer gestionado por Firebase — el inicio de sesión principal del host.',
  ssoPasswordName: 'Correo electrónico y contraseña',
  ssoPasswordDetail: 'Cuentas locales con MFA TOTP (esta aplicación, cuando la función Usuarios está activa).',
  ssoSamlName: 'SSO SAML 2.0',
  ssoSamlDetail: 'El host valida las aserciones del IdP en su ACS (Okta / Azure AD / Ping…).',
  ssoScimName: 'Aprovisionamiento SCIM 2.0',
  ssoScimDetail: 'El IdP crea/desactiva usuarios y asigna grupos mediante SCIM.',

  // SSO endpoints
  ssoEndpointsLabel: 'Endpoints de integración empresarial (apunte aquí su IdP)',
  ssoSamlAcs: 'ACS de SAML',
  ssoScimProvisioning: 'Aprovisionamiento SCIM',

  // SSO not-enabled alert (rich markup via <Trans>)
  ssoNotEnabled:
    'No está habilitado en este despliegue. Un host de marca blanca los activa configurando un certificado de IdP / bearer de SCIM; el host anuncia entonces los perfiles <0> openwop-auth-saml</0> / <1>openwop-auth-scim</1> de arriba.',
  deleteUserConfirm: '¿Eliminar al usuario "{{name}}"?',

  // Collection kit (§4.5 rules 11+13)
  filterGroup: 'Filtrar usuarios',
  filterPlaceholder: 'Buscar usuarios…',
  filterAria: 'Buscar usuarios por nombre o correo',
  filterStatusLabel: 'Filtrar por estado',
  filterSourceLabel: 'Filtrar por origen',
  allStatuses: 'Todos los estados',
  allSources: 'Todos los orígenes',
  status_active: 'Activo',
  status_disabled: 'Deshabilitado',
  source_oidc: 'OIDC',
  source_password: 'Contraseña',
  source_saml: 'SAML',
  source_scim: 'SCIM',
  source_manual: 'Manual',
  viewTable: 'Tabla',
  noMatchTitle: 'Ningún usuario coincide',
  noMatchBody: 'Ningún usuario coincide con los filtros actuales.',
  clearFilters: 'Borrar filtros',

  // ── ADR 0621 D5/D7 — consecuencias del ciclo de vida, autobloqueo, cerrar sesión en todas partes ──
  ownRowHint: 'Tu propia cuenta: pide a otro administrador que la modifique.',
  signOutEverywhere: 'Cerrar sesión en todas partes',
  revokeRowLabel: 'Cerrar la sesión de {{name}} en todas partes',
  revokeUserConfirm: '¿Cerrar la sesión de "{{name}}" en todas partes?',
  revokeUserBody: 'Esto termina de inmediato todas las sesiones activas de este usuario en todos los dispositivos. La cuenta sigue activa y podrá iniciar sesión de nuevo.',
  userSessionsRevoked: 'Se cerró la sesión de {{name}} en todas partes.',
  revokeFailed: 'No se pudo cerrar la sesión del usuario.',
  disableUserConfirm: '¿Desactivar a "{{name}}"?',
  disableUserBody: 'Desactivar termina de inmediato todas las sesiones activas de este usuario y bloquea nuevos inicios de sesión hasta que la cuenta se reactive.',
  userDisabled: '{{name}} fue desactivado y su sesión se cerró en todas partes.',
  userEnabled: '{{name}} fue activado.',
  userDeleted: '{{name}} fue eliminado.',
  deleteUserBody: 'Esto borra de forma permanente la cuenta de {{name}} y todos los registros guardados bajo ella: perfil, memorias, flujos de trabajo, ejecuciones y credenciales almacenadas. No se puede deshacer.',
  selfLockoutRefused: 'No puedes desactivar, cerrar la sesión ni eliminar tu propia cuenta desde aquí; pide a otro administrador que lo haga.',
  legalHoldRefused: 'Este espacio de trabajo está bajo retención legal, así que los datos de usuario no se pueden borrar. Levanta la retención y vuelve a intentarlo.',
  addRequired: 'Introduce un id de principal.',
  addInvalidPrincipal: 'Un id de principal es un solo token sin espacios, p. ej. oidc:sub-123.',
  addDuplicate: 'Ya existe un usuario con este id de principal.',
  principalIdHelp: 'El sujeto del proveedor de identidad con el que inicia sesión este usuario.',
} as const;
