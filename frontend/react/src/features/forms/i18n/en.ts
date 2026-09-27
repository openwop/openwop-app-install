/**
 * `forms` namespace — user-facing copy for the forms feature.
 * Feature-self-contained: every forms string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Workspace',
  orgsEmptyClause: 'Forms belong to an organization',
  orgsFailedClause: 'The form list was never requested',
  title: 'Forms',
  lede: 'Build forms and collect submissions — publish anywhere, route anywhere.',

  // Gating / empty states
  notEnabledTitle: 'Forms is not enabled',
  notEnabledBody: 'Ask an administrator to enable the Forms feature for this tenant.',
  loadFailedTitle: 'Could not load',
  loadFailedBody: 'Something went wrong fetching this. Check your connection and retry.',
  loadingForms: 'Loading forms…',
  noFormsTitle: 'No forms yet',
  noFormsBody: 'Name a form above to build your first one — add fields, publish it, and collect submissions.',

  // aria-labels

  // New-form toolbar
  newFormLabel: 'New form',
  newFormPlaceholder: 'e.g. Contact us',
  newFormButton: 'New form',
  charCountOver: '{{n}} characters too many',
  fieldKeyInvalid: 'Use only letters, numbers and underscores (max 64).',
  saveBlocked: 'Fix these before saving: {{fields}}',
  charCount: '{{n}} / {{max}} characters',
  templatesHeading: 'Or start from a template',
  templatesOpenGallery: 'Start from a template',
  templatesGalleryTitle: 'Start a form from a template',
  templatesEmptyTitle: 'No form templates installed',
  templatesEmptyBody: 'Form templates arrive with packs. Install one, or name a form above to start from blank.',

  templatesReassurance: 'Creates a draft you can edit or delete — nothing is published until you publish it.',
  templateCreated: 'Form created from template.',
  /** DOCTPL-19 — the per-form origin chip: {{source}} is `packName@packVersion`. */
  originTemplateChip: 'From template · {{source}}',
  originTemplateTitle: 'Created from installed template {{templateId}}',
  templateCreateFailed: 'The form could not be created from that template.',

  // Collection (§4.5 list page)
  filterGroup: 'Filter forms',
  noMatchTitle: 'No forms match',
  resultCount_one: '{{count}} form matches your filters',
  resultCount_other: '{{count}} forms match your filters',

  // Collection cells (Card + Row)
  openForm: 'Open {{name}}',
  openFormAction: 'Open',
  subFieldCount_one: '{{count}} field',
  subFieldCount_other: '{{count}} fields',
  subToContact: 'creates CRM contacts',
  subToIntake: 'routed to a priority list',
  subEmailOptIn: 'email opt-in',
  subUpdated: 'Updated {{when}}',

  // Detail page (/forms/:formId)
  detailLede: 'Build the form, publish it, and read what came in.',
  backToForms: '← Back to Forms',
  loadingForm: 'Loading form…',
  loadFormFailedTitle: 'Couldn’t load this form',
  loadFormFailedBody: 'The form didn’t load. Reload the page, or go back to Forms.',
  formNotFoundTitle: 'Form not found',
  formNotFoundBody: 'This form was deleted, or the link points at another workspace.',
  formNotFoundGuessedBody: 'The link didn’t name a workspace, so we looked in “{{workspace}}”. If the form lives in another workspace, switch to it from Forms.',
  unsavedChanges: 'unsaved changes',
  filterPlaceholder: 'Filter forms…',
  filterAria: 'Filter forms by title',
  noMatchBody: 'No form matches your search.',
  clearSearch: 'Clear search',
  status_draft: 'draft',
  status_published: 'published',

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
  fieldDescriptionPlaceholder: 'Help text (optional) — shown under the field',
  fieldDescriptionAria: 'Help text for “{{label}}”',
  fieldTypeAria: 'Field type',
  fieldRequired: 'required',
  removeField: 'Remove field',
  addField: 'Add field',
  createToContact: 'Create a CRM contact from each submission',
  crmDisabledNotice: 'CRM is disabled — submissions are kept; contacts are not created.',
  submitMessageLabel: 'Submit message (optional)',
  submitMessagePlaceholder: 'Thanks — we’ll be in touch.',
  untitledForm: 'Untitled',

  // Intake routing (ADR 0246 — forms → priority-matrix idea intake)
  intakeHeading: 'Route submissions to a priority list',
  intakeLede: 'File each submission as an idea on a Priority Matrix list for triage.',
  intakeListLabel: 'Intake list',
  intakeListOff: 'Not routed',
  intakeListUnknown: 'Currently routed list (unavailable)',
  intakeNoLists: 'No Priority Matrix lists in this org yet — create one to route submissions.',
  intakeListsFailed: 'Routing lists could not be loaded — this is a read error, not an empty workspace.',
  intake_titleField: 'Idea title from',
  intake_requesterField: 'Requester from (optional)',
  intake_notesField: 'Notes from (optional)',
  intakePickRequired: 'Choose a field…',
  intakePickOptional: 'None',
  intakeTitleFieldRequired: 'Choose which field becomes the idea title.',
  intakeEnableHint: 'Routing also needs the “Form submission → intake” automation enabled once for this workspace (Settings → Event bindings).',
  intakeMappingLegend: 'Map form fields to the idea',
  intakeNeedFields: 'Add at least one field above to map into the idea.',

  // Public URL
  publicUrlLabel: 'Public URL',
  copyPublicUrl: 'Copy public URL',
  publishToGetUrl: 'Publish the form to get its public URL.',
  publicUrlCopied: 'Public URL copied',

  // Submissions
  submissionsHeading: 'Submissions',
  noSubmissionsYet: 'No submissions yet.',
  subsLoadFailedTitle: 'Submissions could not be loaded.',
  subsLoadFailedBody: 'This is a problem reading them — not an empty form. Reload to try again.',
  submissionContact: 'contact',
  submissionError: 'error',
  errNoContactFields: 'no contact fields',
  errSuppressionUnreadable: 'Contact not created — the suppression list could not be read',
  errSuppressed: 'Not added — suppressed',
  errSuppressedBody: 'This address is on the suppression list (unsubscribed, bounced, or erased on request), so no CRM contact was created on purpose. Do not add it by hand.',
  csvDestination: 'Destination',
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
  deleteFormConfirm: 'Delete form "{{name}}"?',
  // ADR 0331 — hosted fill page + public renderer
  fillSuccessDefault: 'Thanks — your submission was received.',
  fillErrorGeneric: 'Something went wrong sending your submission. Please try again.',
  starterNameLabel: 'Name',
  starterEmailLabel: 'Email',
  publishSaveFirst: 'Save your changes first — publishing ships the last SAVED version.',
  unpublishConfirm: 'Unpublish "{{name}}"?',
  unpublishBody: 'The shared link stops working until you publish again.',
  keyRenameHint: 'This form already has submissions — renaming a field’s key starts a new column in the inbox and export.',
  fillSubmitAnother: 'Submit another response',
  fillResumedNotice: 'We restored your in-progress answers (saved only in this browser).',
  fillStartOver: 'Start over',
  fieldType_text: 'Text',
  fieldType_email: 'Email',
  fieldType_number: 'Number',
  fieldType_textarea: 'Long text',
  fieldType_select: 'Dropdown',
  fieldType_checkbox: 'Checkbox',
  moveFieldUp: 'Move up',
  moveFieldDown: 'Move down',
  moveFieldUpAria: 'Move “{{label}}” up',
  moveFieldDownAria: 'Move “{{label}}” down',
  fieldMoved: '“{{label}}” moved to position {{n}}',
  fieldOptionsLabel: 'Options (one per line)',
  fieldNum_min: 'Min',
  fieldNum_max: 'Max',
  fieldNum_step: 'Step',
  fieldNum_minAria: 'Minimum value for {{label}}',
  fieldNum_maxAria: 'Maximum value for {{label}}',
  fieldNum_stepAria: 'Step for {{label}}',
  fieldOptionsPlaceholder: 'First option\nSecond option',
  fieldOptionsAria: 'Options for “{{label}}”, one per line',
  blockerSelectNoOptions: '“{{label}}” is a dropdown with no options',
  exportCsv: 'Download CSV',
  exportCsvFailed: 'Couldn’t export submissions — try again.',
  csvSubmittedAt: 'Submitted at',
  csvUtm: 'UTM',
  csvContext: 'Context',
  blockerIncompleteField: 'Field {{n}} needs a label (and a key it can derive)',
  blockerDuplicateKey: 'Two fields share the key “{{key}}”',
  emailOptInMissing: '{{key}} (no longer a checkbox field)',
  deleteFormCascade: 'This permanently deletes the form AND every captured submission — leads cannot be recovered.',
  valueYes: 'Yes',
  valueNo: 'No',
  subMetaReferrer: 'Referrer',
  subsLoadOlderFailed: 'Couldn’t load older submissions — try again.',
  fillLoadFailed: 'This form couldn’t be loaded right now.',
  fillErrorCapacity: 'This form isn’t accepting submissions right now, so your answers weren’t saved. Please contact whoever shared this form with you.',
  fillErrorTooLarge: 'Your answers add up to more than 20,000 characters in total, so they couldn’t be accepted. Please shorten the longest ones and try again.',
  fillErrorRejected: 'Your submission couldn’t be accepted — please review your answers and try again.',
  fillErrorSummaryTitle_one: 'Fix 1 field before submitting:',
  fillErrorSummaryTitle_other: 'Fix {{count}} fields before submitting:',
  fillSubmit: 'Submit',
  fillSubmitting: 'Submitting…',
  fillSelectPlaceholder: 'Choose…',
  fillUnavailableTitle: 'This form isn’t available',
  fillUnavailableBody: 'It may have been unpublished or the link is out of date.',
  hostedUrlLabel: 'Hosted form page (share this link)',
  copyHostedUrl: 'Copy hosted page URL',
  // ADR 0338 — email opt-in designation
  emailOptInLabel: 'Email opt-in field (explicit subscribe checkbox)',
  emailOptInNone: '— none —',
  loadOlderSubmissions: 'Load older submissions',

  // Collection kit (§4.5 rule 13) — status facet + submissions search
  filterStatusLabel: 'Filter by status',
  allStatuses: 'All statuses',
  clearFilters: 'Clear filters',
  subsFilterPlaceholder: 'Search submissions…',
  subsFilterAria: 'Search submissions',
  subsNoMatch: 'No submissions match.',
  subsMoreMayMatch: 'Only loaded submissions are searched — older submissions may match too.',

  // ── ADR 0584 ────────────────────────────────────────────────────────────────
  // FORM-UX-5 — status-mapped failure copy. The seven strings above
  // (`loadFormsFailed`, `createFailed`, `saveFailed`, …) were UNREACHABLE: both
  // pages used `e instanceof Error ? e.message : t(…)` over a client that only
  // ever threw `Error`, so 28 translations were dead and every failure a French
  // or pt-BR operator saw was raw English. `formsClient` throws a typed
  // `FormsRequestError` now and these are what it selects.
  failureForbidden: 'You don’t have access to do that in this workspace.',
  failureNotFound: 'That form is no longer here — it may have been deleted.',
  failureRejected: 'The server rejected the change. Check the highlighted fields and try again.',
  failureRateLimited: 'Too many requests just now. Wait a moment and try again.',
  failureServer: 'The server had a problem with that. Nothing was changed — try again.',
  failureOffline: 'We couldn’t reach the server. Check your connection and try again.',
  // FORM-UX-4 — the designed unavailable state. Deliberately the SAME sentence
  // for deleted / unpublished / feature-off, so it keeps the uniform-404
  // posture: it must not reveal that a draft exists.
  fillUnavailable: 'This form isn’t available right now. If you followed a link, it may have been removed or unpublished.',
  // FORM-UX-1 — the operator-visible abuse ratio. Phrased so it reads correctly
  // at 0, 1 and many without needing plural agreement on either count.
  subsAbuseNotice: 'Abuse controls acted on this form: {{flagged}} held for review, {{dropped}} refused at the quarantine limit. Held submissions are listed below and were not sent to any destination.',
  submissionHeld: 'Held',
  submissionHeldHoneypot: 'Held — hidden-field trap',
  submissionHeldGuard: 'Held — spam check',
  // ADR 0584 §Correction — the held-row operator controls (FORM-CSV-1 /
  // FORM-UX-1b / FORM-BUDGET-1). `csvHeld` is a COLUMN header, empty on a clean
  // row; the include-held opt-in is off by default because the export is the
  // bulk-import path.
  csvHeld: 'Held',
  csvIncludeHeld: 'Include held submissions',
  subsFilterHeld: 'Held ({{count}})',
  discardHeld: 'Discard',
  discardHeldConfirm: 'Discard this held submission?',
  discardHeldBody: 'It is deleted permanently, and the form gets that much of its quarantine capacity back. Real leads are not affected.',
  discardHeldDone: 'Held submission discarded.',
  discardHeldFailed: 'Couldn’t discard that submission — try again.',
} as const;
