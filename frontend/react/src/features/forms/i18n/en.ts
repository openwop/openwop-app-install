/**
 * `forms` namespace — user-facing copy for the forms feature.
 * Feature-self-contained: every forms string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Workspace',
  title: 'Forms',
  lede: 'Build a public form; submissions become CRM contacts.',

  // Gating / empty states
  notEnabledTitle: 'Forms is not enabled',
  notEnabledBody: 'Ask an administrator to enable the Forms feature for this tenant.',
  noOrgsTitle: 'No organizations',
  noOrgsBody: 'Create an organization first — forms belong to an org.',

  // aria-labels
  orgPickerLabel: 'Organization',

  // New-form toolbar
  newFormLabel: 'New form',
  newFormPlaceholder: 'e.g. Contact us',
  newFormButton: 'New form',

  // Forms list
  formsHeading: 'Forms',
  noFormsYet: 'No forms yet.',
  deleteForm: 'Delete form',

  // Builder
  editForm: 'Edit form',
  publish: 'Publish',
  unpublish: 'Unpublish',
  titleLabel: 'Title',
  fieldsHeading: 'Fields',
  fieldLabelPlaceholder: 'Label',
  fieldKeyPlaceholder: 'key (auto)',
  fieldLabelAria: 'Field label',
  fieldKeyAria: 'Field key',
  fieldTypeAria: 'Field type',
  fieldRequired: 'required',
  removeField: 'Remove field',
  addField: 'Add field',
  createToContact: 'Create a CRM contact from each submission',
  submitMessageLabel: 'Submit message (optional)',
  submitMessagePlaceholder: 'Thanks — we’ll be in touch.',
  untitledForm: 'Untitled',

  // Public URL
  publicUrlLabel: 'Public URL',
  copyPublicUrl: 'Copy public URL',
  publishToGetUrl: 'Publish the form to get its public URL.',
  publicUrlCopied: 'Public URL copied',

  // Submissions
  submissionsHeading: 'Submissions',
  noSubmissionsYet: 'No submissions yet.',
  submissionContact: 'contact',
  submissionError: 'error',
  errNoContactFields: 'no contact fields',
  errContactCreateFailed: 'contact failed',

  // Toasts — success
  formCreated: 'Form created',
  saved: 'Saved',

  // Toasts — errors
  loadFormsFailed: 'Failed to load forms.',
  createFailed: 'Create failed.',
  saveFailed: 'Save failed.',
  publishFailed: 'Publish failed.',
  deleteFailed: 'Delete failed.',
} as const;
