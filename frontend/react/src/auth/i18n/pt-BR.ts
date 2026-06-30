/**
 * `auth` namespace — user-facing strings for the auth area (`src/auth/`).
 * FLAT camelCase keys, one per line (ADR 0065). Email/password + OIDC sign-in,
 * account linking, and account deletion copy. `auth/firebase.ts` surfaces these
 * via `i18n.t('auth:…')`; its internal "not configured" diagnostic throws stay
 * in code (developer-facing).
 */
export const messages = {
  // AuthCard — providers + structure
  signInWithSso: 'Entrar com SSO',
  or: 'ou',

  // AuthCard — validation / notices
  passwordsDoNotMatch: 'As senhas não coincidem.',
  verificationEmailSent: 'E-mail de verificação enviado — confira sua caixa de entrada.',
  resetLinkOnItsWay: 'Se esse e-mail tiver uma conta, um link de redefinição de senha está a caminho.',

  // AuthCard — verify view
  checkYourInbox: 'Confira sua caixa de entrada',
  verifyBody: 'Enviamos um link de verificação para <0>{{email}}</0>. Você já está conectado — verifique quando quiser.',
  resendVerificationEmail: 'Reenviar e-mail de verificação',

  // AuthCard — fields
  emailLabel: 'E-mail',
  emailPlaceholder: 'voce@empresa.com',
  nameLabel: 'Nome',
  namePlaceholder: 'Ada Lovelace',
  nameHelp: 'Opcional — exibido na sua conta.',
  passwordLabel: 'Senha',
  passwordHelp: 'Pelo menos 6 caracteres.',
  confirmPasswordLabel: 'Confirmar senha',

  // AuthCard — submit labels
  signIn: 'Entrar',
  createAccount: 'Criar conta',
  sendResetLink: 'Enviar link de redefinição',
  continue: 'Continuar',

  // AuthCard — view switch
  forgotPassword: 'Esqueceu a senha?',
  newHere: ' · Novo por aqui? ',
  createAnAccount: 'Criar uma conta',
  alreadyHaveAccount: 'Já tem uma conta? Entrar',
  backToSignIn: 'Voltar para entrar',

  // SignInButton — sign-in error copy
  signInCancelled: 'A entrada foi cancelada.',
  popupBlocked: 'Seu navegador bloqueou o popup de entrada. Permita popups para app.openwop.dev e tente novamente.',
  providerNotEnabled: 'Este provedor não está habilitado para a implantação. O mantenedor precisa ativá-lo no Console do Firebase.',
  networkErrorIdp: 'Erro de rede ao contatar o provedor de identidade. Verifique sua conexão e tente novamente.',
  signInFailed: 'Falha na entrada: {{code}}.',

  // SignInButton — provider names
  providerGoogle: 'Google',
  providerGithub: 'GitHub',
  providerPassword: 'e-mail + senha',

  // SignInButton — account linking
  linkYourAccount: 'Vincular sua conta {{provider}}',
  alreadySignedUpKnown: '<0>{{email}}</0> já está cadastrado com {{providers}}. Entre com esse provedor uma vez e anexaremos {{attempted}} para que você possa usar qualquer um na próxima vez.',
  alreadySignedUpUnknown: '<0>{{email}}</0> já está cadastrado. Entre com esse provedor uma vez e anexaremos {{attempted}} para que você possa usar qualquer um na próxima vez.',
  continueWith: 'Continuar com {{provider}}',
  cancel: 'Cancelar',

  // SignInButton — sign-in modal
  continueWithGoogle: 'Continuar com Google',
  continueWithGithub: 'Continuar com GitHub',
  signInToSaveTitle: 'Entre para <0>salvar seu trabalho</0>',
  signInToSaveLede: 'Workflows + chaves BYOK que você adicionar após entrar persistem entre sessões. O estado de sessão anônima é apagado a cada 24h.',

  // SignInButton — account fallback name
  accountFallbackName: 'Conta',

  // SignInButton — account menu
  myProfile: 'Meu perfil',
  team: 'Equipe',
  signOut: 'Sair',
  deleteAccount: 'Excluir conta',

  // SignInButton — delete confirmation
  confirmAccountDeletion: 'Confirmar exclusão da conta',
  deleteAccountTitle: 'Excluir sua conta?',
  deleteAccountBody: 'Isso remove permanentemente todo workflow, execução, evento, interrupção e credencial BYOK que você armazenou sob <0>{{email}}</0>. Seu registro de identidade no Firebase também é revogado. Não há como desfazer.',
  deleting: 'Excluindo…',
  deleteEverything: 'Sim, excluir tudo',

  // deleteAccount.ts — error
  requiresRecentLogin: 'O Firebase exige uma entrada recente para excluir a conta. Saia e entre novamente.',

  // describeAuthError (firebase.ts)
  errEmailInUse: 'Já existe uma conta com esse e-mail. Tente entrar.',
  errInvalidEmail: 'Esse endereço de e-mail parece inválido.',
  errWeakPassword: 'A senha é muito fraca — use pelo menos 6 caracteres.',
  errMissingPassword: 'Digite uma senha.',
  errInvalidCredential: 'E-mail ou senha inválidos.',
  errTooManyRequests: 'Tentativas demais — tente novamente em alguns minutos.',
  errOperationNotAllowed: 'A entrada por e-mail/senha não está habilitada para esta implantação. O mantenedor precisa ativá-la no Console do Firebase.',
  errNetworkRequestFailed: 'Erro de rede — verifique sua conexão e tente novamente.',
  errGeneric: 'Algo deu errado.',

  // ExistingProviderSignInError message (firebase.ts)
  existingProviderKnown: '{{email}} já está cadastrado com {{providers}}. Entre com {{providers}} para vincular sua conta {{attempted}}.',
  existingProviderUnknown: '{{email}} já está cadastrado com outro provedor. Entre com esse provedor para vincular sua conta {{attempted}}.',
} as const;
