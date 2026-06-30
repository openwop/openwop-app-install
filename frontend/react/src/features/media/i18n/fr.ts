/**
 * `media` namespace — user-facing copy for the media library feature.
 * Feature-self-contained: every media string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Plateforme',
  title: 'Médiathèque',
  lede: 'Ressources et collections rattachées à l\'organisation.',

  // Gating / empty states
  notEnabledTitle: 'La médiathèque n\'est pas activée',
  notEnabledBody: 'Demandez à un administrateur d\'activer la fonctionnalité Média pour ce locataire.',
  noOrgsTitle: 'Aucune organisation',
  noOrgsBody: 'Créez d\'abord une organisation — les collections de médias appartiennent à une organisation.',
  noAssetsTitle: 'Aucune ressource',
  noAssetsBody: 'Téléversez un fichier pour démarrer cette collection.',

  // aria-labels
  orgPickerLabel: 'Organisation',

  // Collections sidebar
  collectionsHeading: 'Collections',
  allAssets: 'Toutes les ressources',
  uncategorized: 'Non catégorisé',
  deleteCollectionLabel: 'Supprimer la collection',
  newCollectionPlaceholder: 'Nouvelle collection',

  // Assets toolbar
  searchPlaceholder: 'Rechercher par nom…',
  upload: 'Téléverser',
  deleteAssetLabel: 'Supprimer la ressource',

  // Asset-list filterbar + grid/list toggle
  filterGroup: 'Filtrer les ressources',
  filterAria: 'Filtrer les ressources par nom',
  noMatchTitle: 'Aucune ressource correspondante',
  noMatchBody: 'Aucune ressource ne correspond à votre recherche. Essayez un autre terme.',
  clearSearch: 'Effacer la recherche',

  // Asset usage badge ({{used}} is the locale-formatted count; {{count}} drives plural selection)
  usageCount_one: 'utilisé {{used}}×',
  usageCount_other: 'utilisé {{used}}×',
  unused: 'inutilisé',

  // Toasts — success / info
  collectionCreated: 'Collection créée.',
  collectionDeleted: 'Collection supprimée (ressources réaffectées).',
  uploaded: '{{name}} téléversé.',

  // Toasts / errors
  loadOrgsFailed: 'Échec du chargement des organisations.',
  loadAssetsFailed: 'Échec du chargement des ressources.',
  createFailed: 'Échec de la création.',
  deleteFailed: 'Échec de la suppression.',
  uploadFailed: 'Échec du téléversement.',
  deleteAssetConfirm: 'Supprimer cette ressource ? Cette action est irréversible.',
} as const;
