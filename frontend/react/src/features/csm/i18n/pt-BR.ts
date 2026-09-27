/**
 * `csm` namespace — user-facing copy for the csm feature.
 * Feature-self-contained: every csm string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // The feature-specific REASON an organization is needed — a capitalised
  // sentence minus its stop, which `ui:orgStateEmptyBody` supplies. The frame
  // carries no instruction (that is the CTA's) and no noun, so this clause is
  // the one place the noun appears: say "organization", never "org".
  orgsEmptyClause: 'Os vínculos de CRM pertencem a uma organização',
  orgsFailedClause: 'A lista de empresas nunca chegou a ser solicitada',
  // Page chrome
  eyebrow: 'Negócios',
  title: 'CSM',
  lede: 'Contas de sucesso do cliente, da menor saúde primeiro.',
  askHealthInsights: 'Consultar insights de saúde',
  healthInsightsSeed: 'Revise minhas contas de sucesso do cliente e diga quais estão em risco e por quê. Leia primeiro o registro de contas, depois resuma os fatores de saúde e sugira próximos passos.',

  // Gating / empty states
  notEnabledTitle: 'O CSM não está ativado',
  notEnabledBody: 'Peça a um administrador para ativar o recurso CSM em Admin → Feature toggles.',
  noAccountsTitle: 'Nenhuma conta ainda',
  noAccountsBody: 'Adicione sua primeira conta de cliente com o formulário acima — a menor saúde vai para o topo.',

  // Table
  captionAccounts: 'Contas',
  colAccount: 'Conta',
  colHealth: 'Saúde',
  colArr: 'ARR',
  colOwner: 'Responsável',
  companiesLoadFailed: 'Os nomes das empresas não carregaram',
  retryCompaniesLabel: 'Tentar carregar os nomes das empresas novamente',
  companyNameUnavailable: 'nome indisponível',
  fieldArrCurrency: 'Moeda',
  arrCurrencyPlaceholder: 'USD',
  filterRenewalLabel: 'Filtrar por renovação',
  allRenewals: 'Todas as renovações',
  renewalFacetSoon: 'Renova em 90 dias',
  renewalFacetPast: 'Vencidas',
  scoreOutOfRange: 'A pontuação de saúde deve ser um número de 0 a 100.',
  portfolioBandLabel: 'Resumo da carteira',
  portfolioTotalArr: 'ARR total',
  portfolioArrAtRisk: 'ARR em risco',
  portfolioRenewals90: 'Renovações em 90 dias',
  colRenewal: 'Renovação',
  renewalSoon: 'em {{count}} d',
  renewalPast: 'Vencida',
  colLinkedCompany: 'Empresa vinculada',
  colFactors: 'Fatores',
  notLinked: 'Não vinculada',
  factorsCount_one: '{{count}} fator',
  factorsCount_other: '{{count}} fatores',
  factorHeaderFactor: 'Fator',
  factorHeaderWeight: 'Peso',
  factorHeaderValue: 'Valor',
  computedStamp: 'calculado {{time}}',

  // aria-labels
  deleteRowLabel: 'Excluir {{name}}',
  linkLabel: 'Vincular {{name}} a uma empresa do CRM',
  editLinkLabel: 'Editar o vínculo de CRM de {{name}}',

  // Painel de vínculo com o CRM
  linkCompany: 'Vincular empresa',
  editLink: 'Editar vínculo',
  clearLink: 'Remover vínculo',
  linkPanelTitle: 'Vincular "{{name}}" a uma empresa do CRM',
  fieldCompany: 'Empresa',
  selectOrgPlaceholder: 'Selecione uma organização…',
  selectCompanyPlaceholder: 'Selecione uma empresa…',
  linkSaved: 'Empresa vinculada.',
  linkCleared: 'Vínculo removido.',
  linkFailed: 'Falha ao atualizar o vínculo de CRM.',

  // Form field labels / placeholders
  fieldAccount: 'Conta',
  fieldHealth: 'Saúde (0–100)',
  fieldArr: 'ARR',
  fieldRenewal: 'Data de renovação',
  fieldOwner: 'Responsável',
  arrPlaceholder: 'Receita recorrente anual',
  ownerPlaceholder: 'Responsável pela conta',
  accountNamePlaceholder: 'Nome da conta do cliente',

  // Buttons
  addAccount: 'Adicionar conta',

  // Toasts — success
  accountAdded: 'Conta adicionada.',

  // Toasts / errors
  loadAccountsFailed: 'Falha ao carregar as contas.',
  addFailed: 'Falha ao adicionar.',
  deleteFailed: 'Falha ao excluir.',
  updateFailed: 'Falha ao atualizar.',
  arrInvalid: 'O ARR deve ser um número maior ou igual a 0.',
  deleteAccountConfirm: 'Excluir a conta "{{name}}"?',

  // ADR 0582 §6 — mensagens de falha localizadas (antes inalcançáveis).
  failureForbidden: 'Você não tem permissão para fazer isso aqui.',
  failureNotFound: 'Essa conta não está mais aqui.',
  failureRejected: 'A carteira de contas recusou essa alteração.',
  failureRateLimited: 'Requisições demais — espere um instante e tente de novo.',
  failureServer: 'A carteira de contas está indisponível no momento.',
  failureOffline: 'Não foi possível falar com a carteira de contas.',
  loadFailedConsequence: 'Isto não é uma carteira vazia: as contas não puderam ser lidas.',
  staleClause: 'Estes números são os últimos carregados, não os atuais.',

  // ADR 0582 §4/§6 — estados de medição
  healthUnscored: 'Sem pontuação',
  healthUnscoredHint: 'A saúde ainda não foi medida',
  companyGone: 'Empresa não está mais no CRM',
  companyGoneHint: 'Ela foi mesclada ou excluída — vincule esta conta novamente para continuar medindo.',
  healthFailedSince: 'Falhando desde {{date}}',
  healthFailedRelink: 'Vincular empresa novamente',
  healthMeasureFailed: 'A medição falhou',
  healthStalePrevious: 'último valor conhecido {{score}}',
  healthOptionalPlaceholder: 'opcional',
  fieldHealthHint: 'Deixe em branco para adicionar a conta sem pontuação.',
  fieldHealthEditHint: 'Limpe o campo para retirar a pontuação e o detalhamento.',
  portfolioUnmeasured: 'Saúde não medida',
  portfolioUnmeasuredCount_one: '{{count}} conta',
  portfolioUnmeasuredCount_other: '{{count}} contas',
  portfolioUnmeasuredArr: '{{arr}} fora do ARR em risco',

  // ADR 0582 §5 — as duas fórmulas, declaradas para o detalhamento fazer sentido
  'formula_penalty-sum': 'Pontuação = 100 − soma de (peso × contagem). Contagens maiores derrubam a pontuação.',
  'formula_weighted-mean': 'Pontuação = soma de (peso × valor) ÷ peso total. Valores maiores elevam a pontuação.',
  formulaUnstated: 'Este detalhamento foi registrado sem indicar a fórmula.',
  // ADR 0582 §16 — linhas com peso 0 são denominadores de cobertura, não entradas.
  contextRowsNote: 'Linhas com peso 0 são contexto e não entram na pontuação: mostram quanto dos dados de origem pôde ser atribuído a esta conta.',
  factorHeaderCount: 'Contagem',
  noBreakdown: 'Sem detalhamento',

  // Painel de edição (CSM-UX-5)
  editPanelTitle: 'Editar "{{name}}"',
  editRowLabel: 'Editar {{name}}',
  accountUpdated: 'Conta atualizada.',
  accountDeleted: '"{{name}}" excluída.',

  // Collection kit (§4.5 rules 11+13)
  filterGroup: 'Filtros',
  filterAccountsPlaceholder: 'Buscar contas…',
  filterAccountsAria: 'Buscar contas por nome ou responsável',
  filterHealthLabel: 'Filtrar por saúde',
  allHealth: 'Todos os níveis de saúde',
  health_healthy: 'Saudável (70+)',
  health_at_risk: 'Em risco (40–69)',
  health_critical: 'Crítica (abaixo de 40)',
  health_unscored: 'Sem pontuação',
  noMatchTitle: 'Nenhuma conta corresponde',
  noMatchBody: 'Nenhuma conta corresponde aos filtros atuais.',
  clearFilters: 'Limpar filtros',
  viewTable: 'Tabela',
} as const;
