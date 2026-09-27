/**
 * `auth` namespace — user-facing strings for the auth area (`src/auth/`).
 * FLAT camelCase keys, one per line (ADR 0065). Email/password + OIDC sign-in,
 * account linking, and account deletion copy. `auth/firebase.ts` surfaces these
 * via `i18n.t('auth:…')`; its internal "not configured" diagnostic throws stay
 * in code (developer-facing).
 */
export const messages = {
  // AuthCard — providers + structure
  signInWithSso: 'Se connecter avec le SSO',
  or: 'ou',

  // AuthCard — validation / notices
  passwordsDoNotMatch: 'Les mots de passe ne correspondent pas.',
  verificationEmailSent: 'E-mail de vérification envoyé — consultez votre boîte de réception.',
  resetLinkOnItsWay: 'Si cet e-mail est associé à un compte, un lien de réinitialisation du mot de passe est en route.',

  // AuthCard — verify view
  checkYourInbox: 'Consultez votre boîte de réception',
  verifyBody: 'Nous avons envoyé un lien de vérification à <0>{{email}}</0>. Vous êtes déjà connecté — vérifiez quand vous le souhaitez.',
  resendVerificationEmail: 'Renvoyer l’e-mail de vérification',

  // AuthCard — fields
  emailLabel: 'E-mail',
  emailPlaceholder: 'vous@entreprise.com',
  nameLabel: 'Nom',
  namePlaceholder: 'Ada Lovelace',
  nameHelp: 'Facultatif — affiché sur votre compte.',
  passwordLabel: 'Mot de passe',
  passwordHelp: 'Au moins 6 caractères.',
  confirmPasswordLabel: 'Confirmer le mot de passe',

  // AuthCard — submit labels
  signIn: 'Se connecter',
  createAccount: 'Créer un compte',
  sendResetLink: 'Envoyer le lien de réinitialisation',
  continue: 'Continuer',

  // AuthCard — view switch
  forgotPassword: 'Mot de passe oublié ?',
  newHere: ' · Nouveau ici ? ',
  createAnAccount: 'Créer un compte',
  alreadyHaveAccount: 'Vous avez déjà un compte ? Se connecter',
  backToSignIn: 'Retour à la connexion',

  // SignInButton — sign-in error copy
  signInCancelled: 'La connexion a été annulée.',
  popupBlocked: 'Votre navigateur a bloqué la fenêtre contextuelle de connexion. Autorisez les fenêtres contextuelles pour {{domain}} et réessayez.',
  providerNotEnabled: 'Ce fournisseur n’est pas activé pour ce déploiement. Le mainteneur doit l’activer dans la console Firebase.',
  networkErrorIdp: 'Erreur réseau lors de la connexion au fournisseur d’identité. Vérifiez votre connexion et réessayez.',
  signInFailed: 'La connexion a échoué : {{code}}.',

  // SignInButton — provider names
  providerGoogle: 'Google',
  providerGithub: 'GitHub',
  providerMicrosoft: 'Microsoft',
  providerPassword: 'e-mail + mot de passe',

  // SignInButton — account linking
  linkYourAccount: 'Associez votre compte {{provider}}',
  alreadySignedUpKnown: '<0>{{email}}</0> est déjà inscrit avec {{providers}}. Connectez-vous une fois avec ce fournisseur et nous associerons {{attempted}} pour que vous puissiez utiliser l’un ou l’autre la prochaine fois.',
  alreadySignedUpUnknown: '<0>{{email}}</0> est déjà inscrit. Connectez-vous une fois avec ce fournisseur et nous associerons {{attempted}} pour que vous puissiez utiliser l’un ou l’autre la prochaine fois.',
  continueWith: 'Continuer avec {{provider}}',
  cancel: 'Annuler',

  // SignInButton — sign-in modal
  continueWithGoogle: 'Continuer avec Google',
  continueWithGithub: 'Continuer avec GitHub',
  continueWithMicrosoft: 'Continuer avec Microsoft',
  signInToSaveTitle: 'Connectez-vous pour <0>enregistrer votre travail</0>',
  signInToSaveLede: 'Les workflows + clés BYOK que vous ajoutez après vous être connecté persistent d’une session à l’autre. L’état des sessions anonymes est effacé toutes les 24 h.',
  signInIdentityTitle: 'Connectez-vous à <0>votre espace de travail</0>',
  signInIdentityLede: 'Utilisez votre compte pour accéder à vos workflows, agents et clés.',

  // SignInButton — account fallback name
  accountFallbackName: 'Compte',

  // SignInButton — account menu
  myProfile: 'Mon profil',
  team: 'Équipe',
  signOut: 'Se déconnecter',
  deleteAccount: 'Supprimer le compte',

  // SignInButton — delete confirmation
  confirmAccountDeletion: 'Confirmer la suppression du compte',
  deleteAccountTitle: 'Supprimer votre compte ?',
  deleteAccountBody: 'Cela supprime définitivement chaque workflow, exécution, événement, interruption et identifiant BYOK que vous avez stockés sous <0>{{email}}</0>. Votre enregistrement d’identité Firebase est également révoqué. Il n’y a pas d’annulation possible.',
  deleting: 'Suppression…',
  deleteEverything: 'Oui, tout supprimer',

  // deleteAccount.ts — error
  requiresRecentLogin: 'Firebase requiert une connexion récente pour supprimer le compte. Veuillez vous déconnecter puis vous reconnecter.',

  // describeAuthError (firebase.ts)
  errEmailInUse: 'Un compte avec cet e-mail existe déjà. Essayez de vous connecter.',
  errInvalidEmail: 'Cette adresse e-mail semble invalide.',
  errWeakPassword: 'Le mot de passe est trop faible — utilisez au moins 6 caractères.',
  errMissingPassword: 'Saisissez un mot de passe.',
  errInvalidCredential: 'E-mail ou mot de passe invalide.',
  errTooManyRequests: 'Trop de tentatives — réessayez dans quelques minutes.',
  errOperationNotAllowed: 'La connexion par e-mail/mot de passe n’est pas activée pour ce déploiement. Le mainteneur doit l’activer dans la console Firebase.',
  errNetworkRequestFailed: 'Erreur réseau — vérifiez votre connexion et réessayez.',
  errGeneric: 'Une erreur s’est produite.',

  // TOTP multi-factor (ADR 0389 P1 — firebase.ts)
  errInvalidMfaCode: 'Ce code ne correspond pas — vérifiez votre application d’authentification et réessayez.',
  errRequiresRecentLogin: 'Cette modification nécessite une connexion récente. Déconnectez-vous, reconnectez-vous, puis réessayez.',
  mfaCodeRequired: 'Saisissez le code à 6 chiffres de votre application d’authentification pour terminer la connexion.',
  mfaCodeLabel: 'Code d’authentification',
  mfaFactorLabel: 'Appareil d’authentification',
  mfaFactorUnnamed: 'Authentificateur {{index}}',
  mfaNoPendingEnrollment: 'Aucune inscription en cours — recommencez depuis la page Sécurité.',
  mfaNoPendingChallenge: 'Aucune connexion en attente d’un code — reconnectez-vous.',
  mfaNoTotpFactor: 'Ce compte n’a aucun facteur d’application d’authentification inscrit.',
  errNotSignedIn: 'Non connecté.',

  // ExistingProviderSignInError message (firebase.ts)
  existingProviderKnown: '{{email}} est déjà inscrit avec {{providers}}. Connectez-vous avec {{providers}} pour associer votre compte {{attempted}}.',
  existingProviderUnknown: '{{email}} est déjà inscrit avec un autre fournisseur. Connectez-vous avec ce fournisseur pour associer votre compte {{attempted}}.',
  signingInRedirect: 'Connexion en cours… vous serez peut-être redirigé vers votre fournisseur.',

  // ADR 0621 D5 — motif affiché dans la fenêtre de connexion après une déconnexion forcée
  sessionRefused_account_disabled: 'Votre compte a été désactivé par un administrateur : vous avez donc été déconnecté. Contactez l’administrateur de votre espace de travail pour rétablir l’accès.',
  sessionRefused_account_erased: 'Votre compte a été supprimé : vous avez donc été déconnecté. Il ne peut plus servir à se connecter.',
  sessionRefused_session_revoked: 'Vous avez été déconnecté sur tous vos appareils. Reconnectez-vous pour continuer.',
  sessionRefused_self_revoked: 'Vous vous êtes déconnecté de tous vos appareils, celui-ci compris. Reconnectez-vous pour continuer.',
} as const;
