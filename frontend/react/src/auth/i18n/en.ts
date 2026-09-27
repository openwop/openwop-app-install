/**
 * `auth` namespace — user-facing strings for the auth area (`src/auth/`).
 * FLAT camelCase keys, one per line (ADR 0065). Email/password + OIDC sign-in,
 * account linking, and account deletion copy. `auth/firebase.ts` surfaces these
 * via `i18n.t('auth:…')`; its internal "not configured" diagnostic throws stay
 * in code (developer-facing).
 */
export const messages = {
  // AuthCard — providers + structure
  signInWithSso: 'Sign in with SSO',
  or: 'or',

  // AuthCard — validation / notices
  passwordsDoNotMatch: 'Passwords do not match.',
  verificationEmailSent: 'Verification email sent — check your inbox.',
  resetLinkOnItsWay: 'If that email has an account, a password-reset link is on its way.',

  // AuthCard — verify view
  checkYourInbox: 'Check your inbox',
  verifyBody: 'We sent a verification link to <0>{{email}}</0>. You\'re already signed in — verify whenever you like.',
  resendVerificationEmail: 'Resend verification email',

  // AuthCard — fields
  emailLabel: 'Email',
  emailPlaceholder: 'you@company.com',
  nameLabel: 'Name',
  namePlaceholder: 'Ada Lovelace',
  nameHelp: 'Optional — shown on your account.',
  passwordLabel: 'Password',
  passwordHelp: 'At least 6 characters.',
  confirmPasswordLabel: 'Confirm password',

  // AuthCard — submit labels
  signIn: 'Sign in',
  createAccount: 'Create account',
  sendResetLink: 'Send reset link',
  continue: 'Continue',

  // AuthCard — view switch
  forgotPassword: 'Forgot password?',
  newHere: ' · New here? ',
  createAnAccount: 'Create an account',
  alreadyHaveAccount: 'Already have an account? Sign in',
  backToSignIn: 'Back to sign in',

  // SignInButton — sign-in error copy
  signInCancelled: 'Sign-in was cancelled.',
  popupBlocked: 'Your browser blocked the sign-in popup. Allow popups for {{domain}} and try again.',
  providerNotEnabled: 'This provider isn\'t enabled for the deployment. The maintainer needs to turn it on in the Firebase Console.',
  networkErrorIdp: 'Network error reaching the identity provider. Check your connection and try again.',
  signInFailed: 'Sign-in failed: {{code}}.',

  // SignInButton — provider names
  providerGoogle: 'Google',
  providerGithub: 'GitHub',
  providerMicrosoft: 'Microsoft',
  providerPassword: 'email + password',

  // SignInButton — account linking
  linkYourAccount: 'Link your {{provider}} account',
  alreadySignedUpKnown: '<0>{{email}}</0> is already signed up with {{providers}}. Sign in with that provider once and we\'ll attach {{attempted}} so you can use either next time.',
  alreadySignedUpUnknown: '<0>{{email}}</0> is already signed up. Sign in with that provider once and we\'ll attach {{attempted}} so you can use either next time.',
  continueWith: 'Continue with {{provider}}',
  cancel: 'Cancel',

  // SignInButton — sign-in modal
  continueWithGoogle: 'Continue with Google',
  continueWithGithub: 'Continue with GitHub',
  continueWithMicrosoft: 'Continue with Microsoft',
  signInToSaveTitle: 'Sign in to <0>save your work</0>',
  signInToSaveLede: 'Workflows + BYOK keys you add after signing in persist across sessions. Anonymous session state is wiped every 24h.',
  signInIdentityTitle: 'Sign in to <0>your workspace</0>',
  signInIdentityLede: 'Use your account to access your workflows, agents, and keys.',

  // SignInButton — account fallback name
  accountFallbackName: 'Account',

  // SignInButton — account menu
  myProfile: 'My Profile',
  team: 'Team',
  signOut: 'Sign Out',
  deleteAccount: 'Delete Account',

  // SignInButton — delete confirmation
  confirmAccountDeletion: 'Confirm account deletion',
  deleteAccountTitle: 'Delete your account?',
  deleteAccountBody: 'This permanently removes every workflow, run, event, interrupt, and BYOK credential you\'ve stored under <0>{{email}}</0>. Your Firebase identity record is revoked too. There is no undo.',
  deleting: 'Deleting…',
  deleteEverything: 'Yes, delete everything',

  // deleteAccount.ts — error
  requiresRecentLogin: 'Firebase requires a recent sign-in to delete the account. Please sign out and back in.',

  // describeAuthError (firebase.ts)
  errEmailInUse: 'An account with that email already exists. Try signing in.',
  errInvalidEmail: 'That email address looks invalid.',
  errWeakPassword: 'Password is too weak — use at least 6 characters.',
  errMissingPassword: 'Enter a password.',
  errInvalidCredential: 'Invalid email or password.',
  errTooManyRequests: 'Too many attempts — try again in a few minutes.',
  errOperationNotAllowed: 'Email/password sign-in isn\'t enabled for this deployment. The maintainer needs to turn it on in the Firebase Console.',
  errNetworkRequestFailed: 'Network error — check your connection and retry.',
  errGeneric: 'Something went wrong.',

  // TOTP multi-factor (ADR 0389 P1 — firebase.ts)
  errInvalidMfaCode: 'That code didn\'t match — check your authenticator app and try again.',
  errRequiresRecentLogin: 'This change needs a recent sign-in. Sign out and back in, then retry.',
  mfaCodeRequired: 'Enter the 6-digit code from your authenticator app to finish signing in.',
  mfaCodeLabel: 'Authenticator code',
  mfaFactorLabel: 'Authenticator device',
  mfaFactorUnnamed: 'Authenticator {{index}}',
  mfaNoPendingEnrollment: 'No enrollment in progress — start again from the Security page.',
  mfaNoPendingChallenge: 'No sign-in awaiting a code — sign in again.',
  mfaNoTotpFactor: 'This account has no authenticator-app factor enrolled.',
  errNotSignedIn: 'Not signed in.',

  // ExistingProviderSignInError message (firebase.ts)
  existingProviderKnown: '{{email}} is already signed up with {{providers}}. Sign in with {{providers}} to link your {{attempted}} account.',
  existingProviderUnknown: '{{email}} is already signed up with another provider. Sign in with that provider to link your {{attempted}} account.',
  signingInRedirect: 'Signing in… you may be redirected to your provider.',

  // ADR 0621 D5 — the sign-in modal's reason after a mid-session hard sign-out
  // (`sessionRefused_${code}`; the fourth is the self-service "everywhere").
  sessionRefused_account_disabled: 'Your account has been disabled by an administrator, so you were signed out. Contact your workspace admin to restore access.',
  sessionRefused_account_erased: 'Your account has been removed, so you were signed out. It can no longer be used to sign in.',
  sessionRefused_session_revoked: 'You were signed out on every device. Sign in again to continue.',
  sessionRefused_self_revoked: 'You signed out of every device, including this one. Sign in again to continue.',
} as const;
