/**
 * `connections` namespace — user-facing copy for the Connections feature
 * (ADR 0024 / 0025 / 0028). Feature-self-contained: every connections string
 * lives here. Generic actions/states are reused from the `common` namespace via
 * `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Access & data',
  title: 'Connections',
  lede: 'Connect the apps your assistant works across — Google, Slack, ServiceNow, Zoom.',

  // Manager — generic load/connect errors & toasts
  loadFailed: 'Failed to load.',
  connectFailed: 'Connect failed.',
  revokeFailed: 'Revoke failed.',
  testFailed: 'Test failed.',
  connected: '{{label}} connected.',
  connectedForOrg: '{{label}} connected for the organization.',
  couldNotStart: 'Could not start {{label}}.',
  connectionHealthy: '{{name}} is healthy.',
  connectionNeedsReconnect: '{{name}} needs to reconnect.',

  // OAuth consent card
  connectWithConsent: 'Connect with consent',
  consentBlurb:
    "You'll be sent to the provider to approve read access, then returned here. Your tokens are stored encrypted and are never shown back to you.",
  connectProvider: 'Connect {{label}}',
  connectingProvider: 'Connecting {{label}}…',
  notConfiguredHint:
    "Greyed-out providers aren't configured for OAuth on this host yet — the operator must add the client credentials.",
  oauthNotConfiguredTitle: '{{label}} OAuth is not configured on this host',

  // Secret connect form
  providerLabel: 'Provider (API key / token)',
  loadingProviders: 'Loading providers…',
  secretLabel: 'API key / token',
  secretPlaceholder: 'paste your token',
  sharedWith: 'Shared with',
  shareJustMe: 'Just me',
  shareOrganization: 'Organization',
  connect: 'Connect',

  // Connections table
  tableCaption: 'Your connections',
  colConnection: 'Connection',
  colProvider: 'Provider',
  colSharing: 'Sharing',
  colStatus: 'Status',
  sharingOrganization: 'Organization',
  sharingPersonal: 'Personal',
  sharingWrite: 'write',
  grantWriteAccess: 'Grant write access',
  grantWriteAccessLabel: 'Grant write access for {{name}}',
  grantWriteAccessConnect: '{{label}} write access',
  connectProviderConnect: '{{label}} connect',
  testConnectionLabel: 'Test {{name}}',
  test: 'Test',
  revokeConnectionLabel: 'Revoke {{name}}',
  revoke: 'Revoke',
  noConnectionsTitle: 'No connections yet',
  noConnectionsBody: 'Connect an app above to let your assistant read from it.',

  // OAuth callback toast
  callbackConnected: '{{provider}} connected.',
  callbackConsentDenied: 'Consent was declined.',
  callbackInvalidState: 'The consent session expired — please try again.',
  callbackMissingParams: 'The provider response was incomplete — please try again.',
  callbackExchangeFailed: 'Could not complete the token exchange. Please try again.',
  callbackGenericError: 'Could not connect {{provider}}.',

  // Governance panel
  governanceTitle: 'Governance',
  governanceBlurb:
    'Workspace policy: which providers may connect, and what each assistant action kind may do. Enforced at the connect, resolve, and dispatch seams.',
  governanceSaved: 'Governance policy saved.',
  saveFailed: 'Save failed.',
  providerAllowlist: 'Provider allowlist',
  restrictProviders: 'Restrict connectable providers',
  actionPolicy: 'Action policy',
  policyApprovalRequired: 'Approval required (execute on approve)',
  policyDraftOnly: 'Draft only (never executes)',
  policyDisabled: 'Disabled (no drafts)',
  savePolicy: 'Save policy',
  // ADR 0106 — media-generation cost budgets (read-only)
  mediaBudgetTitle: 'Media generation budgets',
  mediaBudgetBlurb:
    'Per-org daily ceilings for paid media generation (transcription and text-to-speech), set by the operator via environment configuration. Usage resets at 00:00 UTC.',
  mediaBudgetTts: 'Text-to-speech',
  mediaBudgetStt: 'Transcription',
  mediaBudgetUsage: '{{used}} / {{cap}} {{unit}} used today',
  mediaBudgetUncapped: '{{used}} {{unit}} used today · no cap',
  mediaUnitChars: 'characters',
  mediaUnitBytes: 'bytes',
  // ADR 0106 editable override
  mediaBudgetBlurbEditable:
    'Per-org daily ceilings for paid media generation. Leave a field blank to use the host default; enter 0 to remove the cap for this organization. Usage resets at 00:00 UTC.',
  mediaBudgetTtsOverride: 'Text-to-speech budget (characters/day)',
  mediaBudgetSttOverride: 'Transcription budget (bytes/day)',
  mediaBudgetEnvPlaceholder: 'Host default: {{value}}',
  mediaBudgetNoDefault: 'no cap',
  mediaBudgetSave: 'Save media budgets',
  mediaBudgetSaved: 'Media budgets updated.',
  mediaBudgetInvalid: 'Budgets must be blank or a non-negative whole number.',

  // OAuth client admin panel
  oauthClientSetup: 'OAuth client setup (operator)',
  oauthClientBlurb:
    "Configure each provider's OAuth app so its Connect button works — no env vars, no redeploy. Register the redirect URI shown below with the provider, then paste its Client ID and Secret here. The secret is sealed server-side and never shown again.",
  loadOAuthClientFailed: 'Failed to load OAuth client config.',
  oauthClientSaved: 'OAuth client saved — {{provider}} can now run consent.',
  oauthClientRemoved: 'OAuth client removed for {{provider}}.',
  removeFailed: 'Remove failed.',
  configured: 'Configured',
  notConfigured: 'Not configured',
  redirectUriLabel: 'Redirect URI to register with {{label}}',
  clientIdLabel: 'Client ID',
  clientIdLabelCurrent: 'Client ID (current: {{clientId}})',
  clientIdPlaceholder: 'paste the OAuth client id',
  clientIdPlaceholderReplace: 'replace the client id',
  clientSecretLabel: 'Client secret',
  clientSecretPlaceholder: 'paste the OAuth client secret',
  replace: 'Replace',
  removeOAuthClientLabel: 'Remove OAuth client for {{label}}',
} as const;
