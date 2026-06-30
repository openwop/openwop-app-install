/**
 * `crm` namespace — user-facing copy for the CRM feature (ADR 0001 §4 / ADR 0008).
 * Feature-self-contained: every crm string lives here. Generic actions/states are
 * reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Affaires',
  title: 'CRM',
  lede: 'Contacts, entreprises, affaires et tâches.',
  ledeVariant: 'Contacts, entreprises, affaires et tâches. Vous êtes dans la variante "{{variant}}".',

  // Tabs
  tabContacts: 'Contacts',
  tabCompanies: 'Entreprises',
  tabDeals: 'Affaires',
  tabTasks: 'Tâches',

  // Gating / empty states
  notEnabledTitle: 'Le CRM n\'est pas activé',
  notEnabledBody: 'Demandez à un administrateur d\'activer la fonctionnalité CRM dans Administration → Bascules de fonctionnalités.',
  noOrgsTitle: 'Aucune organisation',
  noOrgsBody: 'Créez d\'abord une organisation — les entreprises, affaires et tâches appartiennent à une organisation.',
  noContactsTitle: 'Aucun contact pour le moment',
  noContactsBody: 'Ajoutez votre premier contact avec le formulaire ci-dessus — nom, entreprise et une étape du pipeline.',
  noCompaniesTitle: 'Aucune entreprise pour le moment',
  noCompaniesBody: 'Ajoutez une entreprise avec le formulaire ci-dessus pour commencer à regrouper affaires et contacts.',
  noDealsTitle: 'Aucune affaire pour le moment',
  noDealsBody: 'Ajoutez une affaire avec le formulaire ci-dessus — donnez-lui un titre, un montant et une entreprise.',
  noTasksTitle: 'Aucune tâche pour le moment',
  noTasksBody: 'Ajoutez une tâche avec le formulaire ci-dessus pour suivre les relances de cette organisation.',

  // aria-labels
  orgPickerLabel: 'Organisation',
  stageSelectLabel: 'Étape de l\'affaire pour {{title}}',
  statusSelectLabel: 'Statut de la tâche pour {{title}}',
  deleteRowLabel: 'Supprimer {{name}}',

  // Table captions
  captionContacts: 'Contacts',
  captionCompanies: 'Entreprises',
  captionDeals: 'Affaires',
  captionTasks: 'Tâches',
  tablistLabel: 'Sections du CRM',

  // Column headers
  colName: 'Nom',
  colCompany: 'Entreprise',
  colStage: 'Étape',
  colDomain: 'Domaine',
  colTags: 'Étiquettes',
  colTitle: 'Titre',
  colAmount: 'Montant',
  colStatus: 'Statut',

  // Form field labels
  fieldName: 'Nom',
  fieldCompany: 'Entreprise',
  fieldStage: 'Étape',
  fieldDomain: 'Domaine',
  fieldTitle: 'Titre',
  fieldAmount: 'Montant',

  // Placeholders
  contactNamePlaceholder: 'Jeanne Dupont',
  contactCompanyPlaceholder: 'Acme',
  companyNamePlaceholder: 'Globex',
  companyDomainPlaceholder: 'globex.com',
  dealTitlePlaceholder: 'Expansion Globex',
  dealAmountPlaceholder: '5000',
  taskTitlePlaceholder: 'Relancer Globex',

  // Buttons
  triage: 'Trier',
  addContact: 'Ajouter un contact',
  addCompany: 'Ajouter une entreprise',
  addDeal: 'Ajouter une affaire',
  addTask: 'Ajouter une tâche',

  // Toasts — success
  contactAdded: 'Contact ajouté.',
  companyAdded: 'Entreprise ajoutée.',
  dealAdded: 'Affaire ajoutée.',
  taskAdded: 'Tâche ajoutée.',
  triageStarted: 'Tri démarré — variante {{variant}} (exécution {{runId}}…).',
  triageVariantDefault: 'par défaut',

  // Toasts / errors
  actionFailed: 'L\'action a échoué.',
  loadContactsFailed: 'Échec du chargement des contacts.',
  addFailed: 'L\'ajout a échoué.',
  deleteFailed: 'La suppression a échoué.',
  triageFailed: 'Le tri a échoué.',
  loadFailed: 'Le chargement a échoué.',
  amountMustBeNumber: 'Le montant doit être un nombre.',

  // Deal amount cell (number + optional currency code)
  amountWithCurrency: '{{amount}} {{currency}}',
} as const;
