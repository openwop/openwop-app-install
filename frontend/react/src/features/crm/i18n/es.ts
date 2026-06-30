/**
 * `crm` namespace — user-facing copy for the CRM feature (ADR 0001 §4 / ADR 0008).
 * Feature-self-contained: every crm string lives here. Generic actions/states are
 * reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Negocio',
  title: 'CRM',
  lede: 'Contactos, empresas, oportunidades y tareas.',
  ledeVariant: 'Contactos, empresas, oportunidades y tareas. Está en la variante "{{variant}}".',

  // Tabs
  tabContacts: 'Contactos',
  tabCompanies: 'Empresas',
  tabDeals: 'Oportunidades',
  tabTasks: 'Tareas',

  // Gating / empty states
  notEnabledTitle: 'El CRM no está activado',
  notEnabledBody: 'Pida a un administrador que active la función CRM en Administración → Conmutadores de funciones.',
  noOrgsTitle: 'Sin organizaciones',
  noOrgsBody: 'Cree primero una organización: las empresas, oportunidades y tareas pertenecen a una organización.',
  noContactsTitle: 'Aún no hay contactos',
  noContactsBody: 'Añada su primer contacto con el formulario de arriba: nombre, empresa y una etapa del embudo.',
  noCompaniesTitle: 'Aún no hay empresas',
  noCompaniesBody: 'Añada una empresa con el formulario de arriba para empezar a agrupar oportunidades y contactos.',
  noDealsTitle: 'Aún no hay oportunidades',
  noDealsBody: 'Añada una oportunidad con el formulario de arriba: asígnele un título, un importe y una empresa.',
  noTasksTitle: 'Aún no hay tareas',
  noTasksBody: 'Añada una tarea con el formulario de arriba para hacer seguimiento de esta organización.',

  // aria-labels
  orgPickerLabel: 'Organización',
  stageSelectLabel: 'Etapa de la oportunidad para {{title}}',
  statusSelectLabel: 'Estado de la tarea para {{title}}',
  deleteRowLabel: 'Eliminar {{name}}',

  // Table captions
  captionContacts: 'Contactos',
  captionCompanies: 'Empresas',
  captionDeals: 'Oportunidades',
  captionTasks: 'Tareas',
  tablistLabel: 'Secciones del CRM',

  // Column headers
  colName: 'Nombre',
  colCompany: 'Empresa',
  colStage: 'Etapa',
  colDomain: 'Dominio',
  colTags: 'Etiquetas',
  colTitle: 'Título',
  colAmount: 'Importe',
  colStatus: 'Estado',

  // Form field labels
  fieldName: 'Nombre',
  fieldCompany: 'Empresa',
  fieldStage: 'Etapa',
  fieldDomain: 'Dominio',
  fieldTitle: 'Título',
  fieldAmount: 'Importe',

  // Placeholders
  contactNamePlaceholder: 'Juana Pérez',
  contactCompanyPlaceholder: 'Acme',
  companyNamePlaceholder: 'Globex',
  companyDomainPlaceholder: 'globex.com',
  dealTitlePlaceholder: 'Expansión de Globex',
  dealAmountPlaceholder: '5000',
  taskTitlePlaceholder: 'Hacer seguimiento con Globex',

  // Buttons
  triage: 'Clasificar',
  addContact: 'Añadir contacto',
  addCompany: 'Añadir empresa',
  addDeal: 'Añadir oportunidad',
  addTask: 'Añadir tarea',

  // Toasts — success
  contactAdded: 'Contacto añadido.',
  companyAdded: 'Empresa añadida.',
  dealAdded: 'Oportunidad añadida.',
  taskAdded: 'Tarea añadida.',
  triageStarted: 'Clasificación iniciada — variante {{variant}} (ejecución {{runId}}…).',
  triageVariantDefault: 'predeterminada',

  // Toasts / errors
  actionFailed: 'La acción ha fallado.',
  loadContactsFailed: 'No se han podido cargar los contactos.',
  addFailed: 'No se ha podido añadir.',
  deleteFailed: 'No se ha podido eliminar.',
  triageFailed: 'La clasificación ha fallado.',
  loadFailed: 'No se ha podido cargar.',
  amountMustBeNumber: 'El importe debe ser un número.',

  // Deal amount cell (number + optional currency code)
  amountWithCurrency: '{{amount}} {{currency}}',
} as const;
