/**
 * `media` namespace — user-facing copy for the media library feature.
 * Feature-self-contained: every media string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Plataforma',
  title: 'Biblioteca de mídia',
  lede: 'Ativos + coleções no escopo da organização.',

  // Gating / empty states
  notEnabledTitle: 'A biblioteca de mídia não está ativada',
  notEnabledBody: 'Peça a um administrador para ativar o recurso de mídia para este tenant.',
  noOrgsTitle: 'Nenhuma organização',
  noOrgsBody: 'Crie uma organização primeiro — coleções de mídia pertencem a uma organização.',
  noAssetsTitle: 'Nenhum ativo',
  noAssetsBody: 'Faça upload de um arquivo para iniciar esta coleção.',

  // aria-labels
  orgPickerLabel: 'Organização',

  // Collections sidebar
  collectionsHeading: 'Coleções',
  allAssets: 'Todos os ativos',
  uncategorized: 'Sem categoria',
  deleteCollectionLabel: 'Excluir coleção',
  newCollectionPlaceholder: 'Nova coleção',

  // Assets toolbar
  searchPlaceholder: 'Buscar por nome…',
  upload: 'Upload',
  deleteAssetLabel: 'Excluir ativo',

  // Asset-list filterbar + grid/list toggle
  filterGroup: 'Filtrar ativos',
  filterAria: 'Filtrar ativos por nome',
  noMatchTitle: 'Nenhum ativo correspondente',
  noMatchBody: 'Nenhum ativo corresponde à sua busca. Tente outro termo.',
  clearSearch: 'Limpar busca',

  // Asset usage badge ({{used}} is the locale-formatted count; {{count}} drives plural selection)
  usageCount_one: 'usado {{used}}×',
  usageCount_other: 'usado {{used}}×',
  unused: 'não usado',

  // Toasts — success / info
  collectionCreated: 'Coleção criada.',
  collectionDeleted: 'Coleção excluída (ativos realocados).',
  uploaded: 'Upload de {{name}} concluído.',

  // Toasts / errors
  loadOrgsFailed: 'Falha ao carregar as organizações.',
  loadAssetsFailed: 'Falha ao carregar os ativos.',
  createFailed: 'Falha ao criar.',
  deleteFailed: 'Falha ao excluir.',
  uploadFailed: 'Falha no upload.',
  deleteAssetConfirm: 'Excluir este recurso? Esta ação não pode ser desfeita.',
} as const;
