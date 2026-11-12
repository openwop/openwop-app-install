/**
 * ADR 1097 — the `/start-trial` path matcher, kept import-free: `routes.tsx` is on the
 * entry chunk (the feature registry), so the matcher must not pull the link parser or
 * the sign-in return helper in with it. `auth/signInReturn.ts` holds the same literal
 * in its return allowlist; `startTrialRoute.test.ts` pins the two together.
 */
export const START_TRIAL_ROUTE = '/start-trial';

/** A trailing slash is tolerated, like `/pricing`. */
export function matchStartTrialRoute(pathname: string): boolean {
  return pathname === START_TRIAL_ROUTE || pathname === `${START_TRIAL_ROUTE}/`;
}
