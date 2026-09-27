/**
 * `users` namespace — user-facing copy for the users feature (incl. SSO panel).
 * Feature-self-contained: every users string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Access & data',
  title: 'Users & Authentication',
  lede: 'Durable accounts behind the authenticated principal — the identity foundation.',

  // Signed-in notice
  signedInAs: 'Signed in as <0>{{name}}</0> (source: {{source}}; status: {{status}}).',
  meFailed: 'Could not load your own user record. The list and SSO settings below are unaffected.',

  // Form field labels
  fieldPrincipalId: 'Principal id',
  fieldDisplayName: 'Display name',

  // Placeholders
  principalIdPlaceholder: 'oidc:sub-123',
  displayNamePlaceholder: 'Jane Doe',

  // Buttons
  addUser: 'Add user',
  disable: 'Disable',
  enable: 'Enable',

  // aria-labels
  deleteRowLabel: 'Delete {{name}}',
  disableRowLabel: 'Disable {{name}}',
  enableRowLabel: 'Enable {{name}}',

  // Table caption + column headers
  captionUsers: 'Users',
  colPrincipal: 'Principal',
  colEmail: 'Email',
  colSource: 'Source',
  colGroups: 'Groups',
  colStatus: 'Status',

  // Empty state
  noUsers: 'No users yet — add one above, or sign in to create your record.',

  // Toasts
  userAdded: 'User added.',
  addFailed: 'Add failed.',
  updateFailed: 'Update failed.',
  deleteFailed: 'Delete failed.',
  loadUsersFailed: 'Failed to load users.',

  // ── SSO panel ──────────────────────────────────────────────────────────────
  ssoTitle: 'Enterprise SSO & provisioning',
  ssoLede:
    'SAML 2.0 single sign-on and SCIM 2.0 provisioning. Host seams for white-label / B2B deployments — advertised only when configured + honored.',
  ssoReadingCaps: 'Reading host capabilities…',
  ssoCapsFailed: 'Could not read this host’s advertised capabilities, so we can’t say whether SAML or SCIM is enabled. This is not confirmation that they are off.',

  // SSO row state chips
  ssoAdvertised: 'Advertised',
  ssoNotConfigured: 'Not configured',
  ssoActive: 'Active',

  // SSO rows
  ssoOidcName: 'OIDC (Google / GitHub)',
  ssoOidcDetail: "Firebase-brokered bearer — the host's primary sign-in.",
  ssoPasswordName: 'Email & password',
  ssoPasswordDetail: 'Local accounts with TOTP MFA (this app, when the Users feature is on).',
  ssoSamlName: 'SAML 2.0 SSO',
  ssoSamlDetail: 'The host validates IdP assertions at its ACS (Okta / Azure AD / Ping…).',
  ssoScimName: 'SCIM 2.0 provisioning',
  ssoScimDetail: 'The IdP create/deactivates users + assigns groups via SCIM.',

  // SSO endpoints
  ssoEndpointsLabel: 'Enterprise integration endpoints (point your IdP here)',
  ssoSamlAcs: 'SAML ACS',
  ssoScimProvisioning: 'SCIM provisioning',

  // SSO not-enabled alert (rich markup via <Trans>)
  ssoNotEnabled:
    'Not enabled on this deployment. A white-label host turns these on by configuring an IdP certificate / SCIM bearer; the host then advertises the <0> openwop-auth-saml</0> / <1>openwop-auth-scim</1> profiles above.',
  deleteUserConfirm: 'Delete user "{{name}}"?',

  // Collection kit (§4.5 rules 11+13) — filterbar, facets, grid view, zero-match
  filterGroup: 'Filter users',
  filterPlaceholder: 'Search users…',
  filterAria: 'Search users by name or email',
  filterStatusLabel: 'Filter by status',
  filterSourceLabel: 'Filter by source',
  allStatuses: 'All statuses',
  allSources: 'All sources',
  status_active: 'Active',
  status_disabled: 'Disabled',
  source_oidc: 'OIDC',
  source_password: 'Password',
  source_saml: 'SAML',
  source_scim: 'SCIM',
  source_manual: 'Manual',
  viewTable: 'Table',
  noMatchTitle: 'No matching users',
  noMatchBody: 'No users match the current filters.',
  clearFilters: 'Clear filters',

  // ── ADR 0621 D5/D7 — lifecycle consequences, self-lockout, sign-out-everywhere ──
  ownRowHint: 'Your own account — ask another admin to change it.',
  signOutEverywhere: 'Sign out everywhere',
  revokeRowLabel: 'Sign {{name}} out everywhere',
  revokeUserConfirm: 'Sign "{{name}}" out everywhere?',
  revokeUserBody: 'This ends every active session of this user on every device immediately. The account stays active and they can sign in again.',
  userSessionsRevoked: '{{name}} was signed out everywhere.',
  revokeFailed: 'Could not sign the user out.',
  disableUserConfirm: 'Disable "{{name}}"?',
  disableUserBody: 'Disabling ends every active session of this user immediately and blocks new sign-ins until the account is re-enabled.',
  userDisabled: '{{name}} was disabled and signed out everywhere.',
  userEnabled: '{{name}} was enabled.',
  userDeleted: '{{name}} was deleted.',
  deleteUserBody: 'This permanently erases the account of {{name}} and every record stored under it — profile, memories, workflows, runs, and stored credentials. There is no undo.',
  selfLockoutRefused: 'You can\'t disable, sign out, or delete your own account from here — ask another admin.',
  legalHoldRefused: 'This workspace is under legal hold, so user data cannot be erased. Lift the hold, then retry.',
  addRequired: 'Enter a principal id.',
  addInvalidPrincipal: 'A principal id is a single token without spaces, e.g. oidc:sub-123.',
  addDuplicate: 'A user with this principal id already exists.',
  principalIdHelp: 'The identity-provider subject this user signs in with.',
} as const;
