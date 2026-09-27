/**
 * `users` namespace — user-facing copy for the users feature (incl. SSO panel).
 * Feature-self-contained: every users string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Accès et données',
  title: 'Utilisateurs et authentification',
  lede: 'Comptes durables derrière le principal authentifié — la base de l’identité.',

  // Signed-in notice
  signedInAs: 'Connecté en tant que <0>{{name}}</0> (source : {{source}} ; statut : {{status}}).',
  meFailed: 'Impossible de charger votre propre fiche utilisateur. La liste et les réglages SSO ci-dessous ne sont pas affectés.',

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
  disableRowLabel: 'Désactiver {{name}}',
  enableRowLabel: 'Activer {{name}}',

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
  addFailed: 'Échec de l’ajout.',
  updateFailed: 'Échec de la mise à jour.',
  deleteFailed: 'Échec de la suppression.',
  loadUsersFailed: 'Échec du chargement des utilisateurs.',

  // ── SSO panel ──────────────────────────────────────────────────────────────
  ssoTitle: 'SSO et provisionnement d’entreprise',
  ssoLede:
    'Authentification unique SAML 2.0 et provisionnement SCIM 2.0. Coutures hôtes pour les déploiements en marque blanche / B2B — annoncées uniquement lorsqu’elles sont configurées et honorées.',
  ssoReadingCaps: 'Lecture des capacités de l’hôte…',
  ssoCapsFailed: 'Impossible de lire les capacités annoncées par cet hôte : nous ne pouvons pas dire si SAML ou SCIM est activé. Ce n’est pas une confirmation qu’ils sont désactivés.',

  // SSO row state chips
  ssoAdvertised: 'Annoncé',
  ssoNotConfigured: 'Non configuré',
  ssoActive: 'Actif',

  // SSO rows
  ssoOidcName: 'OIDC (Google / GitHub)',
  ssoOidcDetail: 'Jeton porteur via Firebase — la connexion principale de l’hôte.',
  ssoPasswordName: 'E-mail et mot de passe',
  ssoPasswordDetail: 'Comptes locaux avec MFA TOTP (cette application, lorsque la fonctionnalité Utilisateurs est activée).',
  ssoSamlName: 'SSO SAML 2.0',
  ssoSamlDetail: 'L’hôte valide les assertions de l’IdP au niveau de son ACS (Okta / Azure AD / Ping…).',
  ssoScimName: 'Provisionnement SCIM 2.0',
  ssoScimDetail: 'L’IdP crée/désactive les utilisateurs et attribue les groupes via SCIM.',

  // SSO endpoints
  ssoEndpointsLabel: 'Points de terminaison d’intégration d’entreprise (dirigez votre IdP ici)',
  ssoSamlAcs: 'ACS SAML',
  ssoScimProvisioning: 'Provisionnement SCIM',

  // SSO not-enabled alert (rich markup via <Trans>)
  ssoNotEnabled:
    'Non activé sur ce déploiement. Un hôte en marque blanche les active en configurant un certificat IdP / un jeton porteur SCIM ; l’hôte annonce alors les profils <0> openwop-auth-saml</0> / <1>openwop-auth-scim</1> ci-dessus.',
  deleteUserConfirm: 'Supprimer l’utilisateur « {{name}} » ?',

  // Collection kit (§4.5 rules 11+13)
  filterGroup: 'Filtrer les utilisateurs',
  filterPlaceholder: 'Rechercher des utilisateurs…',
  filterAria: 'Rechercher des utilisateurs par nom ou e-mail',
  filterStatusLabel: 'Filtrer par statut',
  filterSourceLabel: 'Filtrer par source',
  allStatuses: 'Tous les statuts',
  allSources: 'Toutes les sources',
  status_active: 'Actif',
  status_disabled: 'Désactivé',
  source_oidc: 'OIDC',
  source_password: 'Mot de passe',
  source_saml: 'SAML',
  source_scim: 'SCIM',
  source_manual: 'Manuel',
  viewTable: 'Tableau',
  noMatchTitle: 'Aucun utilisateur correspondant',
  noMatchBody: 'Aucun utilisateur ne correspond aux filtres actuels.',
  clearFilters: 'Effacer les filtres',

  // ── ADR 0621 D5/D7 — conséquences du cycle de vie, auto-verrouillage, déconnexion partout ──
  ownRowHint: 'Votre propre compte — demandez à un autre administrateur de le modifier.',
  signOutEverywhere: 'Déconnecter partout',
  revokeRowLabel: 'Déconnecter {{name}} partout',
  revokeUserConfirm: 'Déconnecter « {{name}} » partout ?',
  revokeUserBody: 'Cela met fin immédiatement à toutes les sessions actives de cet utilisateur sur tous ses appareils. Le compte reste actif et il pourra se reconnecter.',
  userSessionsRevoked: '{{name}} a été déconnecté partout.',
  revokeFailed: 'Impossible de déconnecter l’utilisateur.',
  disableUserConfirm: 'Désactiver « {{name}} » ?',
  disableUserBody: 'La désactivation met fin immédiatement à toutes les sessions actives de cet utilisateur et bloque toute nouvelle connexion jusqu’à la réactivation du compte.',
  userDisabled: '{{name}} a été désactivé et déconnecté partout.',
  userEnabled: '{{name}} a été activé.',
  userDeleted: '{{name}} a été supprimé.',
  deleteUserBody: 'Cette action efface définitivement le compte de {{name}} et tout ce qui y est enregistré : profil, mémoires, flux de travail, exécutions et identifiants stockés. Aucun retour en arrière possible.',
  selfLockoutRefused: 'Vous ne pouvez pas désactiver, déconnecter ni supprimer votre propre compte depuis cette page — demandez à un autre administrateur.',
  legalHoldRefused: 'Cet espace de travail est sous conservation légale : les données utilisateur ne peuvent pas être effacées. Levez la conservation, puis réessayez.',
  addRequired: 'Saisissez un id de principal.',
  addInvalidPrincipal: 'Un id de principal est un seul jeton sans espaces, p. ex. oidc:sub-123.',
  addDuplicate: 'Un utilisateur avec cet id de principal existe déjà.',
  principalIdHelp: 'Le sujet du fournisseur d’identité avec lequel cet utilisateur se connecte.',
} as const;
