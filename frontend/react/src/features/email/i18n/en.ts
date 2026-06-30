/**
 * `email` namespace — user-facing copy for the email feature.
 * Feature-self-contained: every email string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Workspace',
  title: 'Email',
  lede: 'Templated campaigns over your CRM contacts — consent-gated.',

  // Gating / empty states
  notEnabledTitle: 'Email is not enabled',
  notEnabledBody: 'Ask an administrator to enable the Email feature for this tenant.',
  noOrgsTitle: 'No organizations',
  noOrgsBody: 'Create an organization first — campaigns belong to an org.',

  // aria-labels
  orgPickerLabel: 'Organization',

  // Template form
  templateNameLabel: 'Template name',
  templateNamePlaceholder: 'Welcome',
  subjectLabel: 'Subject',
  subjectPlaceholder: 'Hi {{contact.name}}',
  bodyLabel: 'Body',
  bodyPlaceholder: 'Hello {{contact.name}} …',
  newTemplate: 'New template',

  // Templates list + editor
  templatesHeading: 'Templates',
  noTemplates: 'No templates yet.',
  deleteTemplate: 'Delete template',
  editorNameLabel: 'Name',
  editorSubjectLabel: 'Subject',
  editorBodyLabel: 'Body',

  // Campaign form
  campaignTemplateLabel: 'Template',
  audienceStageLabel: 'Audience stage',
  audienceAllContacts: 'all contacts',
  newCampaign: 'New campaign',

  // Campaigns list
  campaignsHeading: 'Campaigns',
  noCampaigns: 'No campaigns yet.',
  campaignStats: '{{sent}} sent · {{skipped}} skipped · {{failed}} failed',
  resend: 'Re-send',
  campaignSend: 'Send',
  sendCampaignAria: 'Send campaign',
  log: 'Log',
  deleteCampaign: 'Delete campaign',
  noSends: 'No sends yet.',

  // Confirm dialog
  resendConfirm: 'This campaign was already sent — re-send to the whole audience? Every recipient is contacted again.',

  // Toasts — success
  templateCreated: 'Template created',
  templateSaved: 'Saved',
  campaignCreated: 'Campaign created',
  sendResult: 'Sent {{sent}} · skipped {{skipped}} · failed {{failed}}',

  // Toasts / errors
  loadFailed: 'Failed to load.',
  createFailed: 'Create failed.',
  saveFailed: 'Save failed.',
  deleteFailed: 'Delete failed.',
  sendFailed: 'Send failed.',
} as const;
