/**
 * `common` namespace — cross-cutting generic strings (actions, states) reused
 * across many surfaces. Feature-specific copy lives in that feature's own
 * catalog (`src/features/<id>/i18n/en.ts`) or its top-level area catalog.
 * Plural keys use i18next `_one`/`_other` suffixes (Intl.PluralRules).
 */
export const messages = {
  inlineFailed: 'Não foi possível carregar esta seção.',
  inlineEmpty: 'Nada aqui ainda.',
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
  typeToConfirmLabel: 'Digite {{value}} para confirmar',
  create: 'Criar',
  remove: 'Remover',
  retry: 'Tentar novamente',
  // Template gallery (DESIGN.md §4.5 rule 14 — ui/TemplateGallery.tsx)
  templatesFilterGroup: 'Filtrar modelos',
  templatesSearchPlaceholder: 'Buscar modelos…',
  templatesSearchAria: 'Buscar modelos por nome',
  templatesCategoryAria: 'Filtrar modelos por categoria',
  templatesAllCategories: 'Todas as categorias',
  templatesResultCount_one: '{{count}} modelo corresponde',
  templatesResultCount_other: '{{count}} modelos correspondem',
  templatesNoMatchTitle: 'Nenhum modelo corresponde',
  templatesNoMatchBody: 'Tente outra busca ou limpe os filtros para ver tudo o que está instalado.',
  templatesEmptyTitle: 'Nenhum modelo instalado',
  templatesEmptyBody: 'Modelos chegam com os pacotes. Instale um ou comece do zero.',
  templatesClearFilters: 'Limpar filtros',
  templatesUse: 'Usar modelo',
  templatesUseNamed: 'Usar modelo: {{name}}',

  deepLinkMissing: 'O item para o qual você criou o link não está mais disponível.',
  deepLinkMissingClear: 'Descartar',
  refresh: 'Atualizar',
  search: 'Pesquisar',
  searching: 'Pesquisando…',
  // Generic states
  loading: 'Carregando…',
  saving: 'Salvando…',
  none: 'Nenhum',
  // Shared people-picker (UserPicker) — the empty/no-selection options.
  userPickerNone: 'Não atribuído',
  runInputs: {
    title: 'Executar {{name}}',
    blurb: 'Forneça as entradas para esta execução. Os padrões já vêm preenchidos — altere-os apenas para esta execução.',
    run: 'Executar',
    starting: 'Iniciando…',
    requiredPlaceholder: 'Obrigatório',
    optionalPlaceholder: 'Opcional',
    missingHint: 'Preencha as {{n}} entradas obrigatórias para executar.',
    credentialDefault: 'Chave padrão do espaço de trabalho',
    credentialHelp: 'Qual chave de API salva as etapas de IA desta execução usam. As chaves ficam em Configurações → Chaves.',
  },
  // KTUX-10 — ONE localized transport-failure vocabulary. `classifyHttpError`
  // returns hardcoded ENGLISH copy; consuming it verbatim would ship English
  // into every locale while `check-i18n` passed green (it verifies KEY parity,
  // not language). Features map its `kind` discriminator to these keys.
  loadFailed: 'Não foi possível carregar isto.',
  loadFailedTitle: 'Não foi possível carregar isto',
  loadFailedBody: 'A lista não pôde ser lida, portanto não podemos dizer o que há aqui. Tente novamente ou recarregue a página.',
  'error_rate-limited': 'Muitas solicitações agora — aguarde um momento e tente de novo.',
  // ADR 0482 (ux-1) — o 429 de orçamento esgotado é uma pausa deliberada, não uma falha.
  'error_budget-exhausted': 'Orçamento diário atingido — as execuções deste fluxo de trabalho estão pausadas até amanhã (UTC). Aumente ou remova o orçamento no construtor para continuar.',
  errorBudgetExhausted: 'Orçamento diário atingido — as execuções deste fluxo de trabalho estão pausadas até amanhã (UTC). Aumente ou remova o orçamento no construtor para continuar.',
  errorBudgetTitle: 'Orçamento diário atingido',
  errorBudgetDetail: 'As execuções deste fluxo de trabalho estão pausadas até amanhã (UTC). Aumente ou remova o orçamento no construtor para continuar.',
  error_offline: 'Não foi possível conectar ao servidor. Verifique sua conexão e tente de novo.',
  error_auth: 'Sua sessão pode ter expirado. Entre novamente.',
  error_forbidden: "Você não tem permissão para fazer isso aqui. Peça acesso a um administrador deste espaço de trabalho.",
  'error_not-found': 'Isto não está mais disponível.',
  error_server: 'Algo deu errado do nosso lado. Tente de novo em instantes.',
  error_unknown: 'Algo deu errado. Tente de novo.',
  'error_account-disabled': 'Esta conta foi desativada por um administrador. Fale com o administrador do seu espaço de trabalho.',
  'error_account-erased': 'Esta conta não existe mais.',
  'error_session-revoked': 'Sua sessão foi encerrada em todos os dispositivos. Entre de novo para continuar.',
  cannotBeUndone: 'Isso não pode ser desfeito.',
} as const;
