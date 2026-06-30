/**
 * `forms` namespace — user-facing copy for the forms feature.
 * Feature-self-contained: every forms string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Espacio de trabajo',
  title: 'Formularios',
  lede: 'Cree un formulario público; los envíos se convierten en contactos del CRM.',

  // Gating / empty states
  notEnabledTitle: 'Los formularios no están habilitados',
  notEnabledBody: 'Pida a un administrador que habilite la función Formularios para este tenant.',
  noOrgsTitle: 'No hay organizaciones',
  noOrgsBody: 'Cree primero una organización: los formularios pertenecen a una organización.',

  // aria-labels
  orgPickerLabel: 'Organización',

  // New-form toolbar
  newFormLabel: 'Nuevo formulario',
  newFormPlaceholder: 'p. ej. Contáctenos',
  newFormButton: 'Nuevo formulario',

  // Forms list
  formsHeading: 'Formularios',
  noFormsYet: 'Aún no hay formularios.',
  deleteForm: 'Eliminar formulario',

  // Builder
  editForm: 'Editar formulario',
  publish: 'Publicar',
  unpublish: 'Anular publicación',
  titleLabel: 'Título',
  fieldsHeading: 'Campos',
  fieldLabelPlaceholder: 'Etiqueta',
  fieldKeyPlaceholder: 'clave (automática)',
  fieldLabelAria: 'Etiqueta del campo',
  fieldKeyAria: 'Clave del campo',
  fieldTypeAria: 'Tipo de campo',
  fieldRequired: 'obligatorio',
  removeField: 'Eliminar campo',
  addField: 'Añadir campo',
  createToContact: 'Crear un contacto del CRM a partir de cada envío',
  submitMessageLabel: 'Mensaje de envío (opcional)',
  submitMessagePlaceholder: 'Gracias, nos pondremos en contacto.',
  untitledForm: 'Sin título',

  // Public URL
  publicUrlLabel: 'URL pública',
  copyPublicUrl: 'Copiar URL pública',
  publishToGetUrl: 'Publique el formulario para obtener su URL pública.',
  publicUrlCopied: 'URL pública copiada',

  // Submissions
  submissionsHeading: 'Envíos',
  noSubmissionsYet: 'Aún no hay envíos.',
  submissionContact: 'contacto',
  submissionError: 'error',
  errNoContactFields: 'sin campos de contacto',
  errContactCreateFailed: 'fallo al crear el contacto',

  // Toasts — success
  formCreated: 'Formulario creado',
  saved: 'Guardado',

  // Toasts — errors
  loadFormsFailed: 'No se han podido cargar los formularios.',
  createFailed: 'Error al crear.',
  saveFailed: 'Error al guardar.',
  publishFailed: 'Error al publicar.',
  deleteFailed: 'Error al eliminar.',
} as const;
