/**
 * `connections` namespace — user-facing copy for the Connections feature
 * (ADR 0024 / 0025 / 0028). Feature-self-contained: every connections string
 * lives here. Generic actions/states are reused from the `common` namespace via
 * `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Accès et données',
  title: 'Connexions',
  lede: 'Connectez les applications avec lesquelles votre assistant travaille — Google, Slack, ServiceNow, Zoom.',

  // Manager — generic load/connect errors & toasts
  loadFailed: 'Échec du chargement.',
  connectFailed: 'Échec de la connexion.',
  revokeFailed: 'Échec de la révocation.',
  testFailed: 'Échec du test.',
  connected: '{{label}} connecté.',
  connectedForOrg: '{{label}} connecté pour l\'organisation.',
  couldNotStart: 'Impossible de démarrer {{label}}.',
  connectionHealthy: '{{name}} est sain.',
  connectionNeedsReconnect: '{{name}} doit se reconnecter.',

  // OAuth consent card
  connectWithConsent: 'Connecter avec consentement',
  consentBlurb:
    'Vous serez redirigé vers le fournisseur pour approuver l\'accès en lecture, puis ramené ici. Vos jetons sont stockés chiffrés et ne vous sont jamais réaffichés.',
  connectProvider: 'Connecter {{label}}',
  connectingProvider: 'Connexion de {{label}}…',
  notConfiguredHint:
    'Les fournisseurs grisés ne sont pas encore configurés pour OAuth sur cet hôte — l\'opérateur doit ajouter les identifiants client.',
  oauthNotConfiguredTitle: 'OAuth pour {{label}} n\'est pas configuré sur cet hôte',

  // Secret connect form
  providerLabel: 'Fournisseur (clé API / jeton)',
  loadingProviders: 'Chargement des fournisseurs…',
  secretLabel: 'Clé API / jeton',
  secretPlaceholder: 'collez votre jeton',
  sharedWith: 'Partagé avec',
  shareJustMe: 'Moi uniquement',
  shareOrganization: 'Organisation',
  connect: 'Connecter',

  // Connections table
  tableCaption: 'Vos connexions',
  colConnection: 'Connexion',
  colProvider: 'Fournisseur',
  colSharing: 'Partage',
  colStatus: 'Statut',
  sharingOrganization: 'Organisation',
  sharingPersonal: 'Personnel',
  sharingWrite: 'écriture',
  grantWriteAccess: 'Accorder l\'accès en écriture',
  grantWriteAccessLabel: 'Accorder l\'accès en écriture pour {{name}}',
  grantWriteAccessConnect: 'Accès en écriture {{label}}',
  connectProviderConnect: 'Connecter {{label}}',
  testConnectionLabel: 'Tester {{name}}',
  test: 'Tester',
  revokeConnectionLabel: 'Révoquer {{name}}',
  revoke: 'Révoquer',
  noConnectionsTitle: 'Aucune connexion pour le moment',
  noConnectionsBody: 'Connectez une application ci-dessus pour permettre à votre assistant d\'y accéder en lecture.',

  // OAuth callback toast
  callbackConnected: '{{provider}} connecté.',
  callbackConsentDenied: 'Le consentement a été refusé.',
  callbackInvalidState: 'La session de consentement a expiré — veuillez réessayer.',
  callbackMissingParams: 'La réponse du fournisseur était incomplète — veuillez réessayer.',
  callbackExchangeFailed: 'Impossible de finaliser l\'échange de jetons. Veuillez réessayer.',
  callbackGenericError: 'Impossible de connecter {{provider}}.',

  // Governance panel
  governanceTitle: 'Gouvernance',
  governanceBlurb:
    'Politique de l\'espace de travail : quels fournisseurs peuvent se connecter, et ce que chaque type d\'action de l\'assistant peut faire. Appliquée aux points de connexion, de résolution et de répartition.',
  governanceSaved: 'Politique de gouvernance enregistrée.',
  saveFailed: 'Échec de l\'enregistrement.',
  providerAllowlist: 'Liste blanche des fournisseurs',
  restrictProviders: 'Restreindre les fournisseurs connectables',
  actionPolicy: 'Politique d\'action',
  policyApprovalRequired: 'Approbation requise (exécute à l\'approbation)',
  policyDraftOnly: 'Brouillon uniquement (n\'exécute jamais)',
  policyDisabled: 'Désactivé (aucun brouillon)',
  savePolicy: 'Enregistrer la politique',
  mediaBudgetTitle: 'Budgets de génération multimédia',
  mediaBudgetBlurb:
    'Plafonds quotidiens par organisation pour la génération multimédia payante (transcription et synthèse vocale), définis par l’opérateur via la configuration d’environnement. L’utilisation est réinitialisée à 00:00 UTC.',
  mediaBudgetTts: 'Synthèse vocale',
  mediaBudgetStt: 'Transcription',
  mediaBudgetUsage: '{{used}} / {{cap}} {{unit}} utilisés aujourd’hui',
  mediaBudgetUncapped: '{{used}} {{unit}} utilisés aujourd’hui · sans plafond',
  mediaUnitChars: 'caractères',
  mediaUnitBytes: 'octets',
  mediaBudgetBlurbEditable: 'Plafonds quotidiens par organisation pour la génération multimédia payante. Laissez un champ vide pour utiliser la valeur par défaut de l’hôte ; saisissez 0 pour supprimer le plafond de cette organisation. L’utilisation est réinitialisée à 00:00 UTC.',
  mediaBudgetTtsOverride: 'Budget de synthèse vocale (caractères/jour)',
  mediaBudgetSttOverride: 'Budget de transcription (octets/jour)',
  mediaBudgetEnvPlaceholder: 'Valeur par défaut de l’hôte : {{value}}',
  mediaBudgetNoDefault: 'sans plafond',
  mediaBudgetSave: 'Enregistrer les budgets multimédias',
  mediaBudgetSaved: 'Budgets multimédias mis à jour.',
  mediaBudgetInvalid: 'Les budgets doivent être vides ou un entier non négatif.',

  // OAuth client admin panel
  oauthClientSetup: 'Configuration du client OAuth (opérateur)',
  oauthClientBlurb:
    'Configurez l\'application OAuth de chaque fournisseur pour que son bouton Connecter fonctionne — sans variables d\'environnement, sans redéploiement. Enregistrez l\'URI de redirection indiquée ci-dessous auprès du fournisseur, puis collez ici son ID client et son secret. Le secret est scellé côté serveur et n\'est plus jamais réaffiché.',
  loadOAuthClientFailed: 'Échec du chargement de la configuration du client OAuth.',
  oauthClientSaved: 'Client OAuth enregistré — {{provider}} peut désormais exécuter le consentement.',
  oauthClientRemoved: 'Client OAuth supprimé pour {{provider}}.',
  removeFailed: 'Échec de la suppression.',
  configured: 'Configuré',
  notConfigured: 'Non configuré',
  redirectUriLabel: 'URI de redirection à enregistrer auprès de {{label}}',
  clientIdLabel: 'ID client',
  clientIdLabelCurrent: 'ID client (actuel : {{clientId}})',
  clientIdPlaceholder: 'collez l\'ID client OAuth',
  clientIdPlaceholderReplace: 'remplacez l\'ID client',
  clientSecretLabel: 'Secret client',
  clientSecretPlaceholder: 'collez le secret client OAuth',
  replace: 'Remplacer',
  removeOAuthClientLabel: 'Supprimer le client OAuth pour {{label}}',
} as const;
