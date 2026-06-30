/**
 * `crm` namespace — user-facing copy for the CRM feature (ADR 0001 §4 / ADR 0008).
 * Feature-self-contained: every crm string lives here. Generic actions/states are
 * reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Business',
  title: 'CRM',
  lede: 'Contacts, companies, deals, and tasks.',
  ledeVariant: 'Contacts, companies, deals, and tasks. You’re in variant "{{variant}}".',

  // Tabs
  tabContacts: 'Contacts',
  tabCompanies: 'Companies',
  tabDeals: 'Deals',
  tabTasks: 'Tasks',

  // Gating / empty states
  notEnabledTitle: 'CRM is not enabled',
  notEnabledBody: 'Ask an administrator to turn on the CRM feature in Admin → Feature toggles.',
  noOrgsTitle: 'No organizations',
  noOrgsBody: 'Create an organization first — companies, deals, and tasks belong to an org.',
  noContactsTitle: 'No contacts yet',
  noContactsBody: 'Add your first contact with the form above — name, company, and a pipeline stage.',
  noCompaniesTitle: 'No companies yet',
  noCompaniesBody: 'Add a company with the form above to start grouping deals and contacts.',
  noDealsTitle: 'No deals yet',
  noDealsBody: 'Add a deal with the form above — give it a title, amount, and company.',
  noTasksTitle: 'No tasks yet',
  noTasksBody: 'Add a task with the form above to track follow-ups for this org.',

  // aria-labels
  orgPickerLabel: 'Organization',
  stageSelectLabel: 'Deal stage for {{title}}',
  statusSelectLabel: 'Task status for {{title}}',
  deleteRowLabel: 'Delete {{name}}',

  // Table captions
  captionContacts: 'Contacts',
  captionCompanies: 'Companies',
  captionDeals: 'Deals',
  captionTasks: 'Tasks',
  tablistLabel: 'CRM sections',

  // Column headers
  colName: 'Name',
  colCompany: 'Company',
  colStage: 'Stage',
  colDomain: 'Domain',
  colTags: 'Tags',
  colTitle: 'Title',
  colAmount: 'Amount',
  colStatus: 'Status',

  // Form field labels
  fieldName: 'Name',
  fieldCompany: 'Company',
  fieldStage: 'Stage',
  fieldDomain: 'Domain',
  fieldTitle: 'Title',
  fieldAmount: 'Amount',

  // Placeholders
  contactNamePlaceholder: 'Jane Doe',
  contactCompanyPlaceholder: 'Acme',
  companyNamePlaceholder: 'Globex',
  companyDomainPlaceholder: 'globex.com',
  dealTitlePlaceholder: 'Globex expansion',
  dealAmountPlaceholder: '5000',
  taskTitlePlaceholder: 'Follow up with Globex',

  // Buttons
  triage: 'Triage',
  addContact: 'Add contact',
  addCompany: 'Add company',
  addDeal: 'Add deal',
  addTask: 'Add task',

  // Toasts — success
  contactAdded: 'Contact added.',
  companyAdded: 'Company added.',
  dealAdded: 'Deal added.',
  taskAdded: 'Task added.',
  triageStarted: 'Triage started — variant {{variant}} (run {{runId}}…).',
  triageVariantDefault: 'default',

  // Toasts / errors
  actionFailed: 'Action failed.',
  loadContactsFailed: 'Failed to load contacts.',
  addFailed: 'Add failed.',
  deleteFailed: 'Delete failed.',
  triageFailed: 'Triage failed.',
  loadFailed: 'Load failed.',
  amountMustBeNumber: 'Amount must be a number.',

  // Deal amount cell (number + optional currency code)
  amountWithCurrency: '{{amount}} {{currency}}',
} as const;
