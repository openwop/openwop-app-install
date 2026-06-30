/**
 * `media` namespace — user-facing copy for the media library feature.
 * Feature-self-contained: every media string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Plataforma',
  title: 'Biblioteca multimedia',
  lede: 'Recursos y colecciones con ámbito de organización.',

  // Gating / empty states
  notEnabledTitle: 'La biblioteca multimedia no está activada',
  notEnabledBody: 'Solicite a un administrador que active la función Multimedia para este inquilino.',
  noOrgsTitle: 'Sin organizaciones',
  noOrgsBody: 'Cree primero una organización: las colecciones multimedia pertenecen a una organización.',
  noAssetsTitle: 'Sin recursos',
  noAssetsBody: 'Suba un archivo para iniciar esta colección.',

  // aria-labels
  orgPickerLabel: 'Organización',

  // Collections sidebar
  collectionsHeading: 'Colecciones',
  allAssets: 'Todos los recursos',
  uncategorized: 'Sin categoría',
  deleteCollectionLabel: 'Eliminar colección',
  newCollectionPlaceholder: 'Nueva colección',

  // Assets toolbar
  searchPlaceholder: 'Buscar por nombre…',
  upload: 'Subir',
  deleteAssetLabel: 'Eliminar recurso',

  // Asset-list filterbar + grid/list toggle
  filterGroup: 'Filtrar recursos',
  filterAria: 'Filtrar recursos por nombre',
  noMatchTitle: 'No hay recursos que coincidan',
  noMatchBody: 'Ningún recurso coincide con tu búsqueda. Prueba con otro término.',
  clearSearch: 'Borrar búsqueda',

  // Asset usage badge ({{used}} is the locale-formatted count; {{count}} drives plural selection)
  usageCount_one: 'utilizado {{used}}×',
  usageCount_other: 'utilizado {{used}}×',
  unused: 'sin utilizar',

  // Toasts — success / info
  collectionCreated: 'Colección creada.',
  collectionDeleted: 'Colección eliminada (recursos reubicados).',
  uploaded: 'Se ha subido {{name}}.',

  // Toasts / errors
  loadOrgsFailed: 'No se han podido cargar las organizaciones.',
  loadAssetsFailed: 'No se han podido cargar los recursos.',
  createFailed: 'No se ha podido crear.',
  deleteFailed: 'No se ha podido eliminar.',
  uploadFailed: 'No se ha podido subir.',
  deleteAssetConfirm: '¿Eliminar este recurso? Esta acción no se puede deshacer.',
} as const;
