/**
 * Firebase Auth bootstrap for app.openwop.dev.
 *
 * Initializes the Firebase JS SDK once per page load and exposes a
 * minimal API:
 *   - signInWithGoogle / signInWithGithub — popup-based OAuth flows
 *   - signOut                              — drops the local session
 *   - getCurrentUser                       — sync access to the cached user
 *   - getCurrentIdToken                    — fresh ID token (auto-refreshes)
 *   - onAuthChanged                        — subscribe to user changes
 *
 * Config is read from Vite env at build time
 * (VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_PROJECT_ID).
 * Anonymous demo deploys leave these unset; the auth module
 * gracefully no-ops (signIn surfaces a friendly error, hook reports
 * no user). The cookie-mode anon flow is the fallback when Firebase
 * isn't configured.
 *
 * Token caching: Firebase Auth caches ID tokens for ~1h and auto-
 * refreshes on `getIdToken(true)`. We rely on the SDK's own cache
 * rather than reimplementing one. Background refresh fires from
 * `onIdTokenChanged` — the `client/config.ts` helpers re-read the
 * cached token on every authedHeaders() call.
 */

// Firebase is loaded LAZILY (GAP-ANALYSIS E13): the SDK is ~120KB+ and only the
// auth path needs it, so we keep it out of the initial bundle via dynamic
// import() and pull it in on first auth use (sign-in, or the boot-time
// onAuthChanged subscription). Types are `import type` only — erased at build,
// so they add no runtime firebase reference to the entry chunk.
import type { FirebaseApp } from 'firebase/app';
import type { AuthCredential, User, Auth, TotpSecret, MultiFactorResolver } from 'firebase/auth';
import { setCurrentIdToken, registerIdTokenRefresher } from '../client/config.js';
import i18n from '../i18n/index.js';

/** The lazily-imported `firebase/auth` module namespace. */
type AuthMod = typeof import('firebase/auth');

// ─── redirect-flow state persistence ────────────────────────────
// We use the redirect-based sign-in flow (not popup) to dodge the
// `Cross-Origin-Opener-Policy would block window.closed` console
// warnings that Firebase's popup-poller triggers. Cost: the flow now
// spans multiple page loads, so state has to live in sessionStorage.
//
// Two keys:
//   - openwop.auth.attempted   set BEFORE signInWithRedirect so the
//                              redirect-back handler knows which
//                              provider to ask `credentialFromError`
//                              for on the cross-provider collision
//   - openwop.auth.pendingLink set when we capture a rejected
//                              credential, consumed when the user
//                              comes back from signing in with the
//                              existing provider (so we can link the
//                              rejected credential to the same user)

const ATTEMPTED_PROVIDER_KEY = 'openwop.auth.attempted';
const PENDING_LINK_KEY = 'openwop.auth.pendingLink';

type ProviderId = 'google.com' | 'github.com' | 'microsoft.com';

function setAttemptedProvider(id: ProviderId): void {
  try { sessionStorage.setItem(ATTEMPTED_PROVIDER_KEY, id); } catch { /* private mode */ }
}
function consumeAttemptedProvider(): ProviderId | null {
  try {
    const v = sessionStorage.getItem(ATTEMPTED_PROVIDER_KEY);
    sessionStorage.removeItem(ATTEMPTED_PROVIDER_KEY);
    return v === 'google.com' || v === 'github.com' || v === 'microsoft.com' ? v : null;
  } catch { return null; }
}

interface SerializedLink {
  cred: ReturnType<AuthCredential['toJSON']>;
  attemptedProvider: ProviderId;
}

function stashPendingLink(cred: AuthCredential, attemptedProvider: ProviderId): void {
  try {
    sessionStorage.setItem(PENDING_LINK_KEY, JSON.stringify({
      cred: cred.toJSON(),
      attemptedProvider,
    } satisfies SerializedLink));
  } catch { /* private mode */ }
}
function consumePendingLink(am: AuthMod): { cred: AuthCredential; attemptedProvider: ProviderId } | null {
  try {
    const raw = sessionStorage.getItem(PENDING_LINK_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_LINK_KEY);
    const parsed = JSON.parse(raw) as SerializedLink;
    // OAuthProvider.credentialFromJSON resurrects either Google or
    // GitHub OAuth credentials (both extend OAuthProvider).
    const cred = am.OAuthProvider.credentialFromJSON(parsed.cred);
    return { cred, attemptedProvider: parsed.attemptedProvider };
  } catch { return null; }
}

/** Test affordance / sign-out cleanup. */
function clearPendingLinkState(): void {
  try {
    sessionStorage.removeItem(ATTEMPTED_PROVIDER_KEY);
    sessionStorage.removeItem(PENDING_LINK_KEY);
  } catch { /* ignore */ }
}

/**
 * Raised when sign-in fails because the email is already registered
 * via a different provider. Carries the email, the providers the
 * email IS registered with, AND the pending credential from the
 * attempted-but-rejected provider — together they let the caller
 * run the link-account flow:
 *
 *   1. UI prompts user to sign in with `existingProviders[0]`.
 *   2. After that succeeds, `linkPendingCredential(pendingCredential)`
 *      attaches the rejected credential to the now-signed-in user
 *      so subsequent visits work with EITHER provider.
 *
 * Matches the `auth/account-exists-with-different-credential` Firebase
 * error code. `pendingCredential` is null if the rejected provider was
 * one Firebase couldn't extract a credential from (e.g., password).
 */
export class ExistingProviderSignInError extends Error {
  constructor(
    public readonly email: string,
    public readonly existingProviders: readonly string[],
    public readonly pendingCredential: AuthCredential | null,
    public readonly attemptedProvider: ProviderId,
  ) {
    const friendly = existingProviders.map(friendlyProviderName).join(
      ` ${i18n.t('auth:or')} `,
    );
    const attempted = friendlyProviderName(attemptedProvider);
    super(
      friendly
        ? i18n.t('auth:existingProviderKnown', { email, providers: friendly, attempted })
        : i18n.t('auth:existingProviderUnknown', { email, attempted }),
    );
    this.name = 'ExistingProviderSignInError';
  }
}

function friendlyProviderName(providerId: string): string {
  switch (providerId) {
    case 'google.com':
    case 'googleAuthProvider': return i18n.t('auth:providerGoogle');
    case 'github.com':
    case 'githubAuthProvider': return i18n.t('auth:providerGithub');
    case 'microsoft.com': return i18n.t('auth:providerMicrosoft');
    case 'password': return i18n.t('auth:providerPassword');
    default: return providerId;
  }
}

interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
}

let auth: Auth | null = null;
let app: FirebaseApp | null = null;
let authMod: AuthMod | null = null;
let cachedUser: User | null = null;
/** Memoized init so concurrent first-callers share one SDK load + initializeApp. */
let initPromise: Promise<Auth | null> | null = null;

function readConfigFromEnv(): FirebaseConfig | null {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY as string | undefined;
  const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined;
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined;
  if (!apiKey || !authDomain || !projectId) return null;
  return { apiKey, authDomain, projectId };
}

/** Whether Firebase Auth is configured for this build. UI uses this
 *  to decide whether to render the SignInButton. */
export function isAuthConfigured(): boolean {
  return readConfigFromEnv() !== null;
}

/**
 * Lazily load the Firebase SDK + initialize Auth, exactly once. Returns null
 * (without loading anything) when Firebase isn't configured for this build.
 * Memoized via `initPromise` so the boot-time onAuthChanged subscription and a
 * concurrent sign-in click share a single dynamic import + initializeApp.
 */
async function ensureInitAsync(): Promise<Auth | null> {
  if (auth) return auth;
  const cfg = readConfigFromEnv();
  if (!cfg) return null;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const [appMod, am] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
    authMod = am;
    app = appMod.initializeApp(cfg);
    auth = am.getAuth(app);
    // Eagerly capture the cached user (page reload restores the prior session).
    cachedUser = auth.currentUser;
    // Keep the cache in sync + propagate the fresh ID token to the shared
    // client/config cache so authedHeaders() reads it synchronously on fetch.
    am.onIdTokenChanged(auth, async (u) => {
      cachedUser = u;
      if (u) {
        try {
          const token = await u.getIdToken();
          setCurrentIdToken(token);
        } catch {
          setCurrentIdToken(null);
        }
      } else {
        setCurrentIdToken(null);
      }
    });
    // The sync fetch path can SEE that the cached token expired but cannot await a
    // new one, so it calls this. The SDK's proactive refresh is a `setTimeout` and
    // is throttled in background tabs — without a demand-driven path, a backgrounded
    // session keeps posting a dead JWT until that timer finally fires. `true` forces
    // past the SDK's own cache; the result lands via `onIdTokenChanged` above (and
    // directly, in case the value is unchanged and no event fires).
    registerIdTokenRefresher(() => {
      const u = auth?.currentUser ?? cachedUser;
      if (!u) return;
      void u.getIdToken(true).then(
        (token) => setCurrentIdToken(token),
        () => { /* offline / revoked — the cooldown throttles the retry */ },
      );
    });
    return auth;
  })();
  return initPromise;
}

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  /** Federated provider ids on the account ('google.com', 'microsoft.com', …) —
   *  lets first-run surfaces seed vendor defaults from how the user signed in. */
  providerIds: readonly string[];
}

function project(u: User | null): AuthUser | null {
  if (!u) return null;
  return {
    uid: u.uid,
    email: u.email,
    displayName: u.displayName,
    photoURL: u.photoURL,
    providerIds: u.providerData.map((p) => p.providerId),
  };
}

/**
 * Kick off redirect-based sign-in with Google. Never returns — the
 * page navigates away to Firebase's auth handler and comes back on
 * a fresh page load. The redirect-back is observed by
 * `processRedirectResult()` at app boot.
 */
export async function signInWithGoogle(): Promise<void> {
  const a = await ensureInitAsync();
  if (!a || !authMod) throw new Error('Firebase Auth not configured');
  setAttemptedProvider('google.com');
  await authMod.signInWithRedirect(a, new authMod.GoogleAuthProvider());
}

/** Same as `signInWithGoogle`, for GitHub. */
export async function signInWithGithub(): Promise<void> {
  const a = await ensureInitAsync();
  if (!a || !authMod) throw new Error('Firebase Auth not configured');
  setAttemptedProvider('github.com');
  await authMod.signInWithRedirect(a, new authMod.GithubAuthProvider());
}

/** Same as `signInWithGoogle`, for Microsoft (Entra ID / personal accounts).
 *  Requires the operator to enable the Microsoft provider in the Firebase
 *  console (an Azure app registration) AND to build with
 *  `VITE_AUTH_MICROSOFT=true` — the button is gated on that flag so hosts
 *  without the Azure app never show a dead sign-in path. */
export async function signInWithMicrosoft(): Promise<void> {
  const a = await ensureInitAsync();
  if (!a || !authMod) throw new Error('Firebase Auth not configured');
  setAttemptedProvider('microsoft.com');
  await authMod.signInWithRedirect(a, new authMod.OAuthProvider('microsoft.com'));
}

/** Build-time opt-in for the Microsoft sign-in button (see above). */
export function microsoftSignInEnabled(): boolean {
  return Boolean(import.meta.env.VITE_AUTH_MICROSOFT);
}

// ─── Email/password (ADR 0026 — Firebase owns credentials, not the host) ──────
// These resolve IN-PAGE (no redirect), so `onIdTokenChanged` fires immediately
// and the caller (AuthCard) runs `finalizeFirebaseSession()` itself rather than
// relying on the boot-time `processRedirectResult()` path the OAuth flows use.

/** Create a Firebase email/password account; set the display name + send the
 *  verification email (Firebase handles the token + delivery). */
export async function signUpWithEmail(email: string, password: string, displayName?: string): Promise<void> {
  const a = await ensureInitAsync();
  if (!a || !authMod) throw new Error('Firebase Auth not configured');
  const cred = await authMod.createUserWithEmailAndPassword(a, email, password);
  if (displayName && cred.user) {
    try { await authMod.updateProfile(cred.user, { displayName }); } catch { /* non-fatal */ }
  }
  try { await authMod.sendEmailVerification(cred.user); } catch { /* non-fatal — user can resend */ }
}

/** Sign in with a Firebase email/password account. Throws `MfaRequiredError`
 *  when the account has an enrolled second factor (ADR 0389 P1) — the caller
 *  prompts for the authenticator code and calls `completeMfaSignIn(code)`. */
export async function signInWithEmail(email: string, password: string): Promise<void> {
  const a = await ensureInitAsync();
  if (!a || !authMod) throw new Error('Firebase Auth not configured');
  try {
    await authMod.signInWithEmailAndPassword(a, email, password);
  } catch (err) {
    if (stashMfaChallenge(a, err)) throw new MfaRequiredError();
    throw err;
  }
}

/** Send a Firebase password-reset email (Firebase mints + delivers the link). */
export async function sendPasswordReset(email: string): Promise<void> {
  const a = await ensureInitAsync();
  if (!a || !authMod) throw new Error('Firebase Auth not configured');
  await authMod.sendPasswordResetEmail(a, email);
}

/** (Re)send the email-verification link to the currently signed-in user. */
export async function sendVerifyEmail(): Promise<void> {
  const a = await ensureInitAsync();
  if (!a || !authMod || !a.currentUser) throw new Error('Not signed in.');
  await authMod.sendEmailVerification(a.currentUser);
}

/** Map a Firebase Auth error code to a friendly, non-enumerating message. */
export function describeAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  switch (code) {
    case 'auth/email-already-in-use': return i18n.t('auth:errEmailInUse');
    case 'auth/invalid-email': return i18n.t('auth:errInvalidEmail');
    case 'auth/weak-password': return i18n.t('auth:errWeakPassword');
    case 'auth/missing-password': return i18n.t('auth:errMissingPassword');
    // Don't distinguish unknown-email from wrong-password (no account enumeration).
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found': return i18n.t('auth:errInvalidCredential');
    case 'auth/too-many-requests': return i18n.t('auth:errTooManyRequests');
    case 'auth/operation-not-allowed': return i18n.t('auth:errOperationNotAllowed');
    // ADR 0389 P1 — TOTP enrollment / challenge
    case 'auth/invalid-verification-code': return i18n.t('auth:errInvalidMfaCode');
    case 'auth/requires-recent-login': return i18n.t('auth:errRequiresRecentLogin');
    case 'auth/network-request-failed': return i18n.t('auth:errNetworkRequestFailed');
    default: return err instanceof Error && err.message ? err.message : i18n.t('auth:errGeneric');
  }
}

/**
 * What the redirect-back handler decided about the just-completed
 * sign-in attempt. The SignInButton subscribes to this state.
 */
export type RedirectState =
  | { kind: 'none' }
  | { kind: 'success'; linked: boolean }
  | { kind: 'link-required'; error: ExistingProviderSignInError }
  | { kind: 'error'; error: Error };

/**
 * Memoized boot-time promise. Components await this once on mount;
 * subsequent calls reuse the same promise so the redirect result is
 * processed exactly once per page load.
 */
let redirectStatePromise: Promise<RedirectState> | null = null;
export function getRedirectState(): Promise<RedirectState> {
  if (redirectStatePromise === null) {
    redirectStatePromise = processRedirectResult();
  }
  return redirectStatePromise;
}

/**
 * Process the result of the most recent redirect-based sign-in.
 *
 * Outcomes:
 *   - none           the user landed here without a sign-in redirect
 *                    in flight (normal page load or hard refresh)
 *   - success        sign-in completed; the linked flag indicates
 *                    whether we also attached a previously-stashed
 *                    pending credential (the second half of the
 *                    link-account flow)
 *   - link-required  Firebase rejected this redirect with the
 *                    cross-provider collision; carries the typed
 *                    `ExistingProviderSignInError` for the UI to
 *                    render and the pending credential has already
 *                    been stashed for the next redirect-back
 *   - error          some other auth failure; surfaced verbatim
 *
 * Must be called exactly once per page load, before the UI binds to
 * auth state (otherwise the redirect-back result is silently
 * dropped). Safe to call when the app booted without a redirect in
 * flight — returns { kind: 'none' }.
 */
export async function processRedirectResult(): Promise<RedirectState> {
  const a = await ensureInitAsync();
  if (!a || !authMod) return { kind: 'none' };
  const am = authMod;
  const attemptedProvider = consumeAttemptedProvider();
  try {
    const result = await am.getRedirectResult(a);
    // If getRedirectResult returned null BUT we were expecting a
    // redirect AND auth.currentUser is set, Firebase already processed
    // the sign-in on a prior load — treat it as success so the migrate
    // hook still fires. This covers the "user opened DevTools mid-
    // redirect" / strict-mode-replay corner case.
    if (!result && attemptedProvider && a.currentUser) {
      return { kind: 'success', linked: false };
    }
    if (!result) return { kind: 'none' };
    // Successfully signed in via redirect. If there's a pending
    // credential stash from the previous (rejected) redirect, link
    // it now so subsequent visits work with either provider.
    const pending = consumePendingLink(am);
    let linked = false;
    if (pending) {
      try {
        await am.linkWithCredential(result.user, pending.cred);
        linked = true;
      } catch (err) {
        console.warn('openwop.auth: provider linking failed', err);
      }
    }
    return { kind: 'success', linked };
  } catch (err) {
    console.warn('openwop.auth: getRedirectResult threw', err);
    // ADR 0389 P1: an OAuth redirect back for an MFA-enrolled account raises
    // the second-factor challenge here. Stash the resolver; the sign-in UI
    // detects MfaRequiredError and prompts for the authenticator code.
    if (stashMfaChallenge(a, err)) {
      return { kind: 'error', error: new MfaRequiredError() };
    }
    type FbError = { code?: string; customData?: { email?: string } };
    const e = err as FbError;
    if (e.code === 'auth/account-exists-with-different-credential' && e.customData?.email && attemptedProvider) {
      const email = e.customData.email;
      const pendingCred =
        attemptedProvider === 'google.com'
          ? am.GoogleAuthProvider.credentialFromError(err as Parameters<typeof am.GoogleAuthProvider.credentialFromError>[0])
          : am.GithubAuthProvider.credentialFromError(err as Parameters<typeof am.GithubAuthProvider.credentialFromError>[0]);
      let providers: readonly string[] = [];
      try {
        providers = await am.fetchSignInMethodsForEmail(a, email);
      } catch { /* email-enum protection; fall through */ }
      if (pendingCred) stashPendingLink(pendingCred, attemptedProvider);
      const typed = new ExistingProviderSignInError(email, providers, pendingCred, attemptedProvider);
      return { kind: 'link-required', error: typed };
    }
    return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) };
  }
}

// ─── TOTP multi-factor (ADR 0389 P1 — Firebase-delegated; the host never sees
// factor material, it only reads the resulting `firebase.sign_in_second_factor`
// ID-token claim). Enrollment is a two-step client↔Firebase exchange; the
// un-finalized TotpSecret lives ONLY in this module-scoped variable (never
// sessionStorage — it's shared-secret material) and dies with the page.

let pendingTotpSecret: TotpSecret | null = null;
/** The in-flight MFA sign-in challenge (auth/multi-factor-auth-required).
 *  Stashed so the code-entry UI can finish the sign-in via
 *  `completeMfaSignIn()`. In-memory only — a page reload restarts sign-in. */
let pendingMfaResolver: MultiFactorResolver | null = null;

/** Raised when sign-in requires a second factor. The UI catches this, prompts
 *  for the 6-digit authenticator code, and calls `completeMfaSignIn(code)`. */
export class MfaRequiredError extends Error {
  constructor() {
    super(i18n.t('auth:mfaCodeRequired'));
    this.name = 'MfaRequiredError';
  }
}

/** One enrolled second factor, projected for the Security page. */
export interface MfaFactor {
  uid: string;
  displayName: string | null;
  enrolledAt: string | null;
}

/** Enrolled second factors of the signed-in user ([] when none / signed out). */
export async function listMfaFactors(): Promise<MfaFactor[]> {
  const a = await ensureInitAsync();
  if (!a || !authMod || !a.currentUser) return [];
  return authMod.multiFactor(a.currentUser).enrolledFactors.map((f) => ({
    uid: f.uid,
    displayName: f.displayName ?? null,
    enrolledAt: f.enrollmentTime ?? null,
  }));
}

/**
 * Step 1 of TOTP enrollment: mint a fresh shared secret with Firebase. Returns
 * the base32 key (manual entry) + the `otpauth://` URL (authenticator-app
 * deep link). The secret is held module-scoped until `completeTotpEnrollment`.
 * Throws Firebase `auth/operation-not-allowed` when the project hasn't been
 * upgraded to Identity Platform with TOTP enabled — surface it with the
 * operator hint, don't swallow it.
 */
export async function startTotpEnrollment(): Promise<{ secretKey: string; otpauthUrl: string }> {
  const a = await ensureInitAsync();
  if (!a || !authMod || !a.currentUser) throw new Error(i18n.t('auth:errNotSignedIn'));
  const session = await authMod.multiFactor(a.currentUser).getSession();
  const secret = await authMod.TotpMultiFactorGenerator.generateSecret(session);
  pendingTotpSecret = secret;
  const accountName = a.currentUser.email ?? a.currentUser.uid;
  return {
    secretKey: secret.secretKey,
    otpauthUrl: secret.generateQrCodeUrl(accountName, 'OpenWOP'),
  };
}

/** Step 2: verify the user's first authenticator code and finalize enrollment. */
export async function completeTotpEnrollment(code: string, displayName?: string): Promise<void> {
  const a = await ensureInitAsync();
  if (!a || !authMod || !a.currentUser) throw new Error(i18n.t('auth:errNotSignedIn'));
  if (!pendingTotpSecret) throw new Error(i18n.t('auth:mfaNoPendingEnrollment'));
  const assertion = authMod.TotpMultiFactorGenerator.assertionForEnrollment(pendingTotpSecret, code);
  await authMod.multiFactor(a.currentUser).enroll(assertion, displayName);
  pendingTotpSecret = null;
}

/** Abandon an in-flight enrollment (dialog closed) — drops the secret. */
export function cancelTotpEnrollment(): void {
  pendingTotpSecret = null;
}

/** Remove an enrolled factor. Firebase may demand a recent sign-in
 *  (`auth/requires-recent-login`) — surfaced to the caller. */
export async function unenrollMfaFactor(factorUid: string): Promise<void> {
  const a = await ensureInitAsync();
  if (!a || !authMod || !a.currentUser) throw new Error(i18n.t('auth:errNotSignedIn'));
  await authMod.multiFactor(a.currentUser).unenroll(factorUid);
}

/** Detect + stash the second-factor challenge from a failed sign-in. Returns
 *  true when the error was the MFA challenge (caller should then raise
 *  `MfaRequiredError` / show the code prompt). */
function stashMfaChallenge(a: Auth, err: unknown): boolean {
  const am = authMod;
  if (!am) return false;
  if ((err as { code?: string })?.code !== 'auth/multi-factor-auth-required') return false;
  pendingMfaResolver = am.getMultiFactorResolver(
    a,
    err as Parameters<AuthMod['getMultiFactorResolver']>[1],
  );
  return true;
}

/** One TOTP factor of the pending MFA challenge, projected for the picker UI. */
export interface PendingMfaHint {
  uid: string;
  displayName: string | null;
}

/** The pending challenge's enrolled TOTP factors ([] when no challenge). Lets
 *  the sign-in UI offer a device picker when more than one authenticator is
 *  enrolled (USERS-UX-1) — asserting only the FIRST hint locked out a user who
 *  lost that device but still holds the second. */
export function getPendingMfaHints(): PendingMfaHint[] {
  const am = authMod;
  if (!pendingMfaResolver || !am) return [];
  return pendingMfaResolver.hints
    .filter((h) => h.factorId === am.TotpMultiFactorGenerator.FACTOR_ID)
    .map((h) => ({ uid: h.uid, displayName: h.displayName ?? null }));
}

/**
 * Pure hint selection (exported for unit tests — the Firebase resolver itself
 * needs a live challenge). An explicit `factorUid` selects EXACTLY that hint —
 * `null` when absent, never silently a different device; without one, the
 * single/first hint is the default (the pre-picker behavior).
 */
export function selectTotpHint<H extends { uid: string }>(
  hints: readonly H[],
  factorUid?: string,
): H | null {
  if (factorUid !== undefined) return hints.find((h) => h.uid === factorUid) ?? null;
  return hints[0] ?? null;
}

/** Finish an MFA-challenged sign-in with the 6-digit authenticator code.
 *  `factorUid` (from `getPendingMfaHints()`) picks WHICH enrolled authenticator
 *  the code belongs to; omitted, the single/first TOTP hint is asserted. */
export async function completeMfaSignIn(code: string, factorUid?: string): Promise<void> {
  const a = await ensureInitAsync();
  if (!a || !authMod) throw new Error('Firebase Auth not configured');
  if (!pendingMfaResolver) throw new Error(i18n.t('auth:mfaNoPendingChallenge'));
  const am = authMod;
  const totpHints = pendingMfaResolver.hints.filter(
    (h) => h.factorId === am.TotpMultiFactorGenerator.FACTOR_ID,
  );
  const totpHint = selectTotpHint(totpHints, factorUid);
  if (!totpHint) throw new Error(i18n.t('auth:mfaNoTotpFactor'));
  const assertion = am.TotpMultiFactorGenerator.assertionForSignIn(totpHint.uid, code);
  await pendingMfaResolver.resolveSignIn(assertion);
  pendingMfaResolver = null;
}

/** Whether an MFA sign-in challenge is pending (for UI state restoration). */
export function hasPendingMfaChallenge(): boolean {
  return pendingMfaResolver !== null;
}

export async function signOut(): Promise<void> {
  const a = await ensureInitAsync();
  if (!a || !authMod) return;
  clearPendingLinkState();
  await authMod.signOut(a);
  cachedUser = null;
}

/**
 * Delete the signed-in Firebase user (account hard-delete step 2). No-op when
 * Firebase isn't configured or nobody is signed in. Surfaces Firebase errors
 * (e.g. `auth/requires-recent-login`) to the caller. Keeps the firebase SDK
 * import confined to this module so deleteAccount.ts stays SDK-free.
 */
export async function deleteCurrentFirebaseUser(): Promise<void> {
  const a = await ensureInitAsync();
  if (!a) return;
  const u = a.currentUser;
  if (u) await u.delete();
}

/** Cached signed-in user (sync). Returns null until the lazy auth init has
 *  completed and onIdTokenChanged has populated the cache. */
export function getCurrentUser(): AuthUser | null {
  return project(cachedUser);
}

/** Fresh ID token. Returns null if not signed in OR Firebase Auth is
 *  not configured. The SDK caches tokens internally — this call is
 *  cheap unless the cached token is near expiry. */
export async function getCurrentIdToken(): Promise<string | null> {
  const a = await ensureInitAsync();
  if (!a) return null;
  const u = a.currentUser ?? cachedUser;
  if (!u) return null;
  return await u.getIdToken();
}

/** Subscribe to auth-state changes. Kicks off the lazy SDK load, then fires
 *  with the current value and on every change (sign-in, sign-out, token
 *  refresh). Returns an unsubscribe that is safe to call before init resolves.
 *  When Firebase isn't configured, fires once with null and never loads the SDK. */
export function onAuthChanged(cb: (u: AuthUser | null) => void): () => void {
  let unsubscribe: (() => void) | null = null;
  let cancelled = false;
  void ensureInitAsync().then((a) => {
    if (cancelled) return;
    if (!a || !authMod) {
      cb(null);
      return;
    }
    unsubscribe = authMod.onIdTokenChanged(a, (u) => cb(project(u)));
  });
  return () => {
    cancelled = true;
    if (unsubscribe) unsubscribe();
  };
}
