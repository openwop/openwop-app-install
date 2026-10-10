/**
 * "Sign in, then come back to the store" — shared by the public /pricing page
 * (#4534) and the feature store's anonymous state (ADR 0820 §7).
 *
 * The header sign-in dialog is opened through the header trigger's own click
 * (`.signin-trigger`, rendered by `auth/SignInButton`), so the same dialog,
 * providers, MFA and error handling run and no auth code is imported into the
 * caller's chunk.
 *
 * The return path survives an OIDC redirect in sessionStorage, with a short
 * expiry so a dismissed dialog can never hijack a much later sign-in. Per-tab,
 * best-effort: blocked storage just means the visitor lands where the provider
 * returns them, signed in. Only an internal store path is ever honoured.
 */
const RETURN_KEY = 'openwop.pricing.returnTo';
const RETURN_TTL_MS = 30 * 60 * 1000;
/** The one place a remembered return may point (the authed feature store). */
export const STORE_URL = '/marketplace/bundles';

export function rememberReturn(url: string): void {
  try { window.sessionStorage.setItem(RETURN_KEY, JSON.stringify({ url, at: Date.now() })); } catch { /* storage blocked */ }
}

/** The pending return path (only an internal store path), cleared as it is read. */
export function takeReturn(now = Date.now()): string | null {
  try {
    const raw = window.sessionStorage.getItem(RETURN_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(RETURN_KEY);
    const v = JSON.parse(raw) as { url?: unknown; at?: unknown };
    if (typeof v.url !== 'string' || !v.url.startsWith(`${STORE_URL}`) || typeof v.at !== 'number' || now - v.at > RETURN_TTL_MS) return null;
    return v.url;
  } catch { return null; }
}

/** Click the header's sign-in trigger. `false` = this host renders no sign-in UI. */
export function openHeaderSignIn(): boolean {
  const trigger = document.querySelector<HTMLButtonElement>('.signin-trigger');
  if (!trigger) return false;
  trigger.click();
  return true;
}
