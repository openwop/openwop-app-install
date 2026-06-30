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
} as const;
