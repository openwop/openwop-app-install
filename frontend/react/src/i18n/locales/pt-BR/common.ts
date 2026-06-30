/**
 * `common` namespace — cross-cutting generic strings (actions, states) reused
 * across many surfaces. Feature-specific copy lives in that feature's own
 * catalog (`src/features/<id>/i18n/en.ts`) or its top-level area catalog.
 * Plural keys use i18next `_one`/`_other` suffixes (Intl.PluralRules).
 */
export const messages = {
  // App-shell chrome
  skipToContent: 'Pular para o conteúdo',
  privacy: 'Privacidade',
  language: 'Idioma',
  // Generic actions
  save: 'Salvar',
  cancel: 'Cancelar',
  close: 'Fechar',
  delete: 'Excluir',
  edit: 'Editar',
  back: 'Voltar',
  next: 'Avançar',
  confirm: 'Confirmar',
  create: 'Criar',
  remove: 'Remover',
  retry: 'Tentar novamente',
  refresh: 'Atualizar',
  search: 'Pesquisar',
  searching: 'Pesquisando…',
  // Generic states
  loading: 'Carregando…',
  saving: 'Salvando…',
  none: 'Nenhum',
} as const;
