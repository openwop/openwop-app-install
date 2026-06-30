/**
 * `crm` namespace — user-facing copy for the CRM feature (ADR 0001 §4 / ADR 0008).
 * Feature-self-contained: every crm string lives here. Generic actions/states are
 * reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Negócios',
  title: 'CRM',
  lede: 'Contatos, empresas, negócios e tarefas.',
  ledeVariant: 'Contatos, empresas, negócios e tarefas. Você está na variante "{{variant}}".',

  // Tabs
  tabContacts: 'Contatos',
  tabCompanies: 'Empresas',
  tabDeals: 'Negócios',
  tabTasks: 'Tarefas',

  // Gating / empty states
  notEnabledTitle: 'O CRM não está ativado',
  notEnabledBody: 'Peça a um administrador para ativar o recurso CRM em Admin → Feature toggles.',
  noOrgsTitle: 'Nenhuma organização',
  noOrgsBody: 'Crie uma organização primeiro — empresas, negócios e tarefas pertencem a uma organização.',
  noContactsTitle: 'Nenhum contato ainda',
  noContactsBody: 'Adicione seu primeiro contato com o formulário acima — nome, empresa e um estágio do pipeline.',
  noCompaniesTitle: 'Nenhuma empresa ainda',
  noCompaniesBody: 'Adicione uma empresa com o formulário acima para começar a agrupar negócios e contatos.',
  noDealsTitle: 'Nenhum negócio ainda',
  noDealsBody: 'Adicione um negócio com o formulário acima — dê a ele um título, valor e empresa.',
  noTasksTitle: 'Nenhuma tarefa ainda',
  noTasksBody: 'Adicione uma tarefa com o formulário acima para acompanhar os follow-ups desta organização.',

  // aria-labels
  orgPickerLabel: 'Organização',
  stageSelectLabel: 'Estágio do negócio para {{title}}',
  statusSelectLabel: 'Status da tarefa para {{title}}',
  deleteRowLabel: 'Excluir {{name}}',

  // Table captions
  captionContacts: 'Contatos',
  captionCompanies: 'Empresas',
  captionDeals: 'Negócios',
  captionTasks: 'Tarefas',
  tablistLabel: 'Seções do CRM',

  // Column headers
  colName: 'Nome',
  colCompany: 'Empresa',
  colStage: 'Estágio',
  colDomain: 'Domínio',
  colTags: 'Etiquetas',
  colTitle: 'Título',
  colAmount: 'Valor',
  colStatus: 'Status',

  // Form field labels
  fieldName: 'Nome',
  fieldCompany: 'Empresa',
  fieldStage: 'Estágio',
  fieldDomain: 'Domínio',
  fieldTitle: 'Título',
  fieldAmount: 'Valor',

  // Placeholders
  contactNamePlaceholder: 'Jane Doe',
  contactCompanyPlaceholder: 'Acme',
  companyNamePlaceholder: 'Globex',
  companyDomainPlaceholder: 'globex.com',
  dealTitlePlaceholder: 'Expansão Globex',
  dealAmountPlaceholder: '5000',
  taskTitlePlaceholder: 'Dar follow-up com a Globex',

  // Buttons
  triage: 'Triagem',
  addContact: 'Adicionar contato',
  addCompany: 'Adicionar empresa',
  addDeal: 'Adicionar negócio',
  addTask: 'Adicionar tarefa',

  // Toasts — success
  contactAdded: 'Contato adicionado.',
  companyAdded: 'Empresa adicionada.',
  dealAdded: 'Negócio adicionado.',
  taskAdded: 'Tarefa adicionada.',
  triageStarted: 'Triagem iniciada — variante {{variant}} (execução {{runId}}…).',
  triageVariantDefault: 'padrão',

  // Toasts / errors
  actionFailed: 'Falha na ação.',
  loadContactsFailed: 'Falha ao carregar os contatos.',
  addFailed: 'Falha ao adicionar.',
  deleteFailed: 'Falha ao excluir.',
  triageFailed: 'Falha na triagem.',
  loadFailed: 'Falha ao carregar.',
  amountMustBeNumber: 'O valor deve ser um número.',

  // Deal amount cell (number + optional currency code)
  amountWithCurrency: '{{amount}} {{currency}}',
} as const;
