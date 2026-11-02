/**
 * ADR 0910 D11 — step-up re-authentication for the operator-access panel.
 *
 * Lives outside `auth/firebase.ts` (an entry-chunk module) so it ships only with
 * the pages that use it (the KickTodo admin page, and the lazily loaded
 * `ReauthDialog` that answers `auth/requires-recent-login`); `stepUpContext()`
 * hands over the SDK.
 */
import type { User } from '@firebase/auth';
import { MfaRequiredError, stepUpContext } from './firebase.js';

/** The sign-in method cannot re-authenticate in a popup here (an email/password
 *  account), so a step-up needs a fresh sign-in instead. */
export class StepUpUnsupportedError extends Error {
  constructor() {
    super('Re-authentication for this sign-in method is not supported here.');
    this.name = 'StepUpUnsupportedError';
  }
}

/** The popup-capable providers, in the order a multi-provider account tries them. */
const POPUP_PROVIDERS = ['google.com', 'github.com', 'microsoft.com'] as const;
type PopupProviderId = (typeof POPUP_PROVIDERS)[number];

/** How the signed-in person can prove a recent sign-in in place: a popup with
 *  the provider they signed in with, their password, or neither (SSO / phone /
 *  an unknown provider, where only a fresh sign-in will do). */
export type ReauthMethod =
  | { kind: 'popup'; providerId: PopupProviderId }
  | { kind: 'password'; email: string }
  | { kind: 'unsupported' };

type Ctx = Awaited<ReturnType<typeof stepUpContext>>;

function methodFor(u: User): ReauthMethod {
  const ids = u.providerData.map((p) => p.providerId);
  const popup = POPUP_PROVIDERS.find((id) => ids.includes(id));
  if (popup) return { kind: 'popup', providerId: popup };
  if (ids.includes('password') && u.email) return { kind: 'password', email: u.email };
  return { kind: 'unsupported' };
}

async function signedIn(): Promise<{ ctx: Ctx; mod: NonNullable<Ctx['mod']>; user: User }> {
  const ctx = await stepUpContext();
  if (!ctx.auth || !ctx.mod) throw new Error('Firebase Auth not configured');
  const user = ctx.auth.currentUser;
  if (!user) throw new Error('Not signed in');
  return { ctx, mod: ctx.mod, user };
}

/** The re-authentication method for the signed-in person (`unsupported` when
 *  signed out or Firebase is not configured). */
export async function getReauthMethod(): Promise<ReauthMethod> {
  const { auth } = await stepUpContext();
  const u = auth?.currentUser;
  return u ? methodFor(u) : { kind: 'unsupported' };
}

/**
 * Re-authenticate the signed-in person in a popup with the provider they signed
 * in with. With a second factor, Firebase raises the MFA challenge: it is
 * stashed and `MfaRequiredError` thrown; the caller collects the code and calls
 * `completeMfaSignIn(code)`, which resolves a reauthentication resolver too.
 */
export async function reauthenticateWithProviderPopup(): Promise<void> {
  const { ctx, mod, user } = await signedIn();
  const method = methodFor(user);
  if (method.kind !== 'popup') throw new StepUpUnsupportedError();
  const provider = method.providerId === 'google.com' ? new mod.GoogleAuthProvider()
    : method.providerId === 'github.com' ? new mod.GithubAuthProvider()
      : new mod.OAuthProvider('microsoft.com');
  try {
    await mod.reauthenticateWithPopup(user, provider);
  } catch (err) {
    if (ctx.stashMfa(err)) throw new MfaRequiredError();
    throw err;
  }
}

/** Re-authenticate an email/password account with the password the person
 *  typed. Same MFA contract as `reauthenticateWithProviderPopup`. */
export async function reauthenticateWithPassword(password: string): Promise<void> {
  const { ctx, mod, user } = await signedIn();
  if (!user.email) throw new StepUpUnsupportedError();
  try {
    await mod.reauthenticateWithCredential(user, mod.EmailAuthProvider.credential(user.email, password));
  } catch (err) {
    if (ctx.stashMfa(err)) throw new MfaRequiredError();
    throw err;
  }
}

/**
 * Re-authenticate the signed-in person in a popup with the provider they signed
 * in with, then return a FORCED-fresh ID token. Operator activation needs an ID
 * token whose `auth_time` is at most 15 minutes old, which a cached token or the
 * session cookie cannot prove. With a second factor, Firebase raises the MFA
 * challenge: it is stashed and `MfaRequiredError` thrown; the caller collects the
 * code, calls `completeMfaSignIn(code)`, then `getFreshIdToken()`.
 */
export async function reauthenticateForStepUp(): Promise<string> {
  await reauthenticateWithProviderPopup();
  const { auth } = await stepUpContext();
  const u = auth?.currentUser;
  if (!u) throw new Error('Not signed in');
  return await u.getIdToken(true);
}

/** A FORCED-refresh ID token for the signed-in person (null when signed out). */
export async function getFreshIdToken(): Promise<string | null> {
  const { auth } = await stepUpContext();
  const u = auth?.currentUser ?? null;
  return u ? await u.getIdToken(true) : null;
}
