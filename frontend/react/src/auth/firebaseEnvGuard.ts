/**
 * Build guard: a sign-in-gated production build must carry Firebase Auth.
 *
 * Vite inlines `VITE_FIREBASE_*` at build time, so a build made without them
 * ships `isAuthConfigured() === false` for good. On a deployment whose app shell
 * is behind the SIGN-IN gate that is an outage, not a degradation: every app
 * route shows the gate, and nobody can sign in. It happened on myndhyve.ai
 * (2026-11-07): the API key lives in a gitignored `.env.production.local`, and a
 * build from a checkout without that file shipped silently, until the next good
 * build hid it again.
 *
 * Keyed off the GATE MODE, never off the variables alone: the white-label,
 * adopter and demo builds run without Firebase on purpose (gate `none` or
 * `password`), and they must keep building. The error names the missing
 * variables only, never a value.
 */

/** The three variables `auth/firebase.ts` `readConfigFromEnv` requires. */
export const FIREBASE_ENV_KEYS = ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID'] as const;

/** The Firebase variables a build is missing, but only when its app gate is
 *  `sign-in`; otherwise an empty list. A blank value counts as missing. */
export function missingSignInFirebaseEnv(
  env: Record<string, string | undefined>,
  gateMode: 'none' | 'password' | 'sign-in',
): string[] {
  if (gateMode !== 'sign-in') return [];
  return FIREBASE_ENV_KEYS.filter((k) => !(env[k] ?? '').trim());
}

/** The build-abort message: names, never values. */
export function signInFirebaseEnvError(missing: readonly string[]): string {
  return (
    `[openwop] Production build aborted: the app gate is "sign-in" (VITE_BRAND_APP_GATE_MODE) but ` +
    `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set, so nobody could sign in. ` +
    `Set ${missing.length === 1 ? 'it' : 'them'} in frontend/react/.env.production or a gitignored ` +
    `.env.production.local, or set VITE_BRAND_APP_GATE_MODE=none for a build without sign-in.`
  );
}
