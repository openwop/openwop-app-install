/**
 * `media` namespace — user-facing copy for the media library feature.
 * Feature-self-contained: every media string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Platform',
  title: 'Media Library',
  lede: 'Org-scoped assets + collections.',

  // Gating / empty states
  notEnabledTitle: 'Media library is not enabled',
  notEnabledBody: 'Ask an administrator to enable the Media feature for this tenant.',
  noOrgsTitle: 'No organizations',
  noOrgsBody: 'Create an organization first — media collections belong to an org.',
  noAssetsTitle: 'No assets',
  noAssetsBody: 'Upload a file to start this collection.',

  // aria-labels
  orgPickerLabel: 'Organization',

  // Collections sidebar
  collectionsHeading: 'Collections',
  allAssets: 'All assets',
  uncategorized: 'Uncategorized',
  deleteCollectionLabel: 'Delete collection',
  newCollectionPlaceholder: 'New collection',

  // Assets toolbar
  searchPlaceholder: 'Search by name…',
  upload: 'Upload',
  deleteAssetLabel: 'Delete asset',

  // Asset-list filterbar + grid/list toggle
  filterGroup: 'Filter assets',
  filterAria: 'Filter assets by name',
  noMatchTitle: 'No matching assets',
  noMatchBody: 'No asset matches your search. Try a different term.',
  clearSearch: 'Clear search',

  // Asset usage badge ({{used}} is the locale-formatted count; {{count}} drives plural selection)
  usageCount_one: 'used {{used}}×',
  usageCount_other: 'used {{used}}×',
  unused: 'unused',

  // Toasts — success / info
  collectionCreated: 'Collection created.',
  collectionDeleted: 'Collection deleted (assets re-homed).',
  uploaded: 'Uploaded {{name}}.',

  // Toasts / errors
  loadOrgsFailed: 'Failed to load organizations.',
  loadAssetsFailed: 'Failed to load assets.',
  createFailed: 'Create failed.',
  deleteFailed: 'Delete failed.',
  uploadFailed: 'Upload failed.',
  deleteAssetConfirm: "Delete this asset? This can't be undone.",
} as const;
