/**
 * `users` namespace — user-facing copy for the users feature (incl. SSO panel).
 * Feature-self-contained: every users string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Accès et données',
  title: 'Utilisateurs et authentification',
  lede: 'Comptes durables derrière le principal authentifié — la base de l\'identité.',

  // Signed-in notice
  signedInAs: 'Connecté en tant que <0>{{name}}</0> (source : {{source}} ; statut : {{status}}).',

  // Form field labels
  fieldPrincipalId: 'Id du principal',
  fieldDisplayName: 'Nom affiché',

  // Placeholders
  principalIdPlaceholder: 'oidc:sub-123',
  displayNamePlaceholder: 'Jeanne Dupont',

  // Buttons
  addUser: 'Ajouter un utilisateur',
  disable: 'Désactiver',
  enable: 'Activer',

  // aria-labels
  deleteRowLabel: 'Supprimer {{name}}',

  // Table caption + column headers
  captionUsers: 'Utilisateurs',
  colPrincipal: 'Principal',
  colEmail: 'E-mail',
  colSource: 'Source',
  colGroups: 'Groupes',
  colStatus: 'Statut',

  // Empty state
  noUsers: 'Aucun utilisateur pour le moment — ajoutez-en un ci-dessus, ou connectez-vous pour créer votre fiche.',

  // Toasts
  userAdded: 'Utilisateur ajouté.',
  addFailed: 'Échec de l\'ajout.',
  updateFailed: 'Échec de la mise à jour.',
  deleteFailed: 'Échec de la suppression.',
  loadUsersFailed: 'Échec du chargement des utilisateurs.',

  // ── SSO panel ──────────────────────────────────────────────────────────────
  ssoTitle: 'SSO et provisionnement d\'entreprise',
  ssoLede:
    'Authentification unique SAML 2.0 et provisionnement SCIM 2.0. Coutures hôtes pour les déploiements en marque blanche / B2B — annoncées uniquement lorsqu\'elles sont configurées et honorées.',
  ssoReadingCaps: 'Lecture des capacités de l\'hôte…',

  // SSO row state chips
  ssoAdvertised: 'Annoncé',
  ssoNotConfigured: 'Non configuré',
  ssoActive: 'Actif',

  // SSO rows
  ssoOidcName: 'OIDC (Google / GitHub)',
  ssoOidcDetail: 'Jeton porteur via Firebase — la connexion principale de l\'hôte.',
  ssoPasswordName: 'E-mail et mot de passe',
  ssoPasswordDetail: 'Comptes locaux avec MFA TOTP (cette application, lorsque la fonctionnalité Utilisateurs est activée).',
  ssoSamlName: 'SSO SAML 2.0',
  ssoSamlDetail: 'L\'hôte valide les assertions de l\'IdP au niveau de son ACS (Okta / Azure AD / Ping…).',
  ssoScimName: 'Provisionnement SCIM 2.0',
  ssoScimDetail: 'L\'IdP crée/désactive les utilisateurs et attribue les groupes via SCIM.',

  // SSO endpoints
  ssoEndpointsLabel: 'Points de terminaison d\'intégration d\'entreprise (dirigez votre IdP ici)',
  ssoSamlAcs: 'ACS SAML',
  ssoScimProvisioning: 'Provisionnement SCIM',

  // SSO not-enabled alert (rich markup via <Trans>)
  ssoNotEnabled:
    'Non activé sur ce déploiement. Un hôte en marque blanche les active en configurant un certificat IdP / un jeton porteur SCIM ; l\'hôte annonce alors les profils <0> openwop-auth-saml</0> / <1>openwop-auth-scim</1> ci-dessus.',
} as const;
