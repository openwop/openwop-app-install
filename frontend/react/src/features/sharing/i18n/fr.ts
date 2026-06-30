/**
 * `sharing` namespace — user-facing copy for the sharing feature (ADR 0013).
 * Feature-self-contained: every sharing string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Plateforme',
  title: 'Partage',
  lede: 'Générez des liens publics indevinable vers une page ou une collection de connaissances.',

  // Gating / empty states
  notEnabledTitle: 'Le partage n\'est pas activé',
  notEnabledBody: 'Demandez à un administrateur d\'activer la fonctionnalité Partage pour ce locataire.',
  noOrgsTitle: 'Aucune organisation',
  noOrgsBody: 'Créez d\'abord une organisation — les liens de partage appartiennent à une organisation.',

  // aria-labels
  orgPickerLabel: 'Organisation',

  // Resource-type display labels
  typeCmsPage: 'Page CMS',
  typeKbCollection: 'Collection KB',

  // Mint form
  mintTitle: 'Créer un lien de partage',
  fieldResourceType: 'Type de ressource',
  fieldResource: 'Ressource',
  resourcePlaceholder: '— sélectionner —',
  fieldLabel: 'Libellé (facultatif)',
  labelPlaceholder: 'ex. Brouillon à relire',
  fieldExpiry: 'Expire dans (jours, facultatif)',
  expiryPlaceholder: 'jamais',
  createLink: 'Créer un lien',

  // Active links
  activeTitle: 'Liens actifs',
  noActiveLinks: 'Aucun lien de partage actif.',
  expiresAt: 'expire le {{date}}',
  copyLinkLabel: 'Copier le lien public',
  revokeLinkLabel: 'Révoquer',

  // Toasts
  linkCopied: 'Lien copié',
  linkCreated: 'Lien de partage créé',
  loadFailed: 'Échec du chargement des liens.',
  createFailed: 'Échec de la création.',
  revokeFailed: 'Échec de la révocation.',
  revokeShareConfirm: 'Révoquer ce lien de partage ? Toute personne disposant de l’URL perd l’accès.',
  typeDocument: 'Document',
  typeConversation: 'Conversation',
  typePrompt: 'Prompt',

  // Visionneuse publique en lecture seule (ADR 0122 Phase 6)
  publicReadOnly: 'Vue partagée en lecture seule',
  publicLoading: 'Chargement de la vue partagée',
  publicUntitled: 'Conversation partagée',
  publicEmpty: 'Rien à afficher ici.',
  publicGoneTitle: 'Ce lien n’est plus disponible',
  publicGoneBody: 'Le lien de partage a peut-être expiré ou été révoqué par son propriétaire.',
} as const;
