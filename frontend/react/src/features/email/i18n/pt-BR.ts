/**
 * `email` namespace — user-facing copy for the email feature.
 * Feature-self-contained: every email string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Espaço de trabalho',
  title: 'E-mail',
  lede: 'Campanhas com modelos sobre seus contatos do CRM — restritas por consentimento.',

  // Gating / empty states
  notEnabledTitle: 'E-mail não está habilitado',
  notEnabledBody: 'Peça a um administrador para habilitar o recurso E-mail para este tenant.',
  noOrgsTitle: 'Nenhuma organização',
  noOrgsBody: 'Crie uma organização primeiro — campanhas pertencem a uma organização.',

  // aria-labels
  orgPickerLabel: 'Organização',

  // Template form
  templateNameLabel: 'Nome do modelo',
  templateNamePlaceholder: 'Welcome',
  subjectLabel: 'Assunto',
  subjectPlaceholder: 'Hi {{contact.name}}',
  bodyLabel: 'Corpo',
  bodyPlaceholder: 'Hello {{contact.name}} …',
  newTemplate: 'Novo modelo',

  // Templates list + editor
  templatesHeading: 'Modelos',
  noTemplates: 'Ainda sem modelos.',
  deleteTemplate: 'Excluir modelo',
  editorNameLabel: 'Nome',
  editorSubjectLabel: 'Assunto',
  editorBodyLabel: 'Corpo',

  // Campaign form
  campaignTemplateLabel: 'Modelo',
  audienceStageLabel: 'Estágio do público',
  audienceAllContacts: 'todos os contatos',
  newCampaign: 'Nova campanha',

  // Campaigns list
  campaignsHeading: 'Campanhas',
  noCampaigns: 'Ainda sem campanhas.',
  campaignStats: '{{sent}} enviados · {{skipped}} ignorados · {{failed}} com falha',
  resend: 'Reenviar',
  campaignSend: 'Enviar',
  sendCampaignAria: 'Enviar campanha',
  log: 'Registro',
  deleteCampaign: 'Excluir campanha',
  noSends: 'Ainda sem envios.',

  // Confirm dialog
  resendConfirm: 'Esta campanha já foi enviada — reenviar para todo o público? Cada destinatário será contatado novamente.',

  // Toasts — success
  templateCreated: 'Modelo criado',
  templateSaved: 'Salvo',
  campaignCreated: 'Campanha criada',
  sendResult: 'Enviados {{sent}} · ignorados {{skipped}} · com falha {{failed}}',

  // Toasts / errors
  loadFailed: 'Falha ao carregar.',
  createFailed: 'Falha na criação.',
  saveFailed: 'Falha ao salvar.',
  deleteFailed: 'Falha ao excluir.',
  sendFailed: 'Falha no envio.',
} as const;
