/**
 * `marketplace` namespace — user-facing copy for the marketplace feature (ADR 0022).
 * Feature-self-contained: every marketplace string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Entreprise',
  title: 'Place de marché',
  lede: 'Parcourez et installez des packs de fonctionnalités signés depuis le registre.',

  // Gating / empty states
  notEnabledTitle: 'La place de marché n\'est pas activée',
  notEnabledBody: 'Demandez à un administrateur d\'activer la fonctionnalité Place de marché dans Admin → Bascules de fonctionnalités.',
  noPacksFoundTitle: 'Aucun pack trouvé',
  noPacksFoundBodySearch: 'Aucun pack ne correspond à votre recherche. Essayez un terme plus large.',
  noPacksFoundBodyEmpty: 'Aucun pack n\'est encore disponible dans le catalogue.',

  // Search / filter bar
  searchPlaceholder: 'Rechercher des packs par nom, capacité ou catégorie',
  searchPacksLabel: 'Rechercher des packs',
  filterGroup: 'Filtrer les packs',

  // Pack list / cards / rows
  packsLabel: 'Packs',
  installed: 'Installé',
  notInstalled: 'Non installé',
  subNoDescription: 'Aucune description fournie.',
  requiredBy: 'Requis par : {{packs}}',
  reviewsAction: 'Avis',
  install: 'Installer',

  // Stars / rating
  starsReadLabel: '{{count}} sur 5 étoiles',
  ratingLabel: 'Note',
  starLabel_one: '{{count}} étoile',
  starLabel_other: '{{count}} étoiles',

  // Author
  authorAgent: 'Agent',

  // Reviews panel
  reviewsForLabel: 'Avis pour {{pack}}',
  reviewsForTitle: 'Avis — {{pack}}',
  reviewsSummary: '{{average}} ({{total}})',
  noReviewsInline: 'Aucun avis pour le moment',
  orgPickerLabel: 'Organisation',
  closeReviewsLabel: 'Fermer les avis',
  yourRating: 'Votre note',
  commentOptional: 'Commentaire (facultatif)',
  commentPlaceholder: 'Qu\'avez-vous pensé de ce pack ?',
  submitReview: 'Soumettre l\'avis',
  noReviewsTitle: 'Aucun avis pour le moment',
  noReviewsBody: 'Soyez le premier à noter ce pack avec le formulaire ci-dessus.',
  deleteReviewLabel: 'Supprimer l\'avis',

  // Toasts — success
  alreadyInstalled: '{{pack}} est déjà installé.',
  installedToast: '{{pack}} installé.',
  reviewSaved: 'Avis enregistré.',

  // Toasts / errors
  loadFailed: 'Échec du chargement de la place de marché.',
  installFailed: 'Échec de l\'installation.',
  pickRating: 'Choisissez une note de 1 à 5.',
  reviewFailed: 'Échec de l\'avis.',
  deleteFailed: 'Échec de la suppression.',
  loadReviewsFailed: 'Échec du chargement des avis.',
} as const;
