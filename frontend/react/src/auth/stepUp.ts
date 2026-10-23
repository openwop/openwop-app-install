/**
 * ADR 0910 D11 — step-up re-authentication for the operator-access panel.
 *
 * Lives outside `auth/firebase.ts` (an entry-chunk module) so it ships only with
 * the KickTodo admin page that uses it; `stepUpContext()` hands over the SDK.
 */
import { MfaRequiredError, stepUpContext } from './firebase.js';

/** The sign-in method cannot re-authenticate in a popup here (an email/password
 *  account), so a step-up needs a fresh sign-in instead. */
export class StepUpUnsupportedError extends Error {
  constructor() {
    super('Re-authentication for this sign-in method is not supported here.');
    this.name = 'StepUpUnsupportedError';
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
  const { auth, mod, stashMfa } = await stepUpContext();
  if (!auth || !mod) throw new Error('Firebase Auth not configured');
  const u = auth.currentUser;
  if (!u) throw new Error('Not signed in');
  const providerId = u.providerData[0]?.providerId;
  const provider = providerId === 'google.com' ? new mod.GoogleAuthProvider()
    : providerId === 'github.com' ? new mod.GithubAuthProvider()
      : providerId === 'microsoft.com' ? new mod.OAuthProvider('microsoft.com')
        : null;
  if (!provider) throw new StepUpUnsupportedError();
  try {
    await mod.reauthenticateWithPopup(u, provider);
  } catch (err) {
    if (stashMfa(err)) throw new MfaRequiredError();
    throw err;
  }
  return await u.getIdToken(true);
}

/** A FORCED-refresh ID token for the signed-in person (null when signed out). */
export async function getFreshIdToken(): Promise<string | null> {
  const { auth } = await stepUpContext();
  const u = auth?.currentUser ?? null;
  return u ? await u.getIdToken(true) : null;
}
