/**
 * `auth` namespace — user-facing strings for the auth area (`src/auth/`).
 * FLAT camelCase keys, one per line (ADR 0065). Email/password + OIDC sign-in,
 * account linking, and account deletion copy. `auth/firebase.ts` surfaces these
 * via `i18n.t('auth:…')`; its internal "not configured" diagnostic throws stay
 * in code (developer-facing).
 */
export const messages = {
  // AuthCard — providers + structure
  signInWithSso: 'Iniciar sesión con SSO',
  or: 'o',

  // AuthCard — validation / notices
  passwordsDoNotMatch: 'Las contraseñas no coinciden.',
  verificationEmailSent: 'Correo de verificación enviado — revise su bandeja de entrada.',
  resetLinkOnItsWay: 'Si ese correo tiene una cuenta, le llegará un enlace para restablecer la contraseña.',

  // AuthCard — verify view
  checkYourInbox: 'Revise su bandeja de entrada',
  verifyBody: 'Hemos enviado un enlace de verificación a <0>{{email}}</0>. Ya ha iniciado sesión — verifique cuando quiera.',
  resendVerificationEmail: 'Reenviar correo de verificación',

  // AuthCard — fields
  emailLabel: 'Correo electrónico',
  emailPlaceholder: 'usted@empresa.com',
  nameLabel: 'Nombre',
  namePlaceholder: 'Ada Lovelace',
  nameHelp: 'Opcional — se muestra en su cuenta.',
  passwordLabel: 'Contraseña',
  passwordHelp: 'Al menos 6 caracteres.',
  confirmPasswordLabel: 'Confirmar contraseña',

  // AuthCard — submit labels
  signIn: 'Iniciar sesión',
  createAccount: 'Crear cuenta',
  sendResetLink: 'Enviar enlace de restablecimiento',
  continue: 'Continuar',

  // AuthCard — view switch
  forgotPassword: '¿Ha olvidado la contraseña?',
  newHere: ' · ¿Es nuevo aquí? ',
  createAnAccount: 'Crear una cuenta',
  alreadyHaveAccount: '¿Ya tiene una cuenta? Iniciar sesión',
  backToSignIn: 'Volver a iniciar sesión',

  // SignInButton — sign-in error copy
  signInCancelled: 'Se ha cancelado el inicio de sesión.',
  popupBlocked: 'Su navegador ha bloqueado la ventana emergente de inicio de sesión. Permita las ventanas emergentes para {{domain}} e inténtelo de nuevo.',
  providerNotEnabled: 'Este proveedor no está activado para el despliegue. El responsable debe activarlo en la consola de Firebase.',
  networkErrorIdp: 'Error de red al contactar con el proveedor de identidad. Compruebe su conexión e inténtelo de nuevo.',
  signInFailed: 'El inicio de sesión ha fallado: {{code}}.',

  // SignInButton — provider names
  providerGoogle: 'Google',
  providerGithub: 'GitHub',
  providerMicrosoft: 'Microsoft',
  providerPassword: 'correo electrónico + contraseña',

  // SignInButton — account linking
  linkYourAccount: 'Vincule su cuenta de {{provider}}',
  alreadySignedUpKnown: '<0>{{email}}</0> ya está registrado con {{providers}}. Inicie sesión con ese proveedor una vez y vincularemos {{attempted}} para que pueda usar cualquiera de los dos la próxima vez.',
  alreadySignedUpUnknown: '<0>{{email}}</0> ya está registrado. Inicie sesión con ese proveedor una vez y vincularemos {{attempted}} para que pueda usar cualquiera de los dos la próxima vez.',
  continueWith: 'Continuar con {{provider}}',
  cancel: 'Cancelar',

  // SignInButton — sign-in modal
  continueWithGoogle: 'Continuar con Google',
  continueWithGithub: 'Continuar con GitHub',
  continueWithMicrosoft: 'Continuar con Microsoft',
  signInToSaveTitle: 'Inicie sesión para <0>guardar su trabajo</0>',
  signInToSaveLede: 'Los flujos de trabajo y las claves BYOK que añada tras iniciar sesión se conservan entre sesiones. El estado de una sesión anónima se borra cada 24 h.',
  signInIdentityTitle: 'Inicie sesión en <0>su espacio de trabajo</0>',
  signInIdentityLede: 'Use su cuenta para acceder a sus flujos de trabajo, agentes y claves.',

  // SignInButton — account fallback name
  accountFallbackName: 'Cuenta',

  // SignInButton — account menu
  myProfile: 'Mi perfil',
  team: 'Equipo',
  signOut: 'Cerrar sesión',
  deleteAccount: 'Eliminar cuenta',

  // SignInButton — delete confirmation
  confirmAccountDeletion: 'Confirmar la eliminación de la cuenta',
  deleteAccountTitle: '¿Eliminar su cuenta?',
  deleteAccountBody: 'Esto elimina de forma permanente todos los flujos de trabajo, ejecuciones, eventos, interrupciones y credenciales BYOK que haya almacenado bajo <0>{{email}}</0>. Su registro de identidad de Firebase también se revoca. No se puede deshacer.',
  deleting: 'Eliminando…',
  deleteEverything: 'Sí, eliminar todo',

  // deleteAccount.ts — error
  requiresRecentLogin: 'Firebase requiere un inicio de sesión reciente para eliminar la cuenta. Cierre sesión y vuelva a iniciarla.',

  // describeAuthError (firebase.ts)
  errEmailInUse: 'Ya existe una cuenta con ese correo electrónico. Pruebe a iniciar sesión.',
  errInvalidEmail: 'Esa dirección de correo electrónico parece no ser válida.',
  errWeakPassword: 'La contraseña es demasiado débil — use al menos 6 caracteres.',
  errMissingPassword: 'Introduzca una contraseña.',
  errInvalidCredential: 'Correo electrónico o contraseña no válidos.',
  errTooManyRequests: 'Demasiados intentos — inténtelo de nuevo en unos minutos.',
  errOperationNotAllowed: 'El inicio de sesión con correo electrónico y contraseña no está activado para este despliegue. El responsable debe activarlo en la consola de Firebase.',
  errNetworkRequestFailed: 'Error de red — compruebe su conexión y vuelva a intentarlo.',
  errGeneric: 'Algo ha salido mal.',

  // TOTP multi-factor (ADR 0389 P1 — firebase.ts)
  errInvalidMfaCode: 'Ese código no coincide — compruebe su aplicación de autenticación y vuelva a intentarlo.',
  errRequiresRecentLogin: 'Este cambio requiere un inicio de sesión reciente. Cierre la sesión, vuelva a entrar e inténtelo de nuevo.',
  mfaCodeRequired: 'Introduzca el código de 6 dígitos de su aplicación de autenticación para terminar de iniciar sesión.',
  mfaCodeLabel: 'Código de autenticación',
  mfaFactorLabel: 'Dispositivo de autenticación',
  mfaFactorUnnamed: 'Autenticador {{index}}',
  mfaNoPendingEnrollment: 'No hay ninguna inscripción en curso — empiece de nuevo desde la página de Seguridad.',
  mfaNoPendingChallenge: 'No hay ningún inicio de sesión esperando un código — inicie sesión de nuevo.',
  mfaNoTotpFactor: 'Esta cuenta no tiene ningún factor de aplicación de autenticación inscrito.',
  errNotSignedIn: 'No ha iniciado sesión.',

  // ExistingProviderSignInError message (firebase.ts)
  existingProviderKnown: '{{email}} ya está registrado con {{providers}}. Inicie sesión con {{providers}} para vincular su cuenta de {{attempted}}.',
  existingProviderUnknown: '{{email}} ya está registrado con otro proveedor. Inicie sesión con ese proveedor para vincular su cuenta de {{attempted}}.',
  signingInRedirect: 'Iniciando sesión… es posible que se te redirija a tu proveedor.',

  // ADR 0621 D5 — motivo mostrado en el modal de inicio de sesión tras un cierre forzado
  sessionRefused_account_disabled: 'Un administrador desactivó tu cuenta, así que se cerró tu sesión. Contacta con el administrador de tu espacio de trabajo para recuperar el acceso.',
  sessionRefused_account_erased: 'Tu cuenta fue eliminada, así que se cerró tu sesión. Ya no se puede usar para iniciar sesión.',
  sessionRefused_session_revoked: 'Se cerró tu sesión en todos los dispositivos. Inicia sesión de nuevo para continuar.',
  sessionRefused_self_revoked: 'Cerraste la sesión en todos los dispositivos, incluido este. Inicia sesión de nuevo para continuar.',
} as const;
