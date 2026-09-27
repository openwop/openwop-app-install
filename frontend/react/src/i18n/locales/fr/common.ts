/**
 * `common` namespace — cross-cutting generic strings (actions, states) reused
 * across many surfaces. Feature-specific copy lives in that feature’s own
 * catalog (`src/features/<id>/i18n/en.ts`) or its top-level area catalog.
 * Plural keys use i18next `_one`/`_other` suffixes (Intl.PluralRules).
 */
export const messages = {
  inlineFailed: 'Impossible de charger cette section.',
  inlineEmpty: 'Rien ici pour l’instant.',
  // App-shell chrome
  skipToContent: 'Aller au contenu',
  privacy: 'Confidentialité',
  language: 'Langue',
  // Generic actions
  save: 'Enregistrer',
  cancel: 'Annuler',
  close: 'Fermer',
  delete: 'Supprimer',
  edit: 'Modifier',
  back: 'Retour',
  next: 'Suivant',
  confirm: 'Confirmer',
  typeToConfirmLabel: 'Saisissez {{value}} pour confirmer',
  create: 'Créer',
  remove: 'Retirer',
  retry: 'Réessayer',
  // Template gallery (DESIGN.md §4.5 rule 14 — ui/TemplateGallery.tsx)
  templatesFilterGroup: 'Filtrer les modèles',
  templatesSearchPlaceholder: 'Rechercher des modèles…',
  templatesSearchAria: 'Rechercher des modèles par nom',
  templatesCategoryAria: 'Filtrer les modèles par catégorie',
  templatesAllCategories: 'Toutes les catégories',
  templatesResultCount_one: '{{count}} modèle correspond',
  templatesResultCount_other: '{{count}} modèles correspondent',
  templatesNoMatchTitle: 'Aucun modèle ne correspond',
  templatesNoMatchBody: 'Essayez une autre recherche ou effacez les filtres pour voir tout ce qui est installé.',
  templatesEmptyTitle: 'Aucun modèle installé',
  templatesEmptyBody: 'Les modèles arrivent avec les packs. Installez-en un, ou partez d’une page vierge.',
  templatesClearFilters: 'Effacer les filtres',
  templatesUse: 'Utiliser le modèle',
  templatesUseNamed: 'Utiliser le modèle : {{name}}',

  deepLinkMissing: 'L’élément vers lequel pointe ce lien n’est plus disponible.',
  deepLinkMissingClear: 'Effacer',
  refresh: 'Actualiser',
  search: 'Rechercher',
  searching: 'Recherche en cours…',
  // Generic states
  loading: 'Chargement…',
  saving: 'Enregistrement…',
  none: 'Aucun',
  // Shared people-picker (UserPicker) — the empty/no-selection options.
  userPickerNone: 'Non attribué',
  runInputs: {
    title: 'Exécuter {{name}}',
    blurb: 'Renseignez les entrées de cette exécution. Les valeurs par défaut sont préremplies — modifiez-les pour cette exécution uniquement.',
    run: 'Exécuter',
    starting: 'Démarrage…',
    requiredPlaceholder: 'Obligatoire',
    optionalPlaceholder: 'Facultatif',
    missingHint: 'Renseignez les {{n}} entrées obligatoires pour exécuter.',
    credentialDefault: 'Clé par défaut de l’espace de travail',
    credentialHelp: 'La clé d’API enregistrée qu’utilisent les étapes d’IA de cette exécution. Les clés se trouvent dans Paramètres → Clés.',
  },
  // KTUX-10 — ONE localized transport-failure vocabulary. `classifyHttpError`
  // returns hardcoded ENGLISH copy; consuming it verbatim would ship English
  // into every locale while `check-i18n` passed green (it verifies KEY parity,
  // not language). Features map its `kind` discriminator to these keys.
  loadFailed: 'Impossible de charger ceci.',
  loadFailedTitle: 'Impossible de charger ceci',
  loadFailedBody: 'La liste n’a pas pu être lue, nous ne pouvons donc pas indiquer ce qui s’y trouve. Réessayez ou rechargez la page.',
  'error_rate-limited': 'Trop de requêtes pour le moment — patientez un instant puis réessayez.',
  // ADR 0482 (ux-1) — le 429 « budget épuisé » est une pause délibérée, pas une panne.
  'error_budget-exhausted': 'Budget quotidien atteint — les exécutions de ce flux de travail sont en pause jusqu’à demain (UTC). Augmentez ou supprimez le budget dans le générateur pour continuer.',
  errorBudgetExhausted: 'Budget quotidien atteint — les exécutions de ce flux de travail sont en pause jusqu’à demain (UTC). Augmentez ou supprimez le budget dans le générateur pour continuer.',
  errorBudgetTitle: 'Budget quotidien atteint',
  errorBudgetDetail: 'Les exécutions de ce flux de travail sont en pause jusqu’à demain (UTC). Augmentez ou supprimez le budget dans le générateur pour continuer.',
  error_offline: 'Serveur injoignable. Vérifiez votre connexion puis réessayez.',
  error_auth: 'Votre session a peut-être expiré. Reconnectez-vous.',
  error_forbidden: "Vous n'avez pas la permission de faire cela ici. Demandez l'accès à un administrateur de cet espace de travail.",
  'error_not-found': 'Ceci n\'est plus disponible.',
  error_server: 'Un problème est survenu de notre côté. Réessayez sous peu.',
  error_unknown: 'Un problème est survenu. Réessayez.',
  'error_account-disabled': 'Ce compte a été désactivé par un administrateur. Contactez l’administrateur de votre espace de travail.',
  'error_account-erased': 'Ce compte n’existe plus.',
  'error_session-revoked': 'Vous avez été déconnecté sur tous vos appareils. Reconnectez-vous pour continuer.',
  cannotBeUndone: 'Cette action est irréversible.',
} as const;
