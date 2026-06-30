/**
 * `email` namespace — user-facing copy for the email feature.
 * Feature-self-contained: every email string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Espacio de trabajo',
  title: 'Correo electrónico',
  lede: 'Campañas con plantillas sobre sus contactos del CRM — sujetas a consentimiento.',

  // Gating / empty states
  notEnabledTitle: 'El correo electrónico no está habilitado',
  notEnabledBody: 'Pida a un administrador que habilite la función de correo electrónico para este inquilino.',
  noOrgsTitle: 'No hay organizaciones',
  noOrgsBody: 'Cree primero una organización — las campañas pertenecen a una organización.',

  // aria-labels
  orgPickerLabel: 'Organización',

  // Template form
  templateNameLabel: 'Nombre de la plantilla',
  templateNamePlaceholder: 'Bienvenida',
  subjectLabel: 'Asunto',
  subjectPlaceholder: 'Hola {{contact.name}}',
  bodyLabel: 'Cuerpo',
  bodyPlaceholder: 'Hola {{contact.name}} …',
  newTemplate: 'Nueva plantilla',

  // Templates list + editor
  templatesHeading: 'Plantillas',
  noTemplates: 'Aún no hay plantillas.',
  deleteTemplate: 'Eliminar plantilla',
  editorNameLabel: 'Nombre',
  editorSubjectLabel: 'Asunto',
  editorBodyLabel: 'Cuerpo',

  // Campaign form
  campaignTemplateLabel: 'Plantilla',
  audienceStageLabel: 'Etapa de la audiencia',
  audienceAllContacts: 'todos los contactos',
  newCampaign: 'Nueva campaña',

  // Campaigns list
  campaignsHeading: 'Campañas',
  noCampaigns: 'Aún no hay campañas.',
  campaignStats: '{{sent}} enviados · {{skipped}} omitidos · {{failed}} fallidos',
  resend: 'Reenviar',
  campaignSend: 'Enviar',
  sendCampaignAria: 'Enviar campaña',
  log: 'Registro',
  deleteCampaign: 'Eliminar campaña',
  noSends: 'Aún no hay envíos.',

  // Confirm dialog
  resendConfirm: 'Esta campaña ya se envió — ¿reenviarla a toda la audiencia? Se vuelve a contactar a todos los destinatarios.',

  // Toasts — success
  templateCreated: 'Plantilla creada',
  templateSaved: 'Guardado',
  campaignCreated: 'Campaña creada',
  sendResult: 'Enviados {{sent}} · omitidos {{skipped}} · fallidos {{failed}}',

  // Toasts / errors
  loadFailed: 'No se pudo cargar.',
  createFailed: 'Error al crear.',
  saveFailed: 'Error al guardar.',
  deleteFailed: 'Error al eliminar.',
  sendFailed: 'Error al enviar.',
} as const;
