/**
 * `consent` namespace — user-facing copy for the Consent feature (ADR 0020).
 * Feature-self-contained: every consent string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  orgsEmptyClause: 'The consent policy belongs to an organization',
  orgsFailedClause: 'The consent policy was never requested',
  // Page chrome
  eyebrow: 'Workspace',
  title: 'Consent',
  lede: 'Region-aware consent policy + data-subject (GDPR) tools.',

  // Gating / empty states
  notEnabledTitle: 'Consent is not enabled',
  // CONS-UX-31 — say what the toggle does NOT change: suppression and erasure
  // are enforced regardless; marketing consent is enforced only while it is on.
  notEnabledBody: 'While consent is off, marketing consent is not enforced — only suppression and erasure are. Ask an administrator to enable the Consent feature for this tenant.',

  // aria-labels
  orgPickerLabel: 'Organization',

  // Policy form
  regulatedRegionsLabel: 'Regulated regions (comma-separated)',
  regulatedRegionsNotEnforced: 'Informational only — no enforcement path reads this list. Enforcement comes from the default mode and each subject’s recorded consent.',
  channel_email: 'Email',
  channel_sms: 'SMS',
  channel_push: 'Push',
  channel_whatsapp: 'WhatsApp',
  sourceLine: 'Captured via {{source}}',
  legalBasisLine: 'Basis: {{basis}}',
  purposesLine: 'Purposes: {{purposes}}',
  receiptFailedFeatures: 'Failed systems: {{features}}.',
  regulatedRegionsPlaceholder: 'EU, CA',
  defaultModeLabel: 'Default mode',
  defaultModeOptInLabel: 'opt-in (fail-closed)',
  defaultModeOptOutLabel: 'opt-out',
  savePolicy: 'Save policy',

  // Data subject (GDPR)
  dataSubjectTitle: 'Data subject (GDPR)',
  subjectKeyLabel: 'Subject key',
  subjectKeyPlaceholder: 'visitor cookie / user id',
  lookup: 'Look up',
  erase: 'Erase',
  eraseConfirm: 'Erase all data for subject "{{subjectKey}}"? GDPR data-subject delete — cannot be undone.',
  lookupNoRecord: 'No consent record for that subject — downstream data (if any) is still erased.',

  // CONS-4 / CONS-UX-2 — LEGAL HOLD. A hold overrides erasure (GDPR Art. 17(3)(b)/(e)),
  // and the operator had no way to know one was in force until the request failed.
  legalHoldTitle: 'This workspace is under legal hold',
  legalHoldBody: 'Erasure is blocked while the hold is in force \u2014 a legal claim or retention obligation overrides the right to erasure. Reason: {{reason}}. In force since {{since}}. A workspace superadmin must lift the hold before any data-subject deletion can run.',
  legalHoldEraseDisabled: 'Erasure is blocked by a legal hold on this workspace.',
  eraseFailedHeld: 'Erasure refused \u2014 this workspace is under legal hold.',
  // CONS-UX-1 / CONS-UX-3 — the retry the receipt prescribes now has a control,
  // and the lookup result names the subject it describes + has an honest failure.
  retryErasure: 'Retry erasure',
  lookupResultFor: 'Consent for \u201c{{subjectKey}}\u201d',
  lookupFailedTitle: 'Could not read this subject\u2019s consent',
  lookupFailedBody: 'The read for \u201c{{subjectKey}}\u201d failed, so nothing is known about them yet. That is not the same as having no consent record \u2014 retry before concluding anything.',
  // Category chips
  categoryAnalytics: 'analytics',
  categoryMarketing: 'marketing',
  categoryNecessaryOnly: 'necessary only',

  // Consent records
  recordsTitle: 'Consent records',
  noRecords: 'No consent records yet.',

  // Toasts — success
  policySaved: 'Policy saved',
  // CONS-UX-23 (ADR 0657 D7) — erasure also TOMBSTONES the subject: every
  // marketing send and every public re-subscription is blocked until an
  // administrator re-admits them. Said at the moment of decision and on the receipt.
  eraseConfirmBody: 'Across all of this subject\u2019s linked identity keys, every registered feature store is reached. Not everything is destroyed: their own data is DELETED; rows the workspace still needs (access memberships, document versions, scheduled jobs) are ANONYMIZED in place \u2014 the row survives with the subject\u2019s identifiers and authored text overwritten; and records the law requires be kept, such as orders and invoices, are RETAINED with the personal parts redacted (the totals, ids and coarse region stay). Erasure also permanently blocks marketing sends and every public re-subscription for this subject until an administrator re-admits them. It cannot be undone.',
  receiptOk: 'Erasure completed for "{{subjectKey}}" across {{keys}} linked identity key(s); all {{total}} feature store(s) reported success \u2014 data deleted or anonymized in place, with legally-retained records (orders, invoices) kept in redacted form. Marketing sends and every public re-subscription for this subject are now permanently blocked until an administrator re-admits them.',
  receiptPartial: 'Partial erasure of "{{subjectKey}}": {{failed}} erasure step(s) failed (across {{total}} feature stores + identity-link resolution) — this subject\u2019s data MAY still be held.',
  receiptFoundNothing: 'The erasure for "{{subjectKey}}" ran without errors but found NOTHING to erase in this workspace ({{keys}} linked identity key(s) checked across {{total}} feature stores). Erasure only reaches this workspace’s data — if this person exists elsewhere, their personal data may live in their home workspace; run the erasure there too. Marketing sends and every public re-subscription for this subject are now permanently blocked here until an administrator re-admits them.',
  receiptHadRecord: 'A consent record was present and removed.',
  receiptNoRecord: 'No consent record was present.',
  receiptRetry: 'Erasure is idempotent — run it again; if it keeps failing, escalate before reporting the request complete.',
  // CONS-UX-27 — erasers the host expected but that never registered here: a
  // third class, on its own line, never inside the failed-systems sentence.
  receiptMissing: 'Expected but not registered on this host: {{features}}.',
  // CONS-UX-28
  receiptRowsTouched: '{{count}} row(s) deleted or scrubbed.',
  // CONS-UX-33 — a legal-hold refusal is a DURABLE state on the page, not a toast.
  eraseRefusedHeldTitle: 'Erasure refused — legal hold',
  eraseRefusedHeldBody: 'The erasure of "{{subjectKey}}" was refused: this workspace is under legal hold. Nothing was deleted. A workspace superadmin must lift the hold before this request can run.',

  // ADR 0657 D7 — re-admit (CONS-UX-24 / CONS-UX-26). Clears the erasure
  // tombstone ONLY; grants no consent.
  readmitButton: 'Re-admit subject',
  readmitHintAfterErasure: 'If this person later asks to return, an administrator can re-admit them. That lifts the block only — no consent is granted until they opt in again.',
  readmitHintNoRecord: 'If this person was erased and has asked to return, an administrator can re-admit them. That lifts the block only — no consent is granted until they opt in again.',
  readmitDialogTitle: 'Re-admit “{{subjectKey}}”?',
  readmitDialogBody: 'This lifts the erasure block on marketing sends and public re-subscription for this subject. It grants nothing by itself — no consent is recorded; their next affirmative opt-in is what re-grants it. Your statement below is your attestation that the person asked to return, and it is written to the audit log.',
  readmitAttestationLabel: 'Your statement that this person asked to return',
  readmitAttestationPlaceholder: 'e.g. Asked by email on 11 Sep to receive our newsletter again; ticket 4821.',
  readmitAttestationHint: '{{count}} of at least {{min}} characters',
  readmitConfirm: 'Re-admit',
  readmitDone: 'Re-admitted “{{subjectKey}}”. No consent was granted — their next affirmative opt-in re-grants it.',
  readmitNotErased: '“{{subjectKey}}” is not erased on this host — there was no block to lift.',
  readmitFailed: 'Re-admit failed.',
  readmitForbidden: 'Only a workspace administrator can re-admit a subject.',
  readmitAttestationTooShort: 'The statement must be at least {{min}} characters.',

  // Toasts / errors
  loadPolicyFailed: 'Failed to load policy.',
  policyLoadRetry: 'Retry',
  policyLoadFailedTitle: 'Could not load the consent policy',
  saveFailed: 'Save failed.',
  lookupFailed: 'Lookup failed.',
  eraseFailed: 'Erase failed.',
  // §4.5 collection kit — records filtering + designed empty/zero-match states
  recordsFilterGroup: 'Filter',
  recordsSearchPlaceholder: 'Search by subject…',
  recordsSearchAria: 'Search consent records by subject',
  categoryFacetAria: 'Filter by category',
  categoryAll: 'All categories',
  regionFacetAria: 'Filter by region',
  regionAll: 'All regions',
  noRecordsTitle: 'No consent records yet',
  recordsLoadFailedTitle: 'Couldn’t load consent records',
  recordsLoadFailedBody: 'The records read failed — this list is NOT empty until a successful read says so.',
  unsavedChanges: 'Unsaved changes',
  nothingToSave: 'No changes to save',
  discardEditsTitle: 'Discard unsaved policy changes?',
  discardEditsBody: 'Switching workspaces will discard your unsaved consent-policy edits.',
  discardEditsConfirm: 'Discard and switch',
  recordsNoMatchTitle: 'No matches',
  recordsNoMatchBody: 'No consent records match the current filters.',
  recordsClearFilters: 'Clear filters',
} as const;
