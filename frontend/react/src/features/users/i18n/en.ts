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
} as const;
