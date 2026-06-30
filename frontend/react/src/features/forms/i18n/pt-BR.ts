/**
 * `forms` namespace — user-facing copy for the forms feature.
 * Feature-self-contained: every forms string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Espaço de trabalho',
  title: 'Formulários',
  lede: 'Crie um formulário público; os envios viram contatos no CRM.',

  // Gating / empty states
  notEnabledTitle: 'Formulários não está habilitado',
  notEnabledBody: 'Peça a um administrador para habilitar o recurso Formulários para este tenant.',
  noOrgsTitle: 'Nenhuma organização',
  noOrgsBody: 'Crie uma organização primeiro — formulários pertencem a uma organização.',

  // aria-labels
  orgPickerLabel: 'Organização',

  // New-form toolbar
  newFormLabel: 'Novo formulário',
  newFormPlaceholder: 'ex.: Fale conosco',
  newFormButton: 'Novo formulário',

  // Forms list
  formsHeading: 'Formulários',
  noFormsYet: 'Ainda sem formulários.',
  deleteForm: 'Excluir formulário',

  // Builder
  editForm: 'Editar formulário',
  publish: 'Publicar',
  unpublish: 'Despublicar',
  titleLabel: 'Título',
  fieldsHeading: 'Campos',
  fieldLabelPlaceholder: 'Rótulo',
  fieldKeyPlaceholder: 'key (auto)',
  fieldLabelAria: 'Rótulo do campo',
  fieldKeyAria: 'Chave do campo',
  fieldTypeAria: 'Tipo do campo',
  fieldRequired: 'obrigatório',
  removeField: 'Remover campo',
  addField: 'Adicionar campo',
  createToContact: 'Criar um contato no CRM a partir de cada envio',
  submitMessageLabel: 'Mensagem de envio (opcional)',
  submitMessagePlaceholder: 'Obrigado — entraremos em contato.',
  untitledForm: 'Sem título',

  // Public URL
  publicUrlLabel: 'URL pública',
  copyPublicUrl: 'Copiar URL pública',
  publishToGetUrl: 'Publique o formulário para obter sua URL pública.',
  publicUrlCopied: 'URL pública copiada',

  // Submissions
  submissionsHeading: 'Envios',
  noSubmissionsYet: 'Ainda sem envios.',
  submissionContact: 'contato',
  submissionError: 'erro',
  errNoContactFields: 'sem campos de contato',
  errContactCreateFailed: 'falha no contato',

  // Toasts — success
  formCreated: 'Formulário criado',
  saved: 'Salvo',

  // Toasts — errors
  loadFormsFailed: 'Falha ao carregar os formulários.',
  createFailed: 'Falha na criação.',
  saveFailed: 'Falha ao salvar.',
  publishFailed: 'Falha na publicação.',
  deleteFailed: 'Falha ao excluir.',
} as const;
