/**
 * Per-user, per-browser first-run dismissal flags (the ADR 0188 pattern,
 * extracted so the app's first-run surfaces share ONE localStorage key scheme
 * instead of drifting into ad-hoc strings). Key shape:
 *
 *   `openwop-app.onboarding.<feature>.<uid>`
 *
 * Used by `chrome/VendorSetupPrompt` (feature `vendorSetup`, the first-run
 * connect-your-apps nudge) and `chat/WelcomeCard` (feature `getStarted`, the
 * SHELL-4 first-run getting-started strip). Per-uid so a shared browser doesn't
 * leak one user's dismissal to another; best-effort (private-mode-safe) so a
 * storage failure never nags nor throws.
 */
const PREFIX = 'openwop-app.onboarding.';

export function firstRunKey(feature: string, uid: string): string {
  return `${PREFIX}${feature}.${uid}`;
}

/** True when the flag is set (dismissed) OR there is no signed-in user — either
 *  way the first-run surface should stay hidden. Storage errors fail closed
 *  (treated as dismissed) so a private-mode browser never nags. */
export function isFirstRunDismissed(feature: string, uid: string | null | undefined): boolean {
  if (!uid) return true;
  try {
    return localStorage.getItem(firstRunKey(feature, uid)) != null;
  } catch {
    return true;
  }
}

/** Record that this user has seen (and moved past) the first-run surface. No-op
 *  without a uid; swallows storage errors (private mode). */
export function dismissFirstRun(feature: string, uid: string | null | undefined): void {
  if (!uid) return;
  try {
    localStorage.setItem(firstRunKey(feature, uid), new Date().toISOString());
  } catch {
    /* best-effort — storage unavailable (private mode) */
  }
}
